import fs from 'node:fs';
import path from 'node:path';
import { readFastNearMetrics } from 'near-accounting-export';

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
 * The gateway-owned daily billing pass. All billing state lives here; the worker
 * is metrics-only.
 *
 * Each run: read the worker's cumulative per-account FastNear request counts,
 * compute each account's unbilled delta vs a persisted watermark, gate on an
 * active authorisation, clamp the amount to the user's daily cap, and deduct the
 * batch in one transaction. Watermarks advance only for accounts the contract
 * reports as charged, so it's idempotent and restart-safe (re-running the same
 * UTC day is a no-op).
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

    /** True if the daily pass hasn't run yet for the current UTC day. */
    function shouldRun(now = Date.now()) {
        return load().lastRunDay !== utcDay(now);
    }

    async function runOnce({ now = Date.now() } = {}) {
        const metrics = readFastNearMetrics(dataDir); // { accountId: { host: count } }
        const db = load();
        db.accounts = db.accounts || {};

        // Build candidate deductions (delta vs watermark, gated + cap-clamped).
        const candidates = [];
        for (const [accountId, byHost] of Object.entries(metrics)) {
            const billableTotal = sumBillable(byHost, billableHosts);
            const state = db.accounts[accountId] || { billedRequests: 0 };
            const deltaRequests = billableTotal - (state.billedRequests || 0);
            if (deltaRequests <= 0) continue;

            let auth = null;
            try { auth = await deductClient.viewAuthorisation(accountId); } catch { auth = null; }
            if (!auth) continue; // no active authorisation -> skip

            let amount = rate * BigInt(deltaRequests);
            const cap = BigInt(auth.max_per_day || '0');
            if (cap > 0n && amount > cap) amount = cap; // clamp to the user's daily cap
            if (amount <= 0n) continue;

            // Requests covered by the (possibly clamped) amount — the watermark
            // only advances by this much, so a capped overflow bills next day.
            const billedRequestsEquivalent = rate > 0n ? Number(amount / rate) : deltaRequests;
            candidates.push({ accountId, amount: amount.toString(), billedRequestsEquivalent });
        }

        const results = [];
        for (let i = 0; i < candidates.length; i += batchSize) {
            const chunk = candidates.slice(i, i + batchSize);
            const deductions = chunk.map(c => ({ user: c.accountId, amount: c.amount, description: 'fastnear-usage' }));
            let res;
            try {
                res = await deductClient.deduct(deductions);
            } catch (err) {
                // Whole chunk failed (network/tx) — leave watermarks, retry next run.
                res = chunk.map(c => ({ user: c.accountId, status: 'error', reason: String(err?.message || err) }));
            }
            const byUser = Object.fromEntries((res || []).map(r => [r.user, r]));
            for (const c of chunk) {
                const r = byUser[c.accountId] || { status: 'missing' };
                // Advance the watermark when the contract charged the user (or
                // reports an already-today charge, i.e. crash-recovery).
                const charged = r.status === 'deducted' || /already deducted today/.test(r.reason || '');
                if (charged) {
                    const state = db.accounts[c.accountId] || { billedRequests: 0 };
                    state.billedRequests = (state.billedRequests || 0) + c.billedRequestsEquivalent;
                    state.lastBilledAt = new Date(now).toISOString();
                    db.accounts[c.accountId] = state;
                }
                results.push({ accountId: c.accountId, status: r.status, reason: r.reason, amount: c.amount });
            }
        }

        db.lastRunDay = utcDay(now);
        save(db);

        const deducted = results.filter(r => r.status === 'deducted');
        return { deducted, results, total: deducted.length };
    }

    return { runOnce, shouldRun };
}
