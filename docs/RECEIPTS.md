# Receipts: canonical form, and where this build differs from SPEC.md

This file is the record of every place the implementation departs from SPEC.md sections 3 and
4, so the differences are reviewable rather than buried in code. Everything else follows the
spec as written.

## Canonical form

SPEC.md 3.1 as implemented in `contracts/ual/src/canonical.rs` and mirrored in
`packages/sdk/src/canonical.ts`:

- UTF-8, object keys sorted by **byte** order, no insignificant whitespace.
- No floats anywhere.
- Strings printable ASCII only (0x20 to 0x7E). Only `"` and `\` are escaped.
- Nulls are kept, never dropped. Arrays keep their order; they are sequences, not sets.
- Money is signed micro-USD as a decimal string. Time is nanoseconds as a decimal string.

Byte order is not what the eye expects. `"description"` sorts **before** `"deskId"`, because
both start `des` and then `c` (0x63) beats `k` (0x6B). This is exactly why `commit_policy`
re-serializes what it parsed and compares bytes instead of trusting the sender: a
hand-written policy that looks sorted usually is not. A hand-written fixture in the vector
generator got this wrong and the drift guard caught it.

### Addition: integers are bounded to 2^53 - 1

SPEC.md 3.1 says "no floats" but does not bound integer size. This build refuses any JSON
number outside plus or minus 9007199254740991, reported as `E05_POLICY_INVALID`.

The reason is that `apps/web` has to recheck the hash chain in a browser (SPEC.md 10), and
`JSON.parse` silently rounds anything past 2^53 to the nearest double. An unbounded integer
would therefore canonicalise differently in Rust and JavaScript, and receipts would stop
being independently verifiable, which is the one property the whole design rests on.

Nothing is lost. SPEC.md 3.1 already carries every large value (money, timestamps) as a
decimal string. The integers that remain as JSON numbers are sequence counters, basis points
and small counts.

### Consequence for the TypeScript pre-check

Rust's `serde_json` keeps the difference between `100` and `100.0`. JavaScript loses it at
`JSON.parse`. So `canonical()` alone, operating on a parsed value, would accept bytes the
contract rejects.

`packages/sdk` therefore exposes `parseCanonicalJson(text)`, which inspects the number tokens
in the raw text before parsing, and `assertPolicyBytesCanonical(text)`, which is the local
equivalent of what `commit_policy` does. Use those for anything that arrives as a string. A
pre-check that disagrees with the contract is worse than no pre-check, because it sends a
transaction that was always going to fail.

## Receipt key set

`receipt.hash = sha256(canonical(receipt without "hash"))`.

Every receipt carries the **same key set regardless of kind**, with `null` in the fields its
kind does not use. A reader can therefore verify a hash without first knowing the kind. This
is asserted by a test in `packages/sdk/test/vectors.test.ts`.

### Two fields beyond the SPEC.md 3.5 example

SPEC.md 3.5 prints one example receipt, an INTENT, and lists the kinds `EVIDENCE`, `POLICY`,
`CONTROL`, `INTENT`, `FILL`, `MARK`. Two fields are needed that the INTENT example does not
show:

| Field | Why |
|---|---|
| `evidence` | SPEC.md 2A.2 item 7 requires the EVIDENCE receipt to carry `{bundleHash, items, k, sizeMultiplierBps, verifierCodeHash}`. Without it an EVIDENCE receipt records no evidence. `null` on every other kind. |
| `control` | A CONTROL receipt is used for mode changes, agent registration and retirement, fetcher registration and revocation, kill switch both ways, and capital flows. Without a field saying which, every CONTROL receipt looks the same. `null` on every other kind. |

`evidence` also carries three booleans the spec does not name: `anyBadSig`, `anyStale` and
`attested`. The first two exist because the gate fails closed on a tainted bundle and the
receipt has to say why. `attested` exists so that a receipt produced from an unattested
fetcher is labelled as such at the point of use, per SPEC.md 2A.2 item 2 and 16.

## Error and rejection codes

`E01` to `E20` and every `R_*` code are exactly the sets in SPEC.md 4.4 and 4.5. One addition:

| Code | Why it is not one of E01 to E20 |
|---|---|
| `E21_MALFORMED_AMOUNT` | A money field that is not an exact decimal integer string has no correct interpretation, and none of E01 to E20 describes it. Overloading one would have made the ledger lie about why a call failed. |

`PAPER_ONLY_UNCORROBORATED` is not a new rejection reason. SPEC.md 4.5 says an uncorroborated
intent is "recorded as `PAPER_ONLY_UNCORROBORATED`" in paper mode. The contract emits
`R_UNCORROBORATED` always and appends this marker as a second reason when the desk is in
paper mode, so neither reading of the spec loses information.

## Decisions SPEC.md leaves open

| Question | What this build does | Why |
|---|---|---|
| Does `seq` start at 0 or 1? | First receipt is `seq 1`. `get_head` on a desk with no receipts returns `{seq: 0, hash: genesis}`. | `create_desk` appends no receipt, so seq 0 is the genesis anchor rather than a real row. |
| Are exits subject to the allowlists? | Yes for asset and venue and the slippage cap. No for kill switch, daily loss, position caps and evidence. | "You can always exit" is about risk limits. An asset or venue the policy never named is outside the desk's declared mandate, which is a different kind of statement. |
| What does an undeclared evidence source count for? | Nothing. It appears in the receipt with `sourceGroup: "UNDECLARED"` and does not raise k. | Fail closed. Otherwise an attacker picks a source the policy never grouped and gets free corroboration. |
| Can a bundle be banked and spent later? | No. Freshness is re-checked at intent time against `maxAgeSec`, not only at bundle time. | Otherwise an agent submits evidence while it is fresh and trades on it a day later. |
| Does one bad signature drop just that item? | No. It taints the whole bundle and the intent is rejected with `R_EVIDENCE_BAD_SIG`, even if the remaining honest items would have cleared the size table. | A bundle containing a forgery is evidence that the pipeline feeding it is compromised. |
| Who may call `record_mark`? | A registered agent or the desk owner. | SPEC.md 4.1 says registered agent. The owner is included because they could register themselves anyway, so excluding them adds friction, not safety. `submit_intent` stays strict at TRADER or BASELINE, because the Swarms track wants one sub-account per agent and letting the owner shortcut that would make the structure decorative. |
| Is an oversize position clipped or rejected? | Rejected, with `R_MAX_POSITION`. | SPEC.md 14 item 4: Krexa's off-chain `checkOrder` clips to the maximum, the contract rejects. The differential test records the difference. |
| What size may a fill be? | At most the requested notional **after** the evidence multiplier. | Filling the full request against a half-sized approval would walk straight through the gate after it had already sized the trade down. |

## Trust boundary: stance

An evidence item's `stance` (SUPPORT, CONTRADICT, NEUTRAL) is **not** inside the signed
payload. The fetcher signs what it fetched; stance is relative to a specific intent direction
and is assigned by the off-chain deterministic verifier whose code hash is pinned in the
policy.

So the on-chain gate proves provenance, freshness and independent-group counting. It cannot
judge semantics. A dishonest operator can mislabel stance on their own desk, which is a
restatement of the limit SPEC.md 1.1 and 15 already name: the ledger proves what the operator
chose to write. The gate's purpose is to limit the damage from **injected content**, not from
an operator attacking their own record.

The contract does check that the bundle's `verifierCodeHash` equals the one in the committed
policy, so a bundle produced by an unauthorized verifier build is refused with
`E13_BAD_HASH`.
