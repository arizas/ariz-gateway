import { NONCE_RANGE_MULTIPLIER } from './keys.js';

const TRANSACTIONS_PER_CALL = 20;

/**
 * The signatures `accountId` put on a transaction. The account signs either
 * the transaction itself, or, when a relayer submitted it (a meta
 * transaction, NEP-366), the delegate action inside it. Both use one of the
 * account's access keys and move that key's nonce.
 * @returns {Array<{publicKey: string, nonce: number, relayer: string|null}>}
 */
export function signaturesOf(transaction, accountId) {
    const signatures = [];
    if (transaction.signer_id === accountId) {
        signatures.push({ publicKey: transaction.public_key, nonce: transaction.nonce, relayer: null });
    }
    for (const action of transaction.actions ?? []) {
        const delegateAction = action?.Delegate?.delegate_action;
        if (delegateAction?.sender_id === accountId) {
            signatures.push({ publicKey: delegateAction.public_key, nonce: delegateAction.nonce, relayer: transaction.signer_id });
        }
    }
    return signatures;
}

/** The keys whose last use is not yet known at their current nonce. */
function wantedKeys(keys, state) {
    return new Map(keys
        .filter(k => k.transactionsSigned > 0
            && state.lastUse[k.publicKey]?.nonce !== k.nonce
            && state.notIndexed[k.publicKey] !== k.nonce)
        .map(k => [k.publicKey, k]));
}

/**
 * Find when each key last signed, from FastNear's index of the transactions
 * the account signed, newest first. The first signature found with a key is
 * its last use.
 *
 * `state` is kept per account between requests:
 *   lastUse    {publicKey: {nonce, txHash, at, relayer}}, valid while the
 *              key's nonce is the same: such a key has not signed since
 *   notIndexed {publicKey: nonce}: the whole index has no signature of it
 *   scan       {resumeToken, for: {publicKey: nonce}} where an unfinished
 *              search goes on, and for which keys
 *
 * A first search of a busy account is a couple of hundred requests, too many
 * for one HTTP request, so this works for at most `budgetMillis` and leaves
 * `scan` for the next call to go on from (or after `maxPages` pages). A
 * search goes on only for the keys
 * it was started for: a key that has signed since started over from the
 * newest transaction, or it could be missed above the resume point.
 *
 * @returns {Promise<{complete: boolean}>} state is changed in place
 */
export async function findLastUses({ client, accountId, keys, state, budgetMillis = 15_000, maxPages = Infinity, now = Date.now }) {
    state.lastUse ||= {};
    state.notIndexed ||= {};
    const wanted = wantedKeys(keys, state);
    if (wanted.size === 0) {
        state.scan = null;
        return { complete: true };
    }
    const sameKeys = state.scan
        && [...wanted.values()].every(k => state.scan.for?.[k.publicKey] === k.nonce);
    if (!sameKeys) {
        state.scan = { resumeToken: null, for: Object.fromEntries([...wanted.values()].map(k => [k.publicKey, k.nonce])) };
    }

    const started = now();
    let pages = 0;
    while (wanted.size > 0) {
        if (now() - started >= budgetMillis || pages >= maxPages) {
            return { complete: false };
        }
        pages++;
        const page = await client.signedTransactions(accountId, state.scan.resumeToken);
        const listed = page.account_txs;
        const transactions = new Map();
        for (let i = 0; i < listed.length; i += TRANSACTIONS_PER_CALL) {
            const batch = await client.transactions(listed.slice(i, i + TRANSACTIONS_PER_CALL).map(tx => tx.transaction_hash));
            for (const tx of batch) {
                transactions.set(tx.transaction.hash, tx.transaction);
            }
        }
        for (const { transaction_hash, tx_block_timestamp } of listed) {
            const transaction = transactions.get(transaction_hash);
            for (const { publicKey, nonce, relayer } of transaction ? signaturesOf(transaction, accountId) : []) {
                const key = wanted.get(publicKey);
                // A key removed and added again has a new start nonce: a
                // signature from below it belongs to the earlier key.
                if (key && (key.addedBlock === null || nonce >= (key.addedBlock - 1) * NONCE_RANGE_MULTIPLIER)) {
                    state.lastUse[publicKey] = {
                        nonce,
                        txHash: transaction_hash,
                        at: new Date(Number(BigInt(tx_block_timestamp) / 1_000_000n)).toISOString(),
                        relayer,
                    };
                    delete state.notIndexed[publicKey];
                    wanted.delete(publicKey);
                }
            }
        }
        if (!page.resume_token) {
            for (const key of wanted.values()) {
                state.notIndexed[key.publicKey] = key.nonce;
            }
            break;
        }
        state.scan.resumeToken = page.resume_token;
    }
    state.scan = null;
    return { complete: true };
}
