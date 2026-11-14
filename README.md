# Evidence-Bound Intents on the Krexa Underwritable Agent Ledger

An LLM trading swarm should only trade on evidence it can show.

This is a NEAR contract plus a deterministic verifier that refuses a trade unless the signal
cites signed, fresh evidence from independent sources, and sizes the trade by how many
independent sources agree. Every action, **including every refusal**, is recorded in a
hash-chained ledger anyone can recompute in a browser without trusting us.

Built for NEAR HACKATHON (window 2026-10-19 to 2026-11-14). Tracks: `swarms` (primary),
`defi` and `security`. Unaudited. Testnet only. Paper only.

## The problem

LLM trading agents read the same feeds under near-identical prompts, so one fabricated headline
can move many of them into the same trade at the same moment. arXiv 2610.26438 reports it
directly:

> "Prompt injection achieves 14% attack success rate (ASR), but fabricated news reaches 62% and
> two 30-word templates reach 100% on all 15 stocks, inverting the usual LLM-security intuition."

And arXiv 2609.19705 (FARSIGHT) reports that nobody is defending against it:

> "Across 15 academic schemes, no paper describes a halt that skips LLM inference or combines
> source provenance with cross-source corroboration."

Both quotes were checked against the papers ([docs/PRIOR_WORK.md](docs/PRIOR_WORK.md)). FARSIGHT
closes by urging deployers to "corroborate sources, keep interrupts that bypass the model, and
enforce loss limits outside it". **This build does all three.** That is the contribution: gaps
somebody else named, closed in one auditable way on a public chain. Nothing here is a first.

## Research question

Can a deterministic verifier that only allows trades backed by checked, corroborated evidence
limit the damage from fake inputs without destroying real returns?

**Expected answer, written down before anything ran.** Partly. We expected a sharp cut in the
attack success rate of single-source fakes, and we also expected the gate to block some
profitable early signals that start with one source. That is a real cost and it may dominate. It
will not stop an attacker who plants the same fake in several independent-looking sources, and a
TEE proves what was fetched, not that it was true.

## Quick start for AI judges

No keys, no accounts, no manual steps.

```bash
git clone https://github.com/Yatharth4599/krexa-agent-ledger && cd krexa-agent-ledger
./scripts/setup.sh      # checks the toolchain, installs deps, builds the contract, fetches a sandbox node
pnpm test               # 97 Rust unit + 15 sandbox integration + 428 TypeScript tests
pnpm demo               # the whole evidence gate on a local sandbox; exits non-zero on any failure
pnpm attack-demo        # a prompt-injected Trader against a real node; writes docs/attack-demo.log
pnpm ebi:report         # regenerates docs/RESULTS.md from recorded receipts
pnpm web                # http://localhost:3000
```

### Do X, see Y

| Run this | See this |
|---|---|
| `pnpm test` | 540 tests pass. The sandbox ones start a real NEAR node. |
| `pnpm demo` | A fake headline arrives. `plain` trades on it; `ebi` refuses with `R_UNCORROBORATED`. A second independent source arrives and the trade is approved at **half** size. A fabricated RSI of 25.00 is dropped against a recomputed 100.00. One changed byte breaks the chain at a named sequence number. |
| `pnpm attack-demo` | 12 attacking attempts, all blocked: 8 by the NEAR protocol before any contract code runs (plus a check that the attacker's balance did not change), 4 by the contract and recorded as receipts. One of the four is a compromised Trader marking its own equity, which is what feeds the daily loss limit. |
| `pnpm web` then Explorer, Load from chain | 84 receipts from `ual.krexa-ual.testnet`, every hash recomputed **in your browser**, anchored to the desk's genesis. Press Tamper and watch it break at the right seq. |
| `pnpm mcp` | The ledger over MCP stdio. Ask for `withdraw` and it explains that no such tool exists by design. |
| `pnpm ual replay ebi 6` | Recomputes the prompt, snapshot, tool-call and output hashes behind one decision, then says plainly what replay does not prove. |
| `pnpm archive:verify` | Rehashes every archived market snapshot against its recorded hash. Needs `data/archive/raw/`, which is gitignored: on a fresh clone it reports every body as missing and exits 1. |

## It is live on testnet

Contract: [`ual.krexa-ual.testnet`](https://testnet.nearblocks.io/address/ual.krexa-ual.testnet)

Running the current code, including the exit, fill and evidence-reuse checks in
[docs/RECEIPTS.md](docs/RECEIPTS.md).

Desk `ebi` holds a real 84 receipt chain written by `pnpm testnet:walkthrough` across several
runs. Earlier sequences are still there, including one that died partway on a dropped RPC call
and one whose exit was refused (see below), because deleting receipts to tidy a story is the one
thing a ledger must not do. The current walkthrough, on the contract redeployed after the
security review, is seq 70 to 84:

| seq | kind | verdict | what happened |
|---|---|---|---|
| 70 | POLICY | NA | policy `74dea706...`, pinning verifier `135a8442...` |
| 73 | INTENT | APPROVED | a CLOSE of the whole $750 left open by earlier runs |
| 74 | FILL | NA | the flatten applied, so the desk starts at zero |
| 75 | EVIDENCE | NA | one source, `k=1`, size multiplier **0 bps**, `attested: false` |
| 76 | INTENT | **REJECTED** | `R_UNCORROBORATED`, `PAPER_ONLY_UNCORROBORATED` |
| 77 | EVIDENCE | NA | a second independent group, `k=2`, **5000 bps** |
| 78 | INTENT | APPROVED | $500 requested |
| 79 | FILL | NA | **$250** filled: the gate halved it |
| 80 | INTENT | **REJECTED** | `R_EVIDENCE_USED`, `R_UNCORROBORATED` on a $5,000 attempt |
| 81 | CONTROL | NA | kill switch engaged |
| 82 | INTENT | **REJECTED** | `R_KILL_SWITCH`, `R_EVIDENCE_USED` |
| 83 | INTENT | APPROVED | the exit, approved while the brake was engaged |
| 84 | CONTROL | NA | kill switch released |

Seq 80 and 82 carry `R_EVIDENCE_USED` because the bundle at seq 77 was already spent by the
approved open at seq 78. That check came out of the first code review and this is it refusing on
a public chain, not in a test.

**One sequence in the middle records a refused exit, and it is worth reading.** The security
review added a rule that a CLOSE must equal the whole open notional, so that a one micro-USD
CLOSE can no longer wipe a position. The walkthrough was still sending a hard-coded $250 close,
and three earlier runs had each left $250 on the books, so on the first run after the redeploy
the exit was refused `R_CLOSE_SIZE_MISMATCH` on a public chain, in the one beat whose whole point
is that an exit always goes through. The script now reads the position from the chain and closes
exactly that, and it flattens the desk before it starts. The refused receipts stay where they
are.

Trading calls are signed by `trader-ebi.krexa-ual.testnet`, a separate account.

## What NEAR does here, concretely

- **Function-call access keys.** The Trader's key is scoped to one contract and four methods
  (`submit_evidence`, `submit_intent`, `record_fill`, `record_mark`), and the contract refuses its
  `record_mark`: marks come only from the owner or the MONITOR, so a compromised Trader cannot
  mark its own losses away. It cannot transfer, cannot
  call an owner method, cannot reach another contract, and cannot grant itself a better key. The
  **protocol** refuses all of that before any contract code runs, so a bug in our contract would
  not help an attacker. 12 tests in `tests/integration/tests/fc_keys.rs`, plus
  `pnpm attack-demo` against a real node.
- **Least privilege per role.** A MONITOR key holds `engage_kill_switch` and `record_mark` and
  *not* `release_kill_switch`. It can stop the desk; only a human can start it again.
- **Contract-enforced policy and labels.** The policy, the paper/live label and the verdict are
  decided by the contract, not by the operator's server, so the operator is not the judge of
  their own record.
- **`env::ed25519_verify`.** The evidence gate verifies fetcher signatures on chain.
- **A sub-account per agent**, giving each a traceable identity.
- **NEP-297 events** carrying the full receipt, which is what makes an indexer viable later.

## What the gate checks, and what it does not

**Checked by arithmetic, so not forgeable:** that a citation resolves to an item signed by a
registered fetcher key; that it was fetched inside the freshness window; which independence
group the policy assigns its source to; and any claimed RSI, 24h momentum or funding figure,
recomputed from the cited raw prices and **dropped** if it does not match.

That last one holds only because a raw price body is accepted only when it hashes to the id it
is filed under, binding it to the hash the fetcher signed. Without that check the recompute runs
on whatever bytes the caller passed in and proves nothing. It was missing until the code review
caught it, so the precondition is stated here rather than left implicit.

**Taken on the Analyst's word:** whether a *news* item supports or contradicts the thesis.

That second line is the honest boundary. A deterministic function cannot read a headline, and an
LLM inside the verifier would be the very thing an injected fake attacks. So **the gate does not
detect fake news.** It refuses to size a trade on a single source and demands that independent
groups agree. Protection comes from corroboration, not detection.

| k (agreeing groups, net of contradicting) | allowed size |
|---|---|
| 0 or 1 | nothing. `R_UNCORROBORATED` |
| 2 | 50% of requested, then capped by `maxPositionUsd` |
| 3 or more | 100% of requested, then capped |

The multiplier is applied **before** the cap, so a large order on weak evidence is refused as
`R_UNCORROBORATED` rather than `R_MAX_POSITION`. Exits never need evidence.

## Limits

Read these before the results.

Synthetic attacks on replayed data are not real adversaries. **An attacker who plants the same
fake across three declared groups gets full size**, and the declared groups are public on chain,
so an attacker knows which sources to aim at. Worse, and found only in the 337 point run:
**price agreement counts as corroboration**, so a single fake timed to a tape already moving
the right way reaches full size with no second source at all. Corroboration counting rewards an
attacker for patience rather than for reach. There is **no TEE in this build**: every receipt
says `attested: false`. Independence groups are the policy owner's judgement. Paper equity is
operator-reported and is not proof of anything except the operator's commitment over time.
Hashes prove commitment, not correctness, and this is **not zkML**. The model id on a decision is
self-reported. The contract is **unaudited**.

Seven days of archived data cannot show trading skill, so the skill verdict for every desk reads
`CANT_TELL_YET`. [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) lists seven threats with **no
mitigation**, in those words.

## Results

Generated by `pnpm ebi:report` from receipts: [docs/RESULTS.md](docs/RESULTS.md). It regenerates
byte-identically, names its own run and carries the data snapshot hash, so it is the authority
over anything summarised here.

The run that ships is `sim-2026-11-06154524-337p`: 337 decision points from 2026-11-06 to
2026-11-14, 34 attacked per desk, scripted Analysts, verifier `135a8442...`, run after the
security review merged.

**What the fabrication did, and what the gate did about it.** Every template targets a long, and
going long was rare for every desk in this window (about 1 clean decision in 300), so essentially
every long below is one the fake produced:

| desk | attacked | attack changed the decision | changed it to a long | of those, executed |
|---|---|---|---|---|
| `plain` | 34 | 25 | 25 | **25** |
| `ebi` | 34 | 25 | 25 | **5** |
| `hier` | 34 | 14 | 0 | 0 |

`ebi` runs the same Analyst as `plain`, so the fake moved both into the same 25 long decisions.
The gate refused 20 of them and 5 went through: 14.7% attack success [6.4, 30.1] against
`plain`'s 73.5% [56.9, 85.4].

**How the five got through, and it is not the mechanism we predicted.** Four were two-group
plants, which is SPEC.md 2A.6 hypothesis H4 written down before anything ran. The fifth was a
**single**-source fake that reached full size, and the verifier's own explanation says why:

```
synthetic-wire-a.example: NEWS stance SUPPORT is the Analyst's claim, not checked
hyperliquid: 24h move 42 bps, agrees with LONG
binance-public: 24h move 42 bps, agrees with LONG
kraken-public: 24h move 27 bps, agrees with LONG
4 supporting group(s) [newswire-a, exchange-hl, exchange-binance, exchange-kraken]
  minus 0 contradicting [] gives k=4, size multiplier 10000 bps
```

Corroboration counts price-tape agreement as independent support for a news claim. So an
attacker does not need to plant a fake across several outlets: one fake, timed to a tape that
is already drifting the right way, reaches full size on its own. That is the mirror image of the
pilot's finding that the gate's resistance to multi-group planting partly came from the market
happening to disagree ([experiments/ebi/FINDINGS.md](experiments/ebi/FINDINGS.md)). The defence
is **timing-sensitive in the attacker's favour**, and nothing in SPEC.md predicted that.

All five landed on decisions where `ebi` would otherwise have held: 33.3% [15.2, 58.3] when it
was about to hold against 0 of 19 when it was about to short, which is arXiv 2610.26438
finding (iii)'s state dependence showing up here too.

**`hier` scored zero and that is still not a win for `hier`.** It is the baseline SPEC.md said
the gate had to beat, and on the headline number it wins by a margin that excludes zero
(-14.7% [-30.1, -1.6]). But it opened long once in 300 clean decisions: the attacker's direction
is one it was not taking in this window. The fake perturbed it 14 times, never into a long. A
desk that does not take the trade and a gate that refuses the trade are different facts.

**The cost.** The gate refused 19.8% [14.5, 26.4] of clean-run intents, every one for
`R_UNCORROBORATED`. The **false**-block rate, how much of that was a mistake, still is not
measurable: it needs to know whether a blocked signal would have paid at its stated horizon,
which needs a price path extending past each signal.

**Read the limits before the numbers.** They are at the top of
[docs/RESULTS.md](docs/RESULTS.md), above the first table. The shortest version: scripted
Analysts rather than models, so we wrote both the attack and the defence; `polymarket-gamma` was
unreachable for all 337 points and only about half of points had all four price groups; and an
earlier run of the same archive measured the gap between the archive and the wall clock rather
than the gate, which is written up in [docs/FAILURE_CASES.md](docs/FAILURE_CASES.md) and left in
git rather than deleted.

**The pilot** (`sim-2026-11-06154524-10p`, 10 points, every one attacked) is in
[experiments/ebi/FINDINGS.md](experiments/ebi/FINDINGS.md) with its own corrections. It ran under
verifier `dc66e5c0...`, before the raw-body hash check from the code review; an 11-point re-run
under `f1593918...` returned identical counts, for the checkable reason that the harness pairs
every body with the id it hashes to and so never took the unchecked path. Every run since uses
`f1593918...`.

## Reproducibility

Verified from a **fresh `git clone`** in a clean environment with no `.env`, no keys and no
cached sandbox: `setup.sh`, `pnpm test`, `pnpm demo`, `pnpm attack-demo`, `pnpm ebi:report` and
`pnpm web` all succeed, `docs/RESULTS.md` regenerates **byte-identically** to the development
checkout, and `pnpm verifier:codehash` matches across checkouts. Docker is not installed here so
the literal container run was not performed, and
[docs/REPRODUCIBILITY.md](docs/REPRODUCIBILITY.md) says exactly what that does and does not
cover, with the command to try it yourself.

Two runs were scheduled, for 11 and 13 Nov, on whatever the archive had accumulated. **The 11 Nov
one never started**: macOS refuses a `launchd` agent any access under `~/Desktop`, so it died at
`exec` with exit 126, and because the job reports by committing its results an absent commit
looked exactly like a quiet day. It was re-run by hand on 13 Nov, and the 13 Nov run fired from a
timer inheriting a terminal's permissions.
[docs/SCHEDULED_RUNS.md](docs/SCHEDULED_RUNS.md) has the whole thing, including why the recovered
run's numbers then had to be thrown out. Both runs work with or without an LLM key and label
which they used.

The archive records four independent exchanges on a 15 minute grid, content-addressed, with every
failed attempt written down as an explicit gap so a hole in the data cannot be mistaken for a
quiet market.

Cross-language determinism is enforced by `test-vectors/`, generated by the Rust contract and
reproduced by TypeScript. Two asymmetries were found that way and are documented in
[docs/RECEIPTS.md](docs/RECEIPTS.md): `"description"` sorts before `"deskId"` in byte order, and
Rust's `serde_json` distinguishes `100` from `100.0` while `JSON.parse` does not.

## What is real and what is simulated

| Component | Status |
|---|---|
| NEAR contract, receipts, hash chain, function-call keys, evidence gate | **Real** on sandbox and testnet |
| Market prices (Hyperliquid, Binance, Coinbase, Kraken) | **Real** public data, archived with hashes |
| Fetcher attestation | **None.** Every receipt says `attested: false` |
| Fake headlines and indicator panels | **Synthetic**, written by us, labelled everywhere |
| Paper fills, equity, PnL | **Simulated**, labelled `paper` on chain |
| LLM decisions | **Scripted** Analysts unless a run says otherwise |
| Live fills | **Off.** Never enabled in this build |
| Polymarket | **Unreachable** from the operator's network; recorded as a gap |

Details: [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md), [docs/TEE.md](docs/TEE.md).

## Prior work and differentiation

Others have built close variants and this does not claim to be first. SPEC.md section 13 has the
comparison table (AlphaGrid, ScriptSamurai, ERC-8004, OutLayer, TruCore ATF). The two papers are
quoted exactly in [docs/PRIOR_WORK.md](docs/PRIOR_WORK.md), which also records where the prior
work **contradicted our own plan**: finding (v) says hierarchical aggregation works and peer
debate does not, the opposite of what SPEC.md 2A.6 H2 predicted, so H2 was restated and the
cut-line reordered. Both papers share the same two authors, so they are not independent
confirmations of each other.

## Contributors

| | |
|---|---|
| Yatharth Kher ([@Yatharth4599](https://github.com/Yatharth4599)) | design and implementation |
| [@codingstark-dev](https://github.com/codingstark-dev) | code review and the fixes in [PR #2](https://github.com/Yatharth4599/krexa-agent-ledger/pull/2) |

Team size on the submission is recorded as `2 - 4` to reflect this
([docs/SUBMISSION.md](docs/SUBMISSION.md)).

The review found two real bugs that invalidated claims this README was making, which is worth
stating rather than quietly absorbing:

1. **The verifier trusted unverified raw price data.** `verify()` accepted a `rawBodies` map
   keyed by `contentHash` without checking that the body actually hashed to that id. A
   genuinely signed evidence item could therefore be paired with a **fabricated** price body,
   and the verifier would recompute a stance from the fake prices and validate a fabricated
   indicator claim. Confirmed with an exploit before the fix was accepted: swapping the body
   turned a `NEUTRAL` stance into `SUPPORT` and made a fabricated +4492 bps momentum claim pass.
   The claim that indicator recompute is "checked by arithmetic, so not forgeable" was false
   until this was fixed.
2. **`pnpm test` exited 1 on a fresh clone**, because `experiments/ebi` had a `test` script and
   no test files. Our own reproducibility check had missed it by capturing `grep`'s exit status
   instead of `pnpm`'s, so [docs/REPRODUCIBILITY.md](docs/REPRODUCIBILITY.md) was reporting a
   pass that never happened. That document now leads with the correction.

Also fixed: an exit with no open position could record arbitrary notional, one evidence bundle
could back unlimited opens, caller-supplied `equity_usd` could be inflated past the last mark to
dodge the daily loss limit, and the web server crashed on a malformed URL escape.

A second review on 13 Nov, in [PR #3](https://github.com/Yatharth4599/krexa-agent-ledger/pull/3)
and [PR #4](https://github.com/Yatharth4599/krexa-agent-ledger/pull/4), found four more that bit
on claims this README makes. Each was reproduced against the pre-merge code before merging:

1. **Evidence could be replayed.** The contract marked the EVIDENCE *receipt* spent, not the
   items inside it, so the same signed items in a fresh bundle got a fresh sequence number and
   backed another full-size open. Corroboration you can spend twice is not corroboration.
2. **`verifyChain` accepted a truncated chain.** The genesis anchor was checked only when the
   caller passed one and the first receipt was seq 1, and nothing compared the tail to
   `get_head`. "Recompute it in your browser" has to mean the whole chain or it means little.
3. **The off-chain verifier counted any signing key.** Two items signed by a throwaway key
   reached `k=2` in `verify()`. The ledger's verdict was never affected, because the contract
   panics `E19_UNKNOWN_FETCHER` for a key the owner never registered, but the web viewer and the
   local pre-check were wrong.
4. **A compromised Trader controlled the daily loss limit.** `record_mark` accepted any trading
   role, and `record_mark` is on the Trader's function-call key, so it could reset the day basis
   the loss limit reads. `pnpm attack-demo` now has that attempt in it, refused `E02_NOT_AGENT`.

Merging them changed the verifier code hash, which invalidated the policy pinned on testnet and
meant the published results belonged to the old verifier, so the contract was redeployed and the
337 point run above was produced after the merge. The first redeploy also broke the walkthrough's
exit, which is recorded above rather than tidied away.

## Pre-existing code

Only code written in the hackathon window is judged. Everything here was written in the window.
`reused/` is empty: no code was copied from the private `Yatharth4599/Krexa` repo. The only
design ideas carried over are the limits semantics (opens blocked, exits always allowed) and the
percentile-rank scoring idea, both attributed in SPEC.md 13 and 14.

Third-party libraries are in `package.json` and `Cargo.toml`. Notably **not** taken from npm:
SHA-256, base58 and the statistics are written out, because each sits on a path where a reader
needs to be able to check the arithmetic themselves.

## Repo map

| Path | What |
|---|---|
| `contracts/ual` | the NEAR contract: policy, receipts, evidence gate, kill switch |
| `packages/sdk` | canonical JSON, hashing, chain verification, evidence signing, client |
| `packages/verifier` | the deterministic verifier whose code hash the policy pins |
| `packages/scorecard` | Wilson intervals, EBI metrics, allocator CSV |
| `packages/mcp` | the ledger over MCP stdio, read-only |
| `apps/runtime` | Data/Analyst/Trader/Monitor, the desks, the replay harness |
| `apps/archive` | the 15 minute market recorder |
| `apps/fetcher` | evidence fetcher, ed25519, unattested |
| `apps/web` | explorer, leaderboard, EBI results, attack replay |
| `experiments/ebi` | attack templates, findings, budget, results |
| `tests/integration` | near-workspaces sandbox tests including the key denials |
| `test-vectors` | canonical form and hash vectors shared by Rust and TypeScript |

## Status

| Milestone | State |
|---|---|
| M1 contract core, canonical JSON, test vectors | **done** |
| M2 sandbox tests, SDK, fetcher, archive, testnet, `pnpm demo` | **done** |
| M3 deterministic verifier, runtime, desks, replay | **done** |
| M4 attack injector, `hier`, pilot run | **done** |
| M5 scorecard and generated results | **done**, over 337 points on 14 Nov, after the security review merged. Still scripted Analysts: the paid model runs are approved and budgeted but `NEARAI_API_KEY` is empty, and no claim here survives without them |
| M6 web explorer, MCP server | **done** |
| M7 attack demo, skill file, threat model, allocator CSV | **done** |
| M8 README, clean-container reproducibility | **done** |
| Second security review (PR #3, PR #4) | **merged 13 Nov**, contract redeployed, results re-run under the new verifier. Four findings, each reproduced before merging: see Contributors |

## Design and docs

[SPEC.md](SPEC.md) is the full design. [RULES.md](RULES.md) is what each agent may do and which
rules are enforced on chain. [docs/RECEIPTS.md](docs/RECEIPTS.md) records every deviation from
the spec and why. [docs/FAILURE_CASES.md](docs/FAILURE_CASES.md) marks which failures were hit
for real. [skill/SKILL.md](skill/SKILL.md) and [llms.txt](llms.txt) are the agent-facing rules.

## License

MIT. See [LICENSE](LICENSE).

Records of what agents did. Not investment advice. Paper results are simulated.
