# Evidence-Bound Intents on the Krexa Underwritable Agent Ledger

An LLM trading swarm should only trade on evidence it can show. This repo is a NEAR contract plus a
deterministic verifier that refuses a trade unless the signal cites signed, fresh evidence from
independent sources, and sizes the trade by how many independent sources agree. Every action,
including every refusal, is recorded in a hash-chained ledger that anyone can recompute.

Built for NEAR HACKATHON (window 2026-10-19 to 2026-11-14). Tracks: `swarms` (primary), `defi` (secondary).

## Research question

Can a deterministic verifier that only allows trades backed by checked, corroborated evidence limit
the damage from fake inputs without destroying real returns?

## Expected answer, written down before anything was run

Partly. We expect a sharp cut in the attack success rate of single-source fakes, and we also expect
the gate to block some profitable early signals that start with one source. That is a real cost in
clean conditions and it may dominate. It will not stop an attacker who plants the same fake in
several independent-looking sources, and a TEE proves what was fetched, not that it was true.
All results are paper. No returns are claimed for any agent or for Krexa.

## Status

This section is updated at every milestone and states only what actually runs.

| Milestone | What it covers | State |
|---|---|---|
| M1 | Canonical JSON and hash test vectors, contract core, policy commit, evidence gate, hash chain, kill switch | **done**: 67 Rust tests, 57 TypeScript tests, wasm builds |
| M2 | Sandbox integration tests, SDK, evidence fetcher, testnet deploy, data archive, `pnpm demo` | **done**: 15 sandbox tests, SDK, testnet contract live, signed fetcher, archive recording on a 15 minute grid, `pnpm demo` green |
| M3 | Deterministic verifier, agent runtime, desks `plain` and `ebi` | not started |
| M4 | Replay harness, attack injector, `debate` and `hier` desks, pilot run | not started |
| M5 | Full runs and scorecard metrics | not started |
| M6 | Web leaderboard, explorer, attack replay, MCP server | not started |
| M7 | Prompt-injection attack demo, skill file, threat model, allocator CSV | not started |
| M8 | README for judges, clean-container reproducibility | not started |

Nothing below is filled in until the code that produces it runs. The contract is unaudited and
testnet only.

## Quick start for AI judges

These three work now, with no keys and no manual steps:

```bash
git clone https://github.com/Yatharth4599/krexa-agent-ledger && cd krexa-agent-ledger
./scripts/setup.sh      # checks toolchain, pnpm install, builds the contract, fetches a sandbox node
pnpm test               # 67 Rust unit + 15 near-workspaces sandbox + 102 TypeScript tests
pnpm demo               # local sandbox end to end: policy, evidence gate, attack blocked, kill switch, chain verify
```

`pnpm demo` exits non-zero if any assertion fails, so it is a test as much as a demonstration.

Deployed testnet contract: [`ual.krexa-ual.testnet`](https://testnet.nearblocks.io/address/ual.krexa-ual.testnet)
(`code sha256 0f204817adeadae8bbd6fd13a7c6485828bd42e94156a16d99aa53c077461e3c` at first deploy).

The full five-command sequence, once M3 to M6 land:

```bash
git clone https://github.com/Yatharth4599/krexa-agent-ledger && cd krexa-agent-ledger
./scripts/setup.sh      # checks toolchain, pnpm install, builds the contract
pnpm test               # Rust unit + near-workspaces sandbox + TS tests
pnpm demo               # local sandbox: policy, evidence gate, attack blocked, withdraw fails, kill switch, chain verify, CSV
pnpm ebi:report         # recomputes docs/RESULTS.md from recorded receipts
pnpm web                # http://localhost:3000
```

## Data archive

Public market data is recorded on a 15 minute grid from 6 Nov 2026 for deterministic replay.
Four independent exchange groups (Hyperliquid, Binance, Coinbase, Kraken), every response
hashed, every failed attempt recorded as an explicit gap.

```bash
pnpm archive:stats     # per-source coverage and gap counts
pnpm archive:verify    # rehash every stored body against the index
./scripts/archive-start.sh   # run the recorder detached
./scripts/archive-stop.sh
```

Terms for each source are in [data/archive/SOURCES.md](data/archive/SOURCES.md). Polymarket is
in the source list but unreachable from the operator's network (ISP-level DNS blocking), so
every round records an explicit gap for it rather than dropping it from the design. The
consequence for the study, and the replacement independence groups, are in
[docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

## Evidence fetcher

```bash
pnpm fetcher:keygen         # generate an ed25519 key; goes in .env, never committed
pnpm fetcher:once           # fetch live and sign
pnpm fetcher:from-archive   # sign an archived snapshot with its own timestamp
```

The fetcher runs as an ordinary process, not inside an enclave, and is registered with an
attestation hash of 64 zeros. Every receipt downstream therefore carries `attested: false`.
That is a deliberate, labelled outcome, not an unfinished one:
[docs/TEE.md](docs/TEE.md) records what was checked (NEAR AI Cloud attests model inference
only, not arbitrary fetches; OutLayer is the right shape but its HTTP-from-enclave behaviour
is undocumented) and what a working TEE fetch would and would not prove.

## Results

Not run yet. When they exist they appear here with the limits paragraph directly above the table,
the data snapshot hash, the contract id, the model ids and the decision counts, generated by
`pnpm ebi:report` from receipts only.

## Limits

Synthetic attacks on replayed data are not real adversaries. An attacker who plants the same fake
across several sources defeats corroboration counting. The TEE proves fetch, not truth. Independence
groups are a judgement call made by the policy owner. A handful of models over a few thousand
decisions in one market window does not generalize. Paper only. About 8 days of trading data cannot
show trading skill, so the skill verdict for every desk is expected to read `CANT_TELL_YET`.

## What is real and what is simulated

See [SPEC.md section 16](SPEC.md). Short version: the NEAR contract, receipts, hash chain,
function-call keys and the evidence gate are real on sandbox and testnet. Market prices are real
public data, archived with hashes. Fake headlines and indicator panels are **synthetic attacks** and
are labelled as such everywhere. Paper fills, equity and PnL are simulated and labelled `paper` on
chain. Live execution is off by default and is not part of the study.

## Safety defaults

No mainnet transactions. No live orders. No signing with funded keys. Live code paths require
`UAL_ALLOW_LIVE=1` and a typed confirmation at the terminal. NEAR Intents has no testnet, so any
1Click call in this repo uses `dry: true`.

## Prior work and differentiation

This builds on existing work and is not claimed as a first. The two papers that motivate it
have been read and quoted exactly in [docs/PRIOR_WORK.md](docs/PRIOR_WORK.md), which also
records three places where the prior work changes our own plan:

- arXiv 2610.26438 reports prompt injection at 14% attack success rate and fabricated news at
  62%, "inverting the usual LLM-security intuition". Both figures check out.
- The same paper reports that "peer debate fails, and only hierarchical aggregation reduces
  ASR", which **contradicts half of the hypothesis SPEC.md 2A.6 states**. H2 is restated
  accordingly, and the interesting comparison becomes the evidence gate against hierarchical
  aggregation rather than against an undefended agent.
- arXiv 2609.19705 (FARSIGHT) urges deployers to "corroborate sources, keep interrupts that
  bypass the model, and enforce loss limits outside it". This build does all three. That is
  the contribution: gaps someone else named, closed in one auditable way on a public chain.

Both papers share the same two authors, so they are not independent confirmations of each
other. The comparison table for adjacent products (AlphaGrid, ScriptSamurai, ERC-8004,
OutLayer, TruCore ATF) is [SPEC.md section 13](SPEC.md).

## Pre-existing code

Only code written in the hackathon window is judged. Anything pre-existing lives in `reused/` with
its origin, license and changes listed in `reused/README.md`. That folder is empty right now.

## Design

Full design in [SPEC.md](SPEC.md). Agent roles and message flow in [RULES.md](RULES.md).

## License

MIT. See [LICENSE](LICENSE).

Records of what agents did. Not investment advice. Paper results are simulated.
