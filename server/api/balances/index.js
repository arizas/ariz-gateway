import express from 'express';
import { createFastNearClient } from '../accesskeys/fastnear.js';
import { recordUsage } from '../../arizcredits/usage.js';

// An account's token balances, now or at past blocks, and what it holds now:
// what the app's balance check compares its stored history with
// (arizas/Ariz-Portfolio#142).
//
//   POST /api/balances/:accountId           { reads: [{ kind, token, block }] }
//        kind: near (token 'near'), ft or pool (token is the contract), or
//        intents (token is an intents.near token id, nep141:... or nep245:...);
//        block: a block height, or 'final'
//        → { accountId, finalHeight, balances: [{ kind, token, block, balance } or { ..., error }] }
//   GET  /api/balances/:accountId/holdings
//        → { accountId, tokens: [{ token, balance }], pools: [poolId], intents: [tokenId] }
//
// Only these reads, never arbitrary RPC: the balance of one account, through
// the one view method each kind of token has for it. Everything is public on
// chain; what the gateway adds is FastNear with its API key, since straight
// from a browser the archival node allows about 2 requests a second and
// answers the rest with a 429 that has no CORS headers. The FastNear requests
// made for an answer are billed to the signed-in user.

const NEAR_ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const INTENTS_TOKEN_ID = /^nep(141|245):[\w.:-]{1,200}$/;
const INTENTS_CONTRACT_ID = 'intents.near';
export const MAX_READS = 300;
// With the API key FastNear takes many at once; without it (a local gateway)
// about 2 a second, so fewer at a time and longer pauses.
const CONCURRENCY = { key: 8, none: 2 };
const PAUSES_WITHOUT_KEY = [1000, 3000, 9000, 20000];

/** Why a read is not one this API makes, or null. */
function invalidRead(read) {
    if (!read || typeof read !== 'object') return 'a read is { kind, token, block }';
    const { kind, token, block } = read;
    if (block !== 'final' && !(Number.isSafeInteger(block) && block > 0)) return `block must be a block height or 'final', not ${JSON.stringify(block)}`;
    switch (kind) {
        case 'near': return token === 'near' ? null : `a near read has token 'near'`;
        case 'ft':
        case 'pool': return typeof token === 'string' && NEAR_ACCOUNT_ID.test(token) ? null : `${JSON.stringify(token)} is not a contract account id`;
        case 'intents': return typeof token === 'string' && INTENTS_TOKEN_ID.test(token) ? null : `${JSON.stringify(token)} is not an intents token id`;
        default: return `kind must be near, ft, pool or intents, not ${JSON.stringify(kind)}`;
    }
}

function readBalance(client, accountId, { kind, token, block }) {
    switch (kind) {
        case 'near': return client.nearBalance(accountId, block);
        case 'ft': return client.view(token, 'ft_balance_of', { account_id: accountId }, block);
        case 'pool': return client.view(token, 'get_account_total_balance', { account_id: accountId }, block);
        case 'intents': return client.view(INTENTS_CONTRACT_ID, 'mt_balance_of', { account_id: accountId, token_id: token }, block);
    }
}

async function inBatches(items, concurrency, work) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await work(items[index]);
        }
    }));
    return results;
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {string} [opts.apiKey] FASTNEAR_API_KEY
 * @param {Function} [opts.fetchImpl]
 * @param {number[]} [opts.pauses] before each retry of a 429, 5xx or timeout
 */
export function createBalancesRouter({ dataDir, apiKey, fetchImpl, pauses }) {
    const clientFor = (req) => createFastNearClient({
        apiKey,
        fetchImpl,
        pauses: pauses ?? (apiKey ? undefined : PAUSES_WITHOUT_KEY),
        onRequest: (host) => recordUsage(dataDir, req.accountId, host),
    });

    const accountOf = (req, res) => {
        const { accountId } = req.params;
        if (NEAR_ACCOUNT_ID.test(accountId)) return accountId;
        res.status(400).json({ error: 'bad_account_id', message: `${accountId} is not a NEAR account id` });
        return null;
    };

    const router = express.Router();
    router.use(express.json({ limit: '100kb' }));

    router.post('/:accountId', async (req, res) => {
        const accountId = accountOf(req, res);
        if (!accountId) return;
        const reads = req.body?.reads;
        if (!Array.isArray(reads) || reads.length === 0 || reads.length > MAX_READS) {
            return res.status(400).json({ error: 'bad_reads', message: `reads must be a list of 1 to ${MAX_READS}` });
        }
        for (const read of reads) {
            const problem = invalidRead(read);
            if (problem) return res.status(400).json({ error: 'bad_reads', message: problem });
        }
        const client = clientFor(req);
        try {
            const finalHeight = await client.finalBlockHeight();
            // One failed read, such as a contract that did not exist yet at that
            // block, is that read's answer and not the request's.
            const balances = await inBatches(reads, apiKey ? CONCURRENCY.key : CONCURRENCY.none, async ({ kind, token, block }) => {
                try {
                    return { kind, token, block, balance: String(await readBalance(client, accountId, { kind, token, block })) };
                } catch (e) {
                    return { kind, token, block, error: String(e.message).substring(0, 200) };
                }
            });
            res.setHeader('cache-control', 'no-cache');
            res.json({ accountId, finalHeight, balances });
        } catch (e) {
            console.error(`[balances] ${accountId}:`, e);
            res.status(502).json({ error: 'fastnear', message: e.message });
        }
    });

    router.get('/:accountId/holdings', async (req, res) => {
        const accountId = accountOf(req, res);
        if (!accountId) return;
        const client = clientFor(req);
        try {
            const [full, intents] = await Promise.all([
                client.accountFull(accountId),
                client.view(INTENTS_CONTRACT_ID, 'mt_tokens_for_owner', { account_id: accountId }, 'final'),
            ]);
            res.setHeader('cache-control', 'no-cache');
            res.json({
                accountId,
                tokens: (full?.tokens ?? []).map(({ contract_id, balance }) => ({ token: contract_id, balance: String(balance ?? '') })),
                pools: (full?.pools ?? []).map(({ pool_id }) => pool_id),
                intents: (intents ?? []).map(({ token_id }) => token_id),
            });
        } catch (e) {
            console.error(`[balances] holdings of ${accountId}:`, e);
            res.status(502).json({ error: 'fastnear', message: e.message });
        }
    });
    return router;
}
