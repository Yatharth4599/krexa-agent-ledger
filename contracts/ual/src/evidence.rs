//! The on-chain evidence gate. SPEC.md 2A.2 item 3, second bullet.
//!
//! What this proves: each cited item was signed by a fetcher key the desk owner registered,
//! the item was fresh at submission, and the agreeing sources belong to distinct independence
//! groups the policy declared in advance. From that it computes k and a size multiplier.
//!
//! What this does not prove: that any item is true. A TEE attestation binds what was fetched,
//! from where and when. It says nothing about whether the content was accurate, and an
//! attacker who plants the same fake across several declared groups raises k legitimately.
//! That limit is the point of hypothesis H4 in SPEC.md 2A.6 and is measured, not hidden.
//!
//! The gate fails closed throughout: an unresolvable source contributes nothing, and a single
//! item with a bad signature taints the whole bundle rather than being quietly dropped.

use near_sdk::env;
use serde_json::{json, Value};

use crate::canonical::{canonical_hash, is_hex64};
use crate::errors::*;
use crate::policy::Policy;
use crate::types::*;

pub struct GateResult {
    pub summary: EvidenceSummary,
}

impl EvidenceBundleInput {
    pub fn to_value(&self) -> Value {
        let items: Vec<Value> = self
            .items
            .iter()
            .map(|i| {
                json!({
                    "item": i.item.to_value(),
                    "fetcherKey": i.fetcher_key,
                    "signature": i.signature,
                    "stance": i.stance.as_str(),
                })
            })
            .collect();
        json!({
            "asset": self.asset,
            "direction": self.direction.as_str(),
            "verifierCodeHash": self.verifier_code_hash,
            "items": items,
        })
    }
}

/// Evaluate a bundle against the desk's registered fetchers and the committed policy.
///
/// Panics (nothing appended) only for structural problems: too many items, a fetcher key that
/// was never registered or has been revoked, a malformed content hash. Everything else is
/// recorded on the receipt.
pub fn evaluate_bundle(
    bundle: &EvidenceBundleInput,
    policy: &Policy,
    desk: &Desk,
    now_ns: u64,
) -> GateResult {
    require(bundle.items.len() <= MAX_BUNDLE_ITEMS, E20_BUNDLE_TOO_LARGE);
    require(is_hex64(&bundle.verifier_code_hash), E13_BAD_HASH);

    let max_age_ns = policy.evidence_max_age_sec().saturating_mul(1_000_000_000);

    let mut summary_items: Vec<EvidenceSummaryItem> = Vec::with_capacity(bundle.items.len());
    let mut support_groups: Vec<String> = Vec::new();
    let mut contradict_groups: Vec<String> = Vec::new();
    let mut any_bad_sig = false;
    let mut any_stale = false;
    let mut attested = true;

    for entry in &bundle.items {
        // A key the owner never registered is a structural error, not a soft rejection:
        // we have no basis on which to even record what it claims.
        let fetcher = desk
            .fetcher(&entry.fetcher_key)
            .unwrap_or_else(|| env::panic_str(E19_UNKNOWN_FETCHER));
        require(!fetcher.revoked, E19_UNKNOWN_FETCHER);
        if !fetcher.is_attested() {
            attested = false;
        }

        let pubkey = decode_ed25519_pubkey(&entry.fetcher_key)
            .unwrap_or_else(|| env::panic_str(E19_UNKNOWN_FETCHER));
        require(is_hex64(&entry.item.content_hash), E13_BAD_HASH);

        // --- signature ---
        let sig_ok = match decode_ed25519_signature(&entry.signature) {
            None => false,
            Some(sig) => env::ed25519_verify(&sig, &entry.item.signing_bytes()[..], &pubkey),
        };
        if !sig_ok {
            any_bad_sig = true;
        }

        // --- freshness ---
        let fetched_at: u64 = entry.item.fetched_at.parse().unwrap_or(0);
        // A timestamp in the future is treated as stale rather than as extra-fresh, so a
        // fetcher cannot buy itself a longer window by lying forward.
        let fresh = fetched_at > 0
            && fetched_at <= now_ns
            && now_ns.saturating_sub(fetched_at) <= max_age_ns;
        if !fresh {
            any_stale = true;
        }

        let valid = sig_ok && fresh;

        // --- independence group ---
        // The policy decides which group a source belongs to. The fetcher's own claim in
        // `sourceGroup` is signed but not authoritative: the hashed policy is. A source the
        // policy does not declare counts for nothing.
        let resolved_group = policy.group_for_source(&entry.item.source);

        if valid {
            if let Some(ref g) = resolved_group {
                match entry.stance {
                    Stance::SUPPORT => {
                        if !support_groups.contains(g) {
                            support_groups.push(g.clone());
                        }
                    }
                    Stance::CONTRADICT => {
                        if !contradict_groups.contains(g) {
                            contradict_groups.push(g.clone());
                        }
                    }
                    Stance::NEUTRAL => {}
                }
            }
        }

        summary_items.push(EvidenceSummaryItem {
            evidence_id: entry.item.content_hash.clone(),
            source_group: resolved_group.unwrap_or_else(|| "UNDECLARED".to_string()),
            stance: entry.stance,
            fetched_at: entry.item.fetched_at.clone(),
            fetcher_key: entry.fetcher_key.clone(),
            valid,
        });
    }

    // k is agreeing groups net of contradicting groups, floored at zero. SPEC.md 2A.2 item 4.
    let k = (support_groups.len() as u32).saturating_sub(contradict_groups.len() as u32);
    let size_multiplier_bps = policy.size_multiplier_bps(k);

    let bundle_hash = canonical_hash(&bundle.to_value());

    GateResult {
        summary: EvidenceSummary {
            bundle_hash,
            asset: bundle.asset.clone(),
            direction: bundle.direction,
            items: summary_items,
            k,
            size_multiplier_bps,
            verifier_code_hash: bundle.verifier_code_hash.clone(),
            any_bad_sig,
            any_stale,
            attested,
        },
    }
}
