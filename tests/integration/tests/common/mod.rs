//! Shared sandbox setup.
//!
//! These tests run against a real near-sandbox node, so the access-key restrictions they
//! assert are enforced by the NEAR protocol itself rather than by contract code. That is the
//! whole point: a unit test can only prove the contract refuses something, while a sandbox
//! test can prove the protocol refuses it before the contract is ever entered.
//!
//! Each test binary uses a different slice of this module, so unused-item warnings here are
//! noise rather than signal.
#![allow(dead_code)]

use anyhow::{Context, Result};
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::network::Sandbox;
use near_workspaces::types::{AccessKey, AccessKeyPermission, FunctionCallPermission, SecretKey};
use near_workspaces::{Account, Contract, Worker};
use serde_json::json;

/// Methods a TRADER or BASELINE function-call key may call, and nothing else.
/// SPEC.md 4.1, final paragraph.
pub const AGENT_METHODS: [&str; 4] = [
    "submit_evidence",
    "submit_intent",
    "record_fill",
    "record_mark",
];

/// Methods a MONITOR key may call.
///
/// SPEC.md 4.1's method list is written for the Trader, but SPEC.md 2A.2 item 5 requires the
/// Monitor to call `engage_kill_switch` directly, without an LLM in the path. A Monitor
/// holding only `AGENT_METHODS` could not do its one job, which the first version of this
/// harness demonstrated by failing.
///
/// `release_kill_switch` is deliberately absent. The asymmetry is the whole reason it is safe
/// to let a rule-based agent hold the brake: it can stop the desk, and only a human can start
/// it again. RULES.md section 5.
pub const MONITOR_METHODS: [&str; 2] = ["engage_kill_switch", "record_mark"];

/// Methods a DATA key may call. It observes and marks equity; it never decides anything.
pub const DATA_METHODS: [&str; 1] = ["record_mark"];

/// The least-privilege method list for a role. An ANALYST gets nothing: it emits a signal and
/// a DecisionRecord off chain and never touches the ledger, per RULES.md section 1.
pub fn methods_for_role(role: &str) -> Vec<String> {
    let methods: &[&str] = match role {
        "TRADER" | "BASELINE" => &AGENT_METHODS,
        "MONITOR" => &MONITOR_METHODS,
        "DATA" => &DATA_METHODS,
        "ANALYST" => &[],
        other => panic!("unknown role {other}"),
    };
    methods.iter().map(|m| m.to_string()).collect()
}

/// Gas allowance on an agent key. Finite on purpose: SPEC.md 15 lists an exhausted allowance
/// as a real failure mode, and docs/FAILURE_CASES.md describes it.
///
/// Sized from measurement, not guesswork. At `AGENT_GAS` an agent call costs on the order of
/// 0.003 NEAR, so 5 NEAR buys roughly 1,500 writes: comfortable for a desk ticking every 15
/// minutes for the eight days of this study, and still finite.
///
/// The first version of this was 0.5 NEAR combined with `max_gas()`, and the sandbox refused
/// the very first call with NotEnoughAllowance: 300 TGas reserves about 1 NEAR up front
/// whether or not the call uses it. That is the lockout SPEC.md 15 predicts, and
/// `allowance_exhaustion_locks_the_agent_out` now reproduces it deliberately.
pub const AGENT_KEY_ALLOWANCE: near_workspaces::types::NearToken =
    near_workspaces::types::NearToken::from_near(5);

/// Gas budget for one agent write.
///
/// Deliberately not `max_gas()`. A function-call key reserves the full attached gas against
/// its allowance before execution, so attaching 300 TGas to a call that needs 10 burns the
/// allowance about a hundred times faster than necessary.
pub const AGENT_GAS: near_workspaces::types::Gas = near_workspaces::types::Gas::from_tgas(30);

pub const DESK: &str = "ebi-desk";

/// Block timestamps in the sandbox are real wall-clock, so evidence freshness is computed
/// against "now" rather than a fixture constant.
pub fn now_ns() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos() as u64
}

pub fn wasm_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        // cargo-near writes under the workspace root, which is the repo root.
        .join("../../target/near/ual/ual.wasm")
}

pub fn load_wasm() -> Result<Vec<u8>> {
    let path = wasm_path();
    std::fs::read(&path).with_context(|| {
        format!(
            "contract wasm not found at {}.\nBuild it first:\n  \
             cargo near build non-reproducible-wasm --manifest-path contracts/ual/Cargo.toml\n\
             or just run: pnpm test",
            path.display()
        )
    })
}

pub struct Harness {
    pub worker: Worker<Sandbox>,
    pub contract: Contract,
    /// Desk owner. Holds a full-access key, as a human operator would.
    pub owner: Account,
    /// Trader sub-account restricted to a function-call key.
    pub trader_fc: Account,
    /// The same trader account seen through its full-access key, for comparison.
    pub trader_full: Account,
    pub monitor_fc: Account,
    pub fetcher_signing_key: SigningKey,
}

impl Harness {
    pub fn fetcher_pubkey(&self) -> String {
        format!(
            "ed25519:{}",
            bs58::encode(self.fetcher_signing_key.verifying_key().to_bytes()).into_string()
        )
    }

    /// Current chain head for the desk, which every write has to quote.
    pub async fn head(&self) -> Result<String> {
        let head: serde_json::Value = self
            .contract
            .view("get_head")
            .args_json(json!({"desk_id": DESK}))
            .await?
            .json()?;
        Ok(head["hash"].as_str().context("head hash")?.to_string())
    }

    pub async fn head_seq(&self) -> Result<u64> {
        let head: serde_json::Value = self
            .contract
            .view("get_head")
            .args_json(json!({"desk_id": DESK}))
            .await?
            .json()?;
        head["seq"].as_u64().context("head seq")
    }

    pub async fn receipts(&self) -> Result<Vec<serde_json::Value>> {
        Ok(self
            .contract
            .view("get_receipts")
            .args_json(json!({"desk_id": DESK, "from_seq": 1, "limit": 100}))
            .await?
            .json()?)
    }

    /// Sign an evidence item the way `apps/fetcher` does: ed25519 over canonical(item).
    pub fn signed_item(
        &self,
        source: &str,
        kind: &str,
        fetched_at_ns: u64,
        stance: &str,
        content_seed: u8,
    ) -> serde_json::Value {
        let content_hash = hex::encode([content_seed; 32]);
        // Canonical form: keys in byte order, no whitespace. SPEC.md 3.1. Written out by hand
        // here rather than via a serializer, so the test would catch the contract changing
        // what it signs over.
        let signing_string = format!(
            concat!(
                "{{",
                r#""contentHash":"{}","#,
                r#""fetchedAt":"{}","#,
                r#""kind":"{}","#,
                r#""source":"{}","#,
                r#""sourceGroup":"{}","#,
                r#""url":"https://{}/a""#,
                "}}"
            ),
            content_hash, fetched_at_ns, kind, source, group_of(source), source
        );
        let sig = self.fetcher_signing_key.sign(signing_string.as_bytes());
        json!({
            "item": {
                "contentHash": content_hash,
                "fetchedAt": fetched_at_ns.to_string(),
                "kind": kind,
                "source": source,
                "sourceGroup": group_of(source),
                "url": format!("https://{source}/a"),
            },
            "fetcherKey": self.fetcher_pubkey(),
            "signature": bs58::encode(sig.to_bytes()).into_string(),
            "stance": stance,
        })
    }
}

/// The independence group each source belongs to in the test policy.
pub fn group_of(source: &str) -> &'static str {
    match source {
        "hyperliquid" => "exchange-hl",
        "newswire-a.example" => "newswire-a",
        "newswire-b.example" => "newswire-b",
        _ => "unknown-group",
    }
}

/// Canonical test policy. Keys are in byte order because `commit_policy` compares bytes.
/// Note that "description" precedes "deskId": both start "des", then 'c' beats 'k'.
pub fn policy_json(evidence_required: bool) -> String {
    let verifier_hash = "a".repeat(64);
    format!(
        concat!(
            "{{",
            r#""allowedAssets":["BTC","ETH"],"#,
            r#""allowedModes":["paper"],"#,
            r#""allowedVenues":["hyperliquid","paper"],"#,
            r#""dailyLossLimitUsd":"200000000","#,
            r#""description":"sandbox integration test desk","#,
            r#""deskId":"{}","#,
            r#""evidence":{{"#,
            r#""groups":[{{"group":"exchange-hl","sources":["hyperliquid"]}},"#,
            r#"{{"group":"newswire-a","sources":["newswire-a.example"]}},"#,
            r#"{{"group":"newswire-b","sources":["newswire-b.example"]}}],"#,
            r#""maxAgeSec":900,"#,
            r#""required":{},"#,
            r#""sizeTableBps":[0,0,5000,10000],"#,
            r#""verifierCodeHash":"{}""#,
            r#"}},"#,
            r#""killSwitch":{{"autoOnDailyLoss":true,"monitorMayEngage":true}},"#,
            r#""maxOpenPositions":3,"#,
            r#""maxPositionUsd":"1000000000","#,
            r#""schema":"krexa.ual.policy/1","#,
            r#""slippageCapBps":30"#,
            "}}"
        ),
        DESK, evidence_required, verifier_hash
    )
}

/// Deploy, create a desk, commit a policy, and create one sub-account per agent, each
/// holding only a function-call key scoped to this contract and to `AGENT_METHODS`.
pub async fn setup(evidence_required: bool) -> Result<Harness> {
    let worker = near_workspaces::sandbox().await?;
    let wasm = load_wasm()?;
    let contract = worker.dev_deploy(&wasm).await?;

    let owner = worker.dev_create_account().await?;

    contract
        .call("new")
        .args_json(json!({"owner": owner.id()}))
        .transact()
        .await?
        .into_result()?;

    owner
        .call(contract.id(), "create_desk")
        .args_json(json!({"desk_id": DESK}))
        .deposit(near_workspaces::types::NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;

    owner
        .call(contract.id(), "commit_policy")
        .args_json(json!({"desk_id": DESK, "policy_json": policy_json(evidence_required)}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let (trader_full, trader_fc) =
        agent_with_function_call_key(&worker, &owner, contract.id(), "trader", "TRADER").await?;
    let (_, monitor_fc) =
        agent_with_function_call_key(&worker, &owner, contract.id(), "monitor", "MONITOR").await?;

    owner
        .call(contract.id(), "register_agent")
        .args_json(json!({"desk_id": DESK, "agent": trader_fc.id(), "role": "TRADER"}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    owner
        .call(contract.id(), "register_agent")
        .args_json(json!({"desk_id": DESK, "agent": monitor_fc.id(), "role": "MONITOR"}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let fetcher_signing_key = SigningKey::from_bytes(&[7u8; 32]);
    let pubkey = format!(
        "ed25519:{}",
        bs58::encode(fetcher_signing_key.verifying_key().to_bytes()).into_string()
    );
    owner
        .call(contract.id(), "register_fetcher")
        .args_json(json!({
            "desk_id": DESK,
            "pubkey": pubkey,
            // Not a real attestation. The local fetcher build is honest about being
            // unattested, which is what the 64 zeros mean; here we register a non-zero hash
            // so the receipts say attested and the gate logic is exercised end to end.
            "attestation_hash": "b".repeat(64),
            "label": "sandbox-fetcher",
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    Ok(Harness {
        worker,
        contract,
        owner,
        trader_fc,
        trader_full,
        monitor_fc,
        fetcher_signing_key,
    })
}

/// Create `<name>.<owner>` and give it a function-call access key restricted to
/// `contract_id` and `AGENT_METHODS`, with a finite gas allowance.
///
/// Returns (account seen through its full-access key, same account seen through the
/// function-call key). The pair is what lets a test show that the restriction, not the
/// account, is what refuses a transfer.
pub async fn agent_with_function_call_key(
    worker: &Worker<Sandbox>,
    owner: &Account,
    contract_id: &near_workspaces::AccountId,
    name: &str,
    role: &str,
) -> Result<(Account, Account)> {
    agent_with_allowance(worker, owner, contract_id, name, AGENT_KEY_ALLOWANCE, role).await
}

/// Same, with an explicit allowance, so a test can choose one small enough to exhaust.
pub async fn agent_with_allowance(
    worker: &Worker<Sandbox>,
    owner: &Account,
    contract_id: &near_workspaces::AccountId,
    name: &str,
    allowance: near_workspaces::types::NearToken,
    role: &str,
) -> Result<(Account, Account)> {
    let full = owner
        .create_subaccount(name)
        // Comfortably above the key allowance: this test is about the allowance refusing a
        // call, not about the account being unable to pay for one.
        .initial_balance(near_workspaces::types::NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;

    let fc_secret = SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
    let access_key = AccessKey {
        nonce: 0,
        permission: AccessKeyPermission::FunctionCall(FunctionCallPermission {
            allowance: Some(allowance),
            receiver_id: contract_id.to_string(),
            method_names: methods_for_role(role),
        }),
    };

    full.batch(full.id())
        .add_key(fc_secret.public_key(), access_key)
        .transact()
        .await?
        .into_result()?;

    let fc = Account::from_secret_key(full.id().clone(), fc_secret, worker);
    Ok((full, fc))
}
