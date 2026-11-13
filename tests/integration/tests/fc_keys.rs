//! Function-call key restrictions, enforced by the NEAR protocol rather than by the contract.
//!
//! This is the file the AI Security and Defense track asks for (SPEC.md 0, `tracks/06-security.md`):
//! keys scoped to one contract with limits explained, and a demonstration that a
//! prompt-injected or simply buggy agent cannot move value.
//!
//! The distinction being proved matters. The contract has no withdraw method, so there is
//! nothing to call even if an agent wanted to. But that is an argument about this contract's
//! source. These tests show something stronger: the agent's key cannot send a transfer, cannot
//! call an owner method, and cannot touch any other account, because the protocol rejects the
//! transaction before any contract code runs. An attacker who finds a bug in the ledger still
//! cannot reach the trader's balance.

mod common;

use anyhow::Result;
use common::*;
use serde_json::json;

/// The control case. The same account, through its full-access key, can transfer.
/// Without this, a test showing the function-call key cannot transfer would prove nothing:
/// the account might simply be broke or frozen.
#[tokio::test]
async fn full_access_key_can_transfer_so_the_denial_below_is_about_the_key() -> Result<()> {
    let h = setup(false).await?;
    let beneficiary = h.worker.dev_create_account().await?;
    let before = beneficiary.view_account().await?.balance;

    h.trader_full
        .transfer_near(
            beneficiary.id(),
            near_workspaces::types::NearToken::from_near(1),
        )
        .await?
        .into_result()?;

    let after = beneficiary.view_account().await?.balance;
    assert!(
        after > before,
        "the full-access key must be able to transfer, or the next tests are vacuous"
    );
    Ok(())
}

#[tokio::test]
async fn function_call_key_cannot_transfer_near() -> Result<()> {
    let h = setup(false).await?;
    let beneficiary = h.worker.dev_create_account().await?;
    let before = beneficiary.view_account().await?.balance;

    let result = h
        .trader_fc
        .transfer_near(
            beneficiary.id(),
            near_workspaces::types::NearToken::from_near(1),
        )
        .await;

    assert!(
        result.is_err() || result.as_ref().unwrap().clone().into_result().is_err(),
        "a function-call key must not be able to transfer NEAR"
    );
    let after = beneficiary.view_account().await?.balance;
    assert_eq!(after, before, "no value may move");
    Ok(())
}

#[tokio::test]
async fn function_call_key_cannot_call_an_owner_method() -> Result<()> {
    let h = setup(false).await?;

    // commit_policy is not in AGENT_METHODS, so the protocol refuses it. Even if it did get
    // through, the contract's own owner check would refuse it too: two independent barriers.
    let result = h
        .trader_fc
        .call(h.contract.id(), "commit_policy")
        .args_json(json!({"desk_id": DESK, "policy_json": policy_json(false)}))
        .max_gas()
        .transact()
        .await;

    assert!(
        result.is_err() || result.unwrap().into_result().is_err(),
        "a function-call key must not reach commit_policy"
    );
    Ok(())
}

/// A Trader's key cannot touch the kill switch in either direction. The Monitor's can engage
/// it and still cannot release it: see `monitor_may_engage_but_its_key_cannot_release`.
#[tokio::test]
async fn a_traders_key_cannot_engage_or_release_the_kill_switch() -> Result<()> {
    let h = setup(false).await?;

    for method in ["engage_kill_switch", "release_kill_switch"] {
        let result = h
            .trader_fc
            .call(h.contract.id(), method)
            .args_json(json!({"desk_id": DESK, "reason": "injected"}))
            .max_gas()
            .transact()
            .await;
        assert!(
            result.is_err() || result.unwrap().into_result().is_err(),
            "a trader's function-call key must not reach {method}"
        );
    }

    let desk: serde_json::Value = h
        .contract
        .view("get_desk")
        .args_json(json!({"desk_id": DESK}))
        .await?
        .json()?;
    assert_eq!(desk["killSwitch"], json!(false));
    Ok(())
}

#[tokio::test]
async fn function_call_key_cannot_register_a_fetcher() -> Result<()> {
    let h = setup(true).await?;

    // Registering a fetcher key is how evidence becomes trustworthy. If an agent could do it,
    // it could sign its own fake evidence and the whole gate would be decorative.
    let result = h
        .trader_fc
        .call(h.contract.id(), "register_fetcher")
        .args_json(json!({
            "desk_id": DESK,
            "pubkey": "ed25519:11111111111111111111111111111111",
            "attestation_hash": "0".repeat(64),
            "label": "attacker",
        }))
        .max_gas()
        .transact()
        .await;

    assert!(
        result.is_err() || result.unwrap().into_result().is_err(),
        "a function-call key must not reach register_fetcher"
    );
    Ok(())
}

#[tokio::test]
async fn function_call_key_cannot_call_a_different_contract() -> Result<()> {
    let h = setup(false).await?;

    // The key's receiver_id is pinned to the ledger contract, so a second deployment of the
    // very same code is still out of reach.
    let other = h.worker.dev_deploy(&load_wasm()?).await?;
    other
        .call("new")
        .args_json(json!({"owner": h.owner.id()}))
        .transact()
        .await?
        .into_result()?;

    let result = h
        .trader_fc
        .call(other.id(), "create_desk")
        .args_json(json!({"desk_id": "elsewhere"}))
        .deposit(near_workspaces::types::NearToken::from_near(1))
        .max_gas()
        .transact()
        .await;

    assert!(
        result.is_err() || result.unwrap().into_result().is_err(),
        "a function-call key scoped to one contract must not reach another"
    );
    Ok(())
}

#[tokio::test]
async fn function_call_key_cannot_add_another_key_to_escalate() -> Result<()> {
    let h = setup(false).await?;

    // The obvious escape: use the restricted key to grant yourself an unrestricted one.
    // AddKey is not a function call, so the permission does not cover it.
    let escalated =
        near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
    let result = h
        .trader_fc
        .batch(h.trader_fc.id())
        .add_key(
            escalated.public_key(),
            near_workspaces::types::AccessKey::full_access(),
        )
        .transact()
        .await;

    assert!(
        result.is_err() || result.unwrap().into_result().is_err(),
        "a function-call key must not be able to add a full-access key"
    );
    Ok(())
}

#[tokio::test]
async fn function_call_key_can_do_exactly_its_four_methods() -> Result<()> {
    let h = setup(false).await?;

    // record_mark is in the allowed list, so this must succeed. The positive case belongs
    // next to the denials: a key that could do nothing at all would pass every test above
    // while being useless.
    let head = h.head().await?;
    let result = h
        .trader_fc
        .call(h.contract.id(), "record_mark")
        .args_json(json!({
            "desk_id": DESK,
            "equity_usd": "10000000000",
            "prev_hash": head,
            "decisions_root": null,
        }))
        .gas(AGENT_GAS)
        .transact()
        .await?;

    assert!(
        result.is_success(),
        "record_mark is in the allowed method list and must work: {:?}",
        result.failures()
    );

    let receipts = h.receipts().await?;
    let last = receipts.last().expect("a receipt");
    assert_eq!(last["kind"], json!("MARK"));
    assert_eq!(last["agent"], json!(h.trader_fc.id().to_string()));
    Ok(())
}

/// A finite gas allowance is a real failure mode, not a theoretical one: SPEC.md 15 lists an
/// exhausted allowance as something that can lock an agent out, and the Security track asks
/// for the limits to be explained rather than just set.
#[tokio::test]
async fn the_agent_key_allowance_is_finite_and_visible() -> Result<()> {
    let h = setup(false).await?;

    let keys = h.trader_fc.view_access_keys().await?;
    let fc_keys: Vec<_> = keys
        .iter()
        .filter(|k| {
            matches!(
                k.access_key.permission,
                near_workspaces::types::AccessKeyPermission::FunctionCall(_)
            )
        })
        .collect();
    assert_eq!(fc_keys.len(), 1, "exactly one function-call key");

    if let near_workspaces::types::AccessKeyPermission::FunctionCall(ref p) =
        fc_keys[0].access_key.permission
    {
        assert_eq!(
            p.receiver_id,
            h.contract.id().to_string(),
            "the key must be pinned to the ledger contract"
        );
        let mut methods = p.method_names.clone();
        methods.sort();
        let mut expected: Vec<String> = AGENT_METHODS.iter().map(|m| m.to_string()).collect();
        expected.sort();
        assert_eq!(methods, expected, "no method beyond the four");
        assert!(
            p.allowance.is_some_and(|a| !a.is_zero()),
            "the allowance is finite on purpose; see docs/FAILURE_CASES.md"
        );
    }
    Ok(())
}

/// The failure mode SPEC.md 15 names, reproduced on purpose.
///
/// A function-call key reserves the gas it attaches against its allowance *before* the call
/// runs, so the allowance drains whether or not the gas is used. When it is gone the agent is
/// locked out: it cannot write receipts and it cannot top itself up, because adding or
/// replacing a key is not a function call. Only the owner can issue a fresh key.
///
/// This is the argument for `AGENT_GAS` being 30 TGas rather than `max_gas()`, and for
/// monitoring the allowance. docs/FAILURE_CASES.md carries the operational version.
#[tokio::test]
async fn allowance_exhaustion_locks_the_agent_out() -> Result<()> {
    let h = setup(false).await?;

    // Enough for a call or two, not for many.
    let (_, starved) = agent_with_allowance(
        &h.worker,
        &h.owner,
        h.contract.id(),
        "starved",
        near_workspaces::types::NearToken::from_millinear(5),
        "TRADER",
    )
    .await?;
    h.owner
        .call(h.contract.id(), "register_agent")
        .args_json(json!({"desk_id": DESK, "agent": starved.id(), "role": "TRADER"}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // Burn the allowance. Marks are rate limited to one per 5 minutes, so these calls fail
    // on the contract's own rule after the first; either way the gas is reserved and spent,
    // which is exactly the point.
    let mut locked_out_after: Option<usize> = None;
    for attempt in 0..6 {
        let head = h.head().await.unwrap_or_default();
        let result = starved
            .call(h.contract.id(), "record_mark")
            .args_json(json!({
                "desk_id": DESK,
                "equity_usd": "10000000000",
                "prev_hash": head,
                "decisions_root": null,
            }))
            .gas(AGENT_GAS)
            .transact()
            .await;

        // A transport-level error carrying NotEnoughAllowance is the lockout. A contract-level
        // rejection (E14_MARK_TOO_SOON) is not, so the two are told apart by the message.
        if let Err(e) = &result {
            let msg = format!("{e:?}");
            if msg.contains("NotEnoughAllowance") {
                locked_out_after = Some(attempt);
                break;
            }
        }
    }

    assert!(
        locked_out_after.is_some(),
        "a 0.005 NEAR allowance must run out within a handful of 30 TGas calls"
    );

    // The owner's full-access key is unaffected, which is how a desk recovers.
    let head = h.head().await?;
    h.owner
        .call(h.contract.id(), "engage_kill_switch")
        .args_json(json!({"desk_id": DESK, "reason": "agent key allowance exhausted"}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let _ = head;

    let desk: serde_json::Value = h
        .contract
        .view("get_desk")
        .args_json(json!({"desk_id": DESK}))
        .await?
        .json()?;
    assert_eq!(
        desk["killSwitch"],
        json!(true),
        "the owner can still act when an agent key is dead"
    );
    Ok(())
}

/// Least privilege per role, and the asymmetry that makes a rule-based brake safe.
///
/// The Monitor's key carries `engage_kill_switch` and `record_mark` and nothing else. It can
/// stop the desk. It cannot restart it, cannot submit an intent, and cannot submit evidence.
/// Only the desk owner, holding a full-access key, can release the brake.
#[tokio::test]
async fn monitor_may_engage_but_its_key_cannot_release() -> Result<()> {
    let h = setup(false).await?;

    // Engage: allowed by the key and allowed by the policy's monitorMayEngage.
    h.monitor_fc
        .call(h.contract.id(), "engage_kill_switch")
        .args_json(json!({
            "desk_id": DESK,
            "reason": "attack suspect: 3 agents cite one single-source item",
        }))
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
    assert_eq!(
        desk["killSwitch"],
        json!(true),
        "the monitor can stop the desk"
    );

    // Release: not in the key's method list, so the protocol refuses it. The contract would
    // refuse it too, since release is owner-only. Two independent barriers again.
    let release = h
        .monitor_fc
        .call(h.contract.id(), "release_kill_switch")
        .args_json(json!({"desk_id": DESK}))
        .gas(AGENT_GAS)
        .transact()
        .await;
    assert!(
        release.is_err() || release.unwrap().into_result().is_err(),
        "a monitor must never be able to release the kill switch"
    );

    // Nor can it trade.
    let head = h.head().await?;
    let trade = h
        .monitor_fc
        .call(h.contract.id(), "submit_intent")
        .args_json(json!({
            "desk_id": DESK,
            "intent": {
                "clientId": "monitor-overreach", "venue": "hyperliquid", "asset": "BTC",
                "side": "OPEN_LONG", "notionalUsd": "100000000", "maxSlippageBps": 30,
                "quoteRef": null,
            },
            "prev_hash": head, "equity_usd": "10000000000",
            "decision_hash": null, "ai_sig_hash": null, "evidence_seq": null,
        }))
        .gas(AGENT_GAS)
        .transact()
        .await;
    assert!(
        trade.is_err() || trade.unwrap().into_result().is_err(),
        "a monitor must not be able to submit an intent"
    );

    // The owner releases it, which is the only route back.
    h.owner
        .call(h.contract.id(), "release_kill_switch")
        .args_json(json!({"desk_id": DESK}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let desk: serde_json::Value = h
        .contract
        .view("get_desk")
        .args_json(json!({"desk_id": DESK}))
        .await?
        .json()?;
    assert_eq!(desk["killSwitch"], json!(false));
    Ok(())
}

/// Each role's key carries the minimum for its job and no more.
#[tokio::test]
async fn every_role_gets_a_least_privilege_key() -> Result<()> {
    assert_eq!(methods_for_role("TRADER").len(), 4);
    assert_eq!(methods_for_role("BASELINE").len(), 4);
    assert_eq!(
        methods_for_role("MONITOR"),
        vec!["engage_kill_switch", "record_mark"]
    );
    assert_eq!(methods_for_role("DATA"), vec!["record_mark"]);
    // An Analyst writes no receipts at all: it emits a signal off chain.
    assert!(methods_for_role("ANALYST").is_empty());

    // No role, anywhere, gets a method that could release the brake or change the rules.
    for role in ["TRADER", "BASELINE", "MONITOR", "DATA", "ANALYST"] {
        for m in methods_for_role(role) {
            assert!(
                !matches!(
                    m.as_str(),
                    "release_kill_switch"
                        | "commit_policy"
                        | "set_mode"
                        | "register_agent"
                        | "retire_agent"
                        | "register_fetcher"
                        | "revoke_fetcher"
                        | "record_flow"
                        | "pause"
                        | "unpause"
                ),
                "role {role} must not hold owner method {m}"
            );
        }
    }
    Ok(())
}
