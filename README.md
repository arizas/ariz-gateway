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

All routes require a NEAR-signed bearer token, verified per request via the `arizportfolio.near` contract's `get_account_id_for_token` view. See [server/accesscontrol/middleware.js](./server/accesscontrol/middleware.js).

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

The frontend lives in the separate [Ariz-Portfolio](https://github.com/arizas/Ariz-Portfolio) repo and is **compiled into the `arizportfolio.near` contract wasm** — [contract/src/web4/handler.rs](./contract/src/web4/handler.rs) serves `include_str!("index.html.base64")` from `web4_get`. So deploying a frontend change means redeploying the contract.

`contract/src/web4/index.html.base64` is committed (not gitignored) so `main` records exactly what is live on-chain — the on-chain code hash should reproduce from a `cargo near build` of this committed bundle. Because a bare `cargo near build` embeds whatever bundle is currently committed, **deploy with [contract/deploy-frontend.sh](./contract/deploy-frontend.sh)**, which rebuilds from the frontend repo first, deploys (`without-init-call`, state preserved), and re-commits the bundle:

```bash
cd contract
./deploy-frontend.sh            # FRONTEND_DIR / CONTRACT_ID overridable; SKIP_COMMIT=1 to skip the commit
git push
```

## Operational notes

- **Worker stalls = missing FASTNEAR_API_KEY.** If accounting JSONs stop updating, check the gateway logs (`flyctl logs --app arizgateway`) for `Operation cancelled - rate limit detected`. The worker calls FastNEAR for nearly every block it walks; without an API key it gets throttled within seconds.
- **Worker uses archival.** If you see `RPC error in viewAccount for ... at block N: Server error`, `NEAR_RPC_ENDPOINT` is pointing at a non-archival node. Set it to `https://archival-rpc.mainnet.fastnear.com`.
- **Auth model.** Any registered token (registered via `register_token` on the ariz contract, costs 0.2 NEAR) can read **any** account's data via `/api/accounting/:accountId/...`. This is intentional — account ownership isn't cryptographically verifiable at the gateway, so reads are open to authenticated users. Restriction will move to the worker (which accounts get synced) in a follow-up.
- **Lazy enrollment.** First authenticated request for a previously-unseen `accountId` adds it to `accounts.json`; the worker picks it up on its next cycle and starts back-filling history.

## Repository layout

- [server/](./server) — Express app, auth middleware, in-process handlers (prices, RPC, accounting mount)
- [contract/](./contract) — `arizportfolio.near` smart contract: web4 frontend host + access-token registry
- [fly.toml](./fly.toml) — Fly.io app config + volume declaration
- [UNIFIED_BACKEND_PLAN.md](./UNIFIED_BACKEND_PLAN.md) — design history and slice tracking
