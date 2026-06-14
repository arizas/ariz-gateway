import express from 'express';
import {
    fetchCurrencyList,
    fetchCurrent,
    fetchPriceHistory,
    startEodScheduler
} from './api/prices/index.js';
import { createAuthMiddleware } from './accesscontrol/middleware.js';
import { createRpcHandler } from './rpc.js';
import { createRouter as createAccountingRouter, startWorker as startAccountingWorker } from 'near-accounting-export';
import { createDeductClient } from './arizcredits/deduct.js';
import { createBillingPass } from './arizcredits/billing.js';
import { createAuthorizationChecker } from './arizcredits/authorization.js';
import { pruneAccounts } from './arizcredits/enrollment.js';

const SERVER_PORT = process.env.ARIZ_GATEWAY_PORT ?? 15000;
const contractId = process.env.ARIZ_GATEWAY_CONTRACT_ID ?? 'arizportfolio.testnet';
const networkId = process.env.ARIZ_GATEWAY_NEAR_NETWORK_ID ?? 'testnet';
const nodeUrl = process.env.ARIZ_GATEWAY_NODE_URL ?? 'https://rpc.testnet.near.org';
const dataDir = process.env.ARIZ_DATA_DIR ?? '/data';

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
        res.setHeader('Access-Control-Allow-Headers', '*');
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

app.get('/api/prices/current', auth, async (req, res) => {
    const tokens = splitList(req.query.tokens);
    const vs = splitList(req.query.vs);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(await fetchCurrent(tokens, vs), null, 1));
});

app.post('/rpc', auth, handleRpc);

// Path-based account selection. When billing is on, the gateway gates accounting
// access (and therefore enrollment/syncing) on the account having an active
// authorisation + ARIZ balance — an unauthorised account gets 402 and never
// reaches the lazy-enrollment in the (Ariz-agnostic) accounting router.
app.use('/api/accounting/:accountId', auth, async (req, res, next) => {
    // Express resets req.params when entering a mounted router, so stash
    // the path-derived accountId on req for the upstream getAccountId hook.
    req.targetAccountId = req.params.accountId;
    if (accountGate) {
        let allowed = false;
        try { allowed = await accountGate(req.params.accountId); } catch { allowed = false; } // fail closed
        if (!allowed) {
            return res.status(402).json({
                error: 'authorization_required',
                accountId: req.params.accountId,
                message: 'Authorize the Ariz gateway (authorize_deduction on arizcredits.near) and hold ARIZ to enable syncing for this account.',
            });
        }
    }
    next();
}, createAccountingRouter({
    getAccountId: req => req.targetAccountId,
    dataDir
}));

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

startEodScheduler();

let accountingWorker = null;
if (process.env.ARIZ_GATEWAY_DISABLE_ACCOUNTING_WORKER !== 'true') {
    accountingWorker = await startAccountingWorker({ dataDir });
}

// Enrollment reconciliation: periodically prune accounts that no longer qualify
// (authorisation revoked / out of ARIZ) from the worker's account list, so the
// background sync stops syncing them. Pairs with the request-time 402 gate above
// (which keeps new unauthorised accounts out). Gateway-owned policy; the library
// just syncs whatever remains listed.
let reconcileTimer = null;
if (billingEnabled && accountGate) {
    const reconcile = async () => {
        try {
            const pruned = await pruneAccounts(dataDir, accountGate);
            if (pruned.length) console.log(`[enrollment] pruned ${pruned.length} unauthorised account(s): ${pruned.join(', ')}`);
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

const server = app.listen(SERVER_PORT, () => {
    console.log('server listening at port', SERVER_PORT);
});

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
