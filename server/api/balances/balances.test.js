import { describe, test, beforeEach, afterEach } from 'node:test';
import { equal, deepEqual, match } from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createBalancesRouter, MAX_READS } from './index.js';
import { FASTNEAR } from '../accesskeys/fastnear.js';
import { readUsage } from '../../arizcredits/usage.js';

const ACCOUNT = 'alice.near';
const FINAL = 230000000;

// FastNear as these tests want it: balances[`${contract}:${method}`][block],
// and `near` for view_account.
function fakeFastNear() {
    const chain = { calls: [], rateLimitNext: 0 };
    const balances = {
        near: { final: '5000', 100: '4000' },
        'usdt.tether-token.near:ft_balance_of': { final: '7', 100: '7' },
        'astro-stakers.poolv1.near:get_account_total_balance': { final: '"12"' },
        'intents.near:mt_balance_of': { final: '"99"' },
    };
    chain.fetchImpl = async (url, init) => {
        const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
        if (init.method === 'GET') {
            chain.calls.push({ url, authorization: init.headers.Authorization });
            return json({
                account_id: ACCOUNT,
                tokens: [{ contract_id: 'usdt.tether-token.near', balance: '7' }, { contract_id: 'spam.near', balance: '' }],
                pools: [{ pool_id: 'astro-stakers.poolv1.near' }],
            });
        }
        const body = JSON.parse(init.body);
        const host = url === FASTNEAR.rpc ? 'rpc' : 'archival';
        chain.calls.push({ host, method: body.method, params: body.params, authorization: init.headers.Authorization });
        if (chain.rateLimitNext > 0) {
            chain.rateLimitNext--;
            return json({ error: { code: -429 } }, 429);
        }
        const block = body.params.finality === 'final' ? 'final' : body.params.block_id;
        if ((host === 'rpc') !== (block === 'final')) return json({ error: 'wrong node' }, 500);
        if (body.method === 'block') return json({ jsonrpc: '2.0', result: { header: { height: FINAL } } });
        if (body.params.request_type === 'view_account') {
            return json({ jsonrpc: '2.0', result: { amount: balances.near[block] } });
        }
        const { account_id: contract, method_name: method, args_base64 } = body.params;
        const args = JSON.parse(Buffer.from(args_base64, 'base64').toString());
        if (args.account_id !== ACCOUNT) return json({ error: 'wrong account' }, 500);
        if (method === 'mt_tokens_for_owner') {
            const result = [...Buffer.from(JSON.stringify([{ token_id: 'nep141:wrap.near' }]))];
            return json({ jsonrpc: '2.0', result: { result } });
        }
        const value = balances[`${contract}:${method}`]?.[block];
        if (value === undefined) {
            return json({ jsonrpc: '2.0', error: { cause: { name: 'UNKNOWN_ACCOUNT' }, message: 'Server error' } });
        }
        return json({ jsonrpc: '2.0', result: { result: [...Buffer.from(value)] } });
    };
    return chain;
}

describe('/api/balances', () => {
    let dir, server, base, chain;

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'ariz-balances-'));
        chain = fakeFastNear();
        const app = express();
        // Stand-in for the NEP-413 auth middleware: the header names the account.
        app.use('/api/balances', (req, res, next) => {
            req.accountId = req.headers.authorization.slice('Bearer '.length);
            next();
        }, createBalancesRouter({ dataDir: dir, apiKey: 'KEY', fetchImpl: chain.fetchImpl, pauses: [1, 1] }));
        await new Promise(resolve => { server = app.listen(0, resolve); });
        base = `http://localhost:${server.address().port}/api/balances`;
    });
    afterEach(() => server?.close());

    const request = async (method, path, body, signedIn = 'bob.near') => {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { authorization: `Bearer ${signedIn}`, ...(body ? { 'content-type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: res.status, body: await res.json() };
    };

    test('reads each kind of balance, now from the node and at a block from the archive', async () => {
        const { status, body } = await request('POST', `/${ACCOUNT}`, {
            reads: [
                { kind: 'near', token: 'near', block: 'final' },
                { kind: 'near', token: 'near', block: 100 },
                { kind: 'ft', token: 'usdt.tether-token.near', block: 100 },
                { kind: 'pool', token: 'astro-stakers.poolv1.near', block: 'final' },
                { kind: 'intents', token: 'nep141:wrap.near', block: 'final' },
                { kind: 'ft', token: 'gone.near', block: 100 },
            ],
        });
        equal(status, 200);
        equal(body.finalHeight, FINAL);
        deepEqual(body.balances, [
            { kind: 'near', token: 'near', block: 'final', balance: '5000' },
            { kind: 'near', token: 'near', block: 100, balance: '4000' },
            { kind: 'ft', token: 'usdt.tether-token.near', block: 100, balance: '7' },
            { kind: 'pool', token: 'astro-stakers.poolv1.near', block: 'final', balance: '12' },
            { kind: 'intents', token: 'nep141:wrap.near', block: 'final', balance: '99' },
            { kind: 'ft', token: 'gone.near', block: 100, error: 'query: UNKNOWN_ACCOUNT' },
        ]);
        const intentsCall = chain.calls.find(c => c.params.method_name === 'mt_balance_of');
        equal(intentsCall.params.account_id, 'intents.near');
        equal(chain.calls[0].authorization, 'Bearer KEY');
        deepEqual(readUsage(dir), { 'bob.near': { 'rpc.mainnet.fastnear.com': 4, 'archival-rpc.mainnet.fastnear.com': 3 } });
    });

    test('waits out FastNear\'s rate limit, and does not bill what it turned away', async () => {
        chain.rateLimitNext = 2;
        const { status, body } = await request('POST', `/${ACCOUNT}`, { reads: [{ kind: 'near', token: 'near', block: 'final' }] });
        equal(status, 200);
        equal(body.balances[0].balance, '5000');
        deepEqual(readUsage(dir), { 'bob.near': { 'rpc.mainnet.fastnear.com': 2 } });
    });

    test('lists what the account holds now', async () => {
        const { status, body } = await request('GET', `/${ACCOUNT}/holdings`);
        equal(status, 200);
        deepEqual(body, {
            accountId: ACCOUNT,
            tokens: [{ token: 'usdt.tether-token.near', balance: '7' }, { token: 'spam.near', balance: '' }],
            pools: ['astro-stakers.poolv1.near'],
            intents: ['nep141:wrap.near'],
        });
        equal(chain.calls.find(c => c.url).url, `${FASTNEAR.api}/v1/account/${ACCOUNT}/full`);
        equal(chain.calls.find(c => c.url).authorization, 'Bearer KEY');
    });

    test('makes only these reads, never any other call', async () => {
        const refused = async (reads, pattern) => {
            const { status, body } = await request('POST', `/${ACCOUNT}`, { reads });
            equal(status, 400, JSON.stringify(reads));
            match(body.message, pattern);
        };
        await refused([{ kind: 'call', token: 'x.near', block: 'final' }], /kind must be/);
        await refused([{ kind: 'near', token: 'usdt.near', block: 'final' }], /token 'near'/);
        await refused([{ kind: 'ft', token: 'https://evil.example', block: 'final' }], /not a contract account id/);
        await refused([{ kind: 'intents', token: 'wrap.near', block: 'final' }], /not an intents token id/);
        await refused([{ kind: 'near', token: 'near', block: 'latest' }], /block must be/);
        await refused([{ kind: 'near', token: 'near', block: -5 }], /block must be/);
        await refused([], /1 to 300/);
        await refused(Array.from({ length: MAX_READS + 1 }, () => ({ kind: 'near', token: 'near', block: 'final' })), /1 to 300/);
        const bad = await request('POST', '/..%2Fx', { reads: [{ kind: 'near', token: 'near', block: 'final' }] });
        equal(bad.status, 400);
        equal(chain.calls.length, 0);
    });
});
