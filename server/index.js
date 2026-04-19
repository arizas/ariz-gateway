import { createServer } from 'node:http';
import { fetchPriceHistory, fetchCurrencyList } from './api/prices.js';
import { createAuthenticate } from './accesscontrol/middleware.js';
import { createRpcHandler } from './rpc.js';

const SERVER_PORT = process.env.ARIZ_GATEWAY_PORT ?? 15000;
const contractId = process.env.ARIZ_GATEWAY_CONTRACT_ID ?? 'arizportfolio.testnet';
const networkId = process.env.ARIZ_GATEWAY_NEAR_NETWORK_ID ?? 'testnet';
const nodeUrl = process.env.ARIZ_GATEWAY_NODE_URL ?? 'https://rpc.testnet.near.org';

const authenticate = await createAuthenticate({ networkId, contractId, nodeUrl });
const handleRpc = createRpcHandler({ nodeUrl });

function requiresAuth(pathname) {
    return pathname.startsWith('/api/') || pathname === '/rpc';
}

async function dispatch(req, res, pathname, querystring, accountId) {
    if (pathname === '/api/prices/currencylist') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(await fetchCurrencyList(), null, 1));
        return;
    }
    if (pathname === '/api/prices/history') {
        const search = new URLSearchParams(querystring);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(
            await fetchPriceHistory(search.get('basetoken'), search.get('currency'), search.get('todate')),
            null,
            1
        ));
        return;
    }
    if (pathname === '/rpc') {
        await handleRpc(req, res);
        return;
    }
    res.statusCode = 404;
    res.end('Not found');
}

const server = createServer(async (req, res) => {
    const [pathname, querystring] = req.url.split('?');

    if (!requiresAuth(pathname)) {
        res.end('nothing here');
        return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.end();
        return;
    }

    let accountId;
    try {
        ({ accountId } = await authenticate(req));
    } catch (err) {
        res.statusCode = err.statusCode ?? 401;
        res.end(err.message);
        return;
    }

    try {
        await dispatch(req, res, pathname, querystring, accountId);
    } catch {
        if (!res.headersSent) {
            res.statusCode = 500;
            res.end('Internal error');
        } else {
            res.end();
        }
    }
});

await new Promise(resolve => server.listen(SERVER_PORT, () => resolve()));
console.log('server listening at port', SERVER_PORT);
