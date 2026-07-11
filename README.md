Ariz gateway
============

Unified Node backend for [Ariz Portfolio](https://github.com/arizas/Ariz-Portfolio). One Express app, one container, one auth surface.

## What it serves

| Path | Purpose | Source |
|---|---|---|
| `/api/prices/currencylist` | Spot prices for one token across many fiats | CoinGecko free `/simple/price` |
| `/api/prices/history` | Multi-year daily price history (token × fiat × day) | CryptoCompare `histoday` (crypto) + Frankfurter (forex) |
| `/api/prices/current` | Spot price batched across tokens, 60s in-memory TTL | CoinGecko free `/simple/price` |
| `/rpc` | Authenticated NEAR JSON-RPC proxy | Forwarded to `ARIZ_GATEWAY_NODE_URL` |
| `/api/accounting/:accountId/*` | Per-account transaction history (status, JSON, CSV, gap analysis) | [near-accounting-export](https://github.com/PeterSalomonsen/near-accounting-export) router + worker, mounted in-process |
| `/git/:repo` | Plaintext git smart-HTTP, one bare repo per authenticated account (the wasm-git remote) | [server/git.js](./server/git.js) → `git http-backend` on the data volume |
| `/store/me/*` | **Encrypted repository store**: client-side encrypted git packfiles — the gateway only ever sees ciphertext | [encrypted-git-storage](https://github.com/petersalomonsen/encrypted-git-storage) proxy → S3-compatible object storage (Tigris) |
| `/` and client routes (`/accounts`, `/staking`, …) | The bundled Ariz Portfolio frontend (SPA fallback to `index.html`) | `server/public/index.html` |

All **API** routes require a NEAR **NEP-413 signed message** as a bearer token, verified per request (signature, recipient, timestamp window, and Full-Access-key ownership via `view_access_key_list`). See [server/accesscontrol/middleware.js](./server/accesscontrol/middleware.js) and [server/accesscontrol/nep413.js](./server/accesscontrol/nep413.js). The static frontend routes are unauthenticated (the app must load before the user signs in).

### Frontend hosting

The gateway serves the bundled Ariz Portfolio frontend from `server/public/index.html`
so the app can run on this origin. Hosting it here — rather than on web4, which serves
with fixed headers — lets us set the cross-origin isolation headers the OPFS-based
`wasm-git` build needs (`SharedArrayBuffer` requires `COOP: same-origin` + `COEP`).
Opt in with `ARIZ_FRONTEND_COEP=credentialless` (or `require-corp`); unset by default
so the current CDN-dependent app keeps working until those dependencies are
self-hosted. Regenerate the bundle from the Ariz-Portfolio checkout:

```bash
yarn dist && cp dist/index.html ../ariz-gateway/server/public/index.html
```

Architecture overview and slice history: [UNIFIED_BACKEND_PLAN.md](./UNIFIED_BACKEND_PLAN.md).

## Local development

```bash
npm install
cp .env.example .env  # fill in values, see below
env $(grep -v '^#' .env) npm start
```

Required env vars (`.env`, gitignored):

```bash
# Gateway (auth + RPC proxy target)
ARIZ_GATEWAY_PORT=15000
ARIZ_GATEWAY_CONTRACT_ID=arizportfolio.near        # or .testnet
ARIZ_GATEWAY_NEAR_NETWORK_ID=mainnet               # or testnet
ARIZ_GATEWAY_NODE_URL=https://rpc.mainnet.fastnear.com

# Persistent data (prices/forex cache + accounting per-account JSONs)
ARIZ_DATA_DIR=./data

# near-accounting-export worker — REQUIRED for the accounting subsystem
# to make sustained progress without hitting public-RPC rate limits
FASTNEAR_API_KEY=...
NEAR_RPC_ENDPOINT=https://archival-rpc.mainnet.fastnear.com

# Optional, gives the worker richer transaction discovery
NEARBLOCKS_API_KEY=...
PIKESPEAK_API_KEY=...
```

Two RPC env vars on purpose:
- `ARIZ_GATEWAY_NODE_URL` — the gateway's own auth check + the `/rpc` proxy target. Non-archival is fine.
- `NEAR_RPC_ENDPOINT` — the **accounting worker's** RPC. Must be archival; the worker reads historical block state to back-fill account history.

## Tests

```bash
npm test                  # unit (auth + prices)
npm run test:integration  # full server, requires near-workspaces sandbox
```

## Deployment

Deployed to Fly.io as `arizgateway` under the `ariz-as` org → `https://arizgateway.fly.dev`.

CI deploys on every push to `main` via [.github/workflows/fly-deploy.yml](./.github/workflows/fly-deploy.yml). Configuration lives in [fly.toml](./fly.toml). The persistent volume `ariz_data` is mounted at `/data` (declared in `fly.toml`); destroying the app would destroy the volume, so suspend (`flyctl machine stop`) before any teardown.

Production secrets are managed with `flyctl secrets set` — never committed. The full set is the same as the local `.env` above (`FASTNEAR_API_KEY`, `NEARBLOCKS_API_KEY`, `PIKESPEAK_API_KEY`, the four `ARIZ_GATEWAY_*` vars, and `NEAR_RPC_ENDPOINT` for the worker). The `ARIZ_DATA_DIR` is set to `/data` via `fly.toml`'s `[env]` block.

### Frontend (web4 contract)

The frontend lives in the separate [Ariz-Portfolio](https://github.com/arizas/Ariz-Portfolio) repo. The `arizportfolio.near` web4 contract no longer embeds the bundle — [contract/src/web4/handler.rs](./contract/src/web4/handler.rs) returns `Web4Response::BodyUrl { body_url: "https://arizgateway.fly.dev/" }`, so web4 fetches the live bundle the gateway serves from [server/public/index.html](./server/public/index.html). **A frontend change is just a gateway deploy — no contract redeploy.**

To ship a frontend update, build the bundle in the Ariz-Portfolio repo (`yarn dist`), copy `dist/index.html` to `server/public/index.html` here, commit and push — Fly auto-deploys. (`arizportfolio.near.page` may briefly cache the previous body.) The same fixed `body_url` is returned for every path, so the SPA router handles client routes (`/portfolio`, `/year-report`, …).

The contract itself only needs redeploying if the `body_url` or web4 behavior changes.

### Encrypted repository store (`/store`)

Zero-knowledge backup target for user data repos (design + threat model:
[Ariz-Portfolio docs/encrypted-storage.md](https://github.com/arizas/Ariz-Portfolio/blob/main/docs/encrypted-storage.md),
spec: arizas/Ariz-Portfolio#76). Repos arrive as **AES-256-GCM-encrypted
packfiles** (encrypted client-side by the [encrypted-git-storage](https://github.com/petersalomonsen/encrypted-git-storage)
service worker or `git-remote-egit`); the gateway authenticates (NEP-413),
scopes the caller to their own store, and streams opaque bytes to object
storage. It holds no keys and can decrypt nothing.

Configuration:

- **Bucket:** `fly storage create --app arizgateway` (Tigris) sets
  `AWS_ENDPOINT_URL_S3`, `AWS_*` credentials and `BUCKET_NAME`. For local dev,
  `S3_ENDPOINT`/`S3_BUCKET`/`S3_ACCESS_KEY`/`S3_SECRET_KEY` point at MinIO
  (path-style). **`/store` is disabled (with a startup log line) when no bucket
  is configured.**
- **`ARIZ_STORE_ID_SECRET`** — object keys are `HMAC-SHA256(secret, account)`,
  so bucket-level observers can't map objects to NEAR accounts (plain hashes
  would be dictionary-reversible; account names are public). Clients address
  themselves as `/store/me/…`, rewritten after auth. **Never rotate casually:
  changing this secret orphans every existing store.** Unset → plain account
  ids + a startup warning (dev only).
- **`ARIZ_STORE_ALLOWED_ORIGINS`** — CORS allow-list (default
  `https://arizportfolio.near.page`): the app page is web4-served and web4 only
  proxies GETs, so the service worker PUTs to this origin directly.
- Billing-gated like `/git` when ARIZ billing is enabled.

### ARIZ usage billing (operator deduction)

Optional. When enabled, a daily pass deducts ARIZ from each synced account in proportion to the FastNear API requests the worker made for it. The worker only **records** per-account FastNear request metrics (`fastnear-metrics.json`); all billing lives in the gateway ([server/arizcredits/billing.js](./server/arizcredits/billing.js)), which keeps its own watermark in `billing.json` and deducts the unbilled delta via one batched `deduct` once per UTC day. Disabled unless both of the first two vars are set:

```bash
ARIZCREDITS_OPERATOR_KEY=ed25519:...   # function-call key on arizcredits.near (method: call_js_func)
ARIZ_PER_FASTNEAR_REQUEST=...          # raw ARIZ (6 decimals) charged per billable request
ARIZCREDITS_CONTRACT_ID=arizcredits.near        # optional, this is the default
ARIZ_BILLABLE_HOSTS=archival-rpc.mainnet.fastnear.com,transfers.main.fastnear.com  # optional override
```

The operator is `arizcredits.near` itself (the contract's `deduct` guards `predecessor === current_account_id`), so the gateway signs `deduct` as `arizcredits.near` with a **function-call key restricted to `call_js_func`** — never a full-access key. ARIZ returns to the contract treasury. Users opt in by calling `authorize_deduction({operator_account: "arizcredits.near", max_amount_per_day})`; accounts without an authorisation are skipped.

## Operational notes

- **Worker stalls = missing FASTNEAR_API_KEY.** If accounting JSONs stop updating, check the gateway logs (`flyctl logs --app arizgateway`) for `Operation cancelled - rate limit detected`. The worker calls FastNEAR for nearly every block it walks; without an API key it gets throttled within seconds.
- **Worker uses archival.** If you see `RPC error in viewAccount for ... at block N: Server error`, `NEAR_RPC_ENDPOINT` is pointing at a non-archival node. Set it to `https://archival-rpc.mainnet.fastnear.com`.
- **Auth model.** Requests authenticate with a **NEP-413 signed message** (`Authorization: Bearer <base64(JSON)>`); the gateway verifies the signature, recipient, a timestamp window, and that the signing key is a Full Access key on the claimed account ([server/accesscontrol/nep413.js](./server/accesscontrol/nep413.js)). Any signed-in user can read **any** account's data via `/api/accounting/:accountId/...` — account ownership isn't cryptographically verifiable at the gateway, so reads are open to authenticated users. (The legacy `register_token`/`get_account_id_for_token` contract methods are unused now and slated for removal.)
- **Lazy enrollment.** First authenticated request for a previously-unseen `accountId` adds it to `accounts.json`; the worker picks it up on its next cycle and starts back-filling history.

## Repository layout

- [server/](./server) — Express app, auth middleware, in-process handlers (prices, RPC, accounting mount)
- [contract/](./contract) — `arizportfolio.near` smart contract: web4 frontend host + access-token registry
- [fly.toml](./fly.toml) — Fly.io app config + volume declaration
- [UNIFIED_BACKEND_PLAN.md](./UNIFIED_BACKEND_PLAN.md) — design history and slice tracking
