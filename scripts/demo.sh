#!/usr/bin/env bash
# `pnpm demo`: build the contract, then run the end-to-end evidence-gate demo on a local
# NEAR sandbox. No keys, no exchange calls, no LLM. Exits non-zero if any assertion fails.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f target/near/ual/ual.wasm ]; then
  echo "building contract"
  cargo near build non-reproducible-wasm --manifest-path contracts/ual/Cargo.toml
fi

# near-workspaces-js bundles neard 2.6.2, which cannot prepare the wasm cargo-near 0.23
# emits. scripts/fetch-sandbox.sh caches the 2.14.0 build that testnet and the Rust test
# stack agree with.
#
# Both variables are set, and they are NOT interchangeable. The npm near-sandbox package
# treats NEAR_SANDBOX_BINARY_PATH as a directory to search and only checks that
# NEAR_SANDBOX_BIN_PATH is non-empty; the Rust near-sandbox crate reads
# NEAR_SANDBOX_BIN_PATH as the path to the binary itself. Pointing the latter at a directory
# satisfies the JS side and silently breaks `cargo test -p integration`, which is how this
# comment came to exist.
if [ -z "${NEAR_SANDBOX_BINARY_PATH:-}" ]; then
  SANDBOX_DIR="$(./scripts/fetch-sandbox.sh)"
  export NEAR_SANDBOX_BINARY_PATH="$SANDBOX_DIR"
  export NEAR_SANDBOX_BIN_PATH="$SANDBOX_DIR/near-sandbox"
fi

exec pnpm -F @krexa-ual/demo start
