import fs from 'node:fs';
import path from 'node:path';

// Gateway-owned enrollment policy. The near-accounting-export library stays
// generic (it just syncs whatever accounts are listed in accounts.json); the
// gateway decides membership here. This keeps all Ariz/billing knowledge in the
// gateway and out of the library.

/**
 * Remove accounts that no longer qualify from the worker's accounts.json, so the
 * background sync stops processing (and incurring FastNear cost for) them.
 *
 * Fail-safe: an account is pruned only when `isAllowed` resolves a definitive
 * `false`. If the check throws (e.g. transient RPC failure) the account is kept,
 * so a blip never bulk-wipes the enrolled set.
 *
 * @param {string} dataDir
 * @param {(accountId: string) => Promise<boolean>} isAllowed
 * @returns {Promise<string[]>} the account ids that were pruned
 */
export async function pruneAccounts(dataDir, isAllowed) {
    const file = path.join(dataDir, 'accounts.json');
    if (!fs.existsSync(file)) return [];
    let db;
    try {
        db = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return [];
    }
    const accounts = db.accounts || {};
    const pruned = [];
    for (const id of Object.keys(accounts)) {
        let allowed;
        try {
            allowed = await isAllowed(id);
        } catch {
            continue; // couldn't verify -> keep (don't prune on error)
        }
        if (allowed === false) {
            delete accounts[id];
            pruned.push(id);
        }
    }
    if (pruned.length) {
        db.accounts = accounts;
        fs.writeFileSync(file, JSON.stringify(db, null, 2));
    }
    return pruned;
}
