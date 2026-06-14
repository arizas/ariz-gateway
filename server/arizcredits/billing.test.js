import { describe, test, beforeEach } from 'node:test';
import { equal, deepEqual, ok } from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBillingPass } from './billing.js';

function writeMetrics(dir, accounts) {
    writeFileSync(join(dir, 'fastnear-metrics.json'), JSON.stringify({ accounts }, null, 2));
}

// Fake deduct client: authorises everyone except accounts in `noAuth`, with an
// optional per-account cap. Records the batches it was asked to deduct.
function fakeClient({ caps = {}, noAuth = new Set() } = {}) {
    const calls = [];
    return {
        calls,
        async viewAuthorisation(accountId) {
            if (noAuth.has(accountId)) return null;
            return { max_per_day: String(caps[accountId] ?? '0'), last_deduct_day: '', spent_today: '0' };
        },
        async deduct(deductions) {
            calls.push(deductions);
            return deductions.map(d => ({ user: d.user, status: 'deducted', amount: d.amount }));
        },
    };
}

describe('gateway billing pass', () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'ariz-billing-'));
    });

    test('bills the billable-host delta, excludes the free tx API, skips unauthorised', async () => {
        writeMetrics(dir, {
            'a.near': { byHost: { 'archival-rpc.mainnet.fastnear.com': 30, 'tx.main.fastnear.com': 1000 } },
            'noauth.near': { byHost: { 'archival-rpc.mainnet.fastnear.com': 50 } },
        });
        const client = fakeClient({ noAuth: new Set(['noauth.near']) });
        const billing = createBillingPass({ dataDir: dir, deductClient: client, ratePerRequest: 2 });

        const r = await billing.runOnce({ now: 0 });

        equal(client.calls.length, 1, 'one batched deduct call');
        // tx.main.fastnear.com is free -> excluded; 30 archival reqs * rate 2 = 60.
        deepEqual(client.calls[0], [{ user: 'a.near', amount: '60', description: 'fastnear-usage' }]);
        equal(r.total, 1);

        const db = JSON.parse(readFileSync(join(dir, 'billing.json'), 'utf8'));
        equal(db.accounts['a.near'].billedRequests, 30, 'watermark advanced to billed total');
        ok(!db.accounts['noauth.near'], 'unauthorised account not billed');
    });

    test('clamps the amount to the daily cap and advances the watermark proportionally', async () => {
        writeMetrics(dir, { 'c.near': { byHost: { 'archival-rpc.mainnet.fastnear.com': 100 } } });
        // rate 2 -> raw amount 200, but cap is 50 -> clamp; 50/2 = 25 requests billed.
        const client = fakeClient({ caps: { 'c.near': '50' } });
        const billing = createBillingPass({ dataDir: dir, deductClient: client, ratePerRequest: 2 });

        await billing.runOnce({ now: 0 });

        deepEqual(client.calls[0], [{ user: 'c.near', amount: '50', description: 'fastnear-usage' }]);
        const db = JSON.parse(readFileSync(join(dir, 'billing.json'), 'utf8'));
        equal(db.accounts['c.near'].billedRequests, 25, 'watermark advanced only by the billed (capped) portion');
    });

    test('is idempotent: re-running with no new usage deducts nothing', async () => {
        writeMetrics(dir, { 'a.near': { byHost: { 'archival-rpc.mainnet.fastnear.com': 10 } } });
        const client = fakeClient();
        const billing = createBillingPass({ dataDir: dir, deductClient: client, ratePerRequest: 1 });

        await billing.runOnce({ now: 0 });
        await billing.runOnce({ now: 0 });

        equal(client.calls.length, 1, 'second run makes no deduct call (delta is zero)');
    });

    test('bills only the incremental delta on the next run', async () => {
        writeMetrics(dir, { 'a.near': { byHost: { 'archival-rpc.mainnet.fastnear.com': 10 } } });
        const client = fakeClient();
        const billing = createBillingPass({ dataDir: dir, deductClient: client, ratePerRequest: 1 });
        await billing.runOnce({ now: 0 });

        // more usage accrues
        writeMetrics(dir, { 'a.near': { byHost: { 'archival-rpc.mainnet.fastnear.com': 35 } } });
        await billing.runOnce({ now: 86_400_000 });

        equal(client.calls.length, 2);
        deepEqual(client.calls[1], [{ user: 'a.near', amount: '25', description: 'fastnear-usage' }]);
        const db = JSON.parse(readFileSync(join(dir, 'billing.json'), 'utf8'));
        equal(db.accounts['a.near'].billedRequests, 35);
    });

    test('shouldRun gates to once per UTC day', async () => {
        writeMetrics(dir, {});
        const billing = createBillingPass({ dataDir: dir, deductClient: fakeClient(), ratePerRequest: 1 });
        equal(billing.shouldRun(0), true);
        await billing.runOnce({ now: 0 });
        equal(billing.shouldRun(0), false, 'same UTC day -> no re-run');
        equal(billing.shouldRun(86_400_000), true, 'next UTC day -> runs again');
    });
});
