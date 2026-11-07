//! Error and rejection codes, exactly the sets in SPEC.md 4.4 and 4.5.
//!
//! The distinction matters and is load bearing:
//!
//! - An **error** (`E*`) is a panic. The transaction fails and nothing is appended to the
//!   chain. These are structural problems: wrong caller, broken hash chain, malformed policy.
//! - A **rejection reason** (`R*`) is recorded. The transaction succeeds, a receipt is
//!   appended with `verdict: "REJECTED"` and the reasons listed. A blocked trade is part of
//!   the record, not an absence from it. That is the whole point of the ledger.
//!
//! Nothing here is added beyond the two spec lists, with one documented exception noted at
//! `PAPER_ONLY_UNCORROBORATED`.

// --- 4.4 Errors (panics: nothing appended) ---

pub const E01_NOT_OWNER: &str = "E01_NOT_OWNER";
pub const E02_NOT_AGENT: &str = "E02_NOT_AGENT";
pub const E03_CHAIN_BROKEN: &str = "E03_CHAIN_BROKEN";
pub const E04_POLICY_NOT_CANONICAL: &str = "E04_POLICY_NOT_CANONICAL";
pub const E05_POLICY_INVALID: &str = "E05_POLICY_INVALID";
pub const E06_NO_POLICY: &str = "E06_NO_POLICY";
pub const E07_PAUSED: &str = "E07_PAUSED";
pub const E08_DESK_EXISTS: &str = "E08_DESK_EXISTS";
pub const E09_UNKNOWN_DESK: &str = "E09_UNKNOWN_DESK";
pub const E10_INTENT_NOT_APPROVED: &str = "E10_INTENT_NOT_APPROVED";
pub const E11_ALREADY_FILLED: &str = "E11_ALREADY_FILLED";
pub const E12_INSUFFICIENT_STORAGE: &str = "E12_INSUFFICIENT_STORAGE";
pub const E13_BAD_HASH: &str = "E13_BAD_HASH";
pub const E14_MARK_TOO_SOON: &str = "E14_MARK_TOO_SOON";
pub const E15_FILL_EXCEEDS_INTENT: &str = "E15_FILL_EXCEEDS_INTENT";
pub const E16_LABEL_MISMATCH: &str = "E16_LABEL_MISMATCH";
pub const E17_MODE_NOT_ALLOWED: &str = "E17_MODE_NOT_ALLOWED";
pub const E18_NON_ASCII: &str = "E18_NON_ASCII";
pub const E19_UNKNOWN_FETCHER: &str = "E19_UNKNOWN_FETCHER";
pub const E20_BUNDLE_TOO_LARGE: &str = "E20_BUNDLE_TOO_LARGE";

/// Maximum evidence items in one bundle, per E20.
pub const MAX_BUNDLE_ITEMS: usize = 16;

/// Addition beyond SPEC.md 4.4, recorded in docs/RECEIPTS.md.
///
/// A money field that is not an exact decimal integer string has no correct interpretation,
/// and none of E01 to E20 describes it. Overloading one of them would have made the ledger
/// lie about why a call failed, so this is a new code rather than a borrowed one. It is the
/// only code in this contract that SPEC.md 4.4 does not list.
pub const E21_MALFORMED_AMOUNT: &str = "E21_MALFORMED_AMOUNT";

/// Addition beyond SPEC.md 4.4. A fill that the desk's state no longer permits: an open while
/// the kill switch is engaged or past its approval window, an exit larger than the position,
/// or a fill in a different mode from the one the intent was approved in.
pub const E22_FILL_NOT_PERMITTED: &str = "E22_FILL_NOT_PERMITTED";

/// Free-text identifiers on an intent are capped so one call cannot buy unbounded storage.
pub const MAX_IDENT_LEN: usize = 64;

// --- 4.5 Rejection reasons (REJECTED receipts, transaction succeeds) ---

pub const R_KILL_SWITCH: &str = "R_KILL_SWITCH";
pub const R_MAX_POSITION: &str = "R_MAX_POSITION";
pub const R_MAX_OPEN_POSITIONS: &str = "R_MAX_OPEN_POSITIONS";
pub const R_DAILY_LOSS: &str = "R_DAILY_LOSS";
pub const R_ASSET_NOT_ALLOWED: &str = "R_ASSET_NOT_ALLOWED";
pub const R_VENUE_NOT_ALLOWED: &str = "R_VENUE_NOT_ALLOWED";
pub const R_SLIPPAGE_CAP: &str = "R_SLIPPAGE_CAP";
pub const R_NO_EQUITY_MARK: &str = "R_NO_EQUITY_MARK";
pub const R_NO_EVIDENCE: &str = "R_NO_EVIDENCE";
pub const R_EVIDENCE_STALE: &str = "R_EVIDENCE_STALE";
pub const R_EVIDENCE_BAD_SIG: &str = "R_EVIDENCE_BAD_SIG";
pub const R_UNCORROBORATED: &str = "R_UNCORROBORATED";
pub const R_EVIDENCE_MISMATCH: &str = "R_EVIDENCE_MISMATCH";
/// The EVIDENCE receipt already backed an approved open. One bundle, one trade.
pub const R_EVIDENCE_USED: &str = "R_EVIDENCE_USED";
/// REDUCE or CLOSE with no open position on that asset and venue.
pub const R_NO_POSITION: &str = "R_NO_POSITION";
/// REDUCE or CLOSE for more notional than is open. Without this an exit is an unchecked open.
pub const R_EXIT_EXCEEDS_POSITION: &str = "R_EXIT_EXCEEDS_POSITION";

/// SPEC.md 4.5 says an uncorroborated intent is "recorded as `PAPER_ONLY_UNCORROBORATED`"
/// in paper mode. We emit `R_UNCORROBORATED` always, and append this marker as a second
/// reason when the desk is in paper mode, so a reader can tell the two situations apart
/// without either reading of the spec losing information.
pub const PAPER_ONLY_UNCORROBORATED: &str = "PAPER_ONLY_UNCORROBORATED";
