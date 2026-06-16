import fs from 'node:fs';
import path from 'node:path';
import { readFastNearMetrics } from 'near-accounting-export';
import { loadMonitors } from './monitors.js';

// FastNear hosts that cost credits. The free tx-index API (tx.main.fastnear.com)
// is intentionally excluded.
export const DEFAULT_BILLABLE_HOSTS = [
    'archival-rpc.mainnet.fastnear.com',
    'rpc.mainnet.fastnear.com',
    'transfers.main.fastnear.com',
];

const MS_PER_DAY = 86_400_000;
export const utcDay = (now = Date.now()) => Math.floor(now / MS_PER_DAY);

function sumBillable(byHost, billableHosts) {
    let total = 0;
    for (const h of billableHosts) total += byHost[h] || 0;
    return total;
}

/**
 * The gateway-owned daily billing pass.
 *
 * Usage is measured per monitored account (the worker's FastNear metrics), but
 * charged to that account's PAYER (monitors.json). Each run: compute each
 * account's unbilled delta vs a persisted per-account watermark, group by payer,
 * and deduct once per payer (bounded by the payer's daily cap) in one batched
 * transaction. Per-account watermarks advance only for the portion actually
 * charged, so a capped overflow rolls to the next day. Idempotent / restart-safe.
 *
 * @param {object} cfg
 * @param {string} cfg.dataDir
 * @param {{deduct:Function, viewAuthorisation:Function}} cfg.deductClient
 * @param {bigint|string|number} cfg.ratePerRequest  raw ARIZ (6-dec) per billable request
 * @param {string[]} [cfg.billableHosts]
 * @param {number} [cfg.batchSize]
 */
export function createBillingPass({ dataDir, deductClient, ratePerRequest, billableHosts = DEFAULT_BILLABLE_HOSTS, batchSize = 100 }) {
    const billingFile = path.join(dataDir, 'billing.json');
    const rate = BigInt(ratePerRequest);

    function load() {
        if (!fs.existsSync(billingFile)) return { accounts: {}, lastRunDay: null };
        return JSON.parse(fs.readFileSync(billingFile, 'utf8'));
    }
    function save(db) {
        fs.writeFileSync(billingFile, JSON.stringify(db, null, 2));
    }

    function shouldRun(now = Date.now()) {
        return load().lastRunDay !== utcDay(now);
    }

    async function runOnce({ now = Date.now() } = {}) {
        const metrics = readFastNearMetrics(dataDir); // { account: { host: count } }
        const monitors = loadMonitors(dataDir);       // { account: payer }
        const db = load();
        db.accounts = db.accounts || {};

        // 1. Per-account unbilled delta, grouped by payer.
        const perPayer = {}; // payer -> [{ account, delta }]
        for (const [account, byHost] of Object.entries(metrics)) {
            const payer = monitors[account];
            if (!payer) continue; // unmonitored -> reconciliation will prune it
            const billable = sumBillable(byHost, billableHosts);
            const state = db.accounts[account] || { billedRequests: 0 };
            const delta = billable - (state.billedRequests || 0);
            if (delta <= 0) continue;
            (perPayer[payer] ||= []).push({ account, delta });
        }

        // 2. Per payer: clamp to the payer's daily cap, plan which accounts'
        //    watermarks advance (greedy until the charged amount is exhausted).
        const entries = []; // { user, amount, description }
        const plans = {};   // payer -> [{ account, billRequests }]
        for (const [payer, items] of Object.entries(perPayer)) {
            let auth;
            try { auth = await deductClient.viewAuthorisation(payer); } catch { auth = null; }
            if (!auth) continue; // payer no longer authorised -> skip (reconciliation prunes)

            const totalDelta = items.reduce((s, i) => s + i.delta, 0);
            let amount = rate * BigInt(totalDelta);
            const cap = BigInt(auth.max_per_day || '0');
            if (cap > 0n && amount > cap) amount = cap;
            if (amount <= 0n) continue;

            let coveredRequests = rate > 0n ? Number(amount / rate) : totalDelta;
            const plan = [];
            for (const it of items) {
                if (coveredRequests <= 0) break;
                const take = Math.min(it.delta, coveredRequests);
                plan.push({ account: it.account, billRequests: take });
                coveredRequests -= take;
            }
            plans[payer] = plan;
            entries.push({ user: payer, amount: amount.toString(), description: 'fastnear-usage' });
        }

        // 3. Deduct (batched, chunked), then advance watermarks for charged payers.
        const results = [];
        for (let i = 0; i < entries.length; i += batchSize) {
            const chunk = entries.slice(i, i + batchSize);
            let res;
            try {
                res = await deductClient.deduct(chunk);
            } catch (err) {
                res = chunk.map(e => ({ user: e.user, status: 'error', reason: String(err?.message || err) }));
            }
            const byUser = Object.fromEntries((res || []).map(r => [r.user, r]));
            for (const e of chunk) {
                const r = byUser[e.user] || { status: 'missing' };
                const charged = r.status === 'deducted' || /already deducted today/.test(r.reason || '');
                if (charged) {
                    for (const item of plans[e.user] || []) {
                        const state = db.accounts[item.account] || { billedRequests: 0 };
                        state.billedRequests = (state.billedRequests || 0) + item.billRequests;
                        state.lastBilledAt = new Date(now).toISOString();
                        db.accounts[item.account] = state;
                    }
                }
                results.push({ payer: e.user, status: r.status, reason: r.reason, amount: e.amount });
            }
        }

        db.lastRunDay = utcDay(now);
        save(db);

        const charged = results.filter(r => r.status === 'deducted');
        return { charged, results, total: charged.length };
    }

    return { runOnce, shouldRun };
}
