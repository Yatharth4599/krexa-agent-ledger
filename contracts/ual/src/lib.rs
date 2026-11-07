//! Krexa Underwritable Agent Ledger (UAL).
//!
//! An append-only, hash-chained record of what a trading agent did, bound to a policy the
//! owner committed in advance, with an evidence gate that sizes a trade by how many
//! independent sources agree. SPEC.md sections 3 and 4.
//!
//! Three properties are worth stating up front because the rest of the code exists to serve
//! them:
//!
//! 1. **A refusal is a record.** A policy breach appends a receipt with
//!    `verdict: "REJECTED"` and the reasons, and the transaction succeeds. Breaches are the
//!    most interesting rows in an agent's history, so they are not allowed to be absences.
//!    Only structural problems panic, and then nothing is appended at all.
//! 2. **No method moves funds.** There is no withdraw, no transfer, no upgrade entry point.
//!    An agent's function-call key is scoped to this contract and to four methods, so the
//!    NEAR protocol itself refuses anything else signed with it.
//! 3. **Paper is labelled paper, on chain.** The mode lives in desk state and is stamped into
//!    every receipt by the contract, not by the caller, so an operator cannot blend a
//!    simulated run into a live record.
//!
//! Not upgradable in this build: there is no `upgrade` method. The contract account's
//! full-access key can still redeploy, which is disclosed in SPEC.md 15 rather than papered
//! over. Unaudited. Testnet only.

// The enum variants in this crate are the normative JSON spellings that get hashed into
// every receipt (OPEN_LONG, REJECTED, EVIDENCE, and so on). Renaming them to satisfy a
// style lint would change the hash of every receipt ever written, so the lint is off.
#![allow(clippy::upper_case_acronyms)]

use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{env, near, AccountId, NearToken, PanicOnDefault};
use serde_json::{json, Value};

mod canonical;
mod errors;
mod evidence;
mod events;
mod policy;
mod types;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod vectors;

use canonical::{is_hex64, sha256_hex};
use errors::*;
use policy::{valid_desk_id, Policy};
use types::*;

/// Storage attached to `create_desk`. Covers the desk record plus early receipts; the
/// contract account carries the rest, which is affordable on testnet and is called out as
/// future work in SPEC.md 4.6.
const MIN_DESK_DEPOSIT: NearToken = NearToken::from_millinear(100);

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Ual {
    owner: AccountId,
    paused: bool,
    desks: IterableMap<String, Desk>,
    desk_ids: Vector<String>,
    /// policyHash -> canonical policy JSON. Keyed by hash, so a policy is immutable and two
    /// desks committing identical rules share one entry.
    policies: LookupMap<String, String>,
    /// "<deskId>:<seq>" -> receipt.
    receipts: LookupMap<String, Receipt>,
    /// "<deskId>:<intentSeq>" -> true once filled, backing E11_ALREADY_FILLED.
    filled: LookupMap<String, bool>,
}

#[near]
impl Ual {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            paused: false,
            desks: IterableMap::new(b"d".to_vec()),
            desk_ids: Vector::new(b"i".to_vec()),
            policies: LookupMap::new(b"p".to_vec()),
            receipts: LookupMap::new(b"r".to_vec()),
            filled: LookupMap::new(b"f".to_vec()),
        }
    }

    // ------------------------------------------------------------ desks

    /// Anyone may create a desk. The caller becomes its owner. The attached deposit funds
    /// storage; the genesis head is set so the first receipt has something to chain to.
    #[payable]
    pub fn create_desk(&mut self, desk_id: String) {
        self.assert_not_paused();
        require(valid_desk_id(&desk_id), E05_POLICY_INVALID);
        require(!self.desks.contains_key(&desk_id), E08_DESK_EXISTS);
        require(
            env::attached_deposit() >= MIN_DESK_DEPOSIT,
            E12_INSUFFICIENT_STORAGE,
        );

        let genesis = genesis_hash_for(env::current_account_id().as_str(), &desk_id);
        let desk = Desk {
            desk_id: desk_id.clone(),
            owner: env::predecessor_account_id(),
            mode: Mode::Paper,
            policy_hash: None,
            head_seq: 0,
            head_hash: genesis.clone(),
            genesis_hash: genesis.clone(),
            kill_switch: false,
            kill_reason: String::new(),
            agents: Vec::new(),
            fetchers: Vec::new(),
            open_positions: Vec::new(),
            paper: ModeStats::default(),
            live: ModeStats::default(),
            retired: false,
        };
        self.desks.insert(desk_id.clone(), desk);
        self.desk_ids.push(desk_id.clone());

        events::emit(
            events::DESK_CREATED,
            json!({
                "deskId": desk_id,
                "owner": env::predecessor_account_id(),
                "genesisHash": genesis,
                "mode": Mode::Paper.as_str(),
            }),
        );
    }

    /// Validate, canonicalise and store a policy, then append a POLICY receipt.
    ///
    /// The submitted bytes must already be in canonical form. We re-serialize what we parsed
    /// and compare: if they differ the commit fails with E04_POLICY_NOT_CANONICAL. Without
    /// that, two byte strings could both claim to be "the policy" while hashing differently.
    pub fn commit_policy(&mut self, desk_id: String, policy_json: String) -> String {
        self.assert_not_paused();
        let mut desk = self.desk(&desk_id);
        self.assert_desk_owner(&desk);

        let parsed = match Policy::parse_and_validate(&policy_json, &desk_id) {
            Ok(p) => p,
            Err(code) => env::panic_str(code),
        };
        // A policy that does not permit the mode the desk is currently in would leave the
        // desk unable to act, so reject it now rather than at the first intent.
        require(parsed.mode_allowed(desk.mode), E17_MODE_NOT_ALLOWED);

        let policy_hash = sha256_hex(parsed.canonical_str().as_bytes());
        self.policies
            .insert(policy_hash.clone(), parsed.canonical_str().to_string());
        desk.policy_hash = Some(policy_hash.clone());

        let receipt = self.append_receipt(
            &mut desk,
            ReceiptKind::POLICY,
            ReceiptParts {
                control: Some(ControlDetail::new("policy_committed", policy_hash.clone())),
                ..Default::default()
            },
        );
        self.desks.insert(desk_id.clone(), desk);

        events::emit(
            events::POLICY_COMMITTED,
            json!({"deskId": desk_id, "policyHash": policy_hash, "seq": receipt.seq}),
        );
        policy_hash
    }

    /// Switch paper to live or back. The mode lives in desk state, not in the policy, so the
    /// `policyHash` is unchanged by this call. SPEC.md 3.2.
    pub fn set_mode(&mut self, desk_id: String, mode: String) {
        self.assert_not_paused();
        let mut desk = self.desk(&desk_id);
        self.assert_desk_owner(&desk);
        let new_mode = Mode::parse(&mode).unwrap_or_else(|| env::panic_str(E17_MODE_NOT_ALLOWED));
        let policy = self.policy_of(&desk);
        require(policy.mode_allowed(new_mode), E17_MODE_NOT_ALLOWED);

        desk.mode = new_mode;
        self.append_receipt(
            &mut desk,
            ReceiptKind::CONTROL,
            ReceiptParts {
                control: Some(ControlDetail::new("mode_changed", new_mode.as_str())),
                ..Default::default()
            },
        );
        self.desks.insert(desk_id.clone(), desk);
        events::emit(
            events::MODE_CHANGED,
            json!({"deskId": desk_id, "mode": new_mode.as_str()}),
        );
    }

    pub fn register_agent(&mut self, desk_id: String, agent: AccountId, role: String) {
        self.assert_not_paused();
        let mut desk = self.desk(&desk_id);
        self.assert_desk_owner(&desk);
        let role = parse_role(&role);

        if let Some(existing) = desk.agents.iter_mut().find(|a| a.account == agent) {
            existing.role = role;
            existing.retired = false;
        } else {
            desk.agents.push(AgentEntry {
                account: agent.clone(),
                role,
                retired: false,
            });
        }

        self.append_receipt(
            &mut desk,
            ReceiptKind::CONTROL,
            ReceiptParts {
                control: Some(ControlDetail::new(
                    "agent_registered",
                    format!("{} {}", agent, role.as_str()),
                )),
                ..Default::default()
            },
        );
        self.desks.insert(desk_id.clone(), desk);
        events::emit(
            events::AGENT_REGISTERED,
            json!({"deskId": desk_id, "agent": agent, "role": role.as_str()}),
        );
    }

    /// Retire an agent. Its history stays in the ledger; it simply cannot write again.
    /// Nothing is deleted, here or anywhere else in this contract.
    pub fn retire_agent(&mut self, desk_id: String, agent: AccountId) {
        self.assert_not_paused();
        let mut desk = self.desk(&desk_id);
        self.assert_desk_owner(&desk);
        let found = desk.agents.iter_mut().find(|a| a.account == agent);
        match found {
            Some(entry) => entry.retired = true,
            None => env::panic_str(E02_NOT_AGENT),
        }

        self.append_receipt(
            &mut desk,
            ReceiptKind::CONTROL,
            ReceiptParts {
                control: Some(ControlDetail::new("agent_retired", agent.to_string())),
                ..Default::default()
            },
        );
        self.desks.insert(desk_id.clone(), desk);
        events::emit(
            events::AGENT_RETIRED,
            json!({"deskId": desk_id, "agent": agent}),
        );
    }

    // ------------------------------------------------------------ fetchers

    /// Register an evidence fetcher's ed25519 public key after the owner has checked its
    /// attestation off chain.
    ///
    /// The contract cannot verify an Intel TDX quote itself, so this records the owner's
    /// claim and the hash of the report they checked. `attestation_hash` of 64 zeros is the
    /// honest declaration that this fetcher is **not** attested, which makes every evidence
    /// receipt it signs carry `attested: false`. SPEC.md 2A.2 item 2 and 15.
    pub fn register_fetcher(
        &mut self,
        desk_id: String,
        pubkey: String,
        attestation_hash: String,
        label: String,
    ) {
        self.assert_not_paused();
        let mut desk = self.desk(&desk_id);
        self.assert_desk_owner(&desk);
        require(decode_ed25519_pubkey(&pubkey).is_some(), E19_UNKNOWN_FETCHER);
        require(is_hex64(&attestation_hash), E13_BAD_HASH);
        require(label.len() <= 64 && canonical::is_printable_ascii(&label), E18_NON_ASCII);

        if let Some(existing) = desk.fetchers.iter_mut().find(|f| f.pubkey == pubkey) {
            existing.attestation_hash = attestation_hash.clone();
            existing.label = label.clone();
            existing.revoked = false;
        } else {
            desk.fetchers.push(Fetcher {
                pubkey: pubkey.clone(),
                attestation_hash: attestation_hash.clone(),
                label: label.clone(),
                revoked: false,
            });
        }

        let attested = attestation_hash != "0".repeat(64);
        self.append_receipt(
            &mut desk,
            ReceiptKind::CONTROL,
            ReceiptParts {
                control: Some(ControlDetail::new(
                    "fetcher_registered",
                    format!("{} attested={}", pubkey, attested),
                )),
                ..Default::default()
            },
        );
        self.desks.insert(desk_id.clone(), desk);
        events::emit(
            events::FETCHER_REGISTERED,
            json!({"deskId": desk_id, "pubkey": pubkey, "attested": attested, "label": label}),
        );
    }

    pub fn revoke_fetcher(&mut self, desk_id: String, pubkey: String) {
        self.assert_not_paused();
        let mut desk = self.desk(&desk_id);
        self.assert_desk_owner(&desk);
        match desk.fetchers.iter_mut().find(|f| f.pubkey == pubkey) {
            Some(f) => f.revoked = true,
            None => env::panic_str(E19_UNKNOWN_FETCHER),
        }
        self.append_receipt(
            &mut desk,
            ReceiptKind::CONTROL,
            ReceiptParts {
                control: Some(ControlDetail::new("fetcher_revoked", pubkey.clone())),
                ..Default::default()
            },
        );
        self.desks.insert(desk_id.clone(), desk);
        events::emit(
            events::FETCHER_REVOKED,
            json!({"deskId": desk_id, "pubkey": pubkey}),
        );
    }

    // ------------------------------------------------------------ evidence

    /// Verify a bundle's signatures, freshness and independence groups, compute k and the
    /// size multiplier, and append an EVIDENCE receipt.
    ///
    /// The verdict is `NA`: this receipt is a finding, not a decision. The reasons list is
    /// still populated so a reader can see why the following intent was sized as it was.
    pub fn submit_evidence(
        &mut self,
        desk_id: String,
        bundle: EvidenceBundleInput,
        prev_hash: String,
    ) -> Value {
        self.assert_not_paused();
        let mut desk = self.desk(&desk_id);
        self.assert_trading_agent(&desk);
        let policy = self.policy_of(&desk);
        self.assert_chain(&desk, &prev_hash);

        // A desk with no evidence block in its policy has no authorized verifier, so there
        // is nothing a bundle could be checked against.
        let expected_verifier = policy
            .verifier_code_hash()
            .unwrap_or_else(|| env::panic_str(E06_NO_POLICY));
        // A bundle produced by a verifier build the policy does not name cannot be trusted to
        // have assigned stances by the committed rules.
        require(bundle.verifier_code_hash == expected_verifier, E13_BAD_HASH);

        let result = evidence::evaluate_bundle(&bundle, &policy, &desk, env::block_timestamp());
        let summary = result.summary;

        let mut reasons: Vec<String> = Vec::new();
        if summary.any_bad_sig {
            reasons.push(R_EVIDENCE_BAD_SIG.to_string());
        }
        if summary.any_stale {
            reasons.push(R_EVIDENCE_STALE.to_string());
        }
        if let Some(min_k) = policy.min_k_for_nonzero() {
            if summary.k < min_k {
                reasons.push(R_UNCORROBORATED.to_string());
            }
        }

        let size_multiplier_bps = summary.size_multiplier_bps;
        let receipt = self.append_receipt(
            &mut desk,
            ReceiptKind::EVIDENCE,
            ReceiptParts {
                reasons,
                size_multiplier_bps: Some(size_multiplier_bps),
                evidence: Some(summary),
                ..Default::default()
            },
        );
        self.desks.insert(desk_id, desk);
        receipt.to_value()
    }

    // ------------------------------------------------------------ intents

    /// Check an intent against the committed policy and the evidence gate, then append an
    /// INTENT receipt carrying the verdict.
    ///
    /// A breach produces a REJECTED receipt and a successful transaction. The caller learns
    /// the reasons and so does everyone else, forever.
    #[allow(clippy::too_many_arguments)]
    pub fn submit_intent(
        &mut self,
        desk_id: String,
        intent: Intent,
        prev_hash: String,
        equity_usd: String,
        decision_hash: Option<String>,
        ai_sig_hash: Option<String>,
        evidence_seq: Option<u64>,
    ) -> Value {
        self.assert_not_paused();
        let mut desk = self.desk(&desk_id);
        self.assert_trading_agent(&desk);
        let policy = self.policy_of(&desk);
        self.assert_chain(&desk, &prev_hash);

        let requested =
            parse_micro_usd_unsigned(&intent.notional_usd).unwrap_or_else(|| env::panic_str(E21_MALFORMED_AMOUNT));
        let claimed_equity =
            parse_micro_usd(&equity_usd).unwrap_or_else(|| env::panic_str(E21_MALFORMED_AMOUNT));
        for s in [&intent.client_id, &intent.asset, &intent.venue] {
            require(canonical::is_printable_ascii(s), E18_NON_ASCII);
            require(s.len() <= MAX_IDENT_LEN, E18_NON_ASCII);
        }
        if let Some(h) = &decision_hash {
            require(is_hex64(h), E13_BAD_HASH);
        }
        if let Some(h) = &ai_sig_hash {
            require(is_hex64(h), E13_BAD_HASH);
        }

        let now = env::block_timestamp();
        let mode = desk.mode;
        let stats = desk.stats(mode).clone();
        // The caller's equity figure can only make the loss checks stricter. Equity above the
        // last recorded mark would let an agent talk its way past the daily loss limit.
        let equity = match parse_micro_usd(&stats.last_equity_usd) {
            Some(marked) if stats.last_mark_ts != 0 => claimed_equity.min(marked),
            _ => claimed_equity,
        };
        let daily_pnl = daily_pnl_against(&stats, now, equity);
        let dd_bps = drawdown_bps(
            parse_micro_usd(&stats.high_water_usd).unwrap_or(0),
            equity,
        );

        let mut reasons: Vec<String> = Vec::new();

        // The allowlists are structural and apply to every side, including exits: a venue or
        // asset the policy never named is outside the desk's declared mandate.
        if !policy.asset_allowed(&intent.asset) {
            reasons.push(R_ASSET_NOT_ALLOWED.to_string());
        }
        if !policy.venue_allowed(&intent.venue) {
            reasons.push(R_VENUE_NOT_ALLOWED.to_string());
        }
        if intent.max_slippage_bps as u64 > policy.slippage_cap_bps() {
            reasons.push(R_SLIPPAGE_CAP.to_string());
        }

        let mut size_multiplier_bps: Option<u32> = None;
        let mut evidence_receipt_seq: Option<u64> = None;

        if intent.side.is_open() {
            // --- risk limits, opens only. You can always exit. ---
            if desk.kill_switch {
                reasons.push(R_KILL_SWITCH.to_string());
            }
            if stats.last_mark_ts == 0 || now.saturating_sub(stats.last_mark_ts) > MARK_MAX_AGE_NS {
                reasons.push(R_NO_EQUITY_MARK.to_string());
            }
            let loss_limit = policy.daily_loss_limit_usd();
            if loss_limit > 0 && daily_pnl <= -loss_limit {
                reasons.push(R_DAILY_LOSS.to_string());
            }
            if desk.open_positions.len() as u64 >= policy.max_open_positions() {
                reasons.push(R_MAX_OPEN_POSITIONS.to_string());
            }

            // --- evidence gate ---
            let multiplier = if policy.evidence_required() {
                let (mult, seq, mut ev_reasons) =
                    self.check_evidence(&desk, &policy, &intent, evidence_seq, now, mode);
                reasons.append(&mut ev_reasons);
                evidence_receipt_seq = seq;
                mult
            } else {
                10_000
            };
            size_multiplier_bps = Some(multiplier);

            // Size by corroboration first, then cap. The contract rejects rather than
            // clipping, which differs from Krexa's off-chain `checkOrder` and is called out
            // in the differential tests.
            let effective = requested.saturating_mul(multiplier as i128) / 10_000;
            if effective > policy.max_position_usd() {
                reasons.push(R_MAX_POSITION.to_string());
            }
        } else {
            // An exit needs no evidence, but it must be an exit: a CLOSE with nothing open, or
            // a REDUCE larger than the position, is an unchecked open on the other side.
            let open = open_notional(&desk, &intent.asset, &intent.venue);
            if open == 0 {
                reasons.push(R_NO_POSITION.to_string());
            } else if requested > open {
                reasons.push(R_EXIT_EXCEEDS_POSITION.to_string());
            }
        }

        let verdict = if reasons.is_empty() {
            Verdict::APPROVED
        } else {
            Verdict::REJECTED
        };
        // An approved open spends its evidence. Only approval spends it, so a refusal never
        // burns a bundle the agent could still legitimately use.
        if verdict == Verdict::APPROVED {
            if let Some(ev) = evidence_receipt_seq {
                self.filled.insert(evidence_used_key(&desk_id, ev), true);
            }
        }

        let receipt = self.append_receipt(
            &mut desk,
            ReceiptKind::INTENT,
            ReceiptParts {
                intent: Some(intent),
                verdict,
                reasons,
                equity_usd: Some(micro_usd_to_string(equity)),
                drawdown_bps: dd_bps,
                daily_pnl_usd: micro_usd_to_string(daily_pnl),
                decision_hash,
                ai_sig_hash,
                evidence_receipt_seq,
                size_multiplier_bps,
                ..Default::default()
            },
        );
        self.desks.insert(desk_id, desk);
        receipt.to_value()
    }

    /// Record a fill against an APPROVED intent.
    pub fn record_fill(
        &mut self,
        desk_id: String,
        intent_seq: u64,
        fill: FillRef,
        prev_hash: String,
    ) -> Value {
        self.assert_not_paused();
        let mut desk = self.desk(&desk_id);
        self.assert_trading_agent(&desk);
        self.assert_chain(&desk, &prev_hash);

        let intent_receipt = self
            .receipts
            .get(&receipt_key(&desk_id, intent_seq))
            .cloned()
            .unwrap_or_else(|| env::panic_str(E13_BAD_HASH));
        require(
            intent_receipt.kind == ReceiptKind::INTENT
                && intent_receipt.verdict == Verdict::APPROVED,
            E10_INTENT_NOT_APPROVED,
        );
        let fill_key = receipt_key(&desk_id, intent_seq);
        require(self.filled.get(&fill_key).is_none(), E11_ALREADY_FILLED);

        let intent = intent_receipt
            .intent
            .clone()
            .unwrap_or_else(|| env::panic_str(E10_INTENT_NOT_APPROVED));

        // The approved size is the requested notional after the evidence multiplier, not the
        // requested notional. Filling the full request against a half-sized approval would
        // walk straight through the gate.
        let requested = parse_micro_usd_unsigned(&intent.notional_usd)
            .unwrap_or_else(|| env::panic_str(E21_MALFORMED_AMOUNT));
        let approved = match intent_receipt.size_multiplier_bps {
            Some(m) => requested.saturating_mul(m as i128) / 10_000,
            None => requested,
        };
        let filled_notional = parse_micro_usd_unsigned(&fill.notional_usd)
            .unwrap_or_else(|| env::panic_str(E21_MALFORMED_AMOUNT));
        require(filled_notional <= approved, E15_FILL_EXCEEDS_INTENT);

        // Label rules, SPEC.md 3.4. A simulated fill on a live desk, or a settled fill on a
        // paper desk, is the exact confusion the on-chain label exists to prevent.
        match desk.mode {
            Mode::Paper => require(
                fill.simulated && fill.kind.must_be_simulated(),
                E16_LABEL_MISMATCH,
            ),
            Mode::Live => require(
                !fill.simulated && !fill.kind.must_be_simulated(),
                E16_LABEL_MISMATCH,
            ),
        }

        // The desk may have changed since approval. Re-check what approval checked.
        let now = env::block_timestamp();
        if intent.side.is_open() {
            let policy = self.policy_of(&desk);
            require(!desk.kill_switch, E22_FILL_NOT_PERMITTED);
            require(
                (desk.open_positions.len() as u64) < policy.max_open_positions(),
                E22_FILL_NOT_PERMITTED,
            );
            // The loss limit and mark freshness can change between approval and fill, and the
            // auto kill switch only covers the loss limit when the policy turns it on.
            let stats = desk.stats(desk.mode);
            require(
                stats.last_mark_ts != 0 && now.saturating_sub(stats.last_mark_ts) <= MARK_MAX_AGE_NS,
                E22_FILL_NOT_PERMITTED,
            );
            let marked = parse_micro_usd(&stats.last_equity_usd).unwrap_or(0);
            let loss_limit = policy.daily_loss_limit_usd();
            require(
                loss_limit == 0 || daily_pnl_against(stats, now, marked) > -loss_limit,
                E22_FILL_NOT_PERMITTED,
            );
            // An approval is as old as its evidence allows, and no older.
            if policy.evidence_required() {
                let approved_at: u64 = intent_receipt.ts.parse().unwrap_or(0);
                let max_age_ns = policy.evidence_max_age_sec().saturating_mul(1_000_000_000);
                require(now.saturating_sub(approved_at) <= max_age_ns, E22_FILL_NOT_PERMITTED);
            }
        } else {
            require(
                filled_notional <= open_notional(&desk, &intent.asset, &intent.venue),
                E22_FILL_NOT_PERMITTED,
            );
        }

        // Checked after the labels, so a label confusion still reports E16. What is left is a
        // correctly labelled fill against an intent approved in the other mode.
        require(intent_receipt.mode == desk.mode, E22_FILL_NOT_PERMITTED);

        apply_fill_to_positions(&mut desk, &intent, filled_notional, intent_seq);
        self.filled.insert(fill_key, true);

        let mode = desk.mode;
        let stats = desk.stats(mode).clone();
        let equity = parse_micro_usd(&stats.last_equity_usd).unwrap_or(0);
        let receipt = self.append_receipt(
            &mut desk,
            ReceiptKind::FILL,
            ReceiptParts {
                fill_ref: Some(fill),
                intent_seq: Some(intent_seq),
                equity_usd: if stats.last_equity_usd.is_empty() {
                    None
                } else {
                    Some(stats.last_equity_usd.clone())
                },
                drawdown_bps: drawdown_bps(
                    parse_micro_usd(&stats.high_water_usd).unwrap_or(0),
                    equity,
                ),
                daily_pnl_usd: micro_usd_to_string(daily_pnl_against(&stats, now, equity)),
                ..Default::default()
            },
        );
        self.desks.insert(desk_id, desk);
        receipt.to_value()
    }

    /// Record an equity mark. At most one per desk per 5 minutes.
    ///
    /// `decisions_root` is the Merkle root of every DecisionRecord hash since the previous
    /// receipt, which is how HOLD decisions get committed. Without it an agent could decide
    /// not to trade a thousand times and later claim whichever of those it liked.
    ///
    /// Callable by a registered agent or by the desk owner. The owner is allowed because they
    /// could register themselves as an agent anyway, so refusing them adds friction, not
    /// safety.
    pub fn record_mark(
        &mut self,
        desk_id: String,
        equity_usd: String,
        prev_hash: String,
        decisions_root: Option<String>,
    ) -> Value {
        self.assert_not_paused();
        let mut desk = self.desk(&desk_id);
        let caller = env::predecessor_account_id();
        // Owner, trading agents and the Monitor. ANALYST and DATA never touch the ledger
        // (RULES.md 1), and a mark can reset the day basis or trip the auto kill switch.
        require(
            desk.owner == caller
                || desk
                    .active_agent(&caller)
                    .is_some_and(|r| r.may_trade() || r == Role::MONITOR),
            E02_NOT_AGENT,
        );
        let policy = self.policy_of(&desk);
        self.assert_chain(&desk, &prev_hash);
        if let Some(root) = &decisions_root {
            require(is_hex64(root), E13_BAD_HASH);
        }

        let equity =
            parse_micro_usd(&equity_usd).unwrap_or_else(|| env::panic_str(E21_MALFORMED_AMOUNT));
        let now = env::block_timestamp();
        let mode = desk.mode;

        {
            let stats = desk.stats_mut(mode);
            if stats.last_mark_ts != 0 {
                require(
                    now.saturating_sub(stats.last_mark_ts) >= MARK_MIN_INTERVAL_NS,
                    E14_MARK_TOO_SOON,
                );
            }
            let today = day_bucket(now);
            if stats.last_mark_ts == 0 || stats.day != today {
                // First mark of a new UTC day sets the basis for that day's PnL.
                stats.day = today;
                stats.day_start_equity_usd = micro_usd_to_string(equity);
            }
            let hwm = parse_micro_usd(&stats.high_water_usd).unwrap_or(i128::MIN);
            if equity > hwm {
                stats.high_water_usd = micro_usd_to_string(equity);
            }
            stats.last_equity_usd = micro_usd_to_string(equity);
            stats.last_mark_ts = now;
        }

        let stats = desk.stats(mode).clone();
        let daily_pnl = daily_pnl_against(&stats, now, equity);
        let dd_bps = drawdown_bps(parse_micro_usd(&stats.high_water_usd).unwrap_or(0), equity);

        // Auto kill switch. This is the one place the contract engages a control by itself,
        // and it only ever tightens.
        let loss_limit = policy.daily_loss_limit_usd();
        let mut auto_engaged = false;
        if policy.auto_on_daily_loss() && loss_limit > 0 && daily_pnl <= -loss_limit && !desk.kill_switch
        {
            desk.kill_switch = true;
            desk.kill_reason = "auto: daily loss limit".to_string();
            auto_engaged = true;
        }

        let receipt = self.append_receipt(
            &mut desk,
            ReceiptKind::MARK,
            ReceiptParts {
                equity_usd: Some(micro_usd_to_string(equity)),
                drawdown_bps: dd_bps,
                daily_pnl_usd: micro_usd_to_string(daily_pnl),
                decisions_root,
                ..Default::default()
            },
        );
        let seq = receipt.seq;
        let out = receipt.to_value();

        if auto_engaged {
            self.append_receipt(
                &mut desk,
                ReceiptKind::CONTROL,
                ReceiptParts {
                    control: Some(ControlDetail::new(
                        "kill_switch_engaged",
                        "auto: daily loss limit",
                    )),
                    ..Default::default()
                },
            );
            events::emit(
                events::KILL_SWITCH_ENGAGED,
                json!({"deskId": desk_id, "reason": "auto: daily loss limit", "bySeq": seq}),
            );
        }
        self.desks.insert(desk_id, desk);
        out
    }

    /// Record a capital deposit (positive) or withdrawal (negative) so returns can be
    /// time weighted rather than crediting a deposit as profit.
    ///
    /// This records a number. It moves nothing: there is no transfer in this contract.
    pub fn record_flow(&mut self, desk_id: String, amount_usd: String, prev_hash: String) -> Value {
        self.assert_not_paused();
        let mut desk = self.desk(&desk_id);
        self.assert_desk_owner(&desk);
        self.assert_chain(&desk, &prev_hash);
        let amount =
            parse_micro_usd(&amount_usd).unwrap_or_else(|| env::panic_str(E21_MALFORMED_AMOUNT));

        let mode = desk.mode;
        {
            // Shift the day's basis by the flow so the flow does not read as PnL.
            let stats = desk.stats_mut(mode);
            let base = parse_micro_usd(&stats.day_start_equity_usd).unwrap_or(0);
            stats.day_start_equity_usd = micro_usd_to_string(base.saturating_add(amount));
        }

        let receipt = self.append_receipt(
            &mut desk,
            ReceiptKind::CONTROL,
            ReceiptParts {
                control: Some(ControlDetail::new("flow", micro_usd_to_string(amount))),
                ..Default::default()
            },
        );
        self.desks.insert(desk_id, desk);
        receipt.to_value()
    }

    // ------------------------------------------------------------ kill switch

    /// Engage the kill switch. The desk owner may always do this. A registered MONITOR may
    /// too, if the policy says so. A Monitor can never release it, which is the asymmetry
    /// that makes it safe to let a rule-based agent hold the brake.
    pub fn engage_kill_switch(&mut self, desk_id: String, reason: String) {
        self.assert_not_paused();
        let mut desk = self.desk(&desk_id);
        let policy = self.policy_of(&desk);
        let caller = env::predecessor_account_id();
        let is_owner = desk.owner == caller;
        let is_monitor = matches!(desk.active_agent(&caller), Some(Role::MONITOR));
        require(
            is_owner || (is_monitor && policy.monitor_may_engage()),
            E01_NOT_OWNER,
        );
        require(reason.len() <= 200 && canonical::is_printable_ascii(&reason), E18_NON_ASCII);

        desk.kill_switch = true;
        desk.kill_reason = reason.clone();
        self.append_receipt(
            &mut desk,
            ReceiptKind::CONTROL,
            ReceiptParts {
                control: Some(ControlDetail::new("kill_switch_engaged", reason.clone())),
                ..Default::default()
            },
        );
        self.desks.insert(desk_id.clone(), desk);
        events::emit(
            events::KILL_SWITCH_ENGAGED,
            json!({"deskId": desk_id, "reason": reason, "by": caller}),
        );
    }

    /// Release the kill switch. Desk owner only, never an agent.
    pub fn release_kill_switch(&mut self, desk_id: String) {
        self.assert_not_paused();
        let mut desk = self.desk(&desk_id);
        self.assert_desk_owner(&desk);
        desk.kill_switch = false;
        desk.kill_reason = String::new();
        self.append_receipt(
            &mut desk,
            ReceiptKind::CONTROL,
            ReceiptParts {
                control: Some(ControlDetail::new("kill_switch_released", "")),
                ..Default::default()
            },
        );
        self.desks.insert(desk_id.clone(), desk);
        events::emit(
            events::KILL_SWITCH_RELEASED,
            json!({"deskId": desk_id}),
        );
    }

    // ------------------------------------------------------------ global pause

    pub fn pause(&mut self) {
        self.assert_contract_owner();
        self.paused = true;
        events::emit(events::CONTRACT_PAUSED, json!({}));
    }

    pub fn unpause(&mut self) {
        self.assert_contract_owner();
        self.paused = false;
        events::emit(events::CONTRACT_UNPAUSED, json!({}));
    }

    // ------------------------------------------------------------ views

    pub fn get_desk(&self, desk_id: String) -> Option<Desk> {
        self.desks.get(&desk_id).cloned()
    }

    pub fn list_desks(&self, from_index: u32, limit: u32) -> Vec<String> {
        let len = self.desk_ids.len();
        let start = from_index.min(len);
        let end = start.saturating_add(limit.min(100)).min(len);
        (start..end)
            .filter_map(|i| self.desk_ids.get(i).cloned())
            .collect()
    }

    pub fn get_desks_by_owner(&self, owner: AccountId) -> Vec<String> {
        self.desks
            .iter()
            .filter(|(_, d)| d.owner == owner)
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn get_policy(&self, policy_hash: String) -> Option<String> {
        self.policies.get(&policy_hash).cloned()
    }

    pub fn get_head(&self, desk_id: String) -> Option<Value> {
        self.desks
            .get(&desk_id)
            .map(|d| json!({"seq": d.head_seq, "hash": d.head_hash}))
    }

    pub fn genesis_hash(&self, desk_id: String) -> Option<String> {
        self.desks.get(&desk_id).map(|d| d.genesis_hash.clone())
    }

    pub fn get_receipt(&self, desk_id: String, seq: u64) -> Option<Value> {
        self.receipts
            .get(&receipt_key(&desk_id, seq))
            .map(|r| r.to_value())
    }

    pub fn get_receipts(&self, desk_id: String, from_seq: u64, limit: u32) -> Vec<Value> {
        let desk = match self.desks.get(&desk_id) {
            Some(d) => d,
            None => return Vec::new(),
        };
        let limit = limit.min(100) as u64;
        let start = from_seq.max(1);
        let end = (start + limit).min(desk.head_seq + 1);
        (start..end)
            .filter_map(|seq| self.receipts.get(&receipt_key(&desk_id, seq)))
            .map(|r| r.to_value())
            .collect()
    }

    pub fn get_agents(&self, desk_id: String) -> Vec<AgentEntry> {
        self.desks
            .get(&desk_id)
            .map(|d| d.agents.clone())
            .unwrap_or_default()
    }

    pub fn get_open_positions(&self, desk_id: String) -> Vec<Position> {
        self.desks
            .get(&desk_id)
            .map(|d| d.open_positions.clone())
            .unwrap_or_default()
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn contract_owner(&self) -> AccountId {
        self.owner.clone()
    }

    // ------------------------------------------------------------ internals

    fn desk(&self, desk_id: &str) -> Desk {
        self.desks
            .get(desk_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str(E09_UNKNOWN_DESK))
    }

    fn policy_of(&self, desk: &Desk) -> Policy {
        let hash = desk
            .policy_hash
            .clone()
            .unwrap_or_else(|| env::panic_str(E06_NO_POLICY));
        let json_str = self
            .policies
            .get(&hash)
            .cloned()
            .unwrap_or_else(|| env::panic_str(E06_NO_POLICY));
        Policy::from_stored(json_str)
    }

    fn assert_not_paused(&self) {
        require(!self.paused, E07_PAUSED);
    }

    fn assert_contract_owner(&self) {
        require(env::predecessor_account_id() == self.owner, E01_NOT_OWNER);
    }

    fn assert_desk_owner(&self, desk: &Desk) {
        require(env::predecessor_account_id() == desk.owner, E01_NOT_OWNER);
    }

    /// Only a registered, non-retired TRADER or BASELINE may write trading receipts. The desk
    /// owner is deliberately not included: the Swarms track asks for one sub-account per
    /// agent, and letting the owner shortcut that would make the structure decorative.
    fn assert_trading_agent(&self, desk: &Desk) {
        let caller = env::predecessor_account_id();
        let role = desk.active_agent(&caller);
        require(role.is_some_and(|r| r.may_trade()), E02_NOT_AGENT);
    }

    /// Optimistic concurrency on the hash chain. The caller states the head it believes is
    /// current; a mismatch means either a concurrent write or a replay of a stale one, and in
    /// both cases nothing should be appended.
    fn assert_chain(&self, desk: &Desk, prev_hash: &str) {
        require(desk.head_hash == prev_hash, E03_CHAIN_BROKEN);
    }

    /// Resolve the referenced EVIDENCE receipt and decide what it permits.
    /// Returns (size multiplier bps, evidence receipt seq, reasons).
    fn check_evidence(
        &self,
        desk: &Desk,
        policy: &Policy,
        intent: &Intent,
        evidence_seq: Option<u64>,
        now: u64,
        mode: Mode,
    ) -> (u32, Option<u64>, Vec<String>) {
        let mut reasons = Vec::new();

        let seq = match evidence_seq {
            None => return (0, None, vec![R_NO_EVIDENCE.to_string()]),
            Some(s) => s,
        };
        // An unknown seq is a refusal like any other, so it is recorded rather than lost.
        let receipt = match self.receipts.get(&receipt_key(&desk.desk_id, seq)) {
            None => return (0, Some(seq), vec![R_NO_EVIDENCE.to_string()]),
            Some(r) => r,
        };
        if self.filled.get(&evidence_used_key(&desk.desk_id, seq)).is_some() {
            reasons.push(R_EVIDENCE_USED.to_string());
        }
        let summary = match (&receipt.kind, &receipt.evidence) {
            (ReceiptKind::EVIDENCE, Some(s)) => s,
            _ => return (0, Some(seq), vec![R_NO_EVIDENCE.to_string()]),
        };

        // The bundle must be about this trade.
        let direction_matches = intent.side.direction() == Some(summary.direction);
        if summary.asset != intent.asset || !direction_matches {
            reasons.push(R_EVIDENCE_MISMATCH.to_string());
        }

        // Fail closed on a tainted bundle. One forged item blocks the intent rather than
        // being silently discarded, because a bundle containing a forgery tells us the
        // pipeline feeding it is compromised.
        if summary.any_bad_sig {
            reasons.push(R_EVIDENCE_BAD_SIG.to_string());
        }

        // Freshness is re-checked at intent time, not just at bundle time. Otherwise an
        // agent could submit a bundle, wait a day, and spend it.
        let max_age_ns = policy.evidence_max_age_sec().saturating_mul(1_000_000_000);
        let stale_now = summary.items.iter().filter(|i| i.valid).any(|i| {
            let fetched: u64 = i.fetched_at.parse().unwrap_or(0);
            fetched == 0 || now.saturating_sub(fetched) > max_age_ns
        });
        if summary.any_stale || stale_now {
            reasons.push(R_EVIDENCE_STALE.to_string());
        }

        if let Some(min_k) = policy.min_k_for_nonzero() {
            if summary.k < min_k {
                reasons.push(R_UNCORROBORATED.to_string());
                // SPEC.md 4.5: in paper this situation is recorded as
                // PAPER_ONLY_UNCORROBORATED. Both markers are emitted so neither reading of
                // the spec loses information.
                if mode == Mode::Paper {
                    reasons.push(PAPER_ONLY_UNCORROBORATED.to_string());
                }
            }
        }

        (summary.size_multiplier_bps, Some(seq), reasons)
    }

    /// Build, seal, store and emit a receipt, advancing the desk head.
    ///
    /// Everything a caller is not trusted to assert is filled in here: seq, timestamp, block
    /// height, the acting account, the policy hash, the mode, and the chain links.
    fn append_receipt(
        &mut self,
        desk: &mut Desk,
        kind: ReceiptKind,
        parts: ReceiptParts,
    ) -> Receipt {
        let seq = desk.head_seq + 1;
        let mut receipt = Receipt {
            v: 1,
            desk_id: desk.desk_id.clone(),
            seq,
            kind,
            ts: env::block_timestamp().to_string(),
            block_height: env::block_height().to_string(),
            agent: env::predecessor_account_id(),
            policy_hash: desk.policy_hash.clone(),
            mode: desk.mode,
            intent: parts.intent,
            verdict: parts.verdict,
            reasons: parts.reasons,
            fill_ref: parts.fill_ref,
            intent_seq: parts.intent_seq,
            equity_usd: parts.equity_usd,
            drawdown_bps: parts.drawdown_bps,
            daily_pnl_usd: parts.daily_pnl_usd,
            decision_hash: parts.decision_hash,
            decisions_root: parts.decisions_root,
            ai_sig_hash: parts.ai_sig_hash,
            evidence_receipt_seq: parts.evidence_receipt_seq,
            size_multiplier_bps: parts.size_multiplier_bps,
            evidence: parts.evidence,
            control: parts.control,
            prev_hash: desk.head_hash.clone(),
            hash: String::new(),
        };
        receipt.seal();

        desk.head_seq = seq;
        desk.head_hash = receipt.hash.clone();
        self.receipts
            .insert(receipt_key(&desk.desk_id, seq), receipt.clone());

        events::emit(events::RECEIPT_APPENDED, receipt.to_value());
        receipt
    }
}

/// The fields of a receipt a caller or a check contributes. Everything else is computed.
struct ReceiptParts {
    intent: Option<Intent>,
    verdict: Verdict,
    reasons: Vec<String>,
    fill_ref: Option<FillRef>,
    intent_seq: Option<u64>,
    equity_usd: Option<String>,
    drawdown_bps: u32,
    daily_pnl_usd: String,
    decision_hash: Option<String>,
    decisions_root: Option<String>,
    ai_sig_hash: Option<String>,
    evidence_receipt_seq: Option<u64>,
    size_multiplier_bps: Option<u32>,
    evidence: Option<EvidenceSummary>,
    control: Option<ControlDetail>,
}

impl Default for ReceiptParts {
    fn default() -> Self {
        ReceiptParts {
            intent: None,
            // Only INTENT receipts carry a decision, so every other kind reports NA rather
            // than an implied approval.
            verdict: Verdict::NA,
            reasons: Vec::new(),
            fill_ref: None,
            intent_seq: None,
            equity_usd: None,
            drawdown_bps: 0,
            // "0" rather than an empty string: this field is hashed, and an empty money
            // string has no meaning.
            daily_pnl_usd: "0".to_string(),
            decision_hash: None,
            decisions_root: None,
            ai_sig_hash: None,
            evidence_receipt_seq: None,
            size_multiplier_bps: None,
            evidence: None,
            control: None,
        }
    }
}

fn receipt_key(desk_id: &str, seq: u64) -> String {
    // Desk ids match ^[a-z0-9][a-z0-9-]{1,47}$ so they never contain a colon, which keeps
    // this key unambiguous.
    format!("{desk_id}:{seq}")
}

/// "<deskId>:<seq>:ev" marks an EVIDENCE receipt spent. Three segments never collide with a
/// two-segment receipt key, so this shares the `filled` map without a state migration.
fn evidence_used_key(desk_id: &str, seq: u64) -> String {
    format!("{desk_id}:{seq}:ev")
}

/// Open notional on one asset and venue, across both directions.
fn open_notional(desk: &Desk, asset: &str, venue: &str) -> MicroUsd {
    desk.open_positions
        .iter()
        .filter(|p| p.asset == asset && p.venue == venue)
        .map(|p| parse_micro_usd(&p.notional_usd).unwrap_or(0))
        .sum()
}

fn parse_role(role: &str) -> Role {
    match role {
        "DATA" => Role::DATA,
        "ANALYST" => Role::ANALYST,
        "TRADER" => Role::TRADER,
        "MONITOR" => Role::MONITOR,
        "BASELINE" => Role::BASELINE,
        _ => env::panic_str(E05_POLICY_INVALID),
    }
}

/// Daily PnL against the first equity seen on the current UTC day, in the current mode.
/// A day with no basis yet reports zero rather than guessing.
fn daily_pnl_against(stats: &ModeStats, now: u64, equity: MicroUsd) -> MicroUsd {
    if stats.last_mark_ts == 0 || stats.day != day_bucket(now) {
        return 0;
    }
    match parse_micro_usd(&stats.day_start_equity_usd) {
        Some(base) => equity.saturating_sub(base),
        None => 0,
    }
}

/// Update the open position list from a fill. Opens add, closes remove, reduces subtract.
fn apply_fill_to_positions(
    desk: &mut Desk,
    intent: &Intent,
    filled_notional: MicroUsd,
    intent_seq: u64,
) {
    match intent.side {
        Side::OPEN_LONG | Side::OPEN_SHORT => {
            let direction = intent.side.direction().expect("open has a direction");
            desk.open_positions.push(Position {
                asset: intent.asset.clone(),
                venue: intent.venue.clone(),
                direction,
                notional_usd: micro_usd_to_string(filled_notional),
                opened_by_seq: intent_seq,
            });
        }
        Side::CLOSE => {
            desk.open_positions
                .retain(|p| !(p.asset == intent.asset && p.venue == intent.venue));
        }
        Side::REDUCE => {
            let mut remaining = filled_notional;
            desk.open_positions.retain_mut(|p| {
                if remaining <= 0 || p.asset != intent.asset || p.venue != intent.venue {
                    return true;
                }
                let size = parse_micro_usd(&p.notional_usd).unwrap_or(0);
                if size <= remaining {
                    remaining -= size;
                    false
                } else {
                    p.notional_usd = micro_usd_to_string(size - remaining);
                    remaining = 0;
                    true
                }
            });
        }
    }
}
