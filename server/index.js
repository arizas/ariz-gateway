import express from 'express';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
    fetchCurrencyList,
    fetchCurrent,
    fetchNoPriceTokens,
    fetchPriceHistory,
    startEodScheduler
} from './api/prices/index.js';
import { createAuthMiddleware } from './accesscontrol/middleware.js';
import { createRpcHandler } from './rpc.js';
import { makeStoreRepoId } from './store-id.js';
import { createStoreMount } from './store-mount.js';
import { S3Client } from '@aws-sdk/client-s3';
import { createRouter as createAccountingRouter, startWorker as startAccountingWorker } from 'near-accounting-export';
import { createDeductClient } from './arizcredits/deduct.js';
import { createBillingPass } from './arizcredits/billing.js';
import { createAuthorizationChecker } from './arizcredits/authorization.js';
import { pruneAccounts } from './arizcredits/enrollment.js';
import { getPayer, setPayer, removeMonitor } from './arizcredits/monitors.js';

const SERVER_PORT = process.env.ARIZ_GATEWAY_PORT ?? 15000;
const contractId = process.env.ARIZ_GATEWAY_CONTRACT_ID ?? 'arizportfolio.testnet';
const networkId = process.env.ARIZ_GATEWAY_NEAR_NETWORK_ID ?? 'testnet';
const nodeUrl = process.env.ARIZ_GATEWAY_NODE_URL ?? 'https://rpc.testnet.near.org';
const dataDir = process.env.ARIZ_DATA_DIR ?? '/data';

// Serve the bundled Ariz Portfolio frontend (a single self-contained index.html)
// from this origin. Hosting it here rather than on web4 lets us set the
// cross-origin isolation headers the OPFS wasm-git build needs - web4 serves with
// fixed headers and can't. Opt in to isolation with ARIZ_FRONTEND_COEP
// (credentialless | require-corp); default off so the current CDN-dependent app
// keeps working until those dependencies are self-hosted.
const frontendDir = process.env.ARIZ_FRONTEND_DIR ?? fileURLToPath(new URL('./public', import.meta.url));
const frontendIndex = join(frontendDir, 'index.html');
const frontendEnabled = existsSync(frontendIndex);
const frontendCoep = process.env.ARIZ_FRONTEND_COEP; // 'credentialless' | 'require-corp' | undefined

function setIsolationHeaders(res) {
    if (frontendCoep) {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', frontendCoep);
    }
}

// ARIZ usage billing (operator deduction). Disabled unless an operator key and a
// per-request rate are configured.
const arizCreditsContractId = process.env.ARIZCREDITS_CONTRACT_ID ?? 'arizcredits.near';
const arizPerFastNearRequest = process.env.ARIZ_PER_FASTNEAR_REQUEST;

if (!process.env.NEAR_RPC_ENDPOINT) {
    process.env.NEAR_RPC_ENDPOINT = nodeUrl;
}

const auth = await createAuthMiddleware({ networkId, contractId, nodeUrl });
const handleRpc = createRpcHandler({ nodeUrl });

// Billing is enabled only when an operator key + a positive per-request rate are
// set. When enabled, we also gate enrollment + syncing on each account having an
// active authorisation AND a positive ARIZ balance, so we never sync (incur
// FastNear cost for) accounts that aren't paying.
const billingEnabled = !!(process.env.ARIZCREDITS_OPERATOR_KEY && arizPerFastNearRequest && BigInt(arizPerFastNearRequest) > 0n);
const accountGate = billingEnabled
    ? await createAuthorizationChecker({ networkId, nodeUrl, contractId: arizCreditsContractId })
    : null;

function splitList(value) {
    return (value ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

const app = express();

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        // Reflect the requested headers rather than '*': per the Fetch spec the
        // wildcard does NOT cover Authorization (Firefox/Safari enforce this;
        // Chrome is lenient), and every authenticated call — /api, /git, /store —
        // sends it. Reflecting also covers If-Match/If-None-Match for the /store
        // refs CAS.
        res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ?? '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.end();
        return;
    }
    next();
});

app.get('/api/prices/currencylist', auth, async (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(await fetchCurrencyList(), null, 1));
});

app.get('/api/prices/history', auth, async (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(
        await fetchPriceHistory(req.query.basetoken, req.query.currency, req.query.todate),
        null,
        1
    ));
});

app.get('/api/prices/nopricetokens', auth, async (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(await fetchNoPriceTokens(), null, 1));
});

app.get('/api/prices/current', auth, async (req, res) => {
    const tokens = splitList(req.query.tokens);
    const vs = splitList(req.query.vs);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(await fetchCurrent(tokens, vs), null, 1));
});

// 1Click confidential-intents API access (arizas/Ariz-Portfolio#75). The
// frontend needs the partner x-api-key to call https://1click.chaindefuser.com
// (auth + confidential history/balances); the key is a gateway secret, handed
// out only to NEP-413-authenticated users. The actual account authentication
// against 1Click happens client-side with a wallet-signed NEP-413 message —
// this key only opens the API channel, it grants no access to other accounts'
// confidential data.
const oneClickApiKey = process.env.ONECLICK_API_KEY;
const oneClickApiUrl = process.env.ONECLICK_API_URL ?? 'https://1click.chaindefuser.com';
app.get('/api/intents/config', auth, (req, res) => {
    if (!oneClickApiKey) {
        return res.status(404).json({
            error: 'not_configured',
            message: 'Confidential intents access is not configured on this gateway (ONECLICK_API_KEY is not set).',
        });
    }
    res.json({ apiUrl: oneClickApiUrl, apiKey: oneClickApiKey });
});

app.post('/rpc', auth, handleRpc);

// Path-based account selection. When billing is on, each monitored account is
// paid for by a payer account (monitors.json). The payer is established
// implicitly: the first authorized + funded account that loads a not-yet-monitored
// account becomes its payer (and is billed for it). Reads of an already-monitored
// account stay open to any signed-in user; an unmonitored account that the caller
// can't pay for gets 402 (and never reaches the library's lazy-enrollment).
app.use('/api/accounting/:accountId', auth, async (req, res, next) => {
    const target = req.params.accountId;
    req.targetAccountId = target; // Express resets req.params in the mounted router

    if (accountGate) {
        // Is the account currently covered by a valid payer?
        let covered = false;
        const payer = getPayer(dataDir, target);
        if (payer) {
            try { covered = await accountGate(payer); } catch { covered = false; }
        }
        if (!covered) {
            // Try to claim it for the authenticated requester (the payer).
            const requester = req.accountId;
            let canPay = false;
            try { canPay = await accountGate(requester); } catch { canPay = false; } // fail closed
            if (canPay) {
                setPayer(dataDir, target, requester);
            } else {
                return res.status(402).json({
                    error: 'authorization_required',
                    accountId: target,
                    message: 'This account is not being monitored. Log in with an account that has authorized the gateway (authorize_deduction on arizcredits.near) and holds ARIZ, then load this account to start monitoring it — you will be billed for it.',
                });
            }
        }
    }
    next();
}, createAccountingRouter({
    getAccountId: req => req.targetAccountId,
    dataDir
}));

// PLAINTEXT git hosting is RETIRED (arizas/Ariz-Portfolio#76): repositories
// live client-side-encrypted in the /store object store; the app syncs through
// its service worker and the CLI through git-remote-egit. The old handler
// lazily created bare repos on push, so a plain 404 is not enough — answer 410
// so nothing can silently recreate plaintext data on the volume. (Handler kept
// in server/git.js for reference; last plaintext repo deleted 2026-07-12,
// volume snapshots age out ~5 days later.)
app.use('/git', (req, res) => {
    res.status(410).json({
        error: 'gone',
        message: 'Plaintext git hosting is retired. Data syncs end-to-end encrypted via /store — in the app (Storage page), or with git-remote-egit: EGIT_KEY=<exported key> EGIT_AUTH="Bearer <token>" git clone "egit::https://arizgateway.fly.dev/store/me" portfolio',
    });
});

// Encrypted object store (encrypted-git-storage): whole-repo client-side
// encrypted git packfiles in S3-compatible object storage — the gateway only
// ever sees ciphertext. It authenticates the caller (NEP-413) and scopes them to
// their own `<account>/*` keys (repoId = the authenticated account). Configured
// via Tigris' AWS_* env (`fly storage create`) or S3_* (dev/MinIO); disabled
// when no bucket is configured. CORS is required because the app page lives on
// arizportfolio.near.page while pushes are PUTs, which web4 can't proxy — the
// service worker calls this origin directly (preflighted PUTs included).
// See arizas/Ariz-Portfolio#76.
const storeBucket = process.env.BUCKET_NAME ?? process.env.S3_BUCKET;
const storeEndpoint = process.env.AWS_ENDPOINT_URL_S3 ?? process.env.S3_ENDPOINT;
if (storeBucket && storeEndpoint) {
    const storeS3 = new S3Client({
        endpoint: storeEndpoint,
        region: process.env.AWS_REGION ?? process.env.S3_REGION ?? 'auto',
        // Path-style for dev/MinIO (S3_ENDPOINT); Tigris/AWS use virtual-host style.
        forcePathStyle: !!process.env.S3_ENDPOINT,
        // With Tigris the AWS_* credentials come from the default provider chain.
        ...(process.env.S3_ACCESS_KEY ? {
            credentials: {
                accessKeyId: process.env.S3_ACCESS_KEY,
                secretAccessKey: process.env.S3_SECRET_KEY,
            },
        } : {}),
    });
    // Blinded per-account store ids (see server/store-id.js): object keys are
    // HMAC(secret, account), so the bucket reveals no account identities. Clients
    // address their own store as /store/me/… — rewritten after authentication.
    const storeRepoId = makeStoreRepoId(process.env.ARIZ_STORE_ID_SECRET);
    if (!process.env.ARIZ_STORE_ID_SECRET) {
        console.warn('encrypted store: ARIZ_STORE_ID_SECRET not set — store ids are plain account names');
    }
    app.use('/store', createStoreMount({
        s3: storeS3,
        bucket: storeBucket,
        allowedOrigins: splitList(process.env.ARIZ_STORE_ALLOWED_ORIGINS ?? 'https://arizportfolio.near.page'),
        auth,
        accountGate,
        storeRepoId,
    }));
    console.log(`encrypted store: /store -> ${storeEndpoint} bucket=${storeBucket} (blinded ids: ${process.env.ARIZ_STORE_ID_SECRET ? 'on' : 'OFF'})`);
} else {
    console.log('encrypted store: disabled (set BUCKET_NAME + AWS_ENDPOINT_URL_S3, or S3_BUCKET + S3_ENDPOINT)');
}

if (frontendEnabled) {
    // Static assets first, then an SPA fallback to index.html for client-routed
    // paths (/accounts, /staking, ...). API routes are registered above, so they
    // take precedence; only non-/api, non-/rpc GETs fall through to the app.
    app.use((req, res, next) => {
        if (req.method === 'GET' || req.method === 'HEAD') setIsolationHeaders(res);
        next();
    });
    app.use(express.static(frontendDir, { index: false }));
    app.use((req, res, next) => {
        if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/rpc') || req.path.startsWith('/git')) {
            return next();
        }
        setIsolationHeaders(res);
        res.sendFile(frontendIndex);
    });
    console.log(`Serving frontend from ${frontendDir}${frontendCoep ? ` (cross-origin isolation: ${frontendCoep})` : ''}`);
}

app.use((req, res) => {
    res.end('nothing here');
});

app.use((err, req, res, _next) => {
    console.error(err);
    if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Internal error');
    } else {
        res.end();
    }
});

// Start listening immediately, before any background job. A failing worker must
// not be able to prevent the gateway from binding its port or crash-loop the
// process - the HTTP API (including the price endpoints) has to stay up
// independently of the background workers.
const server = app.listen(SERVER_PORT, () => {
    console.log('server listening at port', SERVER_PORT);
});

try {
    startEodScheduler();
} catch (e) {
    console.error('Failed to start EOD price scheduler; gateway continues:', e);
}

let accountingWorker = null;
if (process.env.ARIZ_GATEWAY_DISABLE_ACCOUNTING_WORKER !== 'true') {
    try {
        accountingWorker = await startAccountingWorker({ dataDir });
    } catch (e) {
        console.error('Failed to start accounting worker; gateway continues without it:', e);
    }
}

// Enrollment reconciliation: periodically prune accounts that no longer qualify
// (authorisation revoked / out of ARIZ) from the worker's account list, so the
// background sync stops syncing them. Pairs with the request-time 402 gate above
// (which keeps new unauthorised accounts out). Gateway-owned policy; the library
// just syncs whatever remains listed.
let reconcileTimer = null;
if (billingEnabled && accountGate) {
    // An account stays synced only while its payer is still authorised + funded.
    // Unmonitored accounts (no payer) are pruned too. Fail-safe: an RPC error
    // leaves the account in place (pruneAccounts keeps accounts whose check throws).
    const isStillPaid = async (account) => {
        const payer = getPayer(dataDir, account);
        if (!payer) return false;       // unmonitored -> prune
        return accountGate(payer);      // throws on RPC error -> kept (fail-safe)
    };
    const reconcile = async () => {
        try {
            const pruned = await pruneAccounts(dataDir, isStillPaid);
            for (const account of pruned) removeMonitor(dataDir, account);
            if (pruned.length) console.log(`[enrollment] pruned ${pruned.length} unpaid account(s): ${pruned.join(', ')}`);
        } catch (e) {
            console.error('[enrollment] reconciliation failed:', e);
        }
    };
    await reconcile();
    reconcileTimer = setInterval(reconcile, 60 * 60 * 1000); // hourly
}

// Daily ARIZ usage-billing pass. The worker records per-account FastNear request
// metrics; this pass converts the unbilled delta to ARIZ and deducts it in one
// batched call once per UTC day. All billing state lives in the gateway.
let billingTimer = null;
if (billingEnabled) {
    const deductClient = await createDeductClient({
        networkId,
        nodeUrl,
        contractId: arizCreditsContractId,
        operatorKey: process.env.ARIZCREDITS_OPERATOR_KEY,
    });
    const billableHosts = splitList(process.env.ARIZ_BILLABLE_HOSTS);
    const billing = createBillingPass({
        dataDir,
        deductClient,
        ratePerRequest: arizPerFastNearRequest,
        billableHosts: billableHosts.length ? billableHosts : undefined,
    });
    let billingRunning = false;
    const tickBilling = async () => {
        if (billingRunning || !billing.shouldRun()) return;
        billingRunning = true;
        try {
            const r = await billing.runOnce();
            if (r.total) console.log(`[billing] daily pass: ${r.total} account(s) deducted`);
        } catch (e) {
            console.error('[billing] daily pass failed:', e);
        } finally {
            billingRunning = false;
        }
    };
    await tickBilling();
    billingTimer = setInterval(tickBilling, 60 * 60 * 1000); // hourly check; fires once per UTC day
    console.log('ARIZ usage billing enabled');
} else {
    console.log('ARIZ usage billing disabled (set ARIZCREDITS_OPERATOR_KEY + ARIZ_PER_FASTNEAR_REQUEST to enable)');
}

async function shutdown() {
    server.close();
    if (billingTimer) {
        clearInterval(billingTimer);
    }
    if (reconcileTimer) {
        clearInterval(reconcileTimer);
    }
    if (accountingWorker) {
        await accountingWorker.stop();
    }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
