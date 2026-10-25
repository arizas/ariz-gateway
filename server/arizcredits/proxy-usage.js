import fs from 'node:fs';
import path from 'node:path';

// Requests the gateway itself sends upstream on a signed-in user's behalf
// (/rpc and /api/fastnear/*), counted per user and host. The user who made
// them is the one who pays: the billing pass charges these to that account,
// next to the worker's per-monitored-account metrics.
//
// { accounts: { [accountId]: { byHost: { [host]: count }, updatedAt } } }

function usageFile(dataDir) {
    return path.join(dataDir, 'proxy-usage.json');
}

function load(dataDir) {
    const f = usageFile(dataDir);
    if (!fs.existsSync(f)) return { accounts: {} };
    try {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
        return { accounts: {} };
    }
}

/** Count one upstream request by `accountId` to `host`. */
export function recordProxyRequest(dataDir, accountId, host) {
    const db = load(dataDir);
    db.accounts ||= {};
    const entry = db.accounts[accountId] || { byHost: {}, updatedAt: '' };
    entry.byHost[host] = (entry.byHost[host] || 0) + 1;
    entry.updatedAt = new Date().toISOString();
    db.accounts[accountId] = entry;
    fs.writeFileSync(usageFile(dataDir), JSON.stringify(db, null, 2));
}

/** { [accountId]: { [host]: count } }, cumulative. */
export function readProxyUsage(dataDir) {
    const out = {};
    for (const [accountId, entry] of Object.entries(load(dataDir).accounts || {})) {
        out[accountId] = { ...entry.byHost };
    }
    return out;
}
