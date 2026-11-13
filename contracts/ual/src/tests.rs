//! Unit tests. Every case the M1 acceptance list names, plus the canonical form and hash
//! vectors that `packages/sdk` has to reproduce byte for byte.
//!
//! These run against near-sdk's mocked VM, so `env::sha256` and `env::ed25519_verify` are the
//! real implementations the contract will use on chain, not stand-ins.

use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken};
use serde_json::{json, Value};

use crate::canonical::{canonical, sha256_hex};
use crate::types::*;
use crate::Ual;

// ---------------------------------------------------------------- harness

const CONTRACT: &str = "ual.testnet";
const DESK: &str = "yk-desk";
/// 2026-11-06T10:15:00Z in nanoseconds, so day buckets and freshness windows are realistic.
const T0: u64 = 1_762_423_200_000_000_000;

fn owner() -> AccountId {
    accounts(0) // alice
}
fn trader() -> AccountId {
    accounts(1) // bob
}
fn monitor() -> AccountId {
    accounts(2) // charlie
}
fn stranger() -> AccountId {
    accounts(3) // danny
}

fn ctx(predecessor: AccountId, ts: u64, deposit: NearToken) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id(predecessor)
        .block_timestamp(ts)
        .block_height(100)
        .attached_deposit(deposit);
    b
}

fn set_ctx(predecessor: AccountId, ts: u64) {
    testing_env!(ctx(predecessor, ts, NearToken::from_near(0)).build());
}

/// A fixed signing key so the signature vectors are stable across runs.
fn fetcher_key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn fetcher_pubkey_str() -> String {
    format!(
        "ed25519:{}",
        bs58::encode(fetcher_key().verifying_key().to_bytes()).into_string()
    )
}

/// Canonical policy JSON. Keys are already in byte order, which is what `commit_policy`
/// demands, so this doubles as the canonical-form fixture.
fn policy_json(evidence_required: bool, max_position: &str, daily_loss: &str) -> String {
    let verifier_hash = "a".repeat(64);
    let evidence = format!(
        concat!(
            r#""evidence":{{"#,
            r#""groups":[{{"group":"exchange-hl","sources":["hyperliquid"]}},"#,
            r#"{{"group":"newswire-a","sources":["newswire-a.example"]}},"#,
            r#"{{"group":"newswire-b","sources":["newswire-b.example"]}}],"#,
            r#""maxAgeSec":900,"#,
            r#""required":{},"#,
            r#""sizeTableBps":[0,0,5000,10000],"#,
            r#""verifierCodeHash":"{}""#,
            r#"}},"#
        ),
        evidence_required, verifier_hash
    );
    format!(
        concat!(
            "{{",
            r#""allowedAssets":["BTC","ETH"],"#,
            r#""allowedModes":["live","paper"],"#,
            r#""allowedVenues":["hyperliquid","paper"],"#,
            r#""dailyLossLimitUsd":"{}","#,
            r#""deskId":"{}","#,
            "{}",
            r#""killSwitch":{{"autoOnDailyLoss":true,"monitorMayEngage":true}},"#,
            r#""maxOpenPositions":3,"#,
            r#""maxPositionUsd":"{}","#,
            r#""schema":"krexa.ual.policy/1","#,
            r#""slippageCapBps":30"#,
            "}}"
        ),
        daily_loss, DESK, evidence, max_position
    )
}

/// Contract with a desk, a committed policy, a registered TRADER and MONITOR, a registered
/// fetcher and one equity mark, which is the state every intent test starts from.
fn setup(evidence_required: bool, max_position: &str, daily_loss: &str) -> Ual {
    testing_env!(ctx(owner(), T0, NearToken::from_near(1)).build());
    let mut c = Ual::new(owner());
    c.create_desk(DESK.to_string());
    c.commit_policy(
        DESK.to_string(),
        policy_json(evidence_required, max_position, daily_loss),
    );
    c.register_agent(DESK.to_string(), trader(), "TRADER".to_string());
    c.register_agent(DESK.to_string(), monitor(), "MONITOR".to_string());
    c.register_fetcher(
        DESK.to_string(),
        fetcher_pubkey_str(),
        "b".repeat(64),
        "tee-fetcher-1".to_string(),
    );
    // An equity mark, so opens are not blocked by R_NO_EQUITY_MARK.
    let head = head_hash(&c);
    c.record_mark(DESK.to_string(), "10000000000".to_string(), head, None);
    c
}

/// Put an open BTC position on the desk directly, so exit tests have something to exit.
fn seed_position(c: &mut Ual, notional: &str) {
    let mut d = c.desks.get(DESK).cloned().unwrap();
    d.open_positions.push(Position {
        asset: "BTC".to_string(),
        venue: "hyperliquid".to_string(),
        direction: Direction::LONG,
        notional_usd: notional.to_string(),
        opened_by_seq: 0,
    });
    c.desks.insert(DESK.to_string(), d);
}

fn head_hash(c: &Ual) -> String {
    c.get_head(DESK.to_string()).unwrap()["hash"]
        .as_str()
        .unwrap()
        .to_string()
}

fn head_seq(c: &Ual) -> u64 {
    c.get_head(DESK.to_string()).unwrap()["seq"]
        .as_u64()
        .unwrap()
}

fn intent(side: Side, notional: &str) -> Intent {
    Intent {
        client_id: "trader-7f3a-000123".to_string(),
        venue: "hyperliquid".to_string(),
        asset: "BTC".to_string(),
        side,
        notional_usd: notional.to_string(),
        max_slippage_bps: 30,
        quote_ref: None,
    }
}

fn signed_item(
    source: &str,
    group: &str,
    kind: EvidenceKind,
    fetched_at: u64,
    stance: Stance,
    content_seed: u8,
) -> EvidenceItemInput {
    let payload = EvidencePayload {
        content_hash: hex::encode([content_seed; 32]),
        fetched_at: fetched_at.to_string(),
        kind,
        source: source.to_string(),
        source_group: group.to_string(),
        url: format!("https://{source}/a"),
    };
    let sig = fetcher_key().sign(&payload.signing_bytes());
    EvidenceItemInput {
        item: payload,
        fetcher_key: fetcher_pubkey_str(),
        signature: bs58::encode(sig.to_bytes()).into_string(),
        stance,
    }
}

fn bundle(items: Vec<EvidenceItemInput>, direction: Direction) -> EvidenceBundleInput {
    EvidenceBundleInput {
        asset: "BTC".to_string(),
        direction,
        verifier_code_hash: "a".repeat(64),
        items,
    }
}

fn reasons_of(receipt: &Value) -> Vec<String> {
    receipt["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect()
}

fn verdict_of(receipt: &Value) -> String {
    receipt["verdict"].as_str().unwrap().to_string()
}

// ---------------------------------------------------------------- canonical form and hashes

#[test]
fn canonical_sorts_keys_by_byte_order_and_strips_whitespace() {
    set_ctx(owner(), T0);
    let v: Value = serde_json::from_str(r#"{ "b": 1, "A": 2, "a": 3, "_": 4 }"#).unwrap();
    // Uppercase sorts before lowercase, and '_' (0x5f) before 'a' (0x61).
    assert_eq!(canonical(&v).unwrap(), r#"{"A":2,"_":4,"a":3,"b":1}"#);
}

#[test]
fn canonical_rejects_floats() {
    set_ctx(owner(), T0);
    let v: Value = serde_json::from_str(r#"{"x": 1.5}"#).unwrap();
    assert!(canonical(&v).is_err());
}

#[test]
fn canonical_rejects_non_printable_ascii() {
    set_ctx(owner(), T0);
    let v = json!({"x": "caf\u{e9}"});
    assert!(canonical(&v).is_err());
    let v2 = json!({"x": "line\nbreak"});
    assert!(canonical(&v2).is_err());
}

#[test]
fn canonical_escapes_only_quote_and_backslash() {
    set_ctx(owner(), T0);
    let v = json!({"x": "a\"b\\c"});
    assert_eq!(canonical(&v).unwrap(), r#"{"x":"a\"b\\c"}"#);
}

/// The vector `packages/sdk` must reproduce. If this digest changes, every receipt ever
/// written becomes unverifiable, so the value is pinned here on purpose.
#[test]
fn known_hash_vector() {
    set_ctx(owner(), T0);
    assert_eq!(
        sha256_hex(b"krexa-ual/v1"),
        sha256_hex("krexa-ual/v1".as_bytes())
    );
    // SHA-256 of the empty string, as a sanity check that the mocked VM hashes correctly.
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn genesis_hash_is_contract_and_desk_bound() {
    set_ctx(owner(), T0);
    let g = genesis_hash_for(CONTRACT, DESK);
    assert_eq!(
        g,
        sha256_hex(format!("krexa-ual/v1:{CONTRACT}:{DESK}").as_bytes())
    );
    // A different desk on the same contract must not share a genesis.
    assert_ne!(g, genesis_hash_for(CONTRACT, "other-desk"));
}

#[test]
fn micro_usd_parsing_has_exactly_one_spelling_per_value() {
    assert_eq!(parse_micro_usd("1250000"), Some(1_250_000));
    assert_eq!(parse_micro_usd("-85000000"), Some(-85_000_000));
    assert_eq!(parse_micro_usd("0"), Some(0));
    // Leading zeros would give one value two hashable spellings.
    assert_eq!(parse_micro_usd("01"), None);
    assert_eq!(parse_micro_usd("1.5"), None);
    assert_eq!(parse_micro_usd(""), None);
    assert_eq!(parse_micro_usd(" 1"), None);
    assert_eq!(parse_micro_usd("1e6"), None);
    assert_eq!(parse_micro_usd_unsigned("-1"), None);
}

// ---------------------------------------------------------------- policy

#[test]
fn policy_commit_returns_hash_of_canonical_bytes() {
    let c = setup(true, "1000000000", "200000000");
    let desk = c.get_desk(DESK.to_string()).unwrap();
    let hash = desk.policy_hash.clone().unwrap();
    let stored = c.get_policy(hash.clone()).unwrap();
    assert_eq!(hash, sha256_hex(stored.as_bytes()));
    assert_eq!(stored, policy_json(true, "1000000000", "200000000"));
}

#[test]
#[should_panic(expected = "E04_POLICY_NOT_CANONICAL")]
fn policy_not_canonical_is_e04() {
    testing_env!(ctx(owner(), T0, NearToken::from_near(1)).build());
    let mut c = Ual::new(owner());
    c.create_desk(DESK.to_string());
    // Same policy, keys in the wrong order. Valid JSON, not canonical.
    let bad = r#"{"schema":"krexa.ual.policy/1","deskId":"yk-desk","maxPositionUsd":"1000000000","maxOpenPositions":3,"dailyLossLimitUsd":"200000000","allowedAssets":["BTC","ETH"],"allowedVenues":["hyperliquid","paper"],"slippageCapBps":30,"allowedModes":["live","paper"],"killSwitch":{"autoOnDailyLoss":true,"monitorMayEngage":true}}"#;
    c.commit_policy(DESK.to_string(), bad.to_string());
}

#[test]
#[should_panic(expected = "E04_POLICY_NOT_CANONICAL")]
fn policy_with_insignificant_whitespace_is_e04() {
    testing_env!(ctx(owner(), T0, NearToken::from_near(1)).build());
    let mut c = Ual::new(owner());
    c.create_desk(DESK.to_string());
    let spaced =
        policy_json(true, "1000000000", "200000000").replace(",\"deskId\"", ", \"deskId\"");
    c.commit_policy(DESK.to_string(), spaced);
}

#[test]
#[should_panic(expected = "E01_NOT_OWNER")]
fn non_owner_commit_is_e01() {
    testing_env!(ctx(owner(), T0, NearToken::from_near(1)).build());
    let mut c = Ual::new(owner());
    c.create_desk(DESK.to_string());
    set_ctx(stranger(), T0);
    c.commit_policy(
        DESK.to_string(),
        policy_json(true, "1000000000", "200000000"),
    );
}

#[test]
#[should_panic(expected = "E05_POLICY_INVALID")]
fn policy_with_unsorted_asset_set_is_invalid() {
    testing_env!(ctx(owner(), T0, NearToken::from_near(1)).build());
    let mut c = Ual::new(owner());
    c.create_desk(DESK.to_string());
    let p = policy_json(true, "1000000000", "200000000")
        .replace(r#"["BTC","ETH"]"#, r#"["ETH","BTC"]"#);
    c.commit_policy(DESK.to_string(), p);
}

#[test]
#[should_panic(expected = "E05_POLICY_INVALID")]
fn policy_for_a_different_desk_is_invalid() {
    testing_env!(ctx(owner(), T0, NearToken::from_near(1)).build());
    let mut c = Ual::new(owner());
    c.create_desk("other-desk".to_string());
    // deskId inside the policy says yk-desk.
    c.commit_policy(
        "other-desk".to_string(),
        policy_json(true, "1000000000", "200000000"),
    );
}

#[test]
fn mode_switch_keeps_policy_hash() {
    let mut c = setup(true, "1000000000", "200000000");
    let before = c.get_desk(DESK.to_string()).unwrap().policy_hash;
    set_ctx(owner(), T0 + 1_000);
    c.set_mode(DESK.to_string(), "live".to_string());
    let desk = c.get_desk(DESK.to_string()).unwrap();
    assert_eq!(desk.mode, Mode::Live);
    assert_eq!(desk.policy_hash, before);
}

// ---------------------------------------------------------------- hash chain

#[test]
fn receipts_chain_prev_hash_to_hash() {
    let c = setup(true, "1000000000", "200000000");
    let receipts = c.get_receipts(DESK.to_string(), 1, 100);
    assert!(receipts.len() >= 5);
    let genesis = c.genesis_hash(DESK.to_string()).unwrap();
    assert_eq!(receipts[0]["prevHash"].as_str().unwrap(), genesis);
    for pair in receipts.windows(2) {
        assert_eq!(
            pair[1]["prevHash"].as_str().unwrap(),
            pair[0]["hash"].as_str().unwrap()
        );
    }
}

#[test]
fn every_receipt_hash_recomputes_from_its_own_contents() {
    let c = setup(true, "1000000000", "200000000");
    for r in c.get_receipts(DESK.to_string(), 1, 100) {
        let mut body = r.clone();
        let claimed = body
            .as_object_mut()
            .unwrap()
            .remove("hash")
            .unwrap()
            .as_str()
            .unwrap()
            .to_string();
        set_ctx(owner(), T0);
        assert_eq!(claimed, sha256_hex(canonical(&body).unwrap().as_bytes()));
    }
}

#[test]
#[should_panic(expected = "E03_CHAIN_BROKEN")]
fn wrong_prev_hash_is_e03() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "500000000"),
        "f".repeat(64),
        "10000000000".to_string(),
        None,
        None,
        None,
    );
}

#[test]
fn wrong_prev_hash_appends_nothing() {
    let mut c = setup(false, "1000000000", "200000000");
    let seq_before = head_seq(&c);
    set_ctx(trader(), T0 + 600_000_000_000);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.submit_intent(
            DESK.to_string(),
            intent(Side::OPEN_LONG, "500000000"),
            "f".repeat(64),
            "10000000000".to_string(),
            None,
            None,
            None,
        )
    }));
    assert!(result.is_err());
    assert_eq!(head_seq(&c), seq_before, "head must not move");
}

// ---------------------------------------------------------------- policy limits

#[test]
fn oversize_open_is_rejected_with_r_max_position() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    // $5,000 against a $1,000 cap.
    let r = c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "5000000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        None,
    );
    assert_eq!(verdict_of(&r), "REJECTED");
    assert!(reasons_of(&r).contains(&"R_MAX_POSITION".to_string()));
    // The rejection is a receipt, not a failed transaction.
    assert_eq!(r["kind"].as_str().unwrap(), "INTENT");
    assert_eq!(head_hash(&c), r["hash"].as_str().unwrap());
}

#[test]
fn in_size_open_is_approved() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let r = c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "500000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        None,
    );
    assert_eq!(verdict_of(&r), "APPROVED");
    assert!(reasons_of(&r).is_empty());
}

#[test]
fn disallowed_asset_and_venue_are_rejected() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let mut i = intent(Side::OPEN_LONG, "500000000");
    i.asset = "DOGE".to_string();
    i.venue = "binance".to_string();
    let r = c.submit_intent(
        DESK.to_string(),
        i,
        head,
        "10000000000".to_string(),
        None,
        None,
        None,
    );
    let reasons = reasons_of(&r);
    assert!(reasons.contains(&"R_ASSET_NOT_ALLOWED".to_string()));
    assert!(reasons.contains(&"R_VENUE_NOT_ALLOWED".to_string()));
}

#[test]
fn slippage_above_cap_is_rejected() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let mut i = intent(Side::OPEN_LONG, "500000000");
    i.max_slippage_bps = 500;
    let r = c.submit_intent(
        DESK.to_string(),
        i,
        head,
        "10000000000".to_string(),
        None,
        None,
        None,
    );
    assert!(reasons_of(&r).contains(&"R_SLIPPAGE_CAP".to_string()));
}

#[test]
fn close_is_allowed_under_daily_loss_while_open_is_not() {
    let mut c = setup(false, "1000000000", "200000000");
    seed_position(&mut c, "500000000");
    // Mark down past the $200 daily loss limit. Equity started at $10,000.
    set_ctx(owner(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    c.record_mark(DESK.to_string(), "9700000000".to_string(), head, None);

    set_ctx(trader(), T0 + 1_200_000_000_000);
    let head = head_hash(&c);
    let open = c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "500000000"),
        head,
        "9700000000".to_string(),
        None,
        None,
        None,
    );
    assert_eq!(verdict_of(&open), "REJECTED");
    assert!(reasons_of(&open).contains(&"R_DAILY_LOSS".to_string()));

    let head = head_hash(&c);
    let close = c.submit_intent(
        DESK.to_string(),
        intent(Side::CLOSE, "500000000"),
        head,
        "9700000000".to_string(),
        None,
        None,
        None,
    );
    assert_eq!(
        verdict_of(&close),
        "APPROVED",
        "an exit is never blocked by a loss limit"
    );
}

#[test]
fn open_without_a_recent_equity_mark_is_rejected() {
    let mut c = setup(false, "1000000000", "200000000");
    // More than 24h after the only mark.
    set_ctx(trader(), T0 + 90_000_000_000_000);
    let head = head_hash(&c);
    let r = c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "500000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        None,
    );
    assert!(reasons_of(&r).contains(&"R_NO_EQUITY_MARK".to_string()));
}

#[test]
#[should_panic(expected = "E02_NOT_AGENT")]
fn unregistered_caller_cannot_submit_an_intent() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(stranger(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "500000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        None,
    );
}

#[test]
#[should_panic(expected = "E02_NOT_AGENT")]
fn a_monitor_cannot_submit_an_intent() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(monitor(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "500000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        None,
    );
}

// ---------------------------------------------------------------- kill switch

#[test]
fn kill_switch_blocks_opens_and_allows_close() {
    let mut c = setup(false, "1000000000", "200000000");
    seed_position(&mut c, "500000000");
    set_ctx(owner(), T0 + 600_000_000_000);
    c.engage_kill_switch(DESK.to_string(), "manual test".to_string());

    set_ctx(trader(), T0 + 700_000_000_000);
    let head = head_hash(&c);
    let open = c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "500000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        None,
    );
    assert_eq!(verdict_of(&open), "REJECTED");
    assert!(reasons_of(&open).contains(&"R_KILL_SWITCH".to_string()));

    let head = head_hash(&c);
    let close = c.submit_intent(
        DESK.to_string(),
        intent(Side::CLOSE, "500000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        None,
    );
    assert_eq!(verdict_of(&close), "APPROVED");
}

#[test]
fn monitor_may_engage_but_never_release() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(monitor(), T0 + 600_000_000_000);
    c.engage_kill_switch(DESK.to_string(), "attack suspect".to_string());
    assert!(c.get_desk(DESK.to_string()).unwrap().kill_switch);

    let released = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.release_kill_switch(DESK.to_string())
    }));
    assert!(released.is_err(), "a monitor must not be able to release");
    assert!(c.get_desk(DESK.to_string()).unwrap().kill_switch);

    set_ctx(owner(), T0 + 700_000_000_000);
    c.release_kill_switch(DESK.to_string());
    assert!(!c.get_desk(DESK.to_string()).unwrap().kill_switch);
}

#[test]
fn daily_loss_auto_engages_the_kill_switch_on_mark() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(owner(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    c.record_mark(DESK.to_string(), "9700000000".to_string(), head, None);
    let desk = c.get_desk(DESK.to_string()).unwrap();
    assert!(desk.kill_switch);
    assert_eq!(desk.kill_reason, "auto: daily loss limit");
}

// ---------------------------------------------------------------- evidence gate

#[test]
fn k1_single_source_is_uncorroborated() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let ev = c.submit_evidence(
        DESK.to_string(),
        bundle(
            vec![signed_item(
                "newswire-a.example",
                "newswire-a",
                EvidenceKind::NEWS,
                T0 + 500_000_000_000,
                Stance::SUPPORT,
                1,
            )],
            Direction::LONG,
        ),
        head,
    );
    assert_eq!(ev["kind"].as_str().unwrap(), "EVIDENCE");
    assert_eq!(ev["verdict"].as_str().unwrap(), "NA");
    assert_eq!(ev["evidence"]["k"].as_u64().unwrap(), 1);
    assert_eq!(ev["sizeMultiplierBps"].as_u64().unwrap(), 0);
    let ev_seq = ev["seq"].as_u64().unwrap();

    let head = head_hash(&c);
    let r = c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "500000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        Some(ev_seq),
    );
    assert_eq!(verdict_of(&r), "REJECTED");
    let reasons = reasons_of(&r);
    assert!(reasons.contains(&"R_UNCORROBORATED".to_string()));
    // Paper desk, so the paper-only marker is present too.
    assert!(reasons.contains(&"PAPER_ONLY_UNCORROBORATED".to_string()));
    assert_eq!(r["evidenceReceiptSeq"].as_u64().unwrap(), ev_seq);
}

#[test]
fn k2_two_groups_allows_half_size() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let ev = c.submit_evidence(
        DESK.to_string(),
        bundle(
            vec![
                signed_item(
                    "newswire-a.example",
                    "newswire-a",
                    EvidenceKind::NEWS,
                    T0 + 500_000_000_000,
                    Stance::SUPPORT,
                    1,
                ),
                signed_item(
                    "hyperliquid",
                    "exchange-hl",
                    EvidenceKind::PRICE,
                    T0 + 550_000_000_000,
                    Stance::SUPPORT,
                    2,
                ),
            ],
            Direction::LONG,
        ),
        head,
    );
    assert_eq!(ev["evidence"]["k"].as_u64().unwrap(), 2);
    assert_eq!(ev["sizeMultiplierBps"].as_u64().unwrap(), 5000);
    let ev_seq = ev["seq"].as_u64().unwrap();

    let head = head_hash(&c);
    // $500 requested, halved to $250, under the $1,000 cap.
    let r = c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "500000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        Some(ev_seq),
    );
    assert_eq!(verdict_of(&r), "APPROVED");
    assert_eq!(r["sizeMultiplierBps"].as_u64().unwrap(), 5000);
}

#[test]
fn k2_half_size_still_respects_the_position_cap() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let ev = c.submit_evidence(
        DESK.to_string(),
        bundle(
            vec![
                signed_item(
                    "newswire-a.example",
                    "newswire-a",
                    EvidenceKind::NEWS,
                    T0 + 500_000_000_000,
                    Stance::SUPPORT,
                    1,
                ),
                signed_item(
                    "hyperliquid",
                    "exchange-hl",
                    EvidenceKind::PRICE,
                    T0 + 550_000_000_000,
                    Stance::SUPPORT,
                    2,
                ),
            ],
            Direction::LONG,
        ),
        head,
    );
    let ev_seq = ev["seq"].as_u64().unwrap();
    let head = head_hash(&c);
    // $3,000 halved is $1,500, still over the $1,000 cap. The contract rejects rather than
    // clipping, which is the documented difference from Krexa's off-chain checkOrder.
    let r = c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "3000000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        Some(ev_seq),
    );
    assert_eq!(verdict_of(&r), "REJECTED");
    assert!(reasons_of(&r).contains(&"R_MAX_POSITION".to_string()));
}

#[test]
fn k3_three_groups_allows_full_size() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let ev = c.submit_evidence(
        DESK.to_string(),
        bundle(
            vec![
                signed_item(
                    "newswire-a.example",
                    "newswire-a",
                    EvidenceKind::NEWS,
                    T0 + 500_000_000_000,
                    Stance::SUPPORT,
                    1,
                ),
                signed_item(
                    "newswire-b.example",
                    "newswire-b",
                    EvidenceKind::NEWS,
                    T0 + 510_000_000_000,
                    Stance::SUPPORT,
                    2,
                ),
                signed_item(
                    "hyperliquid",
                    "exchange-hl",
                    EvidenceKind::PRICE,
                    T0 + 550_000_000_000,
                    Stance::SUPPORT,
                    3,
                ),
            ],
            Direction::LONG,
        ),
        head,
    );
    assert_eq!(ev["evidence"]["k"].as_u64().unwrap(), 3);
    assert_eq!(ev["sizeMultiplierBps"].as_u64().unwrap(), 10000);
}

#[test]
fn two_sources_in_one_group_count_once() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    // Both items come from the same declared group, so corroboration does not increase.
    let ev = c.submit_evidence(
        DESK.to_string(),
        bundle(
            vec![
                signed_item(
                    "newswire-a.example",
                    "newswire-a",
                    EvidenceKind::NEWS,
                    T0 + 500_000_000_000,
                    Stance::SUPPORT,
                    1,
                ),
                signed_item(
                    "newswire-a.example",
                    "newswire-a",
                    EvidenceKind::NEWS,
                    T0 + 510_000_000_000,
                    Stance::SUPPORT,
                    2,
                ),
            ],
            Direction::LONG,
        ),
        head,
    );
    assert_eq!(ev["evidence"]["k"].as_u64().unwrap(), 1);
    assert_eq!(ev["sizeMultiplierBps"].as_u64().unwrap(), 0);
}

#[test]
fn contradicting_group_reduces_k() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let ev = c.submit_evidence(
        DESK.to_string(),
        bundle(
            vec![
                signed_item(
                    "newswire-a.example",
                    "newswire-a",
                    EvidenceKind::NEWS,
                    T0 + 500_000_000_000,
                    Stance::SUPPORT,
                    1,
                ),
                signed_item(
                    "newswire-b.example",
                    "newswire-b",
                    EvidenceKind::NEWS,
                    T0 + 505_000_000_000,
                    Stance::SUPPORT,
                    2,
                ),
                signed_item(
                    "hyperliquid",
                    "exchange-hl",
                    EvidenceKind::PRICE,
                    T0 + 550_000_000_000,
                    Stance::CONTRADICT,
                    3,
                ),
            ],
            Direction::LONG,
        ),
        head,
    );
    // 2 supporting groups minus 1 contradicting leaves k = 1.
    assert_eq!(ev["evidence"]["k"].as_u64().unwrap(), 1);
    assert_eq!(ev["sizeMultiplierBps"].as_u64().unwrap(), 0);
}

#[test]
fn an_undeclared_source_counts_for_nothing() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let ev = c.submit_evidence(
        DESK.to_string(),
        bundle(
            vec![
                signed_item(
                    "newswire-a.example",
                    "newswire-a",
                    EvidenceKind::NEWS,
                    T0 + 500_000_000_000,
                    Stance::SUPPORT,
                    1,
                ),
                // Signed by a registered fetcher, but the policy never declared this source,
                // so it cannot buy corroboration. The gate fails closed.
                signed_item(
                    "random-blog.example",
                    "whatever",
                    EvidenceKind::NEWS,
                    T0 + 505_000_000_000,
                    Stance::SUPPORT,
                    2,
                ),
            ],
            Direction::LONG,
        ),
        head,
    );
    assert_eq!(ev["evidence"]["k"].as_u64().unwrap(), 1);
    assert_eq!(
        ev["evidence"]["items"][1]["sourceGroup"].as_str().unwrap(),
        "UNDECLARED"
    );
}

#[test]
fn stale_evidence_is_rejected() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    // maxAgeSec is 900. This item was fetched 2000s before now.
    let ev = c.submit_evidence(
        DESK.to_string(),
        bundle(
            vec![
                signed_item(
                    "newswire-a.example",
                    "newswire-a",
                    EvidenceKind::NEWS,
                    T0 - 1_400_000_000_000,
                    Stance::SUPPORT,
                    1,
                ),
                signed_item(
                    "hyperliquid",
                    "exchange-hl",
                    EvidenceKind::PRICE,
                    T0 + 550_000_000_000,
                    Stance::SUPPORT,
                    2,
                ),
            ],
            Direction::LONG,
        ),
        head,
    );
    assert!(ev["evidence"]["anyStale"].as_bool().unwrap());
    assert!(!ev["evidence"]["items"][0]["valid"].as_bool().unwrap());
    let ev_seq = ev["seq"].as_u64().unwrap();

    let head = head_hash(&c);
    let r = c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "500000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        Some(ev_seq),
    );
    assert_eq!(verdict_of(&r), "REJECTED");
    assert!(reasons_of(&r).contains(&"R_EVIDENCE_STALE".to_string()));
}

#[test]
fn evidence_that_was_fresh_goes_stale_before_the_intent() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let ev = c.submit_evidence(
        DESK.to_string(),
        bundle(
            vec![
                signed_item(
                    "newswire-a.example",
                    "newswire-a",
                    EvidenceKind::NEWS,
                    T0 + 500_000_000_000,
                    Stance::SUPPORT,
                    1,
                ),
                signed_item(
                    "hyperliquid",
                    "exchange-hl",
                    EvidenceKind::PRICE,
                    T0 + 550_000_000_000,
                    Stance::SUPPORT,
                    2,
                ),
            ],
            Direction::LONG,
        ),
        head,
    );
    assert!(!ev["evidence"]["anyStale"].as_bool().unwrap());
    let ev_seq = ev["seq"].as_u64().unwrap();

    // An hour later the bundle is well past maxAgeSec. A bundle cannot be banked and spent.
    set_ctx(trader(), T0 + 4_200_000_000_000);
    let head = head_hash(&c);
    let r = c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "500000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        Some(ev_seq),
    );
    assert_eq!(verdict_of(&r), "REJECTED");
    assert!(reasons_of(&r).contains(&"R_EVIDENCE_STALE".to_string()));
}

#[test]
fn a_forged_signature_taints_the_whole_bundle() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);

    let mut tampered = signed_item(
        "newswire-a.example",
        "newswire-a",
        EvidenceKind::NEWS,
        T0 + 500_000_000_000,
        Stance::SUPPORT,
        1,
    );
    // Change the content after signing, which is exactly what a fake headline injected into
    // the archive would look like.
    tampered.item.content_hash = hex::encode([0x99u8; 32]);

    let ev = c.submit_evidence(
        DESK.to_string(),
        bundle(
            vec![
                tampered,
                signed_item(
                    "newswire-b.example",
                    "newswire-b",
                    EvidenceKind::NEWS,
                    T0 + 505_000_000_000,
                    Stance::SUPPORT,
                    2,
                ),
                signed_item(
                    "hyperliquid",
                    "exchange-hl",
                    EvidenceKind::PRICE,
                    T0 + 550_000_000_000,
                    Stance::SUPPORT,
                    3,
                ),
            ],
            Direction::LONG,
        ),
        head,
    );
    assert!(ev["evidence"]["anyBadSig"].as_bool().unwrap());
    assert!(!ev["evidence"]["items"][0]["valid"].as_bool().unwrap());
    // Two honest groups remain, so k is 2 and the table would allow half size. The gate
    // still refuses, because a bundle containing a forgery means the pipeline is compromised.
    assert_eq!(ev["evidence"]["k"].as_u64().unwrap(), 2);
    let ev_seq = ev["seq"].as_u64().unwrap();

    let head = head_hash(&c);
    let r = c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "500000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        Some(ev_seq),
    );
    assert_eq!(verdict_of(&r), "REJECTED");
    assert!(reasons_of(&r).contains(&"R_EVIDENCE_BAD_SIG".to_string()));
}

#[test]
#[should_panic(expected = "E19_UNKNOWN_FETCHER")]
fn an_unregistered_fetcher_key_is_e19() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let mut item = signed_item(
        "newswire-a.example",
        "newswire-a",
        EvidenceKind::NEWS,
        T0 + 500_000_000_000,
        Stance::SUPPORT,
        1,
    );
    let other = SigningKey::from_bytes(&[9u8; 32]);
    item.fetcher_key = format!(
        "ed25519:{}",
        bs58::encode(other.verifying_key().to_bytes()).into_string()
    );
    c.submit_evidence(DESK.to_string(), bundle(vec![item], Direction::LONG), head);
}

#[test]
#[should_panic(expected = "E19_UNKNOWN_FETCHER")]
fn a_revoked_fetcher_key_is_e19() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(owner(), T0 + 300_000_000_000);
    c.revoke_fetcher(DESK.to_string(), fetcher_pubkey_str());
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    c.submit_evidence(
        DESK.to_string(),
        bundle(
            vec![signed_item(
                "newswire-a.example",
                "newswire-a",
                EvidenceKind::NEWS,
                T0 + 500_000_000_000,
                Stance::SUPPORT,
                1,
            )],
            Direction::LONG,
        ),
        head,
    );
}

#[test]
fn an_open_with_no_evidence_citation_is_rejected() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let r = c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "500000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        None, // no evidence_seq
    );
    assert_eq!(verdict_of(&r), "REJECTED");
    assert!(reasons_of(&r).contains(&"R_NO_EVIDENCE".to_string()));
}

#[test]
fn evidence_for_the_wrong_asset_or_direction_is_a_mismatch() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    // Bundle says SHORT; the intent is an OPEN_LONG.
    let ev = c.submit_evidence(
        DESK.to_string(),
        bundle(
            vec![
                signed_item(
                    "newswire-a.example",
                    "newswire-a",
                    EvidenceKind::NEWS,
                    T0 + 500_000_000_000,
                    Stance::SUPPORT,
                    1,
                ),
                signed_item(
                    "hyperliquid",
                    "exchange-hl",
                    EvidenceKind::PRICE,
                    T0 + 550_000_000_000,
                    Stance::SUPPORT,
                    2,
                ),
            ],
            Direction::SHORT,
        ),
        head,
    );
    let ev_seq = ev["seq"].as_u64().unwrap();
    let head = head_hash(&c);
    let r = c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "500000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        Some(ev_seq),
    );
    assert_eq!(verdict_of(&r), "REJECTED");
    assert!(reasons_of(&r).contains(&"R_EVIDENCE_MISMATCH".to_string()));
}

#[test]
fn an_exit_needs_no_evidence_even_on_a_gated_desk() {
    let mut c = setup(true, "1000000000", "200000000");
    seed_position(&mut c, "500000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let r = c.submit_intent(
        DESK.to_string(),
        intent(Side::CLOSE, "500000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        None,
    );
    assert_eq!(verdict_of(&r), "APPROVED");
    assert!(r["sizeMultiplierBps"].is_null());
}

#[test]
#[should_panic(expected = "E20_BUNDLE_TOO_LARGE")]
fn more_than_sixteen_items_is_e20() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let items: Vec<EvidenceItemInput> = (0..17u8)
        .map(|i| {
            signed_item(
                "newswire-a.example",
                "newswire-a",
                EvidenceKind::NEWS,
                T0 + 500_000_000_000,
                Stance::SUPPORT,
                i,
            )
        })
        .collect();
    c.submit_evidence(DESK.to_string(), bundle(items, Direction::LONG), head);
}

#[test]
#[should_panic(expected = "E13_BAD_HASH")]
fn a_bundle_from_an_unauthorized_verifier_build_is_rejected() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let mut b = bundle(
        vec![signed_item(
            "newswire-a.example",
            "newswire-a",
            EvidenceKind::NEWS,
            T0 + 500_000_000_000,
            Stance::SUPPORT,
            1,
        )],
        Direction::LONG,
    );
    b.verifier_code_hash = "c".repeat(64);
    c.submit_evidence(DESK.to_string(), b, head);
}

// ---------------------------------------------------------------- fills

fn approve_and_get_seq(c: &mut Ual, notional: &str) -> u64 {
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(c);
    let r = c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, notional),
        head,
        "10000000000".to_string(),
        None,
        None,
        None,
    );
    assert_eq!(verdict_of(&r), "APPROVED");
    r["seq"].as_u64().unwrap()
}

fn sim_fill(notional: &str) -> FillRef {
    FillRef {
        kind: FillKind::SIMULATED,
        simulated: true,
        reference: "paper:hl-mid:BTC:2026-11-06T10:15:00Z".to_string(),
        price: "68012".to_string(),
        notional_usd: notional.to_string(),
        evidence_sha256: Some("d".repeat(64)),
    }
}

#[test]
fn a_simulated_fill_on_a_paper_desk_is_recorded_and_opens_a_position() {
    let mut c = setup(false, "1000000000", "200000000");
    let seq = approve_and_get_seq(&mut c, "500000000");
    let head = head_hash(&c);
    let f = c.record_fill(DESK.to_string(), seq, sim_fill("500000000"), head);
    assert_eq!(f["kind"].as_str().unwrap(), "FILL");
    assert_eq!(f["intentSeq"].as_u64().unwrap(), seq);
    assert_eq!(f["mode"].as_str().unwrap(), "paper");
    assert_eq!(c.get_open_positions(DESK.to_string()).len(), 1);
}

#[test]
#[should_panic(expected = "E16_LABEL_MISMATCH")]
fn a_simulated_fill_on_a_live_desk_is_e16() {
    let mut c = setup(false, "1000000000", "200000000");
    let seq = approve_and_get_seq(&mut c, "500000000");
    set_ctx(owner(), T0 + 650_000_000_000);
    c.set_mode(DESK.to_string(), "live".to_string());
    set_ctx(trader(), T0 + 700_000_000_000);
    let head = head_hash(&c);
    c.record_fill(DESK.to_string(), seq, sim_fill("500000000"), head);
}

#[test]
#[should_panic(expected = "E15_FILL_EXCEEDS_INTENT")]
fn a_fill_larger_than_the_intent_is_e15() {
    let mut c = setup(false, "1000000000", "200000000");
    let seq = approve_and_get_seq(&mut c, "500000000");
    let head = head_hash(&c);
    c.record_fill(DESK.to_string(), seq, sim_fill("900000000"), head);
}

#[test]
#[should_panic(expected = "E11_ALREADY_FILLED")]
fn filling_the_same_intent_twice_is_e11() {
    let mut c = setup(false, "1000000000", "200000000");
    let seq = approve_and_get_seq(&mut c, "500000000");
    let head = head_hash(&c);
    c.record_fill(DESK.to_string(), seq, sim_fill("500000000"), head);
    let head = head_hash(&c);
    c.record_fill(DESK.to_string(), seq, sim_fill("500000000"), head);
}

#[test]
#[should_panic(expected = "E10_INTENT_NOT_APPROVED")]
fn filling_a_rejected_intent_is_e10() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let r = c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "5000000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        None,
    );
    assert_eq!(verdict_of(&r), "REJECTED");
    let seq = r["seq"].as_u64().unwrap();
    let head = head_hash(&c);
    c.record_fill(DESK.to_string(), seq, sim_fill("500000000"), head);
}

#[test]
fn a_half_sized_approval_cannot_be_filled_at_full_size() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let ev = c.submit_evidence(
        DESK.to_string(),
        bundle(
            vec![
                signed_item(
                    "newswire-a.example",
                    "newswire-a",
                    EvidenceKind::NEWS,
                    T0 + 500_000_000_000,
                    Stance::SUPPORT,
                    1,
                ),
                signed_item(
                    "hyperliquid",
                    "exchange-hl",
                    EvidenceKind::PRICE,
                    T0 + 550_000_000_000,
                    Stance::SUPPORT,
                    2,
                ),
            ],
            Direction::LONG,
        ),
        head,
    );
    let ev_seq = ev["seq"].as_u64().unwrap();
    let head = head_hash(&c);
    let r = c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "500000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        Some(ev_seq),
    );
    assert_eq!(verdict_of(&r), "APPROVED");
    let seq = r["seq"].as_u64().unwrap();

    // Approved at 50% of $500, so $250 is the ceiling. Filling $500 would walk through the
    // gate after it had already sized the trade down.
    let head = head_hash(&c);
    let too_big = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.record_fill(DESK.to_string(), seq, sim_fill("500000000"), head)
    }));
    assert!(too_big.is_err());

    let head = head_hash(&c);
    let ok = c.record_fill(DESK.to_string(), seq, sim_fill("250000000"), head);
    assert_eq!(ok["kind"].as_str().unwrap(), "FILL");
}

#[test]
fn closing_removes_the_open_position() {
    let mut c = setup(false, "1000000000", "200000000");
    let seq = approve_and_get_seq(&mut c, "500000000");
    let head = head_hash(&c);
    c.record_fill(DESK.to_string(), seq, sim_fill("500000000"), head);
    assert_eq!(c.get_open_positions(DESK.to_string()).len(), 1);

    set_ctx(trader(), T0 + 800_000_000_000);
    let head = head_hash(&c);
    let close = c.submit_intent(
        DESK.to_string(),
        intent(Side::CLOSE, "500000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        None,
    );
    let close_seq = close["seq"].as_u64().unwrap();
    let head = head_hash(&c);
    let mut f = sim_fill("500000000");
    f.reference = "paper:hl-mid:BTC:close".to_string();
    c.record_fill(DESK.to_string(), close_seq, f, head);
    assert_eq!(c.get_open_positions(DESK.to_string()).len(), 0);
}

#[test]
fn max_open_positions_is_enforced() {
    let mut c = setup(false, "1000000000", "200000000");
    // maxOpenPositions is 3.
    for i in 0..3 {
        set_ctx(trader(), T0 + 600_000_000_000 + i * 1_000_000);
        let head = head_hash(&c);
        let r = c.submit_intent(
            DESK.to_string(),
            intent(Side::OPEN_LONG, "100000000"),
            head,
            "10000000000".to_string(),
            None,
            None,
            None,
        );
        let seq = r["seq"].as_u64().unwrap();
        let head = head_hash(&c);
        let mut f = sim_fill("100000000");
        f.reference = format!("paper:hl-mid:BTC:{i}");
        c.record_fill(DESK.to_string(), seq, f, head);
    }
    set_ctx(trader(), T0 + 700_000_000_000);
    let head = head_hash(&c);
    let r = c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "100000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        None,
    );
    assert!(reasons_of(&r).contains(&"R_MAX_OPEN_POSITIONS".to_string()));
}

// ---------------------------------------------------------------- marks and flows

#[test]
#[should_panic(expected = "E14_MARK_TOO_SOON")]
fn two_marks_within_five_minutes_is_e14() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(owner(), T0 + 60_000_000_000);
    let head = head_hash(&c);
    c.record_mark(DESK.to_string(), "10000000000".to_string(), head, None);
}

#[test]
fn a_mark_tracks_drawdown_against_the_high_water_mark() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(owner(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    // Up to $11,000, which raises the high-water mark.
    c.record_mark(DESK.to_string(), "11000000000".to_string(), head, None);
    set_ctx(owner(), T0 + 1_200_000_000_000);
    let head = head_hash(&c);
    let m = c.record_mark(DESK.to_string(), "10450000000".to_string(), head, None);
    // 550 down from 11000 is 5%, which is 500 bps.
    assert_eq!(m["drawdownBps"].as_u64().unwrap(), 500);
}

#[test]
fn a_capital_flow_is_not_counted_as_profit() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(owner(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    // Deposit $1,000 then mark at $11,000. Daily PnL must stay flat, not show +$1,000.
    c.record_flow(DESK.to_string(), "1000000000".to_string(), head);
    set_ctx(owner(), T0 + 1_200_000_000_000);
    let head = head_hash(&c);
    let m = c.record_mark(DESK.to_string(), "11000000000".to_string(), head, None);
    assert_eq!(m["dailyPnlUsd"].as_str().unwrap(), "0");
}

#[test]
fn decisions_root_is_recorded_so_holds_are_committed() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(owner(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let root = "e".repeat(64);
    let m = c.record_mark(
        DESK.to_string(),
        "10000000000".to_string(),
        head,
        Some(root.clone()),
    );
    assert_eq!(m["decisionsRoot"].as_str().unwrap(), root);
}

// ---------------------------------------------------------------- pause and ownership

#[test]
#[should_panic(expected = "E07_PAUSED")]
fn a_paused_contract_refuses_writes() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(owner(), T0 + 600_000_000_000);
    c.pause();
    set_ctx(trader(), T0 + 700_000_000_000);
    let head = head_hash(&c);
    c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "500000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        None,
    );
}

#[test]
#[should_panic(expected = "E01_NOT_OWNER")]
fn only_the_contract_owner_may_pause() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(stranger(), T0 + 600_000_000_000);
    c.pause();
}

#[test]
#[should_panic(expected = "E08_DESK_EXISTS")]
fn creating_the_same_desk_twice_is_e08() {
    testing_env!(ctx(owner(), T0, NearToken::from_near(1)).build());
    let mut c = Ual::new(owner());
    c.create_desk(DESK.to_string());
    c.create_desk(DESK.to_string());
}

#[test]
#[should_panic(expected = "E12_INSUFFICIENT_STORAGE")]
fn creating_a_desk_without_a_storage_deposit_is_e12() {
    testing_env!(ctx(owner(), T0, NearToken::from_near(0)).build());
    let mut c = Ual::new(owner());
    c.create_desk(DESK.to_string());
}

#[test]
#[should_panic(expected = "E09_UNKNOWN_DESK")]
fn an_unknown_desk_is_e09() {
    testing_env!(ctx(owner(), T0, NearToken::from_near(1)).build());
    let mut c = Ual::new(owner());
    c.commit_policy(
        "no-such-desk".to_string(),
        policy_json(true, "1000000000", "200000000"),
    );
}

#[test]
fn a_retired_agent_cannot_write_but_its_history_remains() {
    let mut c = setup(false, "1000000000", "200000000");
    let seq_before = head_seq(&c);
    set_ctx(owner(), T0 + 600_000_000_000);
    c.retire_agent(DESK.to_string(), trader());

    set_ctx(trader(), T0 + 700_000_000_000);
    let head = head_hash(&c);
    let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.submit_intent(
            DESK.to_string(),
            intent(Side::OPEN_LONG, "500000000"),
            head,
            "10000000000".to_string(),
            None,
            None,
            None,
        )
    }));
    assert!(blocked.is_err());
    // Nothing was deleted: the receipts written before retirement are all still there.
    assert!(c.get_receipts(DESK.to_string(), 1, 100).len() as u64 >= seq_before);
    assert!(c.get_agents(DESK.to_string()).iter().any(|a| a.retired));
}

#[test]
fn there_is_no_method_that_moves_funds() {
    // A structural assertion rather than a behavioural one: this test exists so that adding
    // a transfer to the contract breaks a test rather than slipping through review. The
    // method list below is the one an agent's function-call key is scoped to.
    let agent_methods = [
        "submit_evidence",
        "submit_intent",
        "record_fill",
        "record_mark",
    ];
    for m in agent_methods {
        assert!(
            !m.contains("transfer") && !m.contains("withdraw") && !m.contains("send"),
            "agent method {m} must not move value"
        );
    }
}

// ---------------------------------------------------------------- review fixes

fn submit(c: &mut Ual, side: Side, notional: &str, ev: Option<u64>) -> Value {
    let head = head_hash(c);
    c.submit_intent(
        DESK.to_string(),
        intent(side, notional),
        head,
        "10000000000".to_string(),
        None,
        None,
        ev,
    )
}

#[test]
fn a_close_with_nothing_open_is_not_an_exit() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let r = submit(&mut c, Side::CLOSE, "1000000000000", None);
    assert_eq!(verdict_of(&r), "REJECTED");
    assert!(reasons_of(&r).contains(&"R_NO_POSITION".to_string()));
}

#[test]
fn a_reduce_larger_than_the_position_is_rejected() {
    let mut c = setup(false, "1000000000", "200000000");
    seed_position(&mut c, "500000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let r = submit(&mut c, Side::REDUCE, "600000000", None);
    assert!(reasons_of(&r).contains(&"R_EXIT_EXCEEDS_POSITION".to_string()));
    let ok = submit(&mut c, Side::REDUCE, "200000000", None);
    assert_eq!(verdict_of(&ok), "APPROVED");
}

#[test]
#[should_panic(expected = "E22_FILL_NOT_PERMITTED")]
fn an_open_approved_before_the_kill_switch_cannot_fill_after_it() {
    let mut c = setup(false, "1000000000", "200000000");
    let seq = approve_and_get_seq(&mut c, "500000000");
    set_ctx(monitor(), T0 + 650_000_000_000);
    c.engage_kill_switch(DESK.to_string(), "brake".to_string());
    set_ctx(trader(), T0 + 700_000_000_000);
    let head = head_hash(&c);
    c.record_fill(DESK.to_string(), seq, sim_fill("500000000"), head);
}

#[test]
#[should_panic(expected = "E22_FILL_NOT_PERMITTED")]
fn an_exit_fill_cannot_exceed_what_is_open_at_fill_time() {
    let mut c = setup(false, "1000000000", "200000000");
    seed_position(&mut c, "500000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let r = submit(&mut c, Side::REDUCE, "500000000", None);
    let seq = r["seq"].as_u64().unwrap();
    // The position shrinks before the fill lands.
    let mut d = c.desks.get(DESK).cloned().unwrap();
    d.open_positions[0].notional_usd = "100000000".to_string();
    c.desks.insert(DESK.to_string(), d);
    let head = head_hash(&c);
    c.record_fill(DESK.to_string(), seq, sim_fill("500000000"), head);
}

#[test]
fn one_evidence_receipt_backs_one_approved_open() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let ev = c.submit_evidence(
        DESK.to_string(),
        bundle(
            vec![
                signed_item(
                    "newswire-a.example",
                    "newswire-a",
                    EvidenceKind::NEWS,
                    T0 + 500_000_000_000,
                    Stance::SUPPORT,
                    1,
                ),
                signed_item(
                    "hyperliquid",
                    "exchange-hl",
                    EvidenceKind::PRICE,
                    T0 + 550_000_000_000,
                    Stance::SUPPORT,
                    2,
                ),
            ],
            Direction::LONG,
        ),
        head,
    );
    let ev_seq = ev["seq"].as_u64().unwrap();
    let first = submit(&mut c, Side::OPEN_LONG, "500000000", Some(ev_seq));
    assert_eq!(verdict_of(&first), "APPROVED");
    let second = submit(&mut c, Side::OPEN_LONG, "500000000", Some(ev_seq));
    assert_eq!(verdict_of(&second), "REJECTED");
    assert!(reasons_of(&second).contains(&"R_EVIDENCE_USED".to_string()));
}

#[test]
fn an_unknown_evidence_seq_is_a_recorded_refusal() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let r = submit(&mut c, Side::OPEN_LONG, "500000000", Some(999));
    assert_eq!(verdict_of(&r), "REJECTED");
    assert!(reasons_of(&r).contains(&"R_NO_EVIDENCE".to_string()));
}

#[test]
fn claimed_equity_above_the_last_mark_does_not_count() {
    let mut c = setup(false, "1000000000", "200000000");
    // Mark $9,700 against a $10,000 start: $300 down, past the $200 limit.
    set_ctx(owner(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    c.record_mark(DESK.to_string(), "9700000000".to_string(), head, None);
    set_ctx(trader(), T0 + 700_000_000_000);
    // The caller claims $10,000, which would read as flat.
    let r = submit(&mut c, Side::OPEN_LONG, "500000000", None);
    assert!(reasons_of(&r).contains(&"R_DAILY_LOSS".to_string()));
}

#[test]
#[should_panic(expected = "E02_NOT_AGENT")]
fn an_analyst_cannot_record_a_mark() {
    let mut c = setup(false, "1000000000", "200000000");
    let analyst: AccountId = "analyst.test.near".parse().unwrap();
    set_ctx(owner(), T0 + 100_000_000_000);
    c.register_agent(DESK.to_string(), analyst.clone(), "ANALYST".to_string());
    set_ctx(analyst, T0 + 600_000_000_000);
    let head = head_hash(&c);
    c.record_mark(DESK.to_string(), "1".to_string(), head, None);
}

#[test]
#[should_panic(expected = "E18_NON_ASCII")]
fn an_oversized_client_id_is_refused() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let mut i = intent(Side::OPEN_LONG, "500000000");
    i.client_id = "x".repeat(65);
    c.submit_intent(
        DESK.to_string(),
        i,
        head,
        "10000000000".to_string(),
        None,
        None,
        None,
    );
}

#[test]
#[should_panic(expected = "E22_FILL_NOT_PERMITTED")]
fn an_open_cannot_fill_after_the_daily_loss_limit_is_hit() {
    let mut c = setup(false, "1000000000", "200000000");
    let seq = approve_and_get_seq(&mut c, "500000000");
    // $300 down after approval, past the $200 limit.
    set_ctx(owner(), T0 + 900_000_000_000);
    let head = head_hash(&c);
    c.record_mark(DESK.to_string(), "9700000000".to_string(), head, None);
    set_ctx(trader(), T0 + 1_000_000_000_000);
    let head = head_hash(&c);
    c.record_fill(DESK.to_string(), seq, sim_fill("500000000"), head);
}

// ---------------------------------------------------------------- security review fixes

fn two_group_items(a: u8, b: u8) -> Vec<EvidenceItemInput> {
    vec![
        signed_item(
            "newswire-a.example",
            "newswire-a",
            EvidenceKind::NEWS,
            T0 + 500_000_000_000,
            Stance::SUPPORT,
            a,
        ),
        signed_item(
            "hyperliquid",
            "exchange-hl",
            EvidenceKind::PRICE,
            T0 + 550_000_000_000,
            Stance::SUPPORT,
            b,
        ),
    ]
}

fn submit_ev(c: &mut Ual, items: Vec<EvidenceItemInput>) -> Value {
    let head = head_hash(c);
    c.submit_evidence(DESK.to_string(), bundle(items, Direction::LONG), head)
}

/// Runs `f` and returns the panic message, or None if it did not panic.
fn panic_message<F: FnOnce()>(f: F) -> Option<String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
        .err()
        .map(|e| {
            e.downcast_ref::<String>()
                .cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default()
        })
}

#[test]
fn the_same_signed_items_in_a_new_bundle_cannot_back_a_second_open() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let ev1 = submit_ev(&mut c, two_group_items(1, 2));
    let first = submit(
        &mut c,
        Side::OPEN_LONG,
        "500000000",
        Some(ev1["seq"].as_u64().unwrap()),
    );
    assert_eq!(verdict_of(&first), "APPROVED");

    // Same signed items, brand new EVIDENCE receipt.
    let ev2 = submit_ev(&mut c, two_group_items(1, 2));
    assert!(reasons_of(&ev2).contains(&"R_EVIDENCE_USED".to_string()));
    assert_eq!(
        ev2["evidence"]["k"].as_u64().unwrap(),
        0,
        "spent items do not count"
    );
    assert_eq!(ev2["sizeMultiplierBps"].as_u64().unwrap(), 0);
    let second = submit(
        &mut c,
        Side::OPEN_LONG,
        "500000000",
        Some(ev2["seq"].as_u64().unwrap()),
    );
    assert_eq!(verdict_of(&second), "REJECTED");
    // Every item in ev2 is already invalid, so k is 0 and the gate says uncorroborated.
    assert!(reasons_of(&second).contains(&"R_UNCORROBORATED".to_string()));
}

#[test]
fn two_bundles_submitted_before_either_is_spent_still_back_only_one_open() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let ev1 = submit_ev(&mut c, two_group_items(1, 2));
    let ev2 = submit_ev(&mut c, two_group_items(1, 2));
    assert_eq!(
        ev2["evidence"]["k"].as_u64().unwrap(),
        2,
        "nothing was spent yet"
    );
    let first = submit(
        &mut c,
        Side::OPEN_LONG,
        "500000000",
        Some(ev1["seq"].as_u64().unwrap()),
    );
    assert_eq!(verdict_of(&first), "APPROVED");
    let second = submit(
        &mut c,
        Side::OPEN_LONG,
        "500000000",
        Some(ev2["seq"].as_u64().unwrap()),
    );
    assert_eq!(verdict_of(&second), "REJECTED");
    assert!(reasons_of(&second).contains(&"R_EVIDENCE_USED".to_string()));
    assert_eq!(second["sizeMultiplierBps"].as_u64().unwrap(), 0);
}

#[test]
fn a_rejected_intent_does_not_spend_its_evidence_items() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let ev1 = submit_ev(&mut c, two_group_items(1, 2));
    // $5,000 against a $1,000 cap is refused, so nothing is spent.
    let refused = submit(
        &mut c,
        Side::OPEN_LONG,
        "5000000000",
        Some(ev1["seq"].as_u64().unwrap()),
    );
    assert_eq!(verdict_of(&refused), "REJECTED");
    let ev2 = submit_ev(&mut c, two_group_items(1, 2));
    assert_eq!(ev2["evidence"]["k"].as_u64().unwrap(), 2);
}

#[test]
fn a_fetcher_revoked_after_the_bundle_no_longer_counts_at_intent_time() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let ev = submit_ev(&mut c, two_group_items(1, 2));
    set_ctx(owner(), T0 + 610_000_000_000);
    c.revoke_fetcher(DESK.to_string(), fetcher_pubkey_str());
    set_ctx(trader(), T0 + 620_000_000_000);
    let r = submit(
        &mut c,
        Side::OPEN_LONG,
        "500000000",
        Some(ev["seq"].as_u64().unwrap()),
    );
    assert_eq!(verdict_of(&r), "REJECTED");
    assert!(reasons_of(&r).contains(&"R_FETCHER_REVOKED".to_string()));
    assert!(reasons_of(&r).contains(&"R_UNCORROBORATED".to_string()));
    assert_eq!(r["sizeMultiplierBps"].as_u64().unwrap(), 0);
}

#[test]
fn oversized_or_malformed_fill_and_quote_strings_are_refused() {
    let mut c = setup(false, "1000000000", "200000000");
    let seq = approve_and_get_seq(&mut c, "500000000");
    let head = head_hash(&c);

    let mut f = sim_fill("500000000");
    f.reference = "r".repeat(257);
    assert!(panic_message(|| {
        c.record_fill(DESK.to_string(), seq, f, head.clone());
    })
    .is_some_and(|m| m.contains("E18_NON_ASCII")));
    let mut f = sim_fill("500000000");
    f.price = "9".repeat(65);
    assert!(panic_message(|| {
        c.record_fill(DESK.to_string(), seq, f, head.clone());
    })
    .is_some_and(|m| m.contains("E18_NON_ASCII")));
    let mut f = sim_fill("500000000");
    f.evidence_sha256 = Some("not-a-hash".to_string());
    assert!(panic_message(|| {
        c.record_fill(DESK.to_string(), seq, f, head.clone());
    })
    .is_some_and(|m| m.contains("E13_BAD_HASH")));

    // quoteRef on an intent.
    let q = |kind: &str, sha: &str, sig: &str| {
        let mut i = intent(Side::OPEN_LONG, "100000000");
        i.quote_ref = Some(QuoteRef {
            kind: kind.to_string(),
            sha256: sha.to_string(),
            signature: sig.to_string(),
        });
        i
    };
    for (i, want) in [
        (q(&"k".repeat(65), &"a".repeat(64), "s"), "E18_NON_ASCII"),
        (q("k", "xyz", "s"), "E13_BAD_HASH"),
        (q("k", &"a".repeat(64), &"s".repeat(257)), "E18_NON_ASCII"),
    ] {
        let head = head_hash(&c);
        assert!(panic_message(|| {
            c.submit_intent(
                DESK.to_string(),
                i,
                head,
                "10000000000".to_string(),
                None,
                None,
                None,
            );
        })
        .is_some_and(|m| m.contains(want)));
    }
}

#[test]
fn oversized_or_malformed_evidence_fields_are_refused() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);

    let mut b = bundle(two_group_items(1, 2), Direction::LONG);
    b.asset = "A".repeat(65);
    assert!(panic_message(|| {
        c.submit_evidence(DESK.to_string(), b, head.clone());
    })
    .is_some_and(|m| m.contains("E18_NON_ASCII")));

    // The signature covers the edited field, so the refusal is about the field, not a bad sig.
    let resign = |mut it: EvidenceItemInput| {
        let sig = fetcher_key().sign(&it.item.signing_bytes());
        it.signature = bs58::encode(sig.to_bytes()).into_string();
        it
    };
    type Edit = Box<dyn Fn(&mut EvidenceItemInput)>;
    let edits: Vec<(Edit, &str)> = vec![
        (
            Box::new(|i| i.item.url = format!("https://{}", "u".repeat(300))),
            "E18_NON_ASCII",
        ),
        (
            Box::new(|i| i.item.source_group = "g".repeat(65)),
            "E18_NON_ASCII",
        ),
        (
            Box::new(|i| i.item.fetched_at = format!("0{}", i.item.fetched_at)),
            "E21_MALFORMED_AMOUNT",
        ),
        (
            Box::new(|i| i.item.fetched_at = "9".repeat(60)),
            "E21_MALFORMED_AMOUNT",
        ),
    ];
    for (edit, want) in edits {
        let mut items = two_group_items(1, 2);
        edit(&mut items[0]);
        items[0] = resign(items[0].clone());
        let b = bundle(items, Direction::LONG);
        assert!(
            panic_message(|| {
                c.submit_evidence(DESK.to_string(), b, head.clone());
            })
            .is_some_and(|m| m.contains(want)),
            "{want}"
        );
    }
}

#[test]
fn a_policy_may_declare_at_most_32_sources() {
    let with_sources = |n: usize| {
        // "hyperliquid" plus n-1 filler sources, in the first group.
        let mut list = vec!["\"hyperliquid\"".to_string()];
        list.extend((1..n).map(|i| format!("\"s{i:02}.example\"")));
        policy_json(true, "1000000000", "200000000").replace(
            r#""sources":["hyperliquid"]"#,
            &format!(r#""sources":[{}]"#, list.join(",")),
        )
    };
    // The fixture already has 2 other sources, so 30 here makes 32 and 31 makes 33.
    assert!(crate::policy::Policy::parse_and_validate(&with_sources(30), DESK).is_ok());
    assert_eq!(
        crate::policy::Policy::parse_and_validate(&with_sources(31), DESK).err(),
        Some("E05_POLICY_INVALID")
    );
}

#[test]
fn a_desk_may_commit_at_most_16_policies() {
    let mut c = setup(true, "1000000000", "200000000");
    set_ctx(owner(), T0 + 100_000_000_000);
    // setup committed one. Fifteen more fit.
    for _ in 0..15 {
        c.commit_policy(
            DESK.to_string(),
            policy_json(true, "1000000000", "200000000"),
        );
    }
    let msg = panic_message(|| {
        c.commit_policy(
            DESK.to_string(),
            policy_json(true, "1000000000", "200000000"),
        );
    });
    assert!(msg.is_some_and(|m| m.contains("E05_POLICY_INVALID")));
}

#[test]
fn a_close_must_be_for_exactly_what_is_open() {
    let mut c = setup(false, "1000000000", "200000000");
    seed_position(&mut c, "500000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let small = submit(&mut c, Side::CLOSE, "1", None);
    assert_eq!(verdict_of(&small), "REJECTED");
    assert!(reasons_of(&small).contains(&"R_CLOSE_SIZE_MISMATCH".to_string()));
    let exact = submit(&mut c, Side::CLOSE, "500000000", None);
    assert_eq!(verdict_of(&exact), "APPROVED");
}

#[test]
#[should_panic(expected = "E22_FILL_NOT_PERMITTED")]
fn a_close_fill_smaller_than_the_open_position_is_refused() {
    let mut c = setup(false, "1000000000", "200000000");
    seed_position(&mut c, "500000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let r = submit(&mut c, Side::CLOSE, "500000000", None);
    let seq = r["seq"].as_u64().unwrap();
    // The position grows before the fill lands, so a $500 fill no longer closes it.
    let mut d = c.desks.get(DESK).cloned().unwrap();
    d.open_positions[0].notional_usd = "900000000".to_string();
    c.desks.insert(DESK.to_string(), d);
    let head = head_hash(&c);
    c.record_fill(DESK.to_string(), seq, sim_fill("500000000"), head);
}

#[test]
#[should_panic(expected = "E11_ALREADY_FILLED")]
fn one_settlement_reference_cannot_back_two_fills() {
    let mut c = setup(false, "1000000000", "200000000");
    let first = approve_and_get_seq(&mut c, "100000000");
    let head = head_hash(&c);
    c.record_fill(DESK.to_string(), first, sim_fill("100000000"), head);
    set_ctx(trader(), T0 + 700_000_000_000);
    let head = head_hash(&c);
    let r = c.submit_intent(
        DESK.to_string(),
        intent(Side::OPEN_LONG, "100000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        None,
    );
    let second = r["seq"].as_u64().unwrap();
    let head = head_hash(&c);
    // Same kind, same reference, different intent.
    c.record_fill(DESK.to_string(), second, sim_fill("100000000"), head);
}

/// The reference key is per desk, so another desk cannot front-run and burn a real venue tx
/// reference. Cross-desk reuse is a documented known limit.
#[test]
fn the_same_settlement_reference_is_allowed_on_a_different_desk() {
    const OTHER: &str = "other-desk";
    let mut c = setup(false, "1000000000", "200000000");
    let first = approve_and_get_seq(&mut c, "100000000");
    let head = head_hash(&c);
    c.record_fill(DESK.to_string(), first, sim_fill("100000000"), head);

    // A second desk, same owner and trader, its own policy and mark.
    testing_env!(ctx(owner(), T0, NearToken::from_near(1)).build());
    c.create_desk(OTHER.to_string());
    c.commit_policy(
        OTHER.to_string(),
        policy_json(false, "1000000000", "200000000")
            .replace(r#""deskId":"yk-desk""#, r#""deskId":"other-desk""#),
    );
    c.register_agent(OTHER.to_string(), trader(), "TRADER".to_string());
    let head = c.get_head(OTHER.to_string()).unwrap()["hash"]
        .as_str()
        .unwrap()
        .to_string();
    c.record_mark(OTHER.to_string(), "10000000000".to_string(), head, None);

    set_ctx(trader(), T0 + 700_000_000_000);
    let head = c.get_head(OTHER.to_string()).unwrap()["hash"]
        .as_str()
        .unwrap()
        .to_string();
    let r = c.submit_intent(
        OTHER.to_string(),
        intent(Side::OPEN_LONG, "100000000"),
        head,
        "10000000000".to_string(),
        None,
        None,
        None,
    );
    assert_eq!(verdict_of(&r), "APPROVED");
    let head = c.get_head(OTHER.to_string()).unwrap()["hash"]
        .as_str()
        .unwrap()
        .to_string();
    // The very reference desk one already spent.
    let f = c.record_fill(
        OTHER.to_string(),
        r["seq"].as_u64().unwrap(),
        sim_fill("100000000"),
        head,
    );
    assert_eq!(f["kind"].as_str().unwrap(), "FILL");
}

#[test]
#[should_panic(expected = "E23_POSITIONS_OPEN")]
fn the_mode_cannot_change_while_a_position_is_open() {
    let mut c = setup(false, "1000000000", "200000000");
    seed_position(&mut c, "500000000");
    set_ctx(owner(), T0 + 600_000_000_000);
    c.set_mode(DESK.to_string(), "live".to_string());
}

#[test]
fn the_mode_can_change_once_the_desk_is_flat() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(owner(), T0 + 600_000_000_000);
    c.set_mode(DESK.to_string(), "live".to_string());
    assert_eq!(c.get_desk(DESK.to_string()).unwrap().mode, Mode::Live);
}

#[test]
fn a_trader_cannot_record_a_mark_but_the_owner_and_monitor_can() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let msg = panic_message(|| {
        c.record_mark(DESK.to_string(), "99999999999".to_string(), head, None);
    });
    assert!(msg.is_some_and(|m| m.contains("E02_NOT_AGENT")));

    set_ctx(monitor(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let m = c.record_mark(DESK.to_string(), "10000000000".to_string(), head, None);
    assert_eq!(m["kind"].as_str().unwrap(), "MARK");
    set_ctx(owner(), T0 + 1_000_000_000_000);
    let head = head_hash(&c);
    let m = c.record_mark(DESK.to_string(), "10000000000".to_string(), head, None);
    assert_eq!(m["kind"].as_str().unwrap(), "MARK");
}

#[test]
fn a_zero_notional_is_refused_on_intents_and_fills() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(trader(), T0 + 600_000_000_000);
    let head = head_hash(&c);
    let msg = panic_message(|| {
        c.submit_intent(
            DESK.to_string(),
            intent(Side::OPEN_LONG, "0"),
            head,
            "10000000000".to_string(),
            None,
            None,
            None,
        );
    });
    assert!(msg.is_some_and(|m| m.contains("E21_MALFORMED_AMOUNT")));

    let seq = approve_and_get_seq(&mut c, "500000000");
    let head = head_hash(&c);
    let msg = panic_message(|| {
        c.record_fill(DESK.to_string(), seq, sim_fill("0"), head);
    });
    assert!(msg.is_some_and(|m| m.contains("E21_MALFORMED_AMOUNT")));
}

#[test]
fn negative_zero_is_not_a_spelling_of_zero() {
    assert_eq!(parse_micro_usd("-0"), None);
    assert_eq!(parse_micro_usd("0"), Some(0));
    assert_eq!(parse_micro_usd("-1"), Some(-1));
}

#[test]
fn the_kill_switch_still_engages_while_the_contract_is_paused() {
    let mut c = setup(false, "1000000000", "200000000");
    set_ctx(owner(), T0 + 600_000_000_000);
    c.pause();
    set_ctx(monitor(), T0 + 610_000_000_000);
    c.engage_kill_switch(DESK.to_string(), "brake".to_string());
    assert!(c.get_desk(DESK.to_string()).unwrap().kill_switch);
}

#[test]
fn get_receipts_does_not_overflow_on_a_huge_start() {
    let c = setup(false, "1000000000", "200000000");
    assert!(c.get_receipts(DESK.to_string(), u64::MAX, 100).is_empty());
}
