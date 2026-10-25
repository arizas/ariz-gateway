import express from 'express';
import { recordProxyRequest } from './arizcredits/proxy-usage.js';

// FastNear on behalf of a signed-in user (arizas/Ariz-Portfolio#140). The
// browser alone gets rate limited: an account with a hundred access keys
// needs a hundred block lookups, and the answer to a burst is a 429 without
// CORS headers. Through here the requests carry the gateway's FASTNEAR_API_KEY.
//
// Only what the app asks for is passed on, so the key is not a general
// FastNear key for anyone who signs in. Every request sent upstream is
// counted for the signed-in account (proxy-usage.json), and the daily billing
// pass charges it to that account. With billing on, an account that has not
// authorised the gateway gets 402.

export const FASTNEAR_UPSTREAMS = {
    rpc: 'https://rpc.mainnet.fastnear.com/',
    archival: 'https://archival-rpc.mainnet.fastnear.com/',
    tx: 'https://tx.main.fastnear.com',
};

const MAX_ACCOUNT_TXS_LIMIT = 200;
// FastNear's transaction index now and then holds a request open without
// answering. Give up before the browser does (30 s), so it gets a 504 it can
// try again rather than a timeout of its own.
const UPSTREAM_TIMEOUT_MILLIS = 20_000;
const MAX_TX_HASHES = 20;

/** The JSON-RPC calls the app makes: an account's keys, a block, a transaction. */
export function isAllowedRpcCall(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    switch (body.method) {
        case 'query':
            return body.params?.request_type === 'view_access_key_list';
        case 'block':
        case 'tx':
            return true;
        default:
            return false;
    }
}

/**
 * A gate that remembers its answer for a while, so a page making a hundred
 * requests does not make a hundred authorisation lookups.
 */
export function cachedGate(gate, ttlMillis = 5 * 60_000, now = Date.now) {
    const cache = new Map();
    return async (accountId) => {
        const hit = cache.get(accountId);
        if (hit && now() - hit.at < ttlMillis) return hit.ok;
        let ok;
        try { ok = await gate(accountId); } catch { ok = false; } // fail closed
        cache.set(accountId, { ok, at: now() });
        return ok;
    };
}

/**
 * Express middleware: refuse with 402 when billing is on and the signed-in
 * account cannot pay. Runs after `auth`, which sets req.accountId.
 */
export function createPaymentGate(accountGate) {
    const gate = accountGate ? cachedGate(accountGate) : null;
    return async (req, res, next) => {
        if (gate && !(await gate(req.accountId))) {
            return res.status(402).json({
                error: 'authorization_required',
                accountId: req.accountId,
                message: 'Requests to NEAR through the gateway are paid in ARIZ. Authorize the gateway (authorize_deduction on arizcredits.near) with an account that holds ARIZ, and sign in with it.',
            });
        }
        next();
    };
}

/**
 * Send `body` to `url` and pass the answer back, counting the request for the
 * signed-in account.
 */
async function forward(req, res, { url, body, apiKey, dataDir, fetchImpl, timeoutMillis }) {
    recordProxyRequest(dataDir, req.accountId, new URL(url).host);
    let upstream;
    try {
        upstream = await fetchImpl(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMillis),
        });
        const text = await upstream.text();
        res.status(upstream.status);
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-cache');
        res.end(text);
    } catch (e) {
        if (e?.name === 'TimeoutError') {
            return res.status(504).json({ error: 'upstream_timeout' });
        }
        return res.status(502).json({ error: 'upstream_unreachable' });
    }
}

/**
 * Mounted after `auth` and the payment gate.
 * @param {object} opts
 * @param {string} [opts.apiKey] FASTNEAR_API_KEY
 * @param {string} opts.dataDir
 * @param {Function} [opts.fetchImpl]
 * @param {number} [opts.timeoutMillis]
 */
export function createFastNearRouter({ apiKey, dataDir, fetchImpl = fetch, timeoutMillis = UPSTREAM_TIMEOUT_MILLIS }) {
    const router = express.Router();
    router.use(express.json({ limit: '64kb' }));

    const rpc = (url) => (req, res) => {
        if (!isAllowedRpcCall(req.body)) {
            return res.status(400).json({ error: 'not_allowed', message: 'Only view_access_key_list, block and tx are passed on' });
        }
        return forward(req, res, { url, body: req.body, apiKey, dataDir, fetchImpl, timeoutMillis });
    };
    router.post('/rpc', rpc(FASTNEAR_UPSTREAMS.rpc));
    router.post('/archival-rpc', rpc(FASTNEAR_UPSTREAMS.archival));

    router.post('/tx/v0/account', (req, res) => {
        const { account_id, limit } = req.body ?? {};
        if (typeof account_id !== 'string' || (limit !== undefined && !(Number.isInteger(limit) && limit > 0 && limit <= MAX_ACCOUNT_TXS_LIMIT))) {
            return res.status(400).json({ error: 'bad_request', message: `account_id, and a limit of at most ${MAX_ACCOUNT_TXS_LIMIT}` });
        }
        return forward(req, res, { url: `${FASTNEAR_UPSTREAMS.tx}/v0/account`, body: req.body, apiKey, dataDir, fetchImpl, timeoutMillis });
    });
    router.post('/tx/v0/transactions', (req, res) => {
        const hashes = req.body?.tx_hashes;
        if (!Array.isArray(hashes) || hashes.length === 0 || hashes.length > MAX_TX_HASHES || !hashes.every(h => typeof h === 'string')) {
            return res.status(400).json({ error: 'bad_request', message: `tx_hashes: 1 to ${MAX_TX_HASHES} hashes` });
        }
        return forward(req, res, { url: `${FASTNEAR_UPSTREAMS.tx}/v0/transactions`, body: { tx_hashes: hashes }, apiKey, dataDir, fetchImpl, timeoutMillis });
    });
    return router;
}
