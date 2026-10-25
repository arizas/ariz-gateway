import fs from 'node:fs';
import path from 'node:path';

// Requests the gateway sends upstream to answer a signed-in user (/rpc,
// /api/accesskeys), counted per user and host. The user who asked is the one
// who pays: the billing pass charges these to that account, next to the
// worker's per-monitored-account metrics. An answer from the gateway's own
// cache sends nothing upstream and costs nothing.
//
// { accounts: { [accountId]: { byHost: { [host]: count }, updatedAt } } }

function usageFile(dataDir) {
    return path.join(dataDir, 'gateway-usage.json');
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

/** Count one upstream request made for `accountId` to `host`. */
export function recordUsage(dataDir, accountId, host) {
    const db = load(dataDir);
    db.accounts ||= {};
    const entry = db.accounts[accountId] || { byHost: {}, updatedAt: '' };
    entry.byHost[host] = (entry.byHost[host] || 0) + 1;
    entry.updatedAt = new Date().toISOString();
    db.accounts[accountId] = entry;
    fs.writeFileSync(usageFile(dataDir), JSON.stringify(db, null, 2));
}

/** { [accountId]: { [host]: count } }, cumulative. */
export function readUsage(dataDir) {
    const out = {};
    for (const [accountId, entry] of Object.entries(load(dataDir).accounts || {})) {
        out[accountId] = { ...entry.byHost };
    }
    return out;
}
