# Failure cases

What breaks, what the operator sees, and what to do. SPEC.md M7 asks for this and the Open
track prompt asks for a failure-cases section in the README.

Each case below has either been reproduced in a test or hit for real during the build. The ones
that were hit for real are marked, because a failure mode somebody actually tripped over is
worth more than one somebody imagined.

## Agent-side

### The function-call key's gas allowance runs out

**Hit for real**, in the first version of `tests/integration/tests/fc_keys.rs`.

A function-call key reserves the gas it attaches *before* the call runs, so the allowance
drains whether or not the gas is used. Pairing a 0.5 NEAR allowance with `max_gas()` meant the
very first call was refused with `NotEnoughAllowance`: 300 TGas reserves about 1 NEAR up front.

- **Symptom**: every agent write fails at the transport level with `NotEnoughAllowance`. The
  contract is never reached, so there is no receipt and nothing in the ledger records it.
- **Why it is nasty**: the agent cannot fix it. Adding or replacing a key is not a function
  call, so the restricted key cannot top itself up. It is locked out until a human acts.
- **What to do**: the owner issues a fresh key. Reproduced deliberately in
  `allowance_exhaustion_locks_the_agent_out`, which also confirms the owner can still act.
- **Avoiding it**: attach the gas a call needs, not the maximum. Agent writes use 30 TGas
  against a 5 NEAR allowance, which is roughly 1,500 writes. Monitor the allowance; the
  `CHAIN_MISMATCH` Monitor trigger will not catch this because the agent never reaches the
  chain at all.

### The agent's local head is stale

- **Symptom**: `E03_CHAIN_BROKEN`, and nothing is appended.
- **Cause**: two writers on one desk, or a retried transaction after a timeout. The head check
  is optimistic concurrency and it is doing its job.
- **What to do**: re-read `get_head` and resubmit. Do **not** retry with the old head.
- **Note**: this is also what stops a replay of a stale write, so it is a feature in the same
  breath as being an annoyance.

### An intent is refused and the agent retries it differently

- **Symptom**: several REJECTED receipts in a row with the same reason.
- **What to do**: nothing automatic. RULES.md section 7 item 4 and the MCP server's
  `explain_rejection` both say the same thing: do not split, rename or retime an order to get
  around a limit. The attempt is recorded either way, so the retries make the record worse
  rather than the outcome better.
- **For `R_UNCORROBORATED` specifically**, the wrong fix is a smaller order. Size zero is size
  zero at any notional; the fix is more independent evidence or no trade.

### The Analyst produces unparseable output

- **Symptom**: a DecisionRecord with `outputParsed: false`, a thesis of HOLD, and a consistency
  result of `FAIL`.
- **What to do**: nothing. It is recorded and counted. The parser deliberately does not repair
  broken JSON, because the consistency failure rate is one of the things SPEC.md 5.2 measures
  and a repairing parser would hide it.
- **Cost**: the call is still counted against the LLM budget, because it still cost money.

## Evidence-side

### The fetcher key is lost

- **Symptom**: no new evidence can be signed. Gated desks stop opening and report
  `R_NO_EVIDENCE`. Exits keep working.
- **What to do**: generate a new key (`pnpm fetcher:keygen`), register it, and revoke the old
  one. Both are CONTROL receipts, so the rotation is visible.
- **What is not affected**: already-submitted evidence stays valid. Receipts are not
  retroactively invalidated by a key rotation, which is deliberate: the signature was good when
  it was made.

### The fetcher key is compromised

- **Symptom**: possibly none. This is the point. A stolen key signs evidence with perfectly
  good provenance, and the gate checks who signed rather than whether they should have.
- **What to do**: `revoke_fetcher` immediately. Then look at every receipt citing that key
  since the compromise, which the explorer can filter by `fetcherKey`.
- **What the design does not do**: detect it. Listed in
  [THREAT_MODEL.md](THREAT_MODEL.md) with no mitigation.

### A source the policy never declared appears in a bundle

- **Symptom**: the item appears in the EVIDENCE receipt with `sourceGroup: "UNDECLARED"` and
  contributes nothing to k.
- **Cause**: usually a typo in the source id, or a fetcher configured from a different source
  list than the policy.
- **What to do**: make the archive's source list and the policy's groups agree. They share one
  definition in `apps/archive/src/sources.ts` for exactly this reason.

### Evidence goes stale between the bundle and the intent

**Hit for real**, when replaying archived snapshots on a sandbox whose clock is real.

- **Symptom**: `R_EVIDENCE_STALE` on an intent whose bundle verified a moment earlier.
- **Cause**: freshness is re-checked at intent time, not only at bundle time, so a bundle
  cannot be banked and spent later.
- **What to do** in live operation: submit the intent promptly after the bundle.
- **What to do** when replaying history: a replay needs a wider freshness window than a live
  desk, because the snapshots are genuinely old. The sim uses the schema maximum of 86400 and
  prints the distinction so no sim result reads as a live one.

## Operator-side

### The owner key is offline with the kill switch engaged

- **Symptom**: every open is refused with `R_KILL_SWITCH`. Exits still go through.
- **Why it cannot be automated away**: only the owner can release the brake. A Monitor that
  could release it would be a Monitor an attacker could use to release it, which would defeat
  the asymmetry that makes a rule-based brake safe.
- **What to do**: nothing but recover the key. The desk is safe in the meantime, in the sense
  that it cannot take on new risk, and positions can still be closed.
- **Design note**: this is a deliberate trade. The alternative, a timeout that auto-releases,
  turns a safety stop into a delay.

### The daily loss limit auto-engages the brake overnight

- **Symptom**: a CONTROL receipt with reason `auto: daily loss limit`, then `R_KILL_SWITCH` on
  everything afterwards.
- **Cause**: `killSwitch.autoOnDailyLoss` is true in the policy and a MARK crossed the limit.
- **What to do**: review before releasing. The brake fired because the desk lost the amount it
  committed to losing.

### A policy will not commit

- **Symptom**: `E04_POLICY_NOT_CANONICAL` or `E05_POLICY_INVALID`.
- **Cause, nearly always**: key order. Canonical form sorts by **byte** order, which is not
  what the eye expects: `"description"` sorts before `"deskId"` because `c` beats `k`.
- **What to do**: `pnpm mcp` then `check_policy`, or `serializePolicy` from the SDK, which
  produces the right bytes from an object in any order. Do not hand-sort.
- **Hit for real** while writing the test vectors, which is why the contract re-serializes and
  compares rather than trusting the sender.

### No mark in the last 24 hours

- **Symptom**: `R_NO_EQUITY_MARK` on every open.
- **Cause**: the Data agent stopped, so the desk's risk state is unknown and it refuses to take
  on more.
- **What to do**: record a mark. Note the rate limit: one per desk per 5 minutes
  (`E14_MARK_TOO_SOON`).

### The archive stops recording

**Hit for real**: Binance and Kraken each dropped a snapshot during the first hours.

- **Symptom**: `pnpm archive:stats` shows a rising gap count.
- **What it does not do**: silently substitute a stale snapshot. A failed attempt is written to
  `index.jsonl` with `ok: false`, so a replay can tell a gap from a quiet market. Without that,
  a hole in the data would be indistinguishable from nothing happening.
- **What to do**: `./scripts/archive-start.sh` if the recorder died. Gaps already recorded stay
  recorded; they are part of the data.

## Build and tooling

### The sandbox refuses the contract wasm

**Hit for real**, and it cost an hour.

- **Symptom**: `CompilationError: PrepareError: Deserialization` on the first call after a
  deploy that itself succeeded, with the bytes byte-identical on chain.
- **Cause**: near-workspaces-js bundles `neard 2.6.2`, which cannot *prepare* the wasm
  `cargo-near 0.23` emits. Real testnet and the Rust sandbox (`neard 2.14.0`) both accept it.
- **What to do**: `./scripts/fetch-sandbox.sh`, which caches 2.14.0. `pnpm demo` and
  `pnpm runtime:sim` do this for you.
- **Trap worth knowing**: `NEAR_SANDBOX_BIN_PATH` means different things in the two libraries.
  The npm package wants `NEAR_SANDBOX_BINARY_PATH` as a **directory** and only checks the other
  is non-empty; the Rust crate reads `NEAR_SANDBOX_BIN_PATH` as the **binary**. Pointing it at a
  directory silently broke 15 passing Rust tests.

### `pnpm install` leaves the sandbox unable to start

- **Symptom**: "Ignored build scripts: near-sandbox, near-workspaces".
- **Cause**: pnpm 10 blocks dependency build scripts by default, and those two download the
  node binary.
- **What to do**: nothing, if you are using this repo as-is. `pnpm-workspace.yaml` lists them
  under `onlyBuiltDependencies`. If you see the warning, the allowlist has been lost.

### The verifier code hash no longer matches a committed policy

- **Symptom**: `E13_BAD_HASH` on `submit_evidence`.
- **Cause**: `extract.ts`, `indicators.ts` or `verify.ts` changed, so the hash changed, and a
  policy pinning the old one no longer authorises bundles from the new build.
- **This is intended friction.** The stance rules and the indicator tolerances are part of what
  a desk committed to, so changing them should invalidate the commitment rather than silently
  alter it.
- **What to do**: `pnpm verifier:codehash`, commit a new policy with the new hash, and treat
  results from before the change as belonging to the old verifier.
