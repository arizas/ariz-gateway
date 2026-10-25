import { describe, test, beforeEach, afterEach } from 'node:test';
import { equal, deepEqual, ok } from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createAccessKeysRouter } from './index.js';
import { createFastNearClient, FASTNEAR } from './fastnear.js';
import { decodeNonce, listAccessKeys } from './keys.js';
import { signaturesOf } from './lastuse.js';
import { readUsage } from '../../arizcredits/usage.js';

const ACCOUNT = 'alice.near';
const ns = (iso) => (BigInt(Date.parse(iso)) * 1_000_000n).toString();

// FastNear as these tests want it. `index` is the signed-transaction index,
// newest first, in pages.
function fakeFastNear() {
    const chain = {
        keys: [],
        index: [],
        calls: [],
        failNextIndexPage: false,
    };
    chain.fetchImpl = async (url, init) => {
        const body = JSON.parse(init.body);
        const path = url.startsWith(FASTNEAR.tx) ? url.substring(FASTNEAR.tx.length) : `${url}:${body.method}`;
        chain.calls.push({ path, body, authorization: init.headers.Authorization });
        const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
        if (path === `${FASTNEAR.rpc}:query`) {
            return json({ jsonrpc: '2.0', result: { block_height: 221000000, keys: chain.keys } });
        }
        if (path === `${FASTNEAR.archival}:block`) {
            // Block 117149952 was skipped by the chain.
            if (body.params.block_id === 117149952) {
                return json({ jsonrpc: '2.0', error: { cause: { name: 'UNKNOWN_BLOCK' }, message: 'skipped' } });
            }
            return json({ jsonrpc: '2.0', result: { header: { timestamp_nanosec: ns('2024-04-19T04:48:31.587Z') } } });
        }
        if (path === '/v0/account') {
            if (chain.failNextIndexPage) {
                chain.failNextIndexPage = false;
                return json({ message: 'something else' });
            }
            const page = body.resume_token ? Number(body.resume_token) : 0;
            return json({
                account_txs: chain.index[page].map(t => ({ transaction_hash: t.hash, tx_block_timestamp: ns(t.at) })),
                resume_token: page + 1 < chain.index.length ? String(page + 1) : null,
            });
        }
        if (path === '/v0/transactions') {
            return json({ transactions: body.tx_hashes.map(hash => ({ transaction: chain.index.flat().find(t => t.hash === hash).transaction })) });
        }
        return json({ error: 'not mocked' }, 500);
    };
    return chain;
}

const fullAccess = (publicKey, nonce) => ({ public_key: publicKey, access_key: { nonce, permission: 'FullAccess' } });
const own = (hash, at, publicKey, nonce) => ({ hash, at, transaction: { hash, signer_id: ACCOUNT, public_key: publicKey, nonce, actions: [] } });
const relayed = (hash, at, publicKey, nonce) => ({
    hash, at, transaction: {
        hash, signer_id: 'relayer.nearmobile.near', public_key: 'ed25519:RELAYER', nonce: 5,
        actions: [{ Delegate: { delegate_action: { sender_id: ACCOUNT, public_key: publicKey, nonce } } }],
    },
});

describe('/api/accesskeys', () => {
    let dir, server, base, chain;

    const start = async ({ budgetMillis, pagesPerRequest } = {}) => {
        const app = express();
        // Stand-in for the NEP-413 auth middleware: the header names the account.
        app.use('/api/accesskeys', (req, res, next) => {
            req.accountId = req.headers.authorization.slice('Bearer '.length);
            next();
        }, createAccessKeysRouter({ dataDir: dir, apiKey: 'KEY', fetchImpl: chain.fetchImpl, budgetMillis, pagesPerRequest }));
        await new Promise(resolve => { server = app.listen(0, resolve); });
        base = `http://localhost:${server.address().port}/api/accesskeys`;
    };
    const request = async (method, path, signedIn = 'bob.near') => {
        const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${signedIn}` } });
        const text = await res.text();
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        return { status: res.status, body };
    };
    const byKey = (body) => Object.fromEntries(body.keys.map(k => [k.publicKey, k]));

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'ariz-accesskeys-'));
        chain = fakeFastNear();
    });
    afterEach(() => server?.close());

    test('lists the keys with what their nonces say, dating each block once for everyone', async () => {
        await start();
        chain.keys = [
            fullAccess('ed25519:A', 117149950000039),
            fullAccess('ed25519:SKIPPED', 117149951000000),
            {
                public_key: 'ed25519:APP', access_key: {
                    nonce: 168955707000000,
                    permission: { FunctionCall: { allowance: '250000000000000000000000', method_names: [], receiver_id: 'app.near' } },
                },
            },
            fullAccess('ed25519:OLD', 412),
        ];
        const { status, body } = await request('GET', `/${ACCOUNT}`);
        equal(status, 200);
        equal(body.blockHeight, 221000000);
        const keys = byKey(body);
        deepEqual(keys['ed25519:A'], {
            publicKey: 'ed25519:A', nonce: 117149950000039, permission: { type: 'FullAccess' },
            addedBlock: 117149951, transactionsSigned: 39, addedAt: '2024-04-19T04:48:31.587Z',
            lastUse: null, lastUseNotIndexed: false,
        });
        // Its block was skipped: the next one stands in.
        equal(keys['ed25519:SKIPPED'].addedAt, '2024-04-19T04:48:31.587Z');
        deepEqual(keys['ed25519:APP'].permission, { type: 'FunctionCall', receiverId: 'app.near', methodNames: [], allowance: '250000000000000000000000' });
        equal(keys['ed25519:OLD'].addedBlock, null);
        equal(keys['ed25519:OLD'].addedAt, null);
        equal(chain.calls[0].authorization, 'Bearer KEY');

        // Another user asking: only the key list is fetched, and billed to them.
        chain.calls.length = 0;
        await request('GET', `/${ACCOUNT}`, 'carol.near');
        deepEqual(chain.calls.map(c => c.path), [`${FASTNEAR.rpc}:query`]);
        deepEqual(readUsage(dir), {
            'bob.near': { 'rpc.mainnet.fastnear.com': 1, 'archival-rpc.mainnet.fastnear.com': 4 },
            'carol.near': { 'rpc.mainnet.fastnear.com': 1 },
        });
    });

    test('finds the last use of each key, relayed ones too, and keeps it while the nonce stays', async () => {
        await start();
        chain.keys = [fullAccess('ed25519:A', 117149950000043), fullAccess('ed25519:B', 117149960000005), fullAccess('ed25519:UNUSED', 168955707000000)];
        chain.index = [[
            relayed('T3', '2026-06-03T10:00:00.000Z', 'ed25519:A', 117149950000043),
            own('T2', '2026-05-02T10:00:00.000Z', 'ed25519:B', 117149960000005),
            own('T1', '2026-04-01T10:00:00.000Z', 'ed25519:A', 117149950000042),
        ]];
        const { body } = await request('POST', `/${ACCOUNT}/lastuse`);
        deepEqual(body.lastUseSearch, { complete: true });
        deepEqual(byKey(body)['ed25519:A'].lastUse, { nonce: 117149950000043, txHash: 'T3', at: '2026-06-03T10:00:00.000Z', relayer: 'relayer.nearmobile.near' });
        deepEqual(byKey(body)['ed25519:B'].lastUse, { nonce: 117149960000005, txHash: 'T2', at: '2026-05-02T10:00:00.000Z', relayer: null });
        equal(byKey(body)['ed25519:UNUSED'].lastUse, null);

        // Nothing has signed since: no search, and a plain GET has the answer too.
        chain.calls.length = 0;
        const again = await request('POST', `/${ACCOUNT}/lastuse`);
        deepEqual(chain.calls.map(c => c.path), [`${FASTNEAR.rpc}:query`]);
        equal(byKey(again.body)['ed25519:A'].lastUse.txHash, 'T3');
        equal(byKey((await request('GET', `/${ACCOUNT}`)).body)['ed25519:B'].lastUse.txHash, 'T2');
    });

    test('goes on from where the last request stopped, and marks keys the index does not have', async () => {
        await start({ pagesPerRequest: 1 });
        chain.keys = [fullAccess('ed25519:C', 3), fullAccess('ed25519:NOWHERE', 12)];
        chain.index = [
            [own('T3', '2026-03-01T00:00:00.000Z', 'ed25519:X', 1)],
            [own('T2', '2026-02-01T00:00:00.000Z', 'ed25519:X', 2)],
            [own('T1', '2026-01-01T00:00:00.000Z', 'ed25519:C', 3)],
        ];
        const first = await request('POST', `/${ACCOUNT}/lastuse`);
        deepEqual(first.body.lastUseSearch, { complete: false });
        equal(byKey(first.body)['ed25519:C'].lastUse, null);
        const second = await request('POST', `/${ACCOUNT}/lastuse`);
        deepEqual(second.body.lastUseSearch, { complete: false });
        const third = await request('POST', `/${ACCOUNT}/lastuse`);
        deepEqual(third.body.lastUseSearch, { complete: true });
        equal(byKey(third.body)['ed25519:C'].lastUse.txHash, 'T1');
        equal(byKey(third.body)['ed25519:NOWHERE'].lastUseNotIndexed, true);
        deepEqual(chain.calls.filter(c => c.path === '/v0/account').map(c => c.body.resume_token ?? null), [null, '1', '2'],
            'each page once: it goes on, not over');
    });

    test('starts over from the newest when a key signed during an unfinished search', async () => {
        await start({ pagesPerRequest: 1 });
        chain.keys = [fullAccess('ed25519:C', 3), fullAccess('ed25519:D', 9)];
        chain.index = [
            [own('T2', '2026-02-01T00:00:00.000Z', 'ed25519:D', 9)],
            [own('T1', '2026-01-01T00:00:00.000Z', 'ed25519:C', 3)],
        ];
        await request('POST', `/${ACCOUNT}/lastuse`);
        // C signs again before the search reaches page 2: its newest
        // signature is above where the search would go on from.
        chain.keys = [fullAccess('ed25519:C', 4), fullAccess('ed25519:D', 9)];
        chain.index = [[own('T3', '2026-03-01T00:00:00.000Z', 'ed25519:C', 4)], ...chain.index];
        const { body } = await request('POST', `/${ACCOUNT}/lastuse`);
        deepEqual(body.lastUseSearch, { complete: true });
        equal(byKey(body)['ed25519:C'].lastUse.txHash, 'T3');
        equal(byKey(body)['ed25519:D'].lastUse.txHash, 'T2');
    });

    test('an index answer without the list is an error: nothing is marked not indexed', async () => {
        await start();
        chain.keys = [fullAccess('ed25519:C', 3)];
        chain.index = [[own('T1', '2026-01-01T00:00:00.000Z', 'ed25519:C', 3)]];
        chain.failNextIndexPage = true;
        const failed = await request('POST', `/${ACCOUNT}/lastuse`);
        equal(failed.status, 502);
        ok(/did not answer with a list/.test(failed.body.message));
        const { body } = await request('POST', `/${ACCOUNT}/lastuse`);
        equal(byKey(body)['ed25519:C'].lastUse.txHash, 'T1');
        equal(byKey(body)['ed25519:C'].lastUseNotIndexed, false);
    });

    test('refuses what is not a NEAR account id', async () => {
        await start();
        for (const id of ['UPPER.near', 'a', '..%2Fblocktimes', '..%2F..%2Fgateway-usage']) {
            equal((await request('GET', `/${id}`)).status, 400, id);
        }
        // A bare .. is resolved by the URL itself and never reaches the route.
        equal((await request('GET', '/..')).status, 404);
        deepEqual(chain.calls, []);
    });
});

describe('access key helpers', () => {
    test('dates blocks only for as long as the budget lasts, the rest on a later request', async () => {
        let t = 0;
        const asked = [];
        const nonces = [117, 118, 119, 120, 121, 122].map(b => b * 1_000_000_000_000);
        const client = {
            viewAccessKeyList: async () => ({
                block_height: 1,
                keys: nonces.map((nonce, i) => ({ public_key: `ed25519:K${i}`, access_key: { nonce, permission: 'FullAccess' } })),
            }),
            // Each lookup takes a second, once it has started.
            block: async (h) => { asked.push(h); await null; t += 1000; return { header: { timestamp_nanosec: '1713502111587973394' } }; },
        };
        const cache = {};
        const blockTimes = { get: h => cache[h], set: (h, a) => { cache[h] = a; } };
        // Four lookups at a time: the first four start, then the budget is spent.
        const first = await listAccessKeys({ client, accountId: 'a.near', blockTimes, datingBudgetMillis: 1000, now: () => t });
        equal(first.keys.filter(k => k.addedAt).length, 4);
        const second = await listAccessKeys({ client, accountId: 'a.near', blockTimes, datingBudgetMillis: 10_000, now: () => t });
        equal(second.keys.filter(k => k.addedAt).length, 6);
        equal(asked.length, 6, 'each block once');
    });

    test('decodeNonce', () => {
        deepEqual(decodeNonce(117149950000039), { addedBlock: 117149951, transactionsSigned: 39 });
        deepEqual(decodeNonce(412), { addedBlock: null, transactionsSigned: 412 });
    });

    test('signaturesOf reads the account\'s own and its relayed signatures', () => {
        deepEqual(signaturesOf(relayed('T', '2026-01-01T00:00:00.000Z', 'ed25519:A', 7).transaction, ACCOUNT),
            [{ publicKey: 'ed25519:A', nonce: 7, relayer: 'relayer.nearmobile.near' }]);
        deepEqual(signaturesOf(relayed('T', '2026-01-01T00:00:00.000Z', 'ed25519:A', 7).transaction, 'other.near'), []);
    });

    test('the FastNear client tries again after a 429 or a timeout, counting each request', async () => {
        const hosts = [];
        let calls = 0;
        const client = createFastNearClient({
            apiKey: 'KEY', pauses: [0, 0], timeoutMillis: 50,
            onRequest: (host) => hosts.push(host),
            fetchImpl: async (url, init) => {
                calls++;
                if (calls === 1) return new Response('{}', { status: 429 });
                if (calls === 2) {
                    // A request that hangs until the timeout aborts it. The
                    // timeout's timer does not keep the process alive (a real
                    // fetch's socket does), so hold a timer of our own.
                    const keepAlive = setTimeout(() => { }, 10_000);
                    return new Promise((_, reject) => init.signal.addEventListener('abort', () => {
                        clearTimeout(keepAlive);
                        reject(init.signal.reason);
                    }));
                }
                return new Response(JSON.stringify({ jsonrpc: '2.0', result: { header: { timestamp_nanosec: '1' } } }));
            },
        });
        deepEqual(await client.block(1), { header: { timestamp_nanosec: '1' } });
        // Only the answered request is billed: not the 429, not the timeout.
        deepEqual(hosts, ['archival-rpc.mainnet.fastnear.com']);
        equal(calls, 3);
    });
});
