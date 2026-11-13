//! Shared types. JSON spellings here are normative: they are what gets hashed, so a rename
//! is a breaking change to every receipt ever written.
//!
//! SPEC.md 3.3 (intent), 3.4 (fill reference), 3.5 (receipt), 2A.2 (evidence).

use near_sdk::near;
use near_sdk::AccountId;
use serde_json::{json, Map, Value};

use crate::canonical::{canonical_hash, canonical_or_panic, sha256_hex};

/// Money is signed micro-USD carried as a decimal string, so no float ever touches a hash.
/// `"1250000"` is $1.25. SPEC.md 3.1.
pub type MicroUsd = i128;

/// Nanoseconds in a UTC day, for the day bucket in SPEC.md 3.1.
pub const NS_PER_DAY: u64 = 86_400_000_000_000;
/// A desk must have marked equity within this window before it may open. Backs R_NO_EQUITY_MARK.
pub const MARK_MAX_AGE_NS: u64 = 86_400_000_000_000;
/// At most one MARK per desk per 5 minutes. Backs E14_MARK_TOO_SOON.
pub const MARK_MIN_INTERVAL_NS: u64 = 300_000_000_000;

// ---------------------------------------------------------------- enums

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Paper,
    Live,
}

impl Mode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Mode::Paper => "paper",
            Mode::Live => "live",
        }
    }
    pub fn parse(s: &str) -> Option<Mode> {
        match s {
            "paper" => Some(Mode::Paper),
            "live" => Some(Mode::Live),
            _ => None,
        }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(non_camel_case_types)]
pub enum Role {
    DATA,
    ANALYST,
    TRADER,
    MONITOR,
    BASELINE,
}

impl Role {
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::DATA => "DATA",
            Role::ANALYST => "ANALYST",
            Role::TRADER => "TRADER",
            Role::MONITOR => "MONITOR",
            Role::BASELINE => "BASELINE",
        }
    }
    /// Roles allowed to append INTENT, FILL and EVIDENCE receipts. SPEC.md 4.1.
    pub fn may_trade(&self) -> bool {
        matches!(self, Role::TRADER | Role::BASELINE)
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(non_camel_case_types)]
pub enum Side {
    OPEN_LONG,
    OPEN_SHORT,
    REDUCE,
    CLOSE,
}

impl Side {
    pub fn as_str(&self) -> &'static str {
        match self {
            Side::OPEN_LONG => "OPEN_LONG",
            Side::OPEN_SHORT => "OPEN_SHORT",
            Side::REDUCE => "REDUCE",
            Side::CLOSE => "CLOSE",
        }
    }
    /// Only opens are gated. You can always exit. SPEC.md 3.3, mirroring Krexa's existing
    /// limits semantics where daily loss and position caps block buys, never sells.
    pub fn is_open(&self) -> bool {
        matches!(self, Side::OPEN_LONG | Side::OPEN_SHORT)
    }
    /// The direction an open expresses, for matching against evidence stance.
    pub fn direction(&self) -> Option<Direction> {
        match self {
            Side::OPEN_LONG => Some(Direction::LONG),
            Side::OPEN_SHORT => Some(Direction::SHORT),
            _ => None,
        }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(non_camel_case_types)]
pub enum Direction {
    LONG,
    SHORT,
}

impl Direction {
    pub fn as_str(&self) -> &'static str {
        match self {
            Direction::LONG => "LONG",
            Direction::SHORT => "SHORT",
        }
    }
}

/// Where an evidence item stands relative to the intent's direction. Assigned by the
/// off-chain deterministic verifier whose code hash is pinned in the policy, not by the
/// fetcher, so it is deliberately outside the signed payload. See docs/THREAT_MODEL.md:
/// the on-chain gate proves provenance, freshness and group counting; it cannot judge
/// semantics, and a dishonest operator can mislabel stance on their own desk.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(non_camel_case_types)]
pub enum Stance {
    SUPPORT,
    CONTRADICT,
    NEUTRAL,
}

impl Stance {
    pub fn as_str(&self) -> &'static str {
        match self {
            Stance::SUPPORT => "SUPPORT",
            Stance::CONTRADICT => "CONTRADICT",
            Stance::NEUTRAL => "NEUTRAL",
        }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(non_camel_case_types)]
pub enum EvidenceKind {
    NEWS,
    PRICE,
    MARKET,
    ONCHAIN,
}

impl EvidenceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            EvidenceKind::NEWS => "NEWS",
            EvidenceKind::PRICE => "PRICE",
            EvidenceKind::MARKET => "MARKET",
            EvidenceKind::ONCHAIN => "ONCHAIN",
        }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(non_camel_case_types)]
pub enum ReceiptKind {
    POLICY,
    CONTROL,
    EVIDENCE,
    INTENT,
    FILL,
    MARK,
}

impl ReceiptKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ReceiptKind::POLICY => "POLICY",
            ReceiptKind::CONTROL => "CONTROL",
            ReceiptKind::EVIDENCE => "EVIDENCE",
            ReceiptKind::INTENT => "INTENT",
            ReceiptKind::FILL => "FILL",
            ReceiptKind::MARK => "MARK",
        }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(non_camel_case_types)]
pub enum Verdict {
    APPROVED,
    REJECTED,
    NA,
}

impl Verdict {
    pub fn as_str(&self) -> &'static str {
        match self {
            Verdict::APPROVED => "APPROVED",
            Verdict::REJECTED => "REJECTED",
            Verdict::NA => "NA",
        }
    }
}

/// SPEC.md 3.4. `simulated` and the allowed mode are enforced by the contract; whether the
/// referenced settlement is real is checked off chain by the fill verifier.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(non_camel_case_types)]
pub enum FillKind {
    SIMULATED,
    ONECLICK_DRY_QUOTE,
    ONECLICK_SETTLED,
    HYPERLIQUID_FILL,
    POLYMARKET_TX,
}

impl FillKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            FillKind::SIMULATED => "SIMULATED",
            FillKind::ONECLICK_DRY_QUOTE => "ONECLICK_DRY_QUOTE",
            FillKind::ONECLICK_SETTLED => "ONECLICK_SETTLED",
            FillKind::HYPERLIQUID_FILL => "HYPERLIQUID_FILL",
            FillKind::POLYMARKET_TX => "POLYMARKET_TX",
        }
    }
    /// True for kinds that must carry `simulated: true` and may only appear on a paper desk.
    pub fn must_be_simulated(&self) -> bool {
        matches!(self, FillKind::SIMULATED | FillKind::ONECLICK_DRY_QUOTE)
    }
}

// ---------------------------------------------------------------- intent

/// SPEC.md 3.3.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct QuoteRef {
    pub kind: String,
    pub sha256: String,
    pub signature: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Intent {
    #[serde(rename = "clientId")]
    pub client_id: String,
    pub venue: String,
    pub asset: String,
    pub side: Side,
    #[serde(rename = "notionalUsd")]
    pub notional_usd: String,
    #[serde(rename = "maxSlippageBps")]
    pub max_slippage_bps: u32,
    #[serde(rename = "quoteRef", default)]
    pub quote_ref: Option<QuoteRef>,
}

impl Intent {
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("clientId".into(), json!(self.client_id));
        m.insert("venue".into(), json!(self.venue));
        m.insert("asset".into(), json!(self.asset));
        m.insert("side".into(), json!(self.side.as_str()));
        m.insert("notionalUsd".into(), json!(self.notional_usd));
        m.insert("maxSlippageBps".into(), json!(self.max_slippage_bps));
        m.insert(
            "quoteRef".into(),
            match &self.quote_ref {
                None => Value::Null,
                Some(q) => json!({
                    "kind": q.kind,
                    "sha256": q.sha256,
                    "signature": q.signature,
                }),
            },
        );
        Value::Object(m)
    }
}

// ---------------------------------------------------------------- fill

/// SPEC.md 3.4.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct FillRef {
    pub kind: FillKind,
    pub simulated: bool,
    #[serde(rename = "ref")]
    pub reference: String,
    pub price: String,
    #[serde(rename = "notionalUsd")]
    pub notional_usd: String,
    #[serde(rename = "evidenceSha256", default)]
    pub evidence_sha256: Option<String>,
}

impl FillRef {
    pub fn to_value(&self) -> Value {
        json!({
            "kind": self.kind.as_str(),
            "simulated": self.simulated,
            "ref": self.reference,
            "price": self.price,
            "notionalUsd": self.notional_usd,
            "evidenceSha256": match &self.evidence_sha256 {
                Some(h) => json!(h),
                None => Value::Null,
            },
        })
    }
}

// ---------------------------------------------------------------- evidence

/// The exact object a fetcher signs. `evidenceId` is `contentHash`, so an item is addressed
/// by what it said, not by who reported it. SPEC.md 2A.2 item 1.
///
/// The signed message is `canonical(this)` as UTF-8 bytes. `stance` is deliberately not in
/// here: see [`Stance`].
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct EvidencePayload {
    #[serde(rename = "contentHash")]
    pub content_hash: String,
    #[serde(rename = "fetchedAt")]
    pub fetched_at: String,
    pub kind: EvidenceKind,
    pub source: String,
    #[serde(rename = "sourceGroup")]
    pub source_group: String,
    pub url: String,
}

impl EvidencePayload {
    pub fn to_value(&self) -> Value {
        json!({
            "contentHash": self.content_hash,
            "fetchedAt": self.fetched_at,
            "kind": self.kind.as_str(),
            "source": self.source,
            "sourceGroup": self.source_group,
            "url": self.url,
        })
    }
    /// The bytes a fetcher signs.
    pub fn signing_bytes(&self) -> Vec<u8> {
        canonical_or_panic(&self.to_value()).into_bytes()
    }
}

/// One item as submitted: the signed payload, who signed it, the signature, and the
/// verifier's stance call.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct EvidenceItemInput {
    pub item: EvidencePayload,
    /// `ed25519:<base58 of 32 bytes>`, as registered by `register_fetcher`.
    #[serde(rename = "fetcherKey")]
    pub fetcher_key: String,
    /// base58 of the 64 byte ed25519 signature over `item.signing_bytes()`.
    pub signature: String,
    pub stance: Stance,
}

/// What the Trader submits to `submit_evidence`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct EvidenceBundleInput {
    pub asset: String,
    pub direction: Direction,
    /// Must equal `policy.evidence.verifierCodeHash`, which binds the bundle to the exact
    /// verifier build that produced it.
    #[serde(rename = "verifierCodeHash")]
    pub verifier_code_hash: String,
    pub items: Vec<EvidenceItemInput>,
}

/// What the EVIDENCE receipt records. SPEC.md 2A.2 item 7.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct EvidenceSummaryItem {
    #[serde(rename = "evidenceId")]
    pub evidence_id: String,
    #[serde(rename = "sourceGroup")]
    pub source_group: String,
    pub stance: Stance,
    #[serde(rename = "fetchedAt")]
    pub fetched_at: String,
    #[serde(rename = "fetcherKey")]
    pub fetcher_key: String,
    /// False when the signature did not verify or the item was already stale at submission.
    /// Invalid items are kept in the receipt rather than dropped, so a reader can see what
    /// was offered as well as what counted.
    pub valid: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct EvidenceSummary {
    #[serde(rename = "bundleHash")]
    pub bundle_hash: String,
    pub asset: String,
    pub direction: Direction,
    pub items: Vec<EvidenceSummaryItem>,
    /// Agreeing independent groups, net of contradicting groups, floored at zero.
    pub k: u32,
    #[serde(rename = "sizeMultiplierBps")]
    pub size_multiplier_bps: u32,
    #[serde(rename = "verifierCodeHash")]
    pub verifier_code_hash: String,
    /// True when at least one offered item failed signature verification. The gate fails
    /// closed on this, so a bundle carrying one forged item blocks the whole intent.
    #[serde(rename = "anyBadSig")]
    pub any_bad_sig: bool,
    /// True when at least one offered item was already past `maxAgeSec`.
    #[serde(rename = "anyStale")]
    pub any_stale: bool,
    /// True when every fetcher key used was registered with an attestation hash. False means
    /// every receipt downstream of this bundle is labelled unattested.
    pub attested: bool,
}

impl EvidenceSummary {
    pub fn to_value(&self) -> Value {
        let items: Vec<Value> = self
            .items
            .iter()
            .map(|i| {
                json!({
                    "evidenceId": i.evidence_id,
                    "sourceGroup": i.source_group,
                    "stance": i.stance.as_str(),
                    "fetchedAt": i.fetched_at,
                    "fetcherKey": i.fetcher_key,
                    "valid": i.valid,
                })
            })
            .collect();
        json!({
            "bundleHash": self.bundle_hash,
            "asset": self.asset,
            "direction": self.direction.as_str(),
            "items": items,
            "k": self.k,
            "sizeMultiplierBps": self.size_multiplier_bps,
            "verifierCodeHash": self.verifier_code_hash,
            "anyBadSig": self.any_bad_sig,
            "anyStale": self.any_stale,
            "attested": self.attested,
        })
    }
}

// ---------------------------------------------------------------- desk state

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Fetcher {
    /// `ed25519:<base58>`
    pub pubkey: String,
    /// SHA-256 of the attestation report the owner checked off chain before registering.
    /// All zeroes (64 zeros) means the owner declared this fetcher unattested, which makes
    /// every receipt downstream of it carry `attested: false`.
    #[serde(rename = "attestationHash")]
    pub attestation_hash: String,
    pub label: String,
    pub revoked: bool,
}

impl Fetcher {
    pub fn is_attested(&self) -> bool {
        self.attestation_hash != "0".repeat(64)
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Position {
    pub asset: String,
    pub venue: String,
    pub direction: Direction,
    #[serde(rename = "notionalUsd")]
    pub notional_usd: String,
    #[serde(rename = "openedBySeq")]
    pub opened_by_seq: u64,
}

/// Equity bookkeeping, kept separately per mode so paper and live are never blended.
/// SPEC.md 3.5 and 5.1.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct ModeStats {
    /// Last marked equity, micro-USD decimal string. Empty means never marked.
    #[serde(rename = "lastEquityUsd")]
    pub last_equity_usd: String,
    /// High-water mark of equity for the drawdown calculation.
    #[serde(rename = "highWaterUsd")]
    pub high_water_usd: String,
    /// First equity seen on `day`, the basis for daily PnL.
    #[serde(rename = "dayStartEquityUsd")]
    pub day_start_equity_usd: String,
    /// UTC day bucket, `floor(ts_ns / 86_400e9)`.
    pub day: u64,
    /// Block timestamp of the last MARK, nanoseconds. Zero means never marked.
    #[serde(rename = "lastMarkTs")]
    pub last_mark_ts: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Desk {
    #[serde(rename = "deskId")]
    pub desk_id: String,
    pub owner: AccountId,
    pub mode: Mode,
    #[serde(rename = "policyHash")]
    pub policy_hash: Option<String>,
    #[serde(rename = "headSeq")]
    pub head_seq: u64,
    #[serde(rename = "headHash")]
    pub head_hash: String,
    #[serde(rename = "genesisHash")]
    pub genesis_hash: String,
    #[serde(rename = "killSwitch")]
    pub kill_switch: bool,
    #[serde(rename = "killReason")]
    pub kill_reason: String,
    pub agents: Vec<AgentEntry>,
    pub fetchers: Vec<Fetcher>,
    #[serde(rename = "openPositions")]
    pub open_positions: Vec<Position>,
    pub paper: ModeStats,
    pub live: ModeStats,
    pub retired: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct AgentEntry {
    pub account: AccountId,
    pub role: Role,
    pub retired: bool,
}

impl Desk {
    pub fn stats(&self, mode: Mode) -> &ModeStats {
        match mode {
            Mode::Paper => &self.paper,
            Mode::Live => &self.live,
        }
    }
    pub fn stats_mut(&mut self, mode: Mode) -> &mut ModeStats {
        match mode {
            Mode::Paper => &mut self.paper,
            Mode::Live => &mut self.live,
        }
    }
    pub fn active_agent(&self, account: &AccountId) -> Option<Role> {
        self.agents
            .iter()
            .find(|a| &a.account == account && !a.retired)
            .map(|a| a.role)
    }
    pub fn fetcher(&self, pubkey: &str) -> Option<&Fetcher> {
        self.fetchers.iter().find(|f| f.pubkey == pubkey)
    }
}

// ---------------------------------------------------------------- receipt

/// SPEC.md 3.5.
///
/// Two fields go beyond the INTENT example printed in 3.5: `evidence` and `control`. The
/// example is of one receipt kind, and 2A.2 item 7 requires the EVIDENCE receipt to carry the
/// bundle summary, while a CONTROL receipt is meaningless without saying what was controlled.
/// Both are `null` on kinds that do not use them, so the canonical key set is identical for
/// every receipt. docs/RECEIPTS.md records this.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Receipt {
    pub v: u32,
    #[serde(rename = "deskId")]
    pub desk_id: String,
    pub seq: u64,
    pub kind: ReceiptKind,
    /// Block timestamp in nanoseconds, decimal string.
    pub ts: String,
    #[serde(rename = "blockHeight")]
    pub block_height: String,
    pub agent: AccountId,
    #[serde(rename = "policyHash")]
    pub policy_hash: Option<String>,
    pub mode: Mode,
    pub intent: Option<Intent>,
    pub verdict: Verdict,
    pub reasons: Vec<String>,
    #[serde(rename = "fillRef")]
    pub fill_ref: Option<FillRef>,
    #[serde(rename = "intentSeq")]
    pub intent_seq: Option<u64>,
    #[serde(rename = "equityUsd")]
    pub equity_usd: Option<String>,
    #[serde(rename = "drawdownBps")]
    pub drawdown_bps: u32,
    #[serde(rename = "dailyPnlUsd")]
    pub daily_pnl_usd: String,
    #[serde(rename = "decisionHash")]
    pub decision_hash: Option<String>,
    #[serde(rename = "decisionsRoot")]
    pub decisions_root: Option<String>,
    #[serde(rename = "aiSigHash")]
    pub ai_sig_hash: Option<String>,
    #[serde(rename = "evidenceReceiptSeq")]
    pub evidence_receipt_seq: Option<u64>,
    #[serde(rename = "sizeMultiplierBps")]
    pub size_multiplier_bps: Option<u32>,
    pub evidence: Option<EvidenceSummary>,
    pub control: Option<ControlDetail>,
    #[serde(rename = "prevHash")]
    pub prev_hash: String,
    pub hash: String,
}

/// What a CONTROL receipt controlled.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct ControlDetail {
    /// One of: mode_changed, agent_registered, agent_retired, fetcher_registered,
    /// fetcher_revoked, kill_switch_engaged, kill_switch_released, flow.
    pub action: String,
    pub detail: String,
}

impl ControlDetail {
    pub fn new(action: &str, detail: impl Into<String>) -> Self {
        ControlDetail {
            action: action.to_string(),
            detail: detail.into(),
        }
    }
    pub fn to_value(&self) -> Value {
        json!({"action": self.action, "detail": self.detail})
    }
}

fn opt_str(v: &Option<String>) -> Value {
    match v {
        Some(s) => json!(s),
        None => Value::Null,
    }
}

fn opt_u64(v: &Option<u64>) -> Value {
    match v {
        Some(n) => json!(n),
        None => Value::Null,
    }
}

impl Receipt {
    /// The canonical value that gets hashed: every documented key, always present, with
    /// `hash` excluded. `receipt.hash = sha256(canonical(receipt without "hash"))`,
    /// SPEC.md 3.1.
    pub fn to_canonical_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("v".into(), json!(self.v));
        m.insert("deskId".into(), json!(self.desk_id));
        m.insert("seq".into(), json!(self.seq));
        m.insert("kind".into(), json!(self.kind.as_str()));
        m.insert("ts".into(), json!(self.ts));
        m.insert("blockHeight".into(), json!(self.block_height));
        m.insert("agent".into(), json!(self.agent.as_str()));
        m.insert("policyHash".into(), opt_str(&self.policy_hash));
        m.insert("mode".into(), json!(self.mode.as_str()));
        m.insert(
            "intent".into(),
            match &self.intent {
                Some(i) => i.to_value(),
                None => Value::Null,
            },
        );
        m.insert("verdict".into(), json!(self.verdict.as_str()));
        m.insert("reasons".into(), json!(self.reasons));
        m.insert(
            "fillRef".into(),
            match &self.fill_ref {
                Some(f) => f.to_value(),
                None => Value::Null,
            },
        );
        m.insert("intentSeq".into(), opt_u64(&self.intent_seq));
        m.insert("equityUsd".into(), opt_str(&self.equity_usd));
        m.insert("drawdownBps".into(), json!(self.drawdown_bps));
        m.insert("dailyPnlUsd".into(), json!(self.daily_pnl_usd));
        m.insert("decisionHash".into(), opt_str(&self.decision_hash));
        m.insert("decisionsRoot".into(), opt_str(&self.decisions_root));
        m.insert("aiSigHash".into(), opt_str(&self.ai_sig_hash));
        m.insert(
            "evidenceReceiptSeq".into(),
            opt_u64(&self.evidence_receipt_seq),
        );
        m.insert(
            "sizeMultiplierBps".into(),
            match self.size_multiplier_bps {
                Some(n) => json!(n),
                None => Value::Null,
            },
        );
        m.insert(
            "evidence".into(),
            match &self.evidence {
                Some(e) => e.to_value(),
                None => Value::Null,
            },
        );
        m.insert(
            "control".into(),
            match &self.control {
                Some(c) => c.to_value(),
                None => Value::Null,
            },
        );
        m.insert("prevHash".into(), json!(self.prev_hash));
        Value::Object(m)
    }

    /// Compute and store `hash` from the rest of the receipt.
    pub fn seal(&mut self) {
        self.hash = canonical_hash(&self.to_canonical_value());
    }

    /// Full receipt as JSON including `hash`, for views and events.
    pub fn to_value(&self) -> Value {
        let mut v = self.to_canonical_value();
        if let Value::Object(ref mut m) = v {
            m.insert("hash".into(), json!(self.hash));
        }
        v
    }
}

// ---------------------------------------------------------------- money helpers

/// Parse signed micro-USD from a decimal string. Rejects anything that is not an optional
/// minus sign followed by 1 to 30 digits, so no float, no exponent, no whitespace.
pub fn parse_micro_usd(s: &str) -> Option<MicroUsd> {
    let (neg, digits) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s),
    };
    if digits.is_empty() || digits.len() > 30 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // Reject leading zeros so a value has exactly one spelling, which matters because the
    // string itself is what gets hashed.
    if digits.len() > 1 && digits.starts_with('0') {
        return None;
    }
    let v: i128 = digits.parse().ok()?;
    // "-0" is a second spelling of zero, and the string is what gets hashed.
    if neg && v == 0 {
        return None;
    }
    Some(if neg { -v } else { v })
}

/// Parse unsigned micro-USD, for policy limits which are `^[0-9]{1,15}$`.
pub fn parse_micro_usd_unsigned(s: &str) -> Option<MicroUsd> {
    let v = parse_micro_usd(s)?;
    if v < 0 {
        None
    } else {
        Some(v)
    }
}

pub fn micro_usd_to_string(v: MicroUsd) -> String {
    v.to_string()
}

/// Panic helper that keeps call sites short.
pub fn require(cond: bool, code: &'static str) {
    if !cond {
        near_sdk::env::panic_str(code);
    }
}

/// Decode an `ed25519:<base58>` public key to 32 bytes.
pub fn decode_ed25519_pubkey(s: &str) -> Option<[u8; 32]> {
    let b58 = s.strip_prefix("ed25519:")?;
    let bytes = bs58::decode(b58).into_vec().ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Some(out)
}

/// Decode a base58 ed25519 signature to 64 bytes.
pub fn decode_ed25519_signature(s: &str) -> Option<[u8; 64]> {
    let bytes = bs58::decode(s).into_vec().ok()?;
    if bytes.len() != 64 {
        return None;
    }
    let mut out = [0u8; 64];
    out.copy_from_slice(&bytes);
    Some(out)
}

/// Genesis head for a desk: `sha256("krexa-ual/v1:" + contractId + ":" + deskId)`.
/// SPEC.md 3.1.
pub fn genesis_hash_for(contract_id: &str, desk_id: &str) -> String {
    sha256_hex(format!("krexa-ual/v1:{contract_id}:{desk_id}").as_bytes())
}

pub fn day_bucket(ts_ns: u64) -> u64 {
    ts_ns / NS_PER_DAY
}

/// Drawdown in basis points against the high-water mark. Zero when there is no positive
/// high-water mark yet, or when equity is at or above it.
pub fn drawdown_bps(high_water: MicroUsd, equity: MicroUsd) -> u32 {
    if high_water <= 0 || equity >= high_water {
        return 0;
    }
    let dd = high_water - equity;
    let bps = dd.saturating_mul(10_000) / high_water;
    bps.clamp(0, 10_000) as u32
}
