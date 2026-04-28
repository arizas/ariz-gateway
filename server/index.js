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

const SERVER_PORT = process.env.ARIZ_GATEWAY_PORT ?? 15000;
const contractId = process.env.ARIZ_GATEWAY_CONTRACT_ID ?? 'arizportfolio.testnet';
const networkId = process.env.ARIZ_GATEWAY_NEAR_NETWORK_ID ?? 'testnet';
const nodeUrl = process.env.ARIZ_GATEWAY_NODE_URL ?? 'https://rpc.testnet.near.org';
const dataDir = process.env.ARIZ_DATA_DIR ?? '/data';

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
    const search = new URLSearchParams(req.url.split('?')[1] ?? '');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(
        await fetchPriceHistory(search.get('basetoken'), search.get('currency'), search.get('todate')),
        null,
        1
    ));
});

app.get('/api/prices/current', auth, async (req, res) => {
    const search = new URLSearchParams(req.url.split('?')[1] ?? '');
    const tokens = splitList(search.get('tokens'));
    const vs = splitList(search.get('vs'));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(await fetchCurrent(tokens, vs), null, 1));
});

app.post('/rpc', auth, handleRpc);

app.use('/api/accounting', auth, createAccountingRouter({
    getAccountId: req => req.accountId,
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

const server = app.listen(SERVER_PORT, () => {
    console.log('server listening at port', SERVER_PORT);
});

async function shutdown() {
    server.close();
    if (accountingWorker) {
        await accountingWorker.stop();
    }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
