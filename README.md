# Evidence-Bound Intents on the Krexa Underwritable Agent Ledger

An LLM trading swarm should only trade on evidence it can show.

This is a NEAR contract plus a deterministic verifier that refuses a trade unless the signal
cites signed, fresh evidence from independent sources, and sizes the trade by how many
independent sources agree. Every action, **including every refusal**, is recorded in a
hash-chained ledger anyone can recompute in a browser without trusting us.

Built for NEAR HACKATHON (1 to 14 Nov 2026). Tracks: `swarms` (primary),
`defi` (secondary). Unaudited. Testnet only. Paper only.

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
pnpm test               # 76 Rust unit + 15 sandbox integration + 319 TypeScript tests
pnpm demo               # the whole evidence gate on a local sandbox; exits non-zero on any failure
pnpm attack-demo        # a prompt-injected Trader against a real node; writes docs/attack-demo.log
pnpm ebi:report         # regenerates docs/RESULTS.md from recorded receipts
pnpm web                # http://localhost:3000
```

### Do X, see Y

| Run this | See this |
|---|---|
| `pnpm test` | 410 tests pass. The sandbox ones start a real NEAR node. |
| `pnpm demo` | A fake headline arrives. `plain` trades on it; `ebi` refuses with `R_UNCORROBORATED`. A second independent source arrives and the trade is approved at **half** size. A fabricated RSI of 25.00 is dropped against a recomputed 100.00. One changed byte breaks the chain at a named sequence number. |
| `pnpm attack-demo` | 11 attacking attempts, all blocked: 8 by the NEAR protocol before any contract code runs (plus a check that the attacker's balance did not change), 3 by the policy and recorded as receipts. |
| `pnpm web` then Explorer, Load from chain | 14 receipts from `ual.krexa-ual.testnet`, every hash recomputed **in your browser**, anchored to the desk's genesis. Press Tamper and watch it break at the right seq. |
| `pnpm mcp` | The ledger over MCP stdio. Ask for `withdraw` and it explains that no such tool exists by design. |
| `pnpm ual replay ebi 6` | Recomputes the prompt, snapshot, tool-call and output hashes behind one decision, then says plainly what replay does not prove. |
| `pnpm archive:verify` | Rehashes every archived market snapshot against its recorded hash. Needs `data/archive/raw/`, which is gitignored: on a fresh clone it reports every body as missing and exits 1. |

## It is live on testnet

Contract: [`ual.krexa-ual.testnet`](https://testnet.nearblocks.io/address/ual.krexa-ual.testnet)

The testnet deployment predates the exit, fill and evidence-reuse checks in
[docs/RECEIPTS.md](docs/RECEIPTS.md) until it is redeployed. The sandbox tests run the current code.

Desk `ebi` holds a real 14 receipt chain written by `pnpm testnet:walkthrough`:

| seq | kind | verdict | what happened |
|---|---|---|---|
| 5 | EVIDENCE | NA | one source, `k=1`, size multiplier **0 bps**, `attested: false` |
| 6 | INTENT | **REJECTED** | `R_UNCORROBORATED`, `PAPER_ONLY_UNCORROBORATED` |
| 7 | EVIDENCE | NA | a second independent group, `k=2`, **5000 bps** |
| 8 | INTENT | APPROVED | $500 requested |
| 9 | FILL | NA | **$250** filled: the gate halved it |
| 10 | INTENT | **REJECTED** | `R_MAX_POSITION` on a $5,000 attempt |
| 12 | INTENT | **REJECTED** | `R_KILL_SWITCH` |
| 13 | INTENT | APPROVED | a close, approved while the brake was engaged |

Trading calls are signed by `trader-ebi.krexa-ual.testnet`, a separate account.

## What NEAR does here, concretely

- **Function-call access keys.** The Trader's key is scoped to one contract and four methods
  (`submit_evidence`, `submit_intent`, `record_fill`, `record_mark`). It cannot transfer, cannot
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
so an attacker knows which sources to aim at. There is **no TEE in this build**: every receipt
says `attested: false`. Independence groups are the policy owner's judgement. Paper equity is
operator-reported and is not proof of anything except the operator's commitment over time.
Hashes prove commitment, not correctness, and this is **not zkML**. The model id on a decision is
self-reported. The contract is **unaudited**.

A few hours of archived data cannot show trading skill, so the skill verdict for every desk reads
`CANT_TELL_YET`. [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) lists seven threats with **no
mitigation**, in those words.

## Results

Generated by `pnpm ebi:report` from receipts: [docs/RESULTS.md](docs/RESULTS.md). It regenerates
byte-identically and carries the data snapshot hash. It always reports the **latest** run
(today `sim-2026-11-06154524-11p`: 11 points, 2 of them attacked, no `debate` desk), so its
numbers differ from the pilot below.

The pilot (run `sim-2026-11-06154524-10p`, written up in
[experiments/ebi/FINDINGS.md](experiments/ebi/FINDINGS.md)), over 10 archived decision points with scripted Analysts: `plain` opened in the
attacker's direction 8 times out of 10, `ebi` once. **That one failure was `three-group-fake`**,
which is SPEC.md 2A.6 hypothesis H4 written down before anything ran. A defence that fails
precisely where its designers predicted is the most that can be claimed, and it is worth more
than a clean sweep would have been. `debate` tracked `plain` exactly, reproducing arXiv
2610.26438 finding (v)'s "peer debate fails".

**Why that is a pilot and not a result**, and not for the reason you would expect: the gap is
large enough to be statistically distinguishable even at n=10. The reasons are about construct
validity and none improves with more data. The scripted Analyst keys on the same credibility
cues the attack templates carry, by construction. We wrote both the attack and the defence. Each
template was tried once. `hier` never traded at all.
[experiments/ebi/FINDINGS.md](experiments/ebi/FINDINGS.md) sets this out, including a correction
to an earlier claim of mine that was wrong.

**The clean-run cost is not yet measurable**, and that is the half of the research question that
could make the whole answer negative. A gate that blocks fakes *and* blocks every profitable
early signal is not worth deploying. It needs a longer archive or a news feed; the latter is
held up on terms, not code.

## Reproducibility

Verified from a **fresh `git clone`** in a clean environment with no `.env`, no keys and no
cached sandbox: `setup.sh`, `pnpm test`, `pnpm demo`, `pnpm attack-demo`, `pnpm ebi:report` and
`pnpm web` all succeed, `docs/RESULTS.md` regenerates **byte-identically** to the development
checkout, and `pnpm verifier:codehash` matches across checkouts. Docker is not installed here so
the literal container run was not performed, and
[docs/REPRODUCIBILITY.md](docs/REPRODUCIBILITY.md) says exactly what that does and does not
cover, with the command to try it yourself.

Two runs are scheduled for 11 and 13 Nov and fire without anyone at the keyboard, using whatever
the archive has accumulated: [docs/SCHEDULED_RUNS.md](docs/SCHEDULED_RUNS.md). They work with or
without an LLM key and label which they used.

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
| M5 scorecard and generated results | **done**; the paid LLM runs are approved and scheduled, blocked on an API key |
| M6 web explorer, MCP server | **done** |
| M7 attack demo, skill file, threat model, allocator CSV | **done** |
| M8 README, clean-container reproducibility | **done** |

## Design and docs

[SPEC.md](SPEC.md) is the full design. [RULES.md](RULES.md) is what each agent may do and which
rules are enforced on chain. [docs/RECEIPTS.md](docs/RECEIPTS.md) records every deviation from
the spec and why. [docs/FAILURE_CASES.md](docs/FAILURE_CASES.md) marks which failures were hit
for real. [skill/SKILL.md](skill/SKILL.md) and [llms.txt](llms.txt) are the agent-facing rules.

## License

MIT. See [LICENSE](LICENSE).

Records of what agents did. Not investment advice. Paper results are simulated.
