//! Canonical JSON, as pinned by `test-vectors/`.
//!
//! SPEC.md 3.1. UTF-8, object keys sorted by byte order, no insignificant whitespace,
//! no floats anywhere, strings printable ASCII only.
//!
//! This writes the bytes itself rather than leaning on `serde_json::to_string`. Two reasons:
//! serde_json's key order is a property of a cargo feature (`preserve_order`) that a future
//! dependency could flip under us, and we need to reject floats rather than round-trip them.
//! The TypeScript side in `packages/sdk/src/canonical.ts` mirrors this function line for line,
//! and `test-vectors/` holds the inputs and expected digests that both must reproduce.
//!
//! Because strings are restricted to printable ASCII (0x20 to 0x7E), only `"` and `\` ever
//! need escaping, so Rust and JavaScript agree on the escape output without further care.

use serde_json::Value;

use crate::errors::{E05_POLICY_INVALID, E18_NON_ASCII};

// A float can only reach canonicalisation through `commit_policy`, which is the one method
// that takes free-form JSON. Every other caller payload is deserialized into a typed struct
// first, so a non-integer number fails at deserialization. That is why the float branches
// below report E05_POLICY_INVALID rather than needing a code outside SPEC.md 4.4.

/// Printable ASCII, the only bytes a canonical string may contain.
pub fn is_printable_ascii(s: &str) -> bool {
    s.as_bytes().iter().all(|b| (0x20..=0x7e).contains(b))
}

/// Largest integer a canonical JSON number may hold: 2^53 - 1.
///
/// This bound exists because the TypeScript side has to reproduce these bytes exactly, and
/// `JSON.parse` silently rounds anything past 2^53 to the nearest double. A value that
/// canonicalises differently in Rust and JavaScript would make receipts unverifiable in a
/// browser, which is where SPEC.md 10 expects the hash chain to be rechecked.
///
/// Nothing real is lost: SPEC.md 3.1 already carries money as decimal strings and timestamps
/// as nanosecond strings precisely so no large value is ever a JSON number. Integers that
/// appear as numbers are sequence counters and basis points.
pub const MAX_SAFE_INTEGER: i128 = 9_007_199_254_740_991;

fn integer_in_safe_range(n: i128) -> bool {
    n.abs() <= MAX_SAFE_INTEGER
}

/// Serialize `value` to canonical form, or return the error code to panic with.
pub fn canonical(value: &Value) -> Result<String, &'static str> {
    let mut out = String::new();
    write_value(value, &mut out)?;
    Ok(out)
}

/// Canonical form of `value`, panicking with the matching E-code. Used on paths where a
/// structural problem means nothing should be appended.
pub fn canonical_or_panic(value: &Value) -> String {
    match canonical(value) {
        Ok(s) => s,
        Err(code) => near_sdk::env::panic_str(code),
    }
}

fn write_value(value: &Value, out: &mut String) -> Result<(), &'static str> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => {
            // No floats anywhere, and nothing past 2^53 - 1. A JSON number must be an exact
            // integer that JavaScript can also hold exactly.
            let i = if let Some(u) = n.as_u64() {
                u as i128
            } else if let Some(i) = n.as_i64() {
                i as i128
            } else {
                return Err(E05_POLICY_INVALID);
            };
            if !integer_in_safe_range(i) {
                return Err(E05_POLICY_INVALID);
            }
            out.push_str(&i.to_string());
        }
        Value::String(s) => write_string(s, out)?,
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            // Sort by byte order. serde_json's Map is a BTreeMap by default, so this is
            // usually already sorted, but we sort explicitly so the guarantee is ours.
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(key, out)?;
                out.push(':');
                write_value(&map[*key], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

fn write_string(s: &str, out: &mut String) -> Result<(), &'static str> {
    if !is_printable_ascii(s) {
        return Err(E18_NON_ASCII);
    }
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c => out.push(c),
        }
    }
    out.push('"');
    Ok(())
}

/// SHA-256 as lowercase hex, 64 chars.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(near_sdk::env::sha256_array(bytes))
}

/// `sha256(canonical(value))` as lowercase hex.
pub fn canonical_hash(value: &Value) -> String {
    sha256_hex(canonical_or_panic(value).as_bytes())
}

/// True if `s` is exactly 64 lowercase hex characters.
pub fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Walk a parsed value and reject any float or non-printable-ASCII string, returning the
/// E-code. Called before trusting caller-supplied JSON.
pub fn reject_floats_and_non_ascii(value: &Value) -> Result<(), &'static str> {
    match value {
        Value::Number(n) => {
            let i = match (n.as_u64(), n.as_i64()) {
                (Some(u), _) => u as i128,
                (None, Some(i)) => i as i128,
                _ => return Err(E05_POLICY_INVALID),
            };
            if !integer_in_safe_range(i) {
                return Err(E05_POLICY_INVALID);
            }
        }
        Value::String(s) => {
            if !is_printable_ascii(s) {
                return Err(E18_NON_ASCII);
            }
        }
        Value::Array(items) => {
            for item in items {
                reject_floats_and_non_ascii(item)?;
            }
        }
        Value::Object(map) => {
            for (k, v) in map {
                if !is_printable_ascii(k) {
                    return Err(E18_NON_ASCII);
                }
                reject_floats_and_non_ascii(v)?;
            }
        }
        Value::Null | Value::Bool(_) => {}
    }
    Ok(())
}
