# Unified backend service plan

Merge [ariz-gateway](./) and [near-accounting-export](../near-accounting-export) into a single container, plus host filesystem-backed git repos over HTTP from the same container — all behind ariz-gateway's existing NEAR-token auth.

## Slice status

| Slice | Scope | Status | Tracked in |
| --- | --- | --- | --- |
| (a) | Foundation: shared auth middleware, router refactor, in-process `/rpc`, retired Cloudflare Worker, Dockerfile rework | **Shipped** | #2 (merged) |
| (b) | Git over HTTP via `git http-backend` | Not started | (issue TBD) |
| (c) | Mount `near-accounting-export` in-process at `/api/accounting/*` | Blocked on upstream | petersalomonsen/near-accounting-export#42 |
| (d) | Prices rework: replace deactivated CoinGecko Pro key, multi-provider, persistent cache, `/api/prices/current` | Not started | #5 |

## Current state

| Service | Runtime | Port | Auth today |
| --- | --- | --- | --- |
| ariz-gateway | Node 20, built-in `http` | 15000 | NEAR-signed bearer token verified via `get_account_id_for_token` on the ariz contract |
| near-accounting-export | Node/TS, Express | 3000 | No bearer auth; registration gated by a NEAR FT payment tx hash |

Auth pipeline lives in [server/accesscontrol/middleware.js](./server/accesscontrol/middleware.js) (it builds on the lower-level token parsing/verification primitives in [server/accesscontrol/tokenverify.js](./server/accesscontrol/tokenverify.js)).

Git hosting is new. The near-git-storage Rust server is **not** used here — we use stock `git http-backend` with filesystem repos instead (simpler, no extra runtime, no contract plumbing).

## Proposed architecture

### Process model — one Node process

- ariz-gateway is the only long-running process and the only listener on the public port.
- `near-accounting-export` is consumed as an npm dependency; its API router and background sync worker are started in-process by the gateway. No loopback port, no separate service boundary.
- Git over HTTP is served by spawning `git http-backend` per-request as a CGI-style child process. `git` itself is installed in the runtime image; no persistent daemon.

No supervisor, no multi-process container.

### Auth unification

- Extract `tokenverify.js` into `server/accesscontrol/middleware.js` exporting an async `authenticate(req)` that returns `{ accountId }` or throws.
- Rewrite [server/index.js](./server/index.js) to run `authenticate` once per request, attach `accountId`, then dispatch to a router.
- Drop near-accounting-export's `REGISTRATION_FEE_*` path. Access to ariz-gateway already requires a registered token on the ariz contract — that registration is itself payable (`register_token` on [contract/src/lib.rs](./contract/src/lib.rs)), so the "pay to get in" requirement stays in one place.
- **Git-over-HTTP auth**: standard git clients prefer HTTP Basic. Accept both `Authorization: Bearer <token>` and Basic auth where username is ignored and password is the token. This lets `git clone https://ariz.example/git.git` work with any credential helper.

### Routing (public surface)

| Path | Handler |
| --- | --- |
| `/api/prices/*` | existing in-process handlers |
| `/api/accounting/*` | in-process — delegated to the accounting-export router (mounted with prefix stripped) |
| `/rpc` | authenticated NEAR RPC proxy (see below) |
| `/git.git/*` | in-process — spawns `git http-backend` for the authenticated user's repo |

Node's built-in `http` streams request/response bodies, which is what git smart-HTTP needs — no buffering of packfiles.

**Git repo model**: one bare repo per logged-in user, no sharing. Repos live at `$ARIZ_DATA_DIR/git/<sanitized-accountId>.git`. On first request after authenticating, if the repo directory doesn't exist, `git init --bare` it. The public URL contains no repo identifier; the gateway derives the filesystem path from the authenticated `accountId`.

`git http-backend` is invoked per request with:
- `GIT_PROJECT_ROOT=$ARIZ_DATA_DIR/git`
- `GIT_HTTP_EXPORT_ALL=1`
- `PATH_INFO=/<sanitized-accountId>.git/<rest>` (constructed by the gateway from the authenticated account, **not** taken from the incoming URL)
- `REQUEST_METHOD`, `QUERY_STRING`, `CONTENT_TYPE` passed through; request body piped to stdin; stdout streamed back to the client

Since `PATH_INFO` is constructed server-side from the verified `accountId`, there is no way for a client to request anyone else's repo — access control is enforced by construction, not by a path check.

**NEAR RPC proxy**: in-process handler at `/rpc` (see [server/rpc.js](./server/rpc.js)). Same token verification as everything else, forwards JSON-RPC calls to the upstream NEAR node. Shipped in slice (a); the Cloudflare Worker deployment was retired in the same PR.

### Container

Single-stage (or simple two-stage) Dockerfile on `node:20-slim`:

1. **build** (optional stage): install deps, TypeScript-compile anything that needs it.
2. **runtime**: `node:20-slim` with `apt-get install -y git ca-certificates`, runtime deps installed via `yarn install --production --frozen-lockfile` so devDeps (notably `near-sandbox`, which has no Linux arm64 binary) stay out of the image. Copy sources + `node_modules`. Declare `VOLUME /data` for `ARIZ_DATA_DIR` (holds both accounting-export's data and the bare git repos under `/data/git/`). Expose only the gateway port.

No Rust toolchain, no CGI runner, no s6/tini needed — Node is PID 1.

### Env vars

Keep:
- `ARIZ_GATEWAY_PORT`, `ARIZ_GATEWAY_CONTRACT_ID`, `ARIZ_GATEWAY_NEAR_NETWORK_ID`, `ARIZ_GATEWAY_NODE_URL`, `ARIZ_GATEWAY_COINGECKO_API_KEY`

Add:
- `ARIZ_DATA_DIR` (default `/data`)
- Pass-through to accounting-export: `NEAR_RPC_ENDPOINT` and any external API keys it uses

Drop: `CORS_ALLOWED_ORIGINS`, `REGISTRATION_FEE_*` (no longer the access gate).

## Migration steps

1. ✅ Extract auth into a middleware module; add unit tests. *(slice a)*
2. ✅ Refactor [server/index.js](./server/index.js) into an explicit router with the middleware applied uniformly. *(slice a)*
3. ⬜ Consume `near-accounting-export` as an npm dependency — publish it to npm (or install via git URL, e.g. `"near-accounting-export": "github:PeterSalomonsen/near-accounting-export#<sha>"`, while unpublished). Upstream changes needed there: remove its own auth/CORS, expose a `createRouter()` (or `mount(app, opts)`) entry point from `package.json` that accepts a `getAccountId(req)` hook, and start its background sync worker via an exported `startWorker({ dataDir })`. *(slice c, blocked on petersalomonsen/near-accounting-export#42)*
4. ⬜ Add the `/git.git/*` handler: derive the target repo path from the authenticated `accountId`, `mkdir -p` + `git init --bare` lazily, spawn `git http-backend` with the CGI env described above, stream stdin/stdout. Implement the Basic-auth-to-bearer adapter so `git clone` works with credential helpers. *(slice b)*
5. ✅ Port the Cloudflare Worker RPC logic into an in-process `/rpc` handler reusing the shared auth middleware. Retired the Worker deployment in the same PR. *(slice a)*
6. ✅ Update `Dockerfile`: `node:20-slim` base, `apt-get install -y git ca-certificates`, `VOLUME /data`, production-only install. *(slice a)*
7. ⬜ Integration test: obtain a token, then hit (a) `/api/prices/history`, (b) `/api/accounting/accounts`, (c) `/rpc` with a view-call, (d) `git clone https://…/git.git` followed by a commit + push — all with the same token; verify all return 401 without it, and that a second account cannot reach the first account's repo. *(parts (a) and (c) green via slice a unit tests; (b) and (d) pending slices b/c)*

A separate slice (d) tracked in #5 reworks the `/api/prices/*` providers (the sponsored CoinGecko Pro key was deactivated, so prices are currently broken on `main` until that lands).

## Resolved decisions

- **near-accounting-export**: consumed as an npm dependency, mounted in-process in the gateway. No separate port.
- **ACLs**: none in v1. Any token that verifies against the ariz contract is allowed on every endpoint, and the git repo it reaches is determined by the authenticated `accountId`.
- **Git hosting**: stock `git http-backend` + bare repos on a persistent volume. One repo per user, path derived from `accountId`. The Rust `near-git-storage/git-server` is **not** used in this container.
- **Cloudflare Worker RPC proxy**: retired. Its logic is ported into the gateway container as `/rpc`.

## Out of scope (follow-ups)

- Rate limiting (already a TODO in accounting-export's API.md).
- Multi-instance / HA: accounting-export has in-memory job state; filesystem git repos would need shared storage. Scaling is a later story.
- Backups / replication of `$ARIZ_DATA_DIR` (including git repos).
- Re-introducing the on-chain `near-git-storage` backend if/when that becomes desirable.
