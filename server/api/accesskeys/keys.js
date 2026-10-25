// An account's access keys, and what their nonces say.
//
// Since early in mainnet's life a newly added key does not start at nonce 0
// but at (block_height - 1) * 10^6, where block_height is the block the AddKey
// was applied in. Each transaction the key signs then adds one. So from the
// nonce alone:
//
//   added in block  floor(nonce / 10^6) + 1
//   signed          nonce mod 10^6 transactions
//
// Keys added before that rule started at 0, so their nonce is just the count
// of transactions and their block is unknown. Such a nonce is far below the
// first mainnet block, which is how they are told apart.

export const NONCE_RANGE_MULTIPLIER = 1_000_000;
const MAINNET_GENESIS_HEIGHT = 9_820_210;

/** @returns {{addedBlock: number|null, transactionsSigned: number}} */
export function decodeNonce(nonce) {
    const startBlock = Math.floor(nonce / NONCE_RANGE_MULTIPLIER);
    if (startBlock < MAINNET_GENESIS_HEIGHT) {
        return { addedBlock: null, transactionsSigned: nonce };
    }
    return { addedBlock: startBlock + 1, transactionsSigned: nonce % NONCE_RANGE_MULTIPLIER };
}

// The RPC spells a full access key as the string "FullAccess" and a function
// call key as {FunctionCall: {...}}. One shape is easier to store and render.
export function normalizePermission(permission) {
    if (permission === 'FullAccess') {
        return { type: 'FullAccess' };
    }
    const functionCall = permission.FunctionCall;
    return {
        type: 'FunctionCall',
        receiverId: functionCall.receiver_id,
        methodNames: functionCall.method_names,
        allowance: functionCall.allowance,
    };
}

/**
 * When a block was produced, as an ISO timestamp, or null. A height can be
 * skipped by the chain, so the next few heights stand in for it.
 */
async function blockTimestamp(client, height) {
    for (let h = height; h < height + 5; h++) {
        try {
            const nanos = (await client.block(h))?.header?.timestamp_nanosec;
            if (nanos) return new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString();
        } catch {
            // a skipped height: try the next
        }
    }
    return null;
}

/**
 * The account's keys as they are now, each with the block it was added in and
 * when that was. Block times never change, so `blockTimes` keeps them for
 * every account and user; only blocks not seen before are looked up.
 *
 * @param {object} p
 * @param {object} p.client - createFastNearClient
 * @param {string} p.accountId
 * @param {{get: Function, set: Function}} p.blockTimes
 * @param {number} [p.datingBudgetMillis] no new block lookups after this; the
 *   keys left undated (addedAt null) are dated by a later request
 * @param {Function} [p.now]
 */
export async function listAccessKeys({ client, accountId, blockTimes, datingBudgetMillis = 10_000, now = Date.now }) {
    const result = await client.viewAccessKeyList(accountId);
    const keys = result.keys.map(({ public_key, access_key }) => ({
        publicKey: public_key,
        nonce: access_key.nonce,
        permission: normalizePermission(access_key.permission),
        ...decodeNonce(access_key.nonce),
    }));

    const undated = [...new Set(keys.map(k => k.addedBlock).filter(b => b !== null && blockTimes.get(b) === undefined))];
    const started = now();
    const next = async () => {
        for (let height = undated.shift(); height !== undefined && now() - started < datingBudgetMillis; height = undated.shift()) {
            const at = await blockTimestamp(client, height);
            if (at) blockTimes.set(height, at);
        }
    };
    await Promise.all(Array.from({ length: 4 }, next));

    for (const key of keys) {
        key.addedAt = key.addedBlock === null ? null : blockTimes.get(key.addedBlock) ?? null;
    }
    return { blockHeight: result.block_height, keys };
}
