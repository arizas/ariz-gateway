#!/usr/bin/env bash
#
# Build the Ariz-Portfolio frontend, embed it into the arizportfolio.near
# contract, deploy, and commit the deployed bundle.
#
# The frontend is compiled into the contract wasm via include_str! in
# src/web4/handler.rs, so deploying the frontend means redeploying the contract.
# index.html.base64 is committed (not gitignored) precisely so this repo's main
# always records exactly what is live on-chain. A bare `cargo near build`
# therefore embeds whatever bundle is currently committed — run THIS script to
# rebuild from the frontend repo first, so you never ship a stale page.
#
# Usage:  ./deploy-frontend.sh
#
# Env overrides:
#   FRONTEND_DIR   path to the Ariz-Portfolio repo (default: ../../Ariz-Portfolio)
#   CONTRACT_ID    web4 contract account            (default: arizportfolio.near)
#   SKIP_COMMIT=1  build + deploy but leave the bundle uncommitted
#
# Note: base64 uses the BSD (macOS) -i/-o flags.

set -euo pipefail

cd "$(dirname "$0")" # -> contract/
FRONTEND_DIR="${FRONTEND_DIR:-../../Ariz-Portfolio}"
CONTRACT_ID="${CONTRACT_ID:-arizportfolio.near}"
BASE64_FILE="src/web4/index.html.base64"
WASM="target/near/ariz_gateway.wasm"

echo "==> Building frontend bundle in $FRONTEND_DIR"
( cd "$FRONTEND_DIR" && yarn dist )

echo "==> Embedding bundle into $BASE64_FILE"
base64 -i "$FRONTEND_DIR/dist/index.html" -o "$BASE64_FILE"

echo "==> Building contract wasm"
cargo near build non-reproducible-wasm

echo "==> Deploying to $CONTRACT_ID (state preserved, no init call)"
near contract deploy "$CONTRACT_ID" use-file "$WASM" \
    without-init-call network-config mainnet sign-with-keychain send

if [ "${SKIP_COMMIT:-}" = "1" ]; then
    echo "==> SKIP_COMMIT set; leaving $BASE64_FILE uncommitted"
    exit 0
fi

if git diff --quiet -- "$BASE64_FILE"; then
    echo "==> Bundle unchanged; nothing to commit"
else
    echo "==> Committing deployed bundle so main reflects production"
    git add "$BASE64_FILE"
    git commit -m "Deploy frontend bundle to $CONTRACT_ID"
    echo "==> Committed. Push when ready: git push"
fi
