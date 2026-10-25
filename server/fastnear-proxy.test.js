import { describe, test, beforeEach, afterEach } from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createFastNearRouter, createPaymentGate, cachedGate, isAllowedRpcCall, FASTNEAR_UPSTREAMS } from './fastnear-proxy.js';
import { readProxyUsage } from './arizcredits/proxy-usage.js';

describe('FastNear proxy', () => {
    let dir, server, base, upstreamCalls, payers, upstreamHangs;

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'ariz-fastnear-'));
        upstreamCalls = [];
        payers = new Set(['alice.near']);
        upstreamHangs = false;
        const fetchImpl = async (url, init) => {
            upstreamCalls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
            if (upstreamHangs) {
                // Like fetch: hold on until the signal gives up.
                await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
            }
            return new Response(JSON.stringify({ jsonrpc: '2.0', result: { ok: true } }), { status: 200 });
        };
        const app = express();
        // Stand-in for the NEP-413 auth middleware: the header names the account.
        const auth = (req, res, next) => {
            if (!req.headers.authorization) return res.status(401).send('failed to parse token');
            req.accountId = req.headers.authorization.slice('Bearer '.length);
            next();
        };
        app.use('/api/fastnear', auth, createPaymentGate(async (a) => payers.has(a)),
            createFastNearRouter({ apiKey: 'KEY', dataDir: dir, fetchImpl, timeoutMillis: 50 }));
        await new Promise(resolve => { server = app.listen(0, resolve); });
        base = `http://localhost:${server.address().port}/api/fastnear`;
    });
    afterEach(() => server.close());

    const post = (path, body, account = 'alice.near') => fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(account ? { authorization: `Bearer ${account}` } : {}) },
        body: JSON.stringify(body),
    });
    const keyList = { jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_access_key_list', finality: 'final', account_id: 'alice.near' } };

    test('needs a signed-in user', async () => {
        equal((await post('/rpc', keyList, null)).status, 401);
        deepEqual(upstreamCalls, []);
    });

    test('refuses an account that cannot pay, and sends nothing', async () => {
        const res = await post('/rpc', keyList, 'mallory.near');
        equal(res.status, 402);
        equal((await res.json()).error, 'authorization_required');
        deepEqual(upstreamCalls, []);
        deepEqual(readProxyUsage(dir), {});
    });

    test('passes an allowed call on with the API key and counts it for the user', async () => {
        const res = await post('/rpc', keyList);
        equal(res.status, 200);
        deepEqual(await res.json(), { jsonrpc: '2.0', result: { ok: true } });
        equal(upstreamCalls[0].url, FASTNEAR_UPSTREAMS.rpc);
        equal(upstreamCalls[0].headers.Authorization, 'Bearer KEY');
        deepEqual(upstreamCalls[0].body, keyList);

        await post('/archival-rpc', { jsonrpc: '2.0', id: 1, method: 'block', params: { block_id: 1 } });
        await post('/tx/v0/account', { account_id: 'alice.near', is_any_signer: true, limit: 200 });
        await post('/tx/v0/transactions', { tx_hashes: ['A', 'B'] });
        equal(upstreamCalls[3].url, 'https://tx.main.fastnear.com/v0/transactions');
        deepEqual(readProxyUsage(dir), {
            'alice.near': { 'rpc.mainnet.fastnear.com': 1, 'archival-rpc.mainnet.fastnear.com': 1, 'tx.main.fastnear.com': 2 },
        });
    });

    test('answers 504 when FastNear does not answer in time, and still counts the request', async () => {
        upstreamHangs = true;
        const res = await post('/tx/v0/transactions', { tx_hashes: ['A'] });
        equal(res.status, 504);
        deepEqual(await res.json(), { error: 'upstream_timeout' });
        deepEqual(readProxyUsage(dir), { 'alice.near': { 'tx.main.fastnear.com': 1 } });
    });

    test('passes on nothing else', async () => {
        const call = (method, params) => ({ jsonrpc: '2.0', id: 1, method, params });
        for (const body of [
            call('broadcast_tx_commit', ['signed']),
            call('query', { request_type: 'view_state', account_id: 'x.near', prefix_base64: '' }),
            call('query', { request_type: 'call_function', account_id: 'x.near', method_name: 'f', args_base64: '' }),
            [keyList, keyList],
        ]) {
            equal((await post('/rpc', body)).status, 400, JSON.stringify(body));
        }
        equal((await post('/tx/v0/account', { account_id: 'alice.near', limit: 10_000 })).status, 400);
        equal((await post('/tx/v0/transactions', { tx_hashes: Array.from({ length: 21 }, (_, i) => `H${i}`) })).status, 400);
        deepEqual(upstreamCalls, []);
        deepEqual(readProxyUsage(dir), {});
    });

    test('isAllowedRpcCall', () => {
        equal(isAllowedRpcCall({ method: 'tx', params: {} }), true);
        equal(isAllowedRpcCall(null), false);
    });

    test('cachedGate asks once per account within its time, and fails closed', async () => {
        let asked = 0, t = 0;
        const gate = cachedGate(async (a) => { asked++; if (a === 'boom.near') throw new Error('rpc down'); return true; }, 1000, () => t);
        equal(await gate('a.near'), true);
        equal(await gate('a.near'), true);
        equal(asked, 1);
        t = 2000;
        await gate('a.near');
        equal(asked, 2);
        equal(await gate('boom.near'), false);
    });
});
