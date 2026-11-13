//! The full flow on a real sandbox node: policy, evidence, intent, fill, mark, kill switch,
//! and a chain anyone can recompute.
//!
//! The unit tests in `contracts/ual/src/tests.rs` cover the same logic against a mocked VM.
//! What this file adds is everything the mock cannot: real gas, real storage accounting, real
//! block timestamps, real sub-accounts, and receipts read back through view calls the way the
//! explorer and the scorecard will read them.

mod common;

use anyhow::Result;
use common::*;
use serde_json::json;

/// Walks the sequence from SPEC.md 19: a single-source fake is refused, a corroborated signal
/// trades at half size, and the chain holds together throughout.
#[tokio::test]
async fn evidence_gate_end_to_end_on_sandbox() -> Result<()> {
    let h = setup(true).await?;

    // --- an equity mark, so opens are not blocked for want of one ---
    let head = h.head().await?;
    h.trader_fc
        .call(h.contract.id(), "record_mark")
        .args_json(json!({
            "desk_id": DESK, "equity_usd": "10000000000",
            "prev_hash": head, "decisions_root": null,
        }))
        .gas(AGENT_GAS)
        .transact()
        .await?
        .into_result()?;

    // --- one source says so. This is the fake-headline case. ---
    let now = now_ns();
    let head = h.head().await?;
    let ev: serde_json::Value = h
        .trader_fc
        .call(h.contract.id(), "submit_evidence")
        .args_json(json!({
            "desk_id": DESK,
            "bundle": {
                "asset": "BTC",
                "direction": "LONG",
                "verifierCodeHash": "a".repeat(64),
                "items": [h.signed_item("newswire-a.example", "NEWS", now, "SUPPORT", 1)],
            },
            "prev_hash": head,
        }))
        .gas(AGENT_GAS)
        .transact()
        .await?
        .json()?;

    assert_eq!(ev["kind"], json!("EVIDENCE"));
    assert_eq!(ev["evidence"]["k"], json!(1), "one group agreed");
    assert_eq!(ev["sizeMultiplierBps"], json!(0), "k=1 sizes to nothing");
    assert_eq!(
        ev["evidence"]["attested"],
        json!(true),
        "the sandbox fetcher is registered with an attestation hash"
    );
    let ev_seq = ev["seq"].as_u64().expect("seq");

    let head = h.head().await?;
    let rejected: serde_json::Value = h
        .trader_fc
        .call(h.contract.id(), "submit_intent")
        .args_json(json!({
            "desk_id": DESK,
            "intent": {
                "clientId": "trader-sandbox-1", "venue": "hyperliquid", "asset": "BTC",
                "side": "OPEN_LONG", "notionalUsd": "500000000", "maxSlippageBps": 30,
                "quoteRef": null,
            },
            "prev_hash": head,
            "equity_usd": "10000000000",
            "decision_hash": "c".repeat(64),
            "ai_sig_hash": null,
            "evidence_seq": ev_seq,
        }))
        .gas(AGENT_GAS)
        .transact()
        .await?
        .json()?;

    assert_eq!(rejected["verdict"], json!("REJECTED"));
    let reasons: Vec<String> = rejected["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert!(reasons.contains(&"R_UNCORROBORATED".to_string()));
    assert!(reasons.contains(&"PAPER_ONLY_UNCORROBORATED".to_string()));
    // The refusal is a receipt and the transaction succeeded. That is the design.
    assert_eq!(rejected["kind"], json!("INTENT"));

    // --- a second independent group agrees, so the trade goes through at half size ---
    let now = now_ns();
    let head = h.head().await?;
    let ev2: serde_json::Value = h
        .trader_fc
        .call(h.contract.id(), "submit_evidence")
        .args_json(json!({
            "desk_id": DESK,
            "bundle": {
                "asset": "BTC",
                "direction": "LONG",
                "verifierCodeHash": "a".repeat(64),
                "items": [
                    h.signed_item("newswire-a.example", "NEWS", now, "SUPPORT", 1),
                    h.signed_item("hyperliquid", "PRICE", now, "SUPPORT", 2),
                ],
            },
            "prev_hash": head,
        }))
        .gas(AGENT_GAS)
        .transact()
        .await?
        .json()?;

    assert_eq!(ev2["evidence"]["k"], json!(2));
    assert_eq!(ev2["sizeMultiplierBps"], json!(5000));
    let ev2_seq = ev2["seq"].as_u64().expect("seq");

    let head = h.head().await?;
    let approved: serde_json::Value = h
        .trader_fc
        .call(h.contract.id(), "submit_intent")
        .args_json(json!({
            "desk_id": DESK,
            "intent": {
                "clientId": "trader-sandbox-2", "venue": "hyperliquid", "asset": "BTC",
                "side": "OPEN_LONG", "notionalUsd": "500000000", "maxSlippageBps": 30,
                "quoteRef": null,
            },
            "prev_hash": head,
            "equity_usd": "10000000000",
            "decision_hash": "d".repeat(64),
            "ai_sig_hash": null,
            "evidence_seq": ev2_seq,
        }))
        .gas(AGENT_GAS)
        .transact()
        .await?
        .json()?;

    assert_eq!(approved["verdict"], json!("APPROVED"));
    assert_eq!(approved["sizeMultiplierBps"], json!(5000));
    let intent_seq = approved["seq"].as_u64().expect("seq");

    // --- fill it, at the approved size and not the requested one ---
    let head = h.head().await?;
    let too_big = h
        .trader_fc
        .call(h.contract.id(), "record_fill")
        .args_json(json!({
            "desk_id": DESK, "intent_seq": intent_seq,
            "fill": {
                "kind": "SIMULATED", "simulated": true,
                "ref": "paper:hl-mid:BTC:sandbox", "price": "68012",
                "notionalUsd": "500000000", "evidenceSha256": "e".repeat(64),
            },
            "prev_hash": head,
        }))
        .gas(AGENT_GAS)
        .transact()
        .await?;
    assert!(
        too_big.into_result().is_err(),
        "a half-sized approval must not be fillable at full size"
    );

    let head = h.head().await?;
    let fill: serde_json::Value = h
        .trader_fc
        .call(h.contract.id(), "record_fill")
        .args_json(json!({
            "desk_id": DESK, "intent_seq": intent_seq,
            "fill": {
                "kind": "SIMULATED", "simulated": true,
                "ref": "paper:hl-mid:BTC:sandbox", "price": "68012",
                "notionalUsd": "250000000", "evidenceSha256": "e".repeat(64),
            },
            "prev_hash": head,
        }))
        .gas(AGENT_GAS)
        .transact()
        .await?
        .json()?;
    assert_eq!(fill["kind"], json!("FILL"));
    assert_eq!(fill["mode"], json!("paper"), "paper is labelled on chain");

    let positions: Vec<serde_json::Value> = h
        .contract
        .view("get_open_positions")
        .args_json(json!({"desk_id": DESK}))
        .await?
        .json()?;
    assert_eq!(positions.len(), 1);
    assert_eq!(positions[0]["notionalUsd"], json!("250000000"));

    // --- the Monitor engages the kill switch; opens stop, exits do not ---
    //
    // The Monitor holds its own least-privilege key: engage_kill_switch and record_mark, and
    // not release_kill_switch. No LLM sits in this path, so there is nothing here to
    // prompt-inject.
    h.monitor_fc
        .call(h.contract.id(), "engage_kill_switch")
        .args_json(json!({"desk_id": DESK, "reason": "attack suspect: single-source citation"}))
        .gas(AGENT_GAS)
        .transact()
        .await?
        .into_result()?;

    let desk: serde_json::Value = h
        .contract
        .view("get_desk")
        .args_json(json!({"desk_id": DESK}))
        .await?
        .json()?;
    assert_eq!(desk["killSwitch"], json!(true));
    assert_eq!(
        desk["killReason"],
        json!("attack suspect: single-source citation"),
        "the reason is recorded, not just the state"
    );

    let head = h.head().await?;
    let blocked: serde_json::Value = h
        .trader_fc
        .call(h.contract.id(), "submit_intent")
        .args_json(json!({
            "desk_id": DESK,
            "intent": {
                "clientId": "trader-sandbox-3", "venue": "hyperliquid", "asset": "BTC",
                "side": "OPEN_LONG", "notionalUsd": "100000000", "maxSlippageBps": 30,
                "quoteRef": null,
            },
            "prev_hash": head, "equity_usd": "10000000000",
            "decision_hash": null, "ai_sig_hash": null, "evidence_seq": ev2_seq,
        }))
        .gas(AGENT_GAS)
        .transact()
        .await?
        .json()?;
    let reasons: Vec<String> = blocked["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert!(reasons.contains(&"R_KILL_SWITCH".to_string()));

    let head = h.head().await?;
    let exit: serde_json::Value = h
        .trader_fc
        .call(h.contract.id(), "submit_intent")
        .args_json(json!({
            "desk_id": DESK,
            "intent": {
                "clientId": "trader-sandbox-4", "venue": "hyperliquid", "asset": "BTC",
                "side": "CLOSE", "notionalUsd": "250000000", "maxSlippageBps": 30,
                "quoteRef": null,
            },
            "prev_hash": head, "equity_usd": "10000000000",
            "decision_hash": null, "ai_sig_hash": null, "evidence_seq": null,
        }))
        .gas(AGENT_GAS)
        .transact()
        .await?
        .json()?;
    assert_eq!(
        exit["verdict"],
        json!("APPROVED"),
        "you can always exit, kill switch or not, with no evidence"
    );

    // --- the chain, read back the way the explorer will read it ---
    let receipts = h.receipts().await?;
    assert!(receipts.len() >= 10, "got {} receipts", receipts.len());

    let genesis: String = h
        .contract
        .view("genesis_hash")
        .args_json(json!({"desk_id": DESK}))
        .await?
        .json()?;
    assert_eq!(receipts[0]["prevHash"].as_str().unwrap(), genesis);
    for pair in receipts.windows(2) {
        assert_eq!(
            pair[1]["prevHash"].as_str().unwrap(),
            pair[0]["hash"].as_str().unwrap(),
            "receipt {} does not chain to {}",
            pair[1]["seq"],
            pair[0]["seq"],
        );
        assert_eq!(
            pair[1]["seq"].as_u64().unwrap(),
            pair[0]["seq"].as_u64().unwrap() + 1,
        );
    }

    // Every receipt carries the same key set, whatever its kind, so a reader can verify a
    // hash without knowing the kind first.
    let mut key_sets = std::collections::HashSet::new();
    for r in &receipts {
        let mut keys: Vec<&String> = r.as_object().unwrap().keys().collect();
        keys.sort();
        key_sets.insert(format!("{keys:?}"));
    }
    assert_eq!(key_sets.len(), 1, "receipt shape must not depend on kind");

    Ok(())
}

#[tokio::test]
async fn a_stale_prev_hash_appends_nothing_on_a_real_node() -> Result<()> {
    let h = setup(false).await?;

    let head = h.head().await?;
    h.trader_fc
        .call(h.contract.id(), "record_mark")
        .args_json(json!({
            "desk_id": DESK, "equity_usd": "10000000000",
            "prev_hash": head.clone(), "decisions_root": null,
        }))
        .gas(AGENT_GAS)
        .transact()
        .await?
        .into_result()?;

    let seq_before = h.head_seq().await?;

    // Replay the same head the previous write already consumed.
    let replayed = h
        .trader_fc
        .call(h.contract.id(), "submit_intent")
        .args_json(json!({
            "desk_id": DESK,
            "intent": {
                "clientId": "replay", "venue": "hyperliquid", "asset": "BTC",
                "side": "OPEN_LONG", "notionalUsd": "100000000", "maxSlippageBps": 30,
                "quoteRef": null,
            },
            "prev_hash": head,
            "equity_usd": "10000000000",
            "decision_hash": null, "ai_sig_hash": null, "evidence_seq": null,
        }))
        .gas(AGENT_GAS)
        .transact()
        .await?;

    assert!(
        replayed.into_result().is_err(),
        "stale head must be refused"
    );
    assert_eq!(
        h.head_seq().await?,
        seq_before,
        "a refused write must not move the head"
    );
    Ok(())
}

#[tokio::test]
async fn a_baseline_desk_with_no_evidence_block_trades_without_citations() -> Result<()> {
    // This is the `plain` desk of the study: same limits, no evidence gate. If this did not
    // work there would be nothing to compare the gated desk against.
    let h = setup(false).await?;

    let head = h.head().await?;
    h.trader_fc
        .call(h.contract.id(), "record_mark")
        .args_json(json!({
            "desk_id": DESK, "equity_usd": "10000000000",
            "prev_hash": head, "decisions_root": null,
        }))
        .gas(AGENT_GAS)
        .transact()
        .await?
        .into_result()?;

    let head = h.head().await?;
    let r: serde_json::Value = h
        .trader_fc
        .call(h.contract.id(), "submit_intent")
        .args_json(json!({
            "desk_id": DESK,
            "intent": {
                "clientId": "plain-1", "venue": "hyperliquid", "asset": "BTC",
                "side": "OPEN_LONG", "notionalUsd": "500000000", "maxSlippageBps": 30,
                "quoteRef": null,
            },
            "prev_hash": head, "equity_usd": "10000000000",
            "decision_hash": null, "ai_sig_hash": null, "evidence_seq": null,
        }))
        .gas(AGENT_GAS)
        .transact()
        .await?
        .json()?;

    assert_eq!(r["verdict"], json!("APPROVED"));
    assert_eq!(r["sizeMultiplierBps"], json!(10000), "full size, no gate");
    assert!(r["evidenceReceiptSeq"].is_null());
    Ok(())
}
