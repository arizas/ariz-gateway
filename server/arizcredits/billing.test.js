import { describe, test, beforeEach } from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBillingPass } from './billing.js';

const archival = (n) => ({ byHost: { 'archival-rpc.mainnet.fastnear.com': n } });

function writeMetrics(dir, accounts) {
    writeFileSync(join(dir, 'fastnear-metrics.json'), JSON.stringify({ accounts }));
}
function writeMonitors(dir, monitors) {
    writeFileSync(join(dir, 'monitors.json'), JSON.stringify({ monitors }));
}
function billing(dir) {
    return JSON.parse(readFileSync(join(dir, 'billing.json'), 'utf8'));
}

// Fake deduct client: authorises payers with the given caps; records batches.
function fakeClient({ caps = {} } = {}) {
    const calls = [];
    return {
        calls,
        async viewAuthorisation(payer) {
            if (!(payer in caps)) return null;
            return { max_per_day: String(caps[payer]), last_deduct_day: '', spent_today: '0' };
        },
        async deduct(entries) {
            calls.push(entries);
            return entries.map(e => ({ user: e.user, status: 'deducted', amount: e.amount }));
        },
    };
}

describe('gateway billing pass (per-payer)', () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ariz-billing-')); });

    test('groups usage by payer and charges each payer once', async () => {
        writeMetrics(dir, { 'x.near': archival(30), 'y.near': archival(20), 'z.near': archival(50) });
        writeMonitors(dir, { 'x.near': 'p1.near', 'y.near': 'p1.near', 'z.near': 'p2.near' });
        const client = fakeClient({ caps: { 'p1.near': '100000', 'p2.near': '100000' } });
        const b = createBillingPass({ dataDir: dir, deductClient: client, ratePerRequest: 2 });

        await b.runOnce({ now: 0 });

        equal(client.calls.length, 1, 'one batched deduct');
        const byUser = Object.fromEntries(client.calls[0].map(e => [e.user, e.amount]));
        equal(byUser['p1.near'], '100', '(30+20)*2 for p1');
        equal(byUser['p2.near'], '100', '50*2 for p2');

        const db = billing(dir);
        equal(db.accounts['x.near'].billedRequests, 30);
        equal(db.accounts['y.near'].billedRequests, 20);
        equal(db.accounts['z.near'].billedRequests, 50);
    });

    test('clamps a payer to its daily cap; advances only covered watermarks', async () => {
        writeMetrics(dir, { 'a.near': archival(40), 'b.near': archival(40) }); // 80 reqs, rate 2 -> 160 raw
        writeMonitors(dir, { 'a.near': 'p.near', 'b.near': 'p.near' });
        const client = fakeClient({ caps: { 'p.near': '100' } }); // cap 100 -> 50 reqs covered
        const b = createBillingPass({ dataDir: dir, deductClient: client, ratePerRequest: 2 });

        await b.runOnce({ now: 0 });

        deepEqual(client.calls[0], [{ user: 'p.near', amount: '100', description: 'fastnear-usage' }]);
        const db = billing(dir);
        // greedy: a.near (40) fully covered, b.near gets the remaining 10 of the 50.
        equal(db.accounts['a.near'].billedRequests, 40);
        equal(db.accounts['b.near'].billedRequests, 10);
    });

    test('skips unmonitored accounts and payers without authorisation', async () => {
        writeMetrics(dir, { 'm.near': archival(10), 'orphan.near': archival(99) });
        writeMonitors(dir, { 'm.near': 'noauth.near' }); // orphan.near has no payer; payer not authorised
        const client = fakeClient({ caps: {} }); // nobody authorised
        const b = createBillingPass({ dataDir: dir, deductClient: client, ratePerRequest: 2 });

        await b.runOnce({ now: 0 });
        equal(client.calls.length, 0, 'nothing billable');
        equal(billing(dir).accounts['orphan.near'], undefined);
        equal(billing(dir).accounts['m.near'], undefined);
    });

    test('idempotent: re-running with no new usage makes no deduct call', async () => {
        writeMetrics(dir, { 'a.near': archival(10) });
        writeMonitors(dir, { 'a.near': 'p.near' });
        const client = fakeClient({ caps: { 'p.near': '100000' } });
        const b = createBillingPass({ dataDir: dir, deductClient: client, ratePerRequest: 2 });

        await b.runOnce({ now: 0 });
        await b.runOnce({ now: 0 });
        equal(client.calls.length, 1, 'second run has no unbilled delta');
    });

    test('bills only the incremental usage on a later run', async () => {
        writeMetrics(dir, { 'a.near': archival(10) });
        writeMonitors(dir, { 'a.near': 'p.near' });
        const client = fakeClient({ caps: { 'p.near': '100000' } });
        const b = createBillingPass({ dataDir: dir, deductClient: client, ratePerRequest: 2 });
        await b.runOnce({ now: 0 });

        writeMetrics(dir, { 'a.near': archival(35) }); // +25 requests
        await b.runOnce({ now: 86_400_000 });

        equal(client.calls.length, 2);
        deepEqual(client.calls[1], [{ user: 'p.near', amount: '50', description: 'fastnear-usage' }]); // 25*2
        equal(billing(dir).accounts['a.near'].billedRequests, 35);
    });
});
