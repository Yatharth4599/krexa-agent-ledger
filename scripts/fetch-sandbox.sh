#!/usr/bin/env bash
# Download the near-sandbox (neard) binary that `pnpm demo` runs against, and print its path.
#
# Why this exists
# ---------------
# near-workspaces-js 4.x depends on the npm package near-sandbox ^0.1.1, which resolves to
# 0.1.5 and bundles neard 2.6.2. That build cannot *prepare* the wasm cargo-near 0.23
# produces: it fails with CompilationError / PrepareError::Deserialization on a contract that
# NEAR testnet and the Rust near-sandbox (neard 2.14.0) both accept without complaint. The
# bytes deploy fine and are byte-identical on chain; the old runtime simply cannot parse the
# wasm features the current toolchain emits.
#
# Upgrading the npm package is not an option: near-sandbox 0.3.x is a rewrite whose exports
# near-workspaces 4.x cannot load (ERR_PACKAGE_PATH_NOT_EXPORTED), and near-workspaces 5.0.0
# still pins ^0.1.1.
#
# So we fetch the same neard version the Rust tooling uses and hand it to near-workspaces via
# NEAR_SANDBOX_BIN_PATH, which it honours. Both test stacks then run the same runtime as the
# chain we deploy to.
#
# Prints the DIRECTORY containing the binary, which is what near-sandbox's own lookup wants:
# `NEAR_SANDBOX_BINARY_PATH` is a directory it searches for a file called `near-sandbox`, and
# it only skips its built-in default when `NEAR_SANDBOX_BIN_PATH` is also set. Both are
# exported by scripts/demo.sh.
#
# Cached under .sandbox/ (gitignored), so this is a no-op after the first run.
set -euo pipefail

cd "$(dirname "$0")/.."

# Matches DEFAULT_NEAR_SANDBOX_VERSION in the near-sandbox crate that near-workspaces-rs 0.24
# uses, so the JS and Rust test stacks agree.
VERSION="${NEAR_SANDBOX_VERSION:-2.14.0}"
CACHE=".sandbox/${VERSION}"
BIN="${CACHE}/near-sandbox"

if [ -x "$BIN" ]; then
  echo "$PWD/$CACHE"
  exit 0
fi

case "$(uname -s)" in
  Darwin) OS="Darwin" ;;
  Linux)  OS="Linux" ;;
  *) echo "unsupported OS $(uname -s); set NEAR_SANDBOX_BIN_PATH yourself" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  # The S3 layout uses arm64, not aarch64. Darwin-aarch64 returns 403.
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x86_64" ;;
  *) echo "unsupported arch $(uname -m); set NEAR_SANDBOX_BIN_PATH yourself" >&2; exit 1 ;;
esac

URL="https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/${OS}-${ARCH}/${VERSION}/near-sandbox.tar.gz"

echo "fetching neard ${VERSION} for ${OS}-${ARCH}" >&2
mkdir -p "$CACHE"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if ! curl -fsSL "$URL" -o "$TMP/near-sandbox.tar.gz"; then
  echo "download failed: $URL" >&2
  echo "Set NEAR_SANDBOX_BIN_PATH to a neard >= 2.14.0 binary and re-run." >&2
  exit 1
fi

tar -xzf "$TMP/near-sandbox.tar.gz" -C "$TMP"
FOUND=$(find "$TMP" -type f -name "near-sandbox" | head -1)
if [ -z "$FOUND" ]; then
  FOUND=$(find "$TMP" -type f -name "neard" | head -1)
fi
[ -n "$FOUND" ] || { echo "no near-sandbox or neard binary inside the archive" >&2; exit 1; }

mv "$FOUND" "$BIN"
chmod +x "$BIN"

# Fail loudly now rather than with an opaque compilation error during the demo.
if ! "$BIN" --version >/dev/null 2>&1; then
  echo "downloaded binary at $BIN does not run" >&2
  exit 1
fi
"$BIN" --version >&2

echo "$PWD/$CACHE"
