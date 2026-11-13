//! Policy validation and accessors. SPEC.md 3.2.
//!
//! The schema in SPEC.md 3.2 is enforced here by hand rather than by a JSON Schema engine,
//! because a wasm contract should not carry one and because the checks have to be identical
//! to the TypeScript pre-check in `packages/sdk`. `test-vectors/policies/` pins both.
//!
//! `commit_policy` also re-serializes the parsed policy canonically and compares the bytes
//! to what was sent. If they differ the commit is rejected with E04_POLICY_NOT_CANONICAL.
//! Without that check two different byte strings could both claim to be "the policy" while
//! hashing differently, and `policyHash` would mean nothing.

use serde_json::Value;

use crate::canonical::{canonical, is_hex64, reject_floats_and_non_ascii};
use crate::errors::*;
use crate::types::{parse_micro_usd_unsigned, MicroUsd, Mode};

/// Keys the schema permits. `additionalProperties: false`.
const ALLOWED_KEYS: &[&str] = &[
    "schema",
    "deskId",
    "maxPositionUsd",
    "maxOpenPositions",
    "dailyLossLimitUsd",
    "allowedAssets",
    "allowedVenues",
    "slippageCapBps",
    "allowedModes",
    "killSwitch",
    "venueAccounts",
    "evidence",
    "description",
];

const REQUIRED_KEYS: &[&str] = &[
    "schema",
    "deskId",
    "maxPositionUsd",
    "maxOpenPositions",
    "dailyLossLimitUsd",
    "allowedAssets",
    "allowedVenues",
    "slippageCapBps",
    "allowedModes",
    "killSwitch",
];

const VENUES: &[&str] = &["hyperliquid", "polymarket", "near-intents-1click", "paper"];
const MODES: &[&str] = &["paper", "live"];

/// A validated policy. Holds the parsed value so accessors stay cheap and the canonical
/// bytes stay the single source of truth.
pub struct Policy {
    value: Value,
    canonical_bytes: String,
}

impl Policy {
    /// Parse, validate and canonicalise. `desk_id` must match `policy.deskId`.
    ///
    /// Returns the policy, or the E-code to panic with.
    pub fn parse_and_validate(json_str: &str, desk_id: &str) -> Result<Policy, &'static str> {
        let value: Value = serde_json::from_str(json_str).map_err(|_| E05_POLICY_INVALID)?;
        reject_floats_and_non_ascii(&value)?;
        validate(&value, desk_id)?;

        let canonical_bytes = canonical(&value)?;
        // The bytes the caller sent must already be canonical.
        if canonical_bytes != json_str {
            return Err(E04_POLICY_NOT_CANONICAL);
        }
        Ok(Policy {
            value,
            canonical_bytes,
        })
    }

    /// Reconstruct from bytes already stored by this contract. Those bytes were canonical
    /// when they were accepted, so validation is not repeated.
    pub fn from_stored(canonical_bytes: String) -> Policy {
        let value: Value = serde_json::from_str(&canonical_bytes)
            .unwrap_or_else(|_| near_sdk::env::panic_str(E05_POLICY_INVALID));
        Policy {
            value,
            canonical_bytes,
        }
    }

    pub fn canonical_str(&self) -> &str {
        &self.canonical_bytes
    }

    fn obj(&self) -> &serde_json::Map<String, Value> {
        self.value.as_object().expect("validated as object")
    }

    pub fn max_position_usd(&self) -> MicroUsd {
        parse_micro_usd_unsigned(self.obj()["maxPositionUsd"].as_str().unwrap_or("0")).unwrap_or(0)
    }

    pub fn max_open_positions(&self) -> u64 {
        self.obj()["maxOpenPositions"].as_u64().unwrap_or(0)
    }

    pub fn daily_loss_limit_usd(&self) -> MicroUsd {
        parse_micro_usd_unsigned(self.obj()["dailyLossLimitUsd"].as_str().unwrap_or("0"))
            .unwrap_or(0)
    }

    pub fn slippage_cap_bps(&self) -> u64 {
        self.obj()["slippageCapBps"].as_u64().unwrap_or(0)
    }

    pub fn asset_allowed(&self, asset: &str) -> bool {
        self.obj()["allowedAssets"]
            .as_array()
            .map(|a| a.iter().any(|v| v.as_str() == Some(asset)))
            .unwrap_or(false)
    }

    pub fn venue_allowed(&self, venue: &str) -> bool {
        self.obj()["allowedVenues"]
            .as_array()
            .map(|a| a.iter().any(|v| v.as_str() == Some(venue)))
            .unwrap_or(false)
    }

    pub fn mode_allowed(&self, mode: Mode) -> bool {
        self.obj()["allowedModes"]
            .as_array()
            .map(|a| a.iter().any(|v| v.as_str() == Some(mode.as_str())))
            .unwrap_or(false)
    }

    pub fn auto_on_daily_loss(&self) -> bool {
        self.obj()["killSwitch"]["autoOnDailyLoss"]
            .as_bool()
            .unwrap_or(false)
    }

    pub fn monitor_may_engage(&self) -> bool {
        self.obj()["killSwitch"]["monitorMayEngage"]
            .as_bool()
            .unwrap_or(false)
    }

    // --- evidence block ---

    fn evidence(&self) -> Option<&Value> {
        self.obj().get("evidence").filter(|v| !v.is_null())
    }

    /// True when this desk must cite evidence to open. False for the `plain`, `debate` and
    /// `hier` baseline desks, which is how the study compares gated against ungated.
    pub fn evidence_required(&self) -> bool {
        self.evidence()
            .and_then(|e| e["required"].as_bool())
            .unwrap_or(false)
    }

    pub fn evidence_max_age_sec(&self) -> u64 {
        self.evidence()
            .and_then(|e| e["maxAgeSec"].as_u64())
            .unwrap_or(0)
    }

    pub fn verifier_code_hash(&self) -> Option<String> {
        self.evidence()
            .and_then(|e| e["verifierCodeHash"].as_str())
            .map(|s| s.to_string())
    }

    /// The independence group a source belongs to, or None if the policy does not declare it.
    /// An undeclared source counts for nothing: the gate fails closed.
    pub fn group_for_source(&self, source: &str) -> Option<String> {
        let groups = self.evidence()?["groups"].as_array()?;
        for g in groups {
            let sources = g["sources"].as_array()?;
            if sources.iter().any(|s| s.as_str() == Some(source)) {
                return g["group"].as_str().map(|s| s.to_string());
            }
        }
        None
    }

    fn size_table(&self) -> Vec<u32> {
        self.evidence()
            .and_then(|e| e["sizeTableBps"].as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_u64())
                    .map(|n| n as u32)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Size multiplier in basis points for `k` agreeing independent groups. Indices beyond
    /// the table reuse its last entry, so `[0,0,5000,10000]` means k>=3 is full size.
    pub fn size_multiplier_bps(&self, k: u32) -> u32 {
        let table = self.size_table();
        if table.is_empty() {
            // No table means no sizing guidance, so nothing may open through the gate.
            return 0;
        }
        let idx = (k as usize).min(table.len() - 1);
        table[idx]
    }

    /// The smallest k the table gives a non-zero size to. Used to decide whether a blocked
    /// intent is blocked for lack of corroboration specifically.
    pub fn min_k_for_nonzero(&self) -> Option<u32> {
        self.size_table()
            .iter()
            .position(|&m| m > 0)
            .map(|i| i as u32)
    }
}

// ---------------------------------------------------------------- validation

fn validate(value: &Value, desk_id: &str) -> Result<(), &'static str> {
    let obj = value.as_object().ok_or(E05_POLICY_INVALID)?;

    for key in obj.keys() {
        if !ALLOWED_KEYS.contains(&key.as_str()) {
            return Err(E05_POLICY_INVALID);
        }
    }
    for key in REQUIRED_KEYS {
        if !obj.contains_key(*key) {
            return Err(E05_POLICY_INVALID);
        }
    }

    if obj["schema"].as_str() != Some("krexa.ual.policy/1") {
        return Err(E05_POLICY_INVALID);
    }

    let policy_desk = obj["deskId"].as_str().ok_or(E05_POLICY_INVALID)?;
    if !valid_desk_id(policy_desk) {
        return Err(E05_POLICY_INVALID);
    }
    // A policy names the desk it governs. Committing desk A's policy under desk B would make
    // the hash meaningless as a binding.
    if policy_desk != desk_id {
        return Err(E05_POLICY_INVALID);
    }

    check_unsigned_amount(&obj["maxPositionUsd"])?;
    check_unsigned_amount(&obj["dailyLossLimitUsd"])?;

    let mop = obj["maxOpenPositions"].as_u64().ok_or(E05_POLICY_INVALID)?;
    if !(1..=50).contains(&mop) {
        return Err(E05_POLICY_INVALID);
    }

    let slip = obj["slippageCapBps"].as_u64().ok_or(E05_POLICY_INVALID)?;
    if slip > 1000 {
        return Err(E05_POLICY_INVALID);
    }

    check_sorted_unique_strings(&obj["allowedAssets"], 1, 64, valid_asset)?;
    check_sorted_unique_strings(&obj["allowedVenues"], 1, 4, |s| VENUES.contains(&s))?;
    check_sorted_unique_strings(&obj["allowedModes"], 1, 2, |s| MODES.contains(&s))?;

    // killSwitch
    {
        let ks = obj["killSwitch"].as_object().ok_or(E05_POLICY_INVALID)?;
        for key in ks.keys() {
            if !matches!(key.as_str(), "autoOnDailyLoss" | "monitorMayEngage") {
                return Err(E05_POLICY_INVALID);
            }
        }
        if !ks.get("autoOnDailyLoss").is_some_and(|v| v.is_boolean())
            || !ks.get("monitorMayEngage").is_some_and(|v| v.is_boolean())
        {
            return Err(E05_POLICY_INVALID);
        }
    }

    if let Some(va) = obj.get("venueAccounts") {
        let arr = va.as_array().ok_or(E05_POLICY_INVALID)?;
        if arr.len() > 8 {
            return Err(E05_POLICY_INVALID);
        }
        for entry in arr {
            let e = entry.as_object().ok_or(E05_POLICY_INVALID)?;
            for key in e.keys() {
                if !matches!(key.as_str(), "venue" | "address") {
                    return Err(E05_POLICY_INVALID);
                }
            }
            let venue = e
                .get("venue")
                .and_then(|v| v.as_str())
                .ok_or(E05_POLICY_INVALID)?;
            let addr = e
                .get("address")
                .and_then(|v| v.as_str())
                .ok_or(E05_POLICY_INVALID)?;
            if venue.is_empty() || addr.is_empty() || addr.len() > 128 {
                return Err(E05_POLICY_INVALID);
            }
        }
    }

    if let Some(desc) = obj.get("description") {
        let d = desc.as_str().ok_or(E05_POLICY_INVALID)?;
        if d.len() > 280 {
            return Err(E05_POLICY_INVALID);
        }
    }

    if let Some(ev) = obj.get("evidence") {
        validate_evidence(ev)?;
    }

    Ok(())
}

fn validate_evidence(ev: &Value) -> Result<(), &'static str> {
    let e = ev.as_object().ok_or(E05_POLICY_INVALID)?;
    const EV_KEYS: &[&str] = &[
        "required",
        "maxAgeSec",
        "groups",
        "sizeTableBps",
        "verifierCodeHash",
    ];
    for key in e.keys() {
        if !EV_KEYS.contains(&key.as_str()) {
            return Err(E05_POLICY_INVALID);
        }
    }
    for key in EV_KEYS {
        if !e.contains_key(*key) {
            return Err(E05_POLICY_INVALID);
        }
    }

    if !e["required"].is_boolean() {
        return Err(E05_POLICY_INVALID);
    }

    let max_age = e["maxAgeSec"].as_u64().ok_or(E05_POLICY_INVALID)?;
    if !(1..=86_400).contains(&max_age) {
        return Err(E05_POLICY_INVALID);
    }

    let groups = e["groups"].as_array().ok_or(E05_POLICY_INVALID)?;
    if groups.len() > 32 {
        return Err(E05_POLICY_INVALID);
    }
    let mut group_names: Vec<&str> = Vec::new();
    let mut all_sources: Vec<&str> = Vec::new();
    for g in groups {
        let go = g.as_object().ok_or(E05_POLICY_INVALID)?;
        for key in go.keys() {
            if !matches!(key.as_str(), "group" | "sources") {
                return Err(E05_POLICY_INVALID);
            }
        }
        let name = go
            .get("group")
            .and_then(|v| v.as_str())
            .ok_or(E05_POLICY_INVALID)?;
        if name.is_empty() || name.len() > 64 {
            return Err(E05_POLICY_INVALID);
        }
        if group_names.contains(&name) {
            return Err(E05_POLICY_INVALID);
        }
        group_names.push(name);

        let sources = go
            .get("sources")
            .and_then(|v| v.as_array())
            .ok_or(E05_POLICY_INVALID)?;
        if sources.is_empty() {
            return Err(E05_POLICY_INVALID);
        }
        for s in sources {
            let name = s.as_str().ok_or(E05_POLICY_INVALID)?;
            if name.is_empty() || name.len() > 128 {
                return Err(E05_POLICY_INVALID);
            }
            // One source may not sit in two groups, or counting independent groups would
            // be ambiguous and an attacker could pick the reading that helps them.
            if all_sources.contains(&name) {
                return Err(E05_POLICY_INVALID);
            }
            all_sources.push(name);
            if all_sources.len() > MAX_SOURCES_PER_POLICY {
                return Err(E05_POLICY_INVALID);
            }
        }
    }

    let table = e["sizeTableBps"].as_array().ok_or(E05_POLICY_INVALID)?;
    if table.is_empty() || table.len() > 33 {
        return Err(E05_POLICY_INVALID);
    }
    let mut prev = 0u64;
    for (i, v) in table.iter().enumerate() {
        let n = v.as_u64().ok_or(E05_POLICY_INVALID)?;
        if n > 10_000 {
            return Err(E05_POLICY_INVALID);
        }
        // More corroboration must never buy a smaller position. A table that dipped would
        // let an owner claim a gate while leaving a hole at a specific k.
        if i > 0 && n < prev {
            return Err(E05_POLICY_INVALID);
        }
        prev = n;
    }
    // k = 0 means nothing agreed. It must size to zero.
    if table[0].as_u64() != Some(0) {
        return Err(E05_POLICY_INVALID);
    }

    let vch = e["verifierCodeHash"].as_str().ok_or(E05_POLICY_INVALID)?;
    if !is_hex64(vch) {
        return Err(E05_POLICY_INVALID);
    }

    Ok(())
}

fn check_unsigned_amount(v: &Value) -> Result<(), &'static str> {
    let s = v.as_str().ok_or(E05_POLICY_INVALID)?;
    if s.is_empty() || s.len() > 15 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(E05_POLICY_INVALID);
    }
    if s.len() > 1 && s.starts_with('0') {
        return Err(E05_POLICY_INVALID);
    }
    Ok(())
}

/// Sets in a policy must be sorted and deduplicated, per SPEC.md 3.1, so the canonical form
/// of a set is unique.
fn check_sorted_unique_strings<F>(
    v: &Value,
    min: usize,
    max: usize,
    item_ok: F,
) -> Result<(), &'static str>
where
    F: Fn(&str) -> bool,
{
    let arr = v.as_array().ok_or(E05_POLICY_INVALID)?;
    if arr.len() < min || arr.len() > max {
        return Err(E05_POLICY_INVALID);
    }
    let mut prev: Option<&str> = None;
    for item in arr {
        let s = item.as_str().ok_or(E05_POLICY_INVALID)?;
        if !item_ok(s) {
            return Err(E05_POLICY_INVALID);
        }
        if let Some(p) = prev {
            if s.as_bytes() <= p.as_bytes() {
                return Err(E05_POLICY_INVALID);
            }
        }
        prev = Some(s);
    }
    Ok(())
}

/// `^[a-z0-9][a-z0-9-]{1,47}$`
pub fn valid_desk_id(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 2 || b.len() > 48 {
        return false;
    }
    let first_ok = b[0].is_ascii_lowercase() || b[0].is_ascii_digit();
    first_ok
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `^[A-Z0-9:._-]{1,32}$`
fn valid_asset(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.bytes().all(|b| {
            b.is_ascii_uppercase() || b.is_ascii_digit() || matches!(b, b':' | b'.' | b'_' | b'-')
        })
}
