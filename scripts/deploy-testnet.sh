#!/usr/bin/env bash
# Deploy the UAL contract to NEAR testnet.
#
# Testnet only, by construction. There is no mainnet branch in this script and it refuses to
# run against any network but testnet, because a contract that records paper trading has no
# business on mainnet and SPEC.md's safety rules say so in plain words.
#
# Idempotent: deploying again over the same account upgrades the code and keeps the state, so
# re-running after a contract change does not lose receipts.
#
# Usage:
#   ./scripts/deploy-testnet.sh                      # uses the defaults below
#   UAL_CONTRACT_ID=ual.my.testnet ./scripts/deploy-testnet.sh
set -euo pipefail

cd "$(dirname "$0")/.."

NETWORK="testnet"
OWNER_ACCOUNT="${UAL_OWNER_ACCOUNT:-krexa-ual.testnet}"
CONTRACT_ID="${UAL_CONTRACT_ID:-ual.${OWNER_ACCOUNT}}"
# The Cargo workspace is at the repo root (tests/integration needs to inherit from it), so
# cargo-near writes here and not under contracts/.
WASM="target/near/ual/ual.wasm"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

case "$OWNER_ACCOUNT" in
  *.testnet) ;;
  *) die "owner account must end in .testnet, got '$OWNER_ACCOUNT'. This script does not deploy to mainnet." ;;
esac
case "$CONTRACT_ID" in
  *.testnet) ;;
  *) die "contract id must end in .testnet, got '$CONTRACT_ID'." ;;
esac

command -v near >/dev/null 2>&1 || die "near-cli-rs not found. Install: cargo install near-cli-rs --locked"

say "network   $NETWORK"
say "owner     $OWNER_ACCOUNT"
say "contract  $CONTRACT_ID"
say ""

# --- build ---
# Always rebuild. A redeploy is almost always *because* the contract changed, so trusting a
# wasm that happens to be sitting there is how you deploy last week's code and then spend an
# hour wondering why the code hash does not match.
if [ "${UAL_SKIP_BUILD:-0}" != "1" ]; then
  say "building contract"
  cargo near build non-reproducible-wasm --manifest-path contracts/ual/Cargo.toml
fi
[ -f "$WASM" ] || die "wasm still missing at $WASM"
CODE_HASH=$(shasum -a 256 "$WASM" | cut -d' ' -f1)
say "wasm      $WASM"
say "sha256    $CODE_HASH"
say ""

# --- owner account must exist and have a key we hold ---
if ! near account view-account-summary "$OWNER_ACCOUNT" network-config "$NETWORK" now >/dev/null 2>&1; then
  die "$OWNER_ACCOUNT does not exist on $NETWORK. Create it with:
  near account create-account sponsor-by-faucet-service $OWNER_ACCOUNT autogenerate-new-keypair save-to-legacy-keychain network-config $NETWORK create"
fi

# --- contract sub-account ---
if near account view-account-summary "$CONTRACT_ID" network-config "$NETWORK" now >/dev/null 2>&1; then
  say "contract account exists, redeploying over it (state is preserved)"
  FRESH=0
else
  say "creating contract sub-account $CONTRACT_ID"
  near account create-account fund-myself "$CONTRACT_ID" '5 NEAR' \
    autogenerate-new-keypair save-to-legacy-keychain \
    sign-as "$OWNER_ACCOUNT" \
    network-config "$NETWORK" \
    sign-with-legacy-keychain send
  FRESH=1
fi

# --- deploy ---
say ""
if [ "$FRESH" = "1" ]; then
  say "deploying with init call new({owner: $OWNER_ACCOUNT})"
  near contract deploy "$CONTRACT_ID" \
    use-file "$WASM" \
    with-init-call new json-args "{\"owner\":\"$OWNER_ACCOUNT\"}" \
    prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
    network-config "$NETWORK" sign-with-legacy-keychain send
else
  say "deploying without init call (already initialised)"
  near contract deploy "$CONTRACT_ID" \
    use-file "$WASM" \
    without-init-call \
    network-config "$NETWORK" sign-with-legacy-keychain send
fi

say ""
say "deployed"
say "  contract id   $CONTRACT_ID"
say "  code sha256   $CODE_HASH"
say "  explorer      https://testnet.nearblocks.io/address/$CONTRACT_ID"
say ""
say "Put this in .env and in the README:"
say "  UAL_CONTRACT_ID=$CONTRACT_ID"
say ""
say "The contract account's full-access key is in ~/.near-credentials and is the only way to"
say "redeploy. There is no upgrade method, which SPEC.md 15 discloses rather than hides."
