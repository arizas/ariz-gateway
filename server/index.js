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

// Path-based account selection: any authenticated user can request data
// for any accountId. Account ownership isn't cryptographically verifiable
// at the gateway, so read access is open to all signed-in users.
// Worker enrollment (which accounts the background sync actually processes)
// is the place to apply restrictions like a payment gate; that's a follow-up.
app.use('/api/accounting/:accountId', auth, (req, _res, next) => {
    // Express resets req.params when entering a mounted router, so stash
    // the path-derived accountId on req for the upstream getAccountId hook.
    req.targetAccountId = req.params.accountId;
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

// Daily ARIZ usage-billing pass. The worker records per-account FastNear request
// metrics; this pass converts the unbilled delta to ARIZ and deducts it in one
// batched call once per UTC day. All billing state lives in the gateway.
let billingTimer = null;
if (process.env.ARIZCREDITS_OPERATOR_KEY && arizPerFastNearRequest && BigInt(arizPerFastNearRequest) > 0n) {
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
    if (accountingWorker) {
        await accountingWorker.stop();
    }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
