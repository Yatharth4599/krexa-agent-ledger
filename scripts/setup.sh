#!/usr/bin/env bash
# Checks the toolchain, installs JS deps, builds the contract.
# Safe to run on a clean clone with no keys. Does not touch the network beyond package registries.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
fail=0

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  MISS  %s\n' "$*"; fail=1; }

say "krexa-agent-ledger setup"
say ""
say "toolchain"

if command -v node >/dev/null 2>&1; then
  major=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
  if [ "$major" -ge 20 ]; then ok "node $(node -v)"; else bad "node $(node -v), need >= 20"; fi
else
  bad "node not found, need >= 20 (https://nodejs.org)"
fi

if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm $(pnpm -v)"
else
  bad "pnpm not found. Install with: npm i -g pnpm"
fi

if command -v cargo >/dev/null 2>&1; then
  ok "cargo $(cargo --version | cut -d' ' -f2)"
else
  bad "cargo not found. Install Rust: https://rustup.rs"
fi

if rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown; then
  ok "wasm32-unknown-unknown target"
else
  say "  adding wasm32-unknown-unknown target"
  rustup target add wasm32-unknown-unknown
fi

if command -v cargo-near >/dev/null 2>&1 || cargo near --version >/dev/null 2>&1; then
  ok "cargo-near $(cargo near --version 2>/dev/null | head -1 | cut -d' ' -f2 || echo present)"
else
  say "  cargo-near not found, installing (this compiles and takes a few minutes)"
  cargo install cargo-near --locked
fi

if command -v gitleaks >/dev/null 2>&1; then
  ok "gitleaks $(gitleaks version 2>/dev/null | head -1)"
else
  say "  WARN  gitleaks not found. The pre-commit secret hook will refuse commits until you install it."
  say "        brew install gitleaks   or   https://github.com/gitleaks/gitleaks/releases"
fi

if [ "$fail" -ne 0 ]; then
  say ""
  say "Install the items marked MISS and run this again."
  exit 1
fi

say ""
say "secret hook"
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit
ok "pre-commit hook installed (core.hooksPath=.githooks)"

if [ ! -f .env ]; then
  cp .env.example .env
  ok ".env created from .env.example (all values blank, live mode off)"
else
  ok ".env already present, left alone"
fi

say ""
say "js dependencies"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

say ""
say "contract build"
cargo near build non-reproducible-wasm --manifest-path contracts/ual/Cargo.toml

say ""
say "setup done. Next:"
say "  pnpm test    rust unit + sandbox integration + TS tests"
say "  pnpm demo    local sandbox end to end, no keys needed"
