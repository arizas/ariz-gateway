# arizcredits.near

JavaScript bundle and upgrade tests for the **arizcredits.near** fungible
token contract on NEAR mainnet.

The wasm runtime is the [quickjs-rust-near](https://github.com/petersalomonsen/quickjs-rust-near)
`fungibletoken` example, which embeds a QuickJS interpreter and dispatches
view/call requests to JS functions uploaded via `post_javascript`. This
directory owns the JS that the gateway expects to be on-chain.

## Contents

- `src/aiconversation.js` — original on-chain logic: `start_ai_conversation`,
  `view_ai_conversation`, `refund_unspent`, `buy_tokens_for_near`.
  Contains the `REPLACE_REFUND_SIGNATURE_PUBLIC_KEY` placeholder substituted
  at deploy time.
- `src/web4_get.js` — vendored AI-proxy web4 frontend currently exported by
  `arizcredits.near`'s `web4_get`. Captured verbatim (~57 KB base64 HTML
  blob) from the most recent on-chain `post_javascript` so deployments
  don't silently drop `arizcredits.near.page`. Regenerated upstream by
  `yarn aiproxy:web4bundle` in quickjs-rust-near.
- `src/operator-deduction.js` — gateway-driven usage metering:
  `authorize_deduction`, `revoke_deduction`, `deduct`,
  `view_authorisation`, `view_spent_since_reset`.
- `src/bundle.js` — assembles the deployable JS by concatenating the three
  source files (`aiconversation` + `web4_get` + `operator-deduction`) and
  substituting the refund-signature public key.
- `sandbox/upgrade.test.js` — end-to-end check that the next wasm
  upgrade plus this JS bundle is state-compatible with what's currently
  on-chain. See **Upgrade test** below.

## Upgrade test

`npm run test:arizcredits-upgrade` runs `node --test sandbox/upgrade.test.js`
inside a fresh near-workspaces sandbox. The flow:

1. Fetch the current on-chain wasm at `arizcredits.near` via mainnet
   `view_code` RPC (cached in `sandbox/fixtures/`). The published v0.0.4
   release wasm is older than what's actually on-chain and predates the
   `env.attached_deposit` / `env.ft_transfer_internal` bindings the
   production JS depends on, so it would be a misleading baseline.
   Override the account or RPC via `ARIZCREDITS_BASELINE_ACCOUNT` /
   `ARIZ_GATEWAY_NODE_URL`.
2. Deploy that wasm to a sandbox account; initialise it.
3. Upload the **legacy** JS (just `aiconversation.js`, with the refund
   public key substituted) and exercise it: `start_ai_conversation`,
   `view_ai_conversation`, `buy_tokens_for_near`.
4. Deploy the **new** wasm built from `../quickjs-rust-near` —
   `examples/fungibletoken/out/fungible_token.wasm`. **No init call**,
   **no migration call**.
5. Verify that FT balances and the prior `conversation` entry survived
   the deploy.
6. Upload the **new** combined JS bundle (`aiconversation` +
   `operator-deduction`).
7. Verify the legacy methods still work.
8. Exercise the operator-deduction lifecycle:
   `authorize_deduction` → `deduct` → `view_authorisation` →
   `view_spent_since_reset` → `revoke_deduction`, plus a deduct-without-
   authorisation rejection.

If step 5 fails, this is the signal that a state migration **is**
required and the upgrade plan needs revisiting.

### Requirements

The test builds the new wasm on demand by running
`./build.sh` in `../quickjs-rust-near/examples/fungibletoken`. That
requires the quickjs-rust-near checkout as a sibling directory and a
working build chain (emscripten 3.1.74, cargo with the wasm32 target,
binaryen ≥ 116). You can skip the build by pre-building the wasm and
pointing `ARIZCREDITS_NEW_WASM` at it:

```bash
ARIZCREDITS_NEW_WASM=/path/to/fungible_token.wasm \
  node --test arizcredits/sandbox/upgrade.test.js
```

## Deploying to mainnet

After PR review + merge the gateway operator deploys with:

```bash
# 1. Build the bundle (the operator picks the refund public key).
node -e '
import("./arizcredits/src/bundle.js").then(async ({ buildArizCreditsJs }) => {
  const pk = Buffer.from("BASE64_PUBKEY_HERE", "base64");
  process.stdout.write(await buildArizCreditsJs({ refundSignaturePublicKey: new Uint8Array(pk) }));
});
' > /tmp/arizcredits.js

# 2. Upload via post_javascript (function-call access key on arizcredits.near is sufficient).
near contract call-function as-transaction arizcredits.near post_javascript \
  json-args "$(jq -Rs '{javascript: .}' < /tmp/arizcredits.js)" \
  prepaid-gas '300.0 Tgas' attached-deposit '0 NEAR' \
  sign-as arizcredits.near network-config mainnet sign-with-keychain send
```

If a wasm upgrade is required (e.g. for the `block_timestamp_ms` /
`clear_data` fixes from quickjs-rust-near PR #51), deploy the wasm
**first**, then re-upload the JS.
