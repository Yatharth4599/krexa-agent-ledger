#!/usr/bin/env bash
# Run a command with a sandbox binary new enough for our wasm.
#
# See scripts/fetch-sandbox.sh for why the bundled one will not do. The two variables are not
# interchangeable: the npm near-sandbox package treats NEAR_SANDBOX_BINARY_PATH as a directory
# to search and only checks that NEAR_SANDBOX_BIN_PATH is non-empty, while the Rust crate
# reads NEAR_SANDBOX_BIN_PATH as the binary itself.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${NEAR_SANDBOX_BINARY_PATH:-}" ]; then
  SANDBOX_DIR="$(./scripts/fetch-sandbox.sh)"
  export NEAR_SANDBOX_BINARY_PATH="$SANDBOX_DIR"
  export NEAR_SANDBOX_BIN_PATH="$SANDBOX_DIR/near-sandbox"
fi
exec "$@"
