# Reproducibility: what was tested, and what was not

SPEC.md M8 asks for the five commands to succeed in a clean Docker container with no keys and
no manual steps. Here is what was actually verified, and the one thing that was not.

## A correction, kept in view because the method was the problem

The first version of this file reported `pnpm test` as **exit 0** on a fresh clone. That was
wrong, and the way it was wrong is worth recording.

The check was run as `pnpm test | grep ... ; echo $?`, which reports the exit status of **grep**,
not of `pnpm`. Grep found matching lines, so it exited 0, and the pass was recorded. `pnpm test`
was in fact exiting **1**: `experiments/ebi` had a `test` script and no test files, so `vitest`
exited 1 and the recursive run failed.

So the single check this document exists to make was not actually being made. It was found by
codingstark-dev in a code review (PR #1), not by us, and the fix is
`vitest run --passWithNoTests` for the package that legitimately has no tests. Every result
below was then re-measured with the exit status captured directly.

The general lesson, since it applies to anything else verified by eye: a command piped into a
filter reports the filter's status. `set -o pipefail`, or capture the status before piping.

## Tested: a fresh clone in a clean environment

Re-measured on 13 Nov 2026 at commit `9ac892f`, which is the submitted tree apart from this
file and the archive index that grows behind it, from `git clone` of the
public repo into an empty directory, with `NEAR_SANDBOX_BIN_PATH`, `NEAR_SANDBOX_BINARY_PATH`,
`NEARAI_API_KEY`, `FETCHER_SECRET_KEY` and `UAL_CONTRACT_ID` all unset. **Each exit status
captured directly from the command, never through a pipe:**

| Command | Result |
|---|---|
| `./scripts/setup.sh` | **exit 0.** Installed deps, built the contract (316,817 byte wasm, sha256 `ecc7927f...`), fetched `neard 2.14.0`. |
| `pnpm test` | **exit 0.** 433 tests: 77 Rust unit, 12 + 3 sandbox integration, 341 TypeScript (102 sdk, 79 scorecard, 53 verifier, 20 mcp, 6 experiments-ebi, 81 runtime). |
| `pnpm demo` | **exit 0.** "demo complete: every assertion held". |
| `pnpm attack-demo` | **exit 0.** "every attacking attempt was blocked, and every policy breach was recorded". It rewrites `docs/attack-demo.log`, which differs from the committed copy by one line, the timestamp of the run. |
| `pnpm ebi:report` | **exit 0**, and produced `docs/RESULTS.md` **byte-identical** to the committed one: `git diff` reported no change, sha256 `6f00c5e2...` in both checkouts. |
| `pnpm web` | served `/`, `/ual.js`, `/data/runs` and `/data/results-md` with HTTP 200. |

### The measurement that mattered, on the run before this one

The same check at commit `98da5a5`, a few hours earlier, **failed** on the byte-identity line:
the clone regenerated `docs/RESULTS.md` from an 11 point run of 7 Nov rather than the 323 point
run of 13 Nov. The report was choosing the latest run by `run.json` mtime, and a clone stamps
every checked-out file with the checkout time, so the ordering was whatever order git wrote in.
Correct on the machine that produced the runs; wrong on every other machine, which is to say
wrong on a judge's.

It is worth recording for the same reason as the correction above: nothing in the repo could have
caught it. Both unit tests and a careful reading of the function pass. Only running the thing on
a real clone fails. The ordering key now comes out of `run.json` and `latestRun` has six tests
that set mtimes contradicting the right answer.

Two further checks, because they are the ones that would quietly break:

- **`pnpm verifier:codehash` is identical across checkouts** (`f1593918...`, and `dc66e5c0...`
  before the review fixes landed in PR #2 changed `verify.ts`). If it were not,
  policies pinning that hash would be invalid in one checkout and valid in another, and the
  pinning would mean nothing.
- **`docs/RESULTS.md` hashes identically** when regenerated from the same committed receipts in
  a different directory. SPEC.md M5 asks for byte-identical regeneration and this is it.

### What the fresh clone deliberately does not have

A judge gets no `.env`, no `data/archive/raw/` (gitignored, it is bulk), no `.sandbox/` and no
`node_modules`. What they do get is `data/archive/index.jsonl` (1,635 lines at this
measurement, and growing while the recorder runs) and the
run directories under `experiments/ebi/results`, which is why `pnpm ebi:report` works
immediately on a clone.

The verifier's real-payload extractor tests read `data/archive/raw/`, which is absent on a
clone. They **skip rather than fail**, and print a warning saying so, so a reader can tell a
skipped network test from a passing one.

## Not tested: an actual Docker container

Docker is not installed on the development machine, so the literal container run in SPEC.md M8
was not performed. Saying it passed would be a guess.

What the fresh-clone test does and does not cover, relative to a container:

**Covered.** Missing files, gitignored essentials, absolute paths leaking into committed code,
anything that only worked because of a file sitting in the development directory, and
environment variables the build had come to depend on. That is the class of failure most likely
to break a judge's run, and it is the reason the fresh-clone test is worth doing even where a
container is available.

**Not covered.** A different OS or architecture, a different Node or Rust version than the
pinned ones, and a genuinely empty toolchain cache. In particular:

- `scripts/fetch-sandbox.sh` resolves `Darwin-arm64` here. It handles `Linux-x86_64` and
  `Linux-arm64` by the same rule and the S3 layout is the same, but only the Darwin path has
  been exercised.
- `rust-toolchain.toml` pins 1.99.1, so `rustup` will fetch it in a container. That download
  has not been timed and the container would need `rustup` present.
- `cargo-near` would be installed by `setup.sh` on first run, which takes several minutes.

## Running it in a container yourself

```bash
docker run -it --rm -v "$PWD:/w" -w /w node:22 bash -lc '
  curl -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none
  . "$HOME/.cargo/env"
  npm i -g pnpm
  ./scripts/setup.sh && pnpm test && pnpm demo
'
```

`setup.sh` installs `cargo-near` itself if it is missing, and `rust-toolchain.toml` makes
`rustup` fetch the pinned compiler. Expect the first run to take a while: a contract build plus
a `neard` download plus `cargo-near` compiling from source.

If that fails, it is a bug and the fresh-clone test did not catch it. The most likely causes are
the two items above: platform resolution in `fetch-sandbox.sh`, or a toolchain the container
cannot fetch.

## Determinism, where it matters

Three things in this repo have to be reproducible or the design does not hold:

1. **Canonical form and hashing.** Enforced across languages by `test-vectors/`, generated by
   the Rust contract and reproduced by the TypeScript SDK. A drift fails a test rather than
   silently making receipts unverifiable. Two real asymmetries were found this way and are
   documented in [RECEIPTS.md](RECEIPTS.md).
2. **The verifier code hash.** Computed over source files in a fixed order, so it is
   reproducible with nothing but the repo and `sha256`. Verified identical across two checkouts.
3. **`docs/RESULTS.md`.** Generated from receipts with no hand-entered number, no clock read at
   render time and no randomness. Verified byte-identical across checkouts and across repeated
   runs in the same checkout.

The harness itself is deterministic too: the attack schedule is index-based rather than random,
the scripted Analysts are pure functions of their inputs, and decision points are built only
from snapshots dated at or before each point, with an assertion that fails the run otherwise.
