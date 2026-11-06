//! NEP-297 events. Standard `krexa_ual`, version `1.0.0`. SPEC.md 4.3.
//!
//! `receipt_appended` carries the full receipt in `data`, which is what makes an indexer
//! viable later: SPEC.md 4.6 notes that a mainnet build would store only
//! `{seq, kind, verdict, hash}` on chain and reconstruct the rest from these logs.

use near_sdk::env;
use serde_json::{json, Value};

pub const STANDARD: &str = "krexa_ual";
pub const VERSION: &str = "1.0.0";

pub fn emit(event: &str, data: Value) {
    let payload = json!({
        "standard": STANDARD,
        "version": VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

pub const DESK_CREATED: &str = "desk_created";
pub const POLICY_COMMITTED: &str = "policy_committed";
pub const AGENT_REGISTERED: &str = "agent_registered";
pub const AGENT_RETIRED: &str = "agent_retired";
pub const RECEIPT_APPENDED: &str = "receipt_appended";
pub const MODE_CHANGED: &str = "mode_changed";
pub const KILL_SWITCH_ENGAGED: &str = "kill_switch_engaged";
pub const KILL_SWITCH_RELEASED: &str = "kill_switch_released";
pub const CONTRACT_PAUSED: &str = "contract_paused";
pub const CONTRACT_UNPAUSED: &str = "contract_unpaused";
pub const FETCHER_REGISTERED: &str = "fetcher_registered";
pub const FETCHER_REVOKED: &str = "fetcher_revoked";
