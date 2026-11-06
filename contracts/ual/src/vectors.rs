//! Generator and guard for `test-vectors/`.
//!
//! The vectors are produced by the same canonical-form and hashing code the contract runs,
//! then committed. Two tests use them:
//!
//! - `test_vectors_match_committed_files` here, which fails if the contract's output drifts
//!   from the checked-in files. A change to canonical form or to the receipt key set is
//!   therefore impossible to make quietly: it breaks this test and shows up in the diff.
//! - `packages/sdk/test/vectors.test.ts`, which reads the same files and must reproduce every
//!   canonical string and digest in TypeScript.
//!
//! To regenerate after an intentional format change:
//!
//!     UAL_WRITE_VECTORS=1 cargo test --manifest-path contracts/Cargo.toml write_vectors
//!
//! and then read the diff carefully, because every receipt ever written hashes differently
//! afterwards.

use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::{testing_env, NearToken};
use serde_json::{json, Value};

use crate::canonical::{canonical, sha256_hex};
use crate::types::*;
use crate::Ual;

const CONTRACT: &str = "ual.testnet";
const DESK: &str = "yk-desk";
const T0: u64 = 1_762_423_200_000_000_000;

fn vectors_dir() -> std::path::PathBuf {
    // CARGO_MANIFEST_DIR is contracts/ual, so the repo root is two levels up.
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-vectors")
        .canonicalize()
        .unwrap_or_else(|_| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-vectors")
        })
}

fn set_env() {
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id(accounts(0))
        .block_timestamp(T0)
        .block_height(100)
        .attached_deposit(NearToken::from_near(1));
    testing_env!(b.build());
}

/// Pretty-print with a trailing newline, so the committed files are readable in a diff.
fn to_pretty(v: &Value) -> String {
    let mut s = serde_json::to_string_pretty(v).expect("serializable");
    s.push('\n');
    s
}

// ---------------------------------------------------------------- builders

fn canonical_cases() -> Value {
    set_env();

    // Inputs are raw JSON text, not parsed values.
    //
    // This matters. Rust's serde_json keeps the difference between `100` and `100.0`;
    // JavaScript loses it at JSON.parse. If the vector carried a parsed value, the file
    // would have to be written through a serializer and the float cases would arrive in
    // TypeScript already flattened to integers, so the two languages could not be held to
    // the same rule. Carrying the exact bytes removes the ambiguity entirely.
    let ok_inputs: Vec<(&str, &str, &str)> = vec![
        ("empty-object", "{}", "{}"),
        ("empty-array", "[]", "[]"),
        (
            "key-order-is-byte-order",
            r#"{"b":1,"A":2,"a":3,"_":4}"#,
            r#"{"A":2,"_":4,"a":3,"b":1}"#,
        ),
        (
            "nested-objects-sort-at-every-level",
            r#"{"z":{"y":1,"x":2},"a":[{"q":1,"p":2}]}"#,
            r#"{"a":[{"p":2,"q":1}],"z":{"x":2,"y":1}}"#,
        ),
        (
            "nulls-are-kept-not-dropped",
            r#"{"b":1,"a":null}"#,
            r#"{"a":null,"b":1}"#,
        ),
        ("booleans", r#"{"t":true,"f":false}"#, r#"{"f":false,"t":true}"#),
        (
            "negative-and-large-safe-integers",
            r#"{"n":-85000000,"big":9007199254740991}"#,
            r#"{"big":9007199254740991,"n":-85000000}"#,
        ),
        (
            "only-quote-and-backslash-are-escaped",
            r#"{"s":"a\"b\\c/d"}"#,
            r#"{"s":"a\"b\\c/d"}"#,
        ),
        (
            "money-is-a-decimal-string",
            r#"{"notionalUsd":"500000000","dailyPnlUsd":"-85000000"}"#,
            r#"{"dailyPnlUsd":"-85000000","notionalUsd":"500000000"}"#,
        ),
        (
            "array-order-is-preserved-arrays-are-not-sorted",
            r#"["b","a","c"]"#,
            r#"["b","a","c"]"#,
        ),
        (
            "insignificant-whitespace-is-removed",
            "{ \"a\" : 1 , \"b\" : [ 2 , 3 ] }",
            r#"{"a":1,"b":[2,3]}"#,
        ),
        (
            "description-sorts-before-deskId",
            r#"{"deskId":"yk-desk","description":"d"}"#,
            r#"{"description":"d","deskId":"yk-desk"}"#,
        ),
    ];

    let mut cases: Vec<Value> = Vec::new();
    for (name, raw, expected) in ok_inputs {
        let parsed: Value = serde_json::from_str(raw).unwrap_or_else(|e| {
            panic!("vector {name} is not valid JSON: {e}");
        });
        let got = canonical(&parsed).expect("canonical");
        assert_eq!(got, expected, "canonical form of {name}");
        cases.push(json!({
            "name": name,
            "rawJson": raw,
            "canonical": got,
            "sha256": sha256_hex(got.as_bytes()),
        }));
    }

    let bad_inputs: Vec<(&str, &str, &str, &str)> = vec![
        (
            "float-is-refused",
            r#"{"x":1.5}"#,
            "E05_POLICY_INVALID",
            "a float cannot be hashed identically across languages",
        ),
        (
            "integral-float-is-refused",
            r#"{"x":100.0}"#,
            "E05_POLICY_INVALID",
            "100.0 and 100 must not be two spellings of one value",
        ),
        (
            "exponent-is-refused",
            r#"{"x":1e2}"#,
            "E05_POLICY_INVALID",
            "an exponent gives a value a second spelling",
        ),
        (
            "non-ascii-string-is-refused",
            "{\"x\":\"caf\u{e9}\"}",
            "E18_NON_ASCII",
            "strings are printable ASCII only, SPEC.md 3.1",
        ),
        (
            "control-character-is-refused",
            r#"{"x":"line\nbreak"}"#,
            "E18_NON_ASCII",
            "a newline would need an escape the two languages must agree on",
        ),
        (
            "tab-is-refused",
            r#"{"x":"a\tb"}"#,
            "E18_NON_ASCII",
            "same reason as the newline",
        ),
        (
            "non-ascii-key-is-refused",
            "{\"k\u{e9}y\":1}",
            "E18_NON_ASCII",
            "keys are sorted by byte order, so they are held to the same rule",
        ),
        (
            "integer-beyond-2-to-the-53-is-refused",
            r#"{"x":9007199254740992}"#,
            "E05_POLICY_INVALID",
            "JSON.parse would round it; values this large belong in a decimal string",
        ),
    ];

    let mut rejects: Vec<Value> = Vec::new();
    for (name, raw, code, why) in bad_inputs {
        let parsed: Value = serde_json::from_str(raw).unwrap_or_else(|e| {
            panic!("reject vector {name} must still be valid JSON: {e}");
        });
        let err = canonical(&parsed).expect_err("must be refused");
        assert_eq!(err, code, "error code for {name}");
        rejects.push(json!({"name": name, "rawJson": raw, "error": code, "why": why}));
    }

    json!({
        "note": concat!(
            "Canonical JSON vectors, SPEC.md 3.1. UTF-8, object keys sorted by byte order, ",
            "no insignificant whitespace, integers only and only within 2^53 - 1, printable ",
            "ASCII strings only, nulls kept, array order preserved. Inputs are raw JSON ",
            "text so that no serializer sits between the two implementations. Generated by ",
            "contracts/ual/src/vectors.rs; packages/sdk must reproduce every canonical ",
            "string and digest. TypeScript needs parseCanonicalJson rather than JSON.parse ",
            "for the reject cases, because JSON.parse erases the float syntax."
        ),
        "accept": cases,
        "reject": rejects,
    })
}

fn hash_cases() -> Value {
    set_env();
    let strings = [
        "",
        "krexa-ual/v1",
        "{}",
        r#"{"schema":"krexa.ual.policy/1"}"#,
        "The quick brown fox jumps over the lazy dog",
    ];
    let cases: Vec<Value> = strings
        .iter()
        .map(|s| json!({"utf8": s, "sha256": sha256_hex(s.as_bytes())}))
        .collect();

    json!({
        "note": "SHA-256 of UTF-8 bytes, lowercase hex, 64 chars. SPEC.md 3.1.",
        "cases": cases,
        "genesis": {
            "note": "genesis prevHash = sha256(\"krexa-ual/v1:\" + contractId + \":\" + deskId)",
            "contractId": CONTRACT,
            "deskId": DESK,
            "genesisHash": genesis_hash_for(CONTRACT, DESK),
        },
    })
}

fn evidence_cases() -> Value {
    set_env();
    // A fixed key, so the signature vectors are stable. This key is a test fixture and is
    // published on purpose: it signs nothing but test data.
    let secret = [7u8; 32];
    let sk = SigningKey::from_bytes(&secret);
    let pubkey = format!(
        "ed25519:{}",
        bs58::encode(sk.verifying_key().to_bytes()).into_string()
    );

    let items = [
        (
            "news-newswire-a",
            EvidencePayload {
                content_hash: hex::encode([1u8; 32]),
                fetched_at: (T0 + 500_000_000_000).to_string(),
                kind: EvidenceKind::NEWS,
                source: "newswire-a.example".to_string(),
                source_group: "newswire-a".to_string(),
                url: "https://newswire-a.example/a".to_string(),
            },
        ),
        (
            "price-hyperliquid",
            EvidencePayload {
                content_hash: hex::encode([2u8; 32]),
                fetched_at: (T0 + 550_000_000_000).to_string(),
                kind: EvidenceKind::PRICE,
                source: "hyperliquid".to_string(),
                source_group: "exchange-hl".to_string(),
                url: "https://api.hyperliquid.xyz/info".to_string(),
            },
        ),
    ];

    let cases: Vec<Value> = items
        .iter()
        .map(|(name, payload)| {
            let bytes = payload.signing_bytes();
            let signing_string = String::from_utf8(bytes.clone()).expect("ascii");
            let sig = sk.sign(&bytes);
            json!({
                "name": name,
                "item": payload.to_value(),
                "signingString": signing_string,
                "signingStringSha256": sha256_hex(&bytes),
                "evidenceId": payload.content_hash,
                "signature": bs58::encode(sig.to_bytes()).into_string(),
            })
        })
        .collect();

    json!({
        "note": concat!(
            "Evidence item signing vectors. A fetcher signs canonical(item) as UTF-8 bytes ",
            "with ed25519; the contract verifies with env::ed25519_verify. `stance` is ",
            "deliberately outside the signed payload: it is the off-chain verifier's call, ",
            "not the fetcher's. This secret key is a published test fixture and signs ",
            "nothing but these vectors."
        ),
        "fetcherSecretKeyHex": hex::encode(secret),
        "fetcherPublicKey": pubkey,
        "items": cases,
    })
}

/// The canonical policy fixture, as a pure function. Both `policy_cases` and `receipt_cases`
/// need it, and only one of them may create the desk: the mocked VM keeps its storage across
/// `testing_env!` calls inside a single test, so a second `create_desk` would hit
/// E08_DESK_EXISTS.
fn valid_policy_json() -> String {
    let verifier_hash = "a".repeat(64);
    format!(
        concat!(
            "{{",
            r#""allowedAssets":["BTC","ETH"],"#,
            r#""allowedModes":["live","paper"],"#,
            r#""allowedVenues":["hyperliquid","paper"],"#,
            r#""dailyLossLimitUsd":"200000000","#,
            // "description" sorts before "deskId": both start "des", then 'c' (0x63) beats
            // 'k' (0x6b). Byte order is not alphabetical-by-eye, which is exactly why the
            // contract re-serializes and compares rather than trusting the sender.
            r#""description":"EBI gated desk. Paper only in this build.","#,
            r#""deskId":"yk-desk","#,
            r#""evidence":{{"#,
            r#""groups":[{{"group":"exchange-hl","sources":["hyperliquid"]}},"#,
            r#"{{"group":"newswire-a","sources":["newswire-a.example"]}},"#,
            r#"{{"group":"newswire-b","sources":["newswire-b.example"]}}],"#,
            r#""maxAgeSec":900,"#,
            r#""required":true,"#,
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
        verifier_hash
    )
}

fn policy_cases() -> Value {
    set_env();
    let valid = valid_policy_json();

    // Confirm the fixture really is canonical. The hash is computed from these bytes rather
    // than taken from a contract run, so this generator does not need to create a desk.
    let parsed: Value = serde_json::from_str(&valid).expect("valid json");
    assert_eq!(canonical(&parsed).expect("canonical"), valid);
    let hash = sha256_hex(valid.as_bytes());

    let invalid = vec![
        json!({
            "name": "keys-out-of-byte-order",
            // description and deskId swapped: the order a human would guess, which is wrong.
            "policyJson": valid.replace(
                r#""description":"EBI gated desk. Paper only in this build.","deskId":"yk-desk","#,
                r#""deskId":"yk-desk","description":"EBI gated desk. Paper only in this build.","#,
            ),
            "error": "E04_POLICY_NOT_CANONICAL",
            "why": "same policy, two keys swapped: valid JSON, not canonical bytes",
        }),
        json!({
            "name": "unsorted-asset-set",
            "policyJson": valid.replace(r#"["BTC","ETH"]"#, r#"["ETH","BTC"]"#),
            "error": "E05_POLICY_INVALID",
            "why": "sets must be sorted and deduplicated, SPEC.md 3.1",
        }),
        json!({
            "name": "unknown-top-level-key",
            "policyJson": valid.replace(r#""deskId":"yk-desk","#, r#""deskId":"yk-desk","extra":1,"#),
            "error": "E05_POLICY_INVALID",
            "why": "additionalProperties is false",
        }),
        json!({
            "name": "size-table-does-not-start-at-zero",
            "policyJson": valid.replace("[0,0,5000,10000]", "[1,0,5000,10000]"),
            "error": "E05_POLICY_INVALID",
            "why": "k = 0 means nothing agreed, which must size to zero",
        }),
        json!({
            "name": "size-table-decreases",
            "policyJson": valid.replace("[0,0,5000,10000]", "[0,0,10000,5000]"),
            "error": "E05_POLICY_INVALID",
            "why": "more corroboration must never buy a smaller position",
        }),
        json!({
            "name": "slippage-cap-above-1000-bps",
            "policyJson": valid.replace(r#""slippageCapBps":30"#, r#""slippageCapBps":1001"#),
            "error": "E05_POLICY_INVALID",
            "why": "schema maximum is 1000",
        }),
        json!({
            "name": "money-with-a-leading-zero",
            "policyJson": valid.replace(r#""maxPositionUsd":"1000000000""#, r#""maxPositionUsd":"0100000000""#),
            "error": "E05_POLICY_INVALID",
            "why": "one value must have exactly one hashable spelling",
        }),
        json!({
            "name": "source-in-two-groups",
            "policyJson": valid.replace(
                r#"{"group":"newswire-b","sources":["newswire-b.example"]}"#,
                r#"{"group":"newswire-b","sources":["newswire-a.example"]}"#,
            ),
            "error": "E05_POLICY_INVALID",
            "why": "independent-group counting would be ambiguous",
        }),
    ];

    json!({
        "note": concat!(
            "Policy vectors, SPEC.md 3.2. The valid policy is already in canonical form, ",
            "which is what commit_policy demands: it re-serializes what it parsed and ",
            "compares bytes, so policyHash is unambiguous."
        ),
        "valid": {
            "policyJson": valid,
            "policyHash": hash,
        },
        "invalid": invalid,
    })
}

/// Real receipts from a real contract run, with the canonical string and digest of each.
/// This is the strongest cross-language check: TypeScript has to rebuild the exact bytes the
/// contract hashed.
fn receipt_cases() -> Value {
    set_env();
    let policy = valid_policy_json();
    let mut c = Ual::new(accounts(0));
    c.create_desk(DESK.to_string());
    c.commit_policy(DESK.to_string(), policy);
    c.register_agent(DESK.to_string(), accounts(1), "TRADER".to_string());
    c.register_fetcher(
        DESK.to_string(),
        format!(
            "ed25519:{}",
            bs58::encode(SigningKey::from_bytes(&[7u8; 32]).verifying_key().to_bytes())
                .into_string()
        ),
        "b".repeat(64),
        "tee-fetcher-1".to_string(),
    );

    let head = |c: &Ual| -> String {
        c.get_head(DESK.to_string()).unwrap()["hash"]
            .as_str()
            .unwrap()
            .to_string()
    };

    let h = head(&c);
    c.record_mark(DESK.to_string(), "10000000000".to_string(), h, None);

    // Two supporting groups, so k = 2 and the trade is allowed at half size.
    let sk = SigningKey::from_bytes(&[7u8; 32]);
    let pubkey = format!(
        "ed25519:{}",
        bs58::encode(sk.verifying_key().to_bytes()).into_string()
    );
    let mk = |source: &str, group: &str, kind: EvidenceKind, at: u64, seed: u8| {
        let payload = EvidencePayload {
            content_hash: hex::encode([seed; 32]),
            fetched_at: at.to_string(),
            kind,
            source: source.to_string(),
            source_group: group.to_string(),
            url: format!("https://{source}/a"),
        };
        let sig = sk.sign(&payload.signing_bytes());
        EvidenceItemInput {
            item: payload,
            fetcher_key: pubkey.clone(),
            signature: bs58::encode(sig.to_bytes()).into_string(),
            stance: Stance::SUPPORT,
        }
    };

    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id(accounts(1))
        .block_timestamp(T0 + 600_000_000_000)
        .block_height(101);
    testing_env!(b.build());

    let h = head(&c);
    let ev = c.submit_evidence(
        DESK.to_string(),
        EvidenceBundleInput {
            asset: "BTC".to_string(),
            direction: Direction::LONG,
            verifier_code_hash: "a".repeat(64),
            items: vec![
                mk("newswire-a.example", "newswire-a", EvidenceKind::NEWS, T0 + 500_000_000_000, 1),
                mk("hyperliquid", "exchange-hl", EvidenceKind::PRICE, T0 + 550_000_000_000, 2),
            ],
        },
        h,
    );
    let ev_seq = ev["seq"].as_u64().unwrap();

    let h = head(&c);
    c.submit_intent(
        DESK.to_string(),
        Intent {
            client_id: "trader-7f3a-000123".to_string(),
            venue: "hyperliquid".to_string(),
            asset: "BTC".to_string(),
            side: Side::OPEN_LONG,
            notional_usd: "500000000".to_string(),
            max_slippage_bps: 30,
            quote_ref: None,
        },
        h,
        "10000000000".to_string(),
        Some("c".repeat(64)),
        None,
        Some(ev_seq),
    );

    // An oversize open, so a REJECTED receipt is in the vectors too. A refusal is a record,
    // and a reader has to be able to verify one.
    let h = head(&c);
    c.submit_intent(
        DESK.to_string(),
        Intent {
            client_id: "trader-7f3a-000124".to_string(),
            venue: "hyperliquid".to_string(),
            asset: "BTC".to_string(),
            side: Side::OPEN_LONG,
            notional_usd: "5000000000".to_string(),
            max_slippage_bps: 30,
            quote_ref: None,
        },
        h,
        "10000000000".to_string(),
        None,
        None,
        Some(ev_seq),
    );

    set_env();
    let receipts: Vec<Value> = c
        .get_receipts(DESK.to_string(), 1, 100)
        .into_iter()
        .map(|r| {
            let mut body = r.clone();
            let claimed = body
                .as_object_mut()
                .unwrap()
                .remove("hash")
                .unwrap()
                .as_str()
                .unwrap()
                .to_string();
            let canon = canonical(&body).expect("canonical");
            assert_eq!(claimed, sha256_hex(canon.as_bytes()));
            json!({
                "receipt": r,
                "canonicalWithoutHash": canon,
                "hash": claimed,
            })
        })
        .collect();

    json!({
        "note": concat!(
            "Receipts from a real contract run on the mocked VM. ",
            "receipt.hash = sha256(canonical(receipt without \"hash\")), SPEC.md 3.1. ",
            "Every receipt carries the same key set, with null on fields its kind does not ",
            "use, so the canonical shape never depends on the kind. The `evidence` and ",
            "`control` fields are additions to the INTENT example in SPEC.md 3.5 and are ",
            "documented in docs/RECEIPTS.md."
        ),
        "contractId": CONTRACT,
        "deskId": DESK,
        "genesisHash": genesis_hash_for(CONTRACT, DESK),
        "receipts": receipts,
    })
}

// ---------------------------------------------------------------- the test

fn all_vectors() -> Vec<(&'static str, Value)> {
    vec![
        ("canonical.json", canonical_cases()),
        ("hashes.json", hash_cases()),
        ("policies.json", policy_cases()),
        ("evidence.json", evidence_cases()),
        ("receipts.json", receipt_cases()),
    ]
}

#[test]
fn write_vectors() {
    let dir = vectors_dir();
    let write = std::env::var("UAL_WRITE_VECTORS").as_deref() == Ok("1");
    if !write {
        eprintln!(
            "skipping vector write (set UAL_WRITE_VECTORS=1 to regenerate into {})",
            dir.display()
        );
        return;
    }
    std::fs::create_dir_all(&dir).expect("create test-vectors dir");
    for (name, value) in all_vectors() {
        std::fs::write(dir.join(name), to_pretty(&value)).expect("write vector file");
        eprintln!("wrote {}", dir.join(name).display());
    }
}

/// Guard: the committed vectors must still equal what the contract produces. If this fails,
/// either a bug changed the canonical form or someone changed it on purpose and needs to
/// regenerate and review the diff.
#[test]
fn test_vectors_match_committed_files() {
    let dir = vectors_dir();
    for (name, value) in all_vectors() {
        let path = dir.join(name);
        let committed = std::fs::read_to_string(&path).unwrap_or_else(|_| {
            panic!(
                "missing {}. Run: UAL_WRITE_VECTORS=1 cargo test --manifest-path contracts/Cargo.toml write_vectors",
                path.display()
            )
        });
        assert_eq!(
            committed,
            to_pretty(&value),
            "{} has drifted from what the contract produces",
            path.display()
        );
    }
}
