import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createFastNearClient } from './fastnear.js';
import { listAccessKeys, NONCE_RANGE_MULTIPLIER } from './keys.js';
import { findLastUses } from './lastuse.js';
import { recordUsage } from '../../arizcredits/usage.js';

// An account's access keys and when each last signed (arizas/Ariz-Portfolio#140).
//
//   GET  /api/accesskeys/:accountId          the keys, each with the block it
//        was added in, when, how many transactions it signed, and its last
//        use as far as it is known
//   POST /api/accesskeys/:accountId/lastuse  search on for the last uses not
//        known yet; answers `lastUseSearch.complete: false` when there is more
//        to do, and the next call goes on from there
//
// Everything is public on chain; what the gateway adds is FastNear with its API
// key, and keeping what never changes: block times for everyone, and per
// account each key's last use, valid as long as the key's nonce is the same.
// The FastNear requests made for an answer are billed to the signed-in user.

const NEAR_ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {string} [opts.apiKey] FASTNEAR_API_KEY
 * @param {Function} [opts.fetchImpl]
 * @param {number} [opts.budgetMillis] work per last-use request
 * @param {number} [opts.pagesPerRequest] index pages per last-use request
 */
export function createAccessKeysRouter({ dataDir, apiKey, fetchImpl, budgetMillis, pagesPerRequest }) {
    const dir = path.join(dataDir, 'accesskeys');
    const blockTimesFile = path.join(dir, 'blocktimes.json');
    const blockTimeCache = readJson(blockTimesFile, {});
    const blockTimes = {
        get: (height) => blockTimeCache[height],
        set: (height, at) => { blockTimeCache[height] = at; },
    };
    const stateFile = (accountId) => path.join(dir, 'accounts', `${accountId}.json`);

    // One request per account at a time: a last-use search reads, extends and
    // writes the account's state.
    const locks = new Map();
    const withLock = async (accountId, fn) => {
        const previous = locks.get(accountId) ?? Promise.resolve();
        const current = previous.then(fn, fn);
        locks.set(accountId, current.catch(() => { }));
        return current;
    };

    const clientFor = (req) => createFastNearClient({
        apiKey,
        fetchImpl,
        onRequest: (host) => recordUsage(dataDir, req.accountId, host),
    });

    async function answer(req, res, searchLastUse) {
        const accountId = req.params.accountId;
        if (!NEAR_ACCOUNT_ID.test(accountId)) {
            return res.status(400).json({ error: 'bad_account_id', message: `${accountId} is not a NEAR account id` });
        }
        try {
            const body = await withLock(accountId, async () => {
                const client = clientFor(req);
                const { blockHeight, keys } = await listAccessKeys({ client, accountId, blockTimes });
                writeJson(blockTimesFile, blockTimeCache);

                const state = readJson(stateFile(accountId), {});
                state.lastUse ||= {};
                state.notIndexed ||= {};
                let lastUseSearch;
                if (searchLastUse) {
                    lastUseSearch = await findLastUses({ client, accountId, keys, state, budgetMillis, maxPages: pagesPerRequest });
                    writeJson(stateFile(accountId), state);
                }
                return {
                    accountId,
                    blockHeight,
                    keys: keys.map(key => ({
                        ...key,
                        lastUse: state.lastUse[key.publicKey] ? lastUseFor(key, state.lastUse[key.publicKey]) : null,
                        lastUseNotIndexed: state.notIndexed[key.publicKey] === key.nonce,
                    })),
                    ...(lastUseSearch ? { lastUseSearch } : {}),
                };
            });
            res.setHeader('cache-control', 'no-cache');
            res.json(body);
        } catch (e) {
            console.error(`[accesskeys] ${accountId}:`, e);
            res.status(502).json({ error: 'fastnear', message: e.message });
        }
    }

    const router = express.Router();
    router.get('/:accountId', (req, res) => answer(req, res, false));
    router.post('/:accountId/lastuse', (req, res) => answer(req, res, true));
    return router;
}

// A stored last use only belongs to the key as it is now if it is from the
// same key: not from before it was removed and added again.
function lastUseFor(key, lastUse) {
    if (key.addedBlock !== null && lastUse.nonce < (key.addedBlock - 1) * NONCE_RANGE_MULTIPLIER) {
        return null;
    }
    return lastUse;
}
