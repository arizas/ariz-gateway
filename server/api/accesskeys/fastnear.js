// The FastNear calls behind /api/accesskeys, with the gateway's API key.
// Each request FastNear answered is reported through `onRequest(host)`, so it
// is billed to the user it was made for. One turned away as too many (429) or
// not answered in time is not: the user should not pay for those.

export const FASTNEAR = {
    rpc: 'https://rpc.mainnet.fastnear.com/',
    archival: 'https://archival-rpc.mainnet.fastnear.com/',
    tx: 'https://tx.main.fastnear.com',
};

export class FastNearError extends Error {}

const ACCESS_KEYS_PER_PAGE = 100;

/**
 * @param {object} opts
 * @param {string} [opts.apiKey] FASTNEAR_API_KEY
 * @param {Function} [opts.onRequest] (host) => void, once per request answered
 * @param {Function} [opts.fetchImpl]
 * @param {number} [opts.timeoutMillis] FastNear's tx index now and then holds
 *   a request open without answering
 * @param {number[]} [opts.pauses] before each retry of a 429, 5xx or timeout
 */
export function createFastNearClient({ apiKey, onRequest = () => { }, fetchImpl = fetch, timeoutMillis = 20_000, pauses = [1000, 3000, 9000] } = {}) {
    async function post(url, body) {
        for (let attempt = 0; ; attempt++) {
            let retryable;
            try {
                const response = await fetchImpl(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(timeoutMillis),
                });
                if (response.status !== 429) {
                    onRequest(new URL(url).host);
                }
                if (response.ok) {
                    return await response.json();
                }
                retryable = response.status === 429 || response.status >= 500;
                if (!retryable || attempt >= pauses.length) {
                    throw new FastNearError(`FastNear answered ${response.status} to ${new URL(url).pathname}: ${(await response.text()).substring(0, 200)}`);
                }
            } catch (e) {
                if (e instanceof FastNearError) throw e;
                if (attempt >= pauses.length) {
                    throw new FastNearError(`FastNear did not answer ${new URL(url).pathname}: ${e.message}`, { cause: e });
                }
            }
            await new Promise(resolve => setTimeout(resolve, pauses[attempt]));
        }
    }

    async function rpc(url, method, params) {
        const json = await post(url, { jsonrpc: '2.0', id: method, method, params });
        if (json.error) {
            throw new FastNearError(`${method}: ${json.error.data ?? json.error.cause?.name ?? json.error.message}`);
        }
        return json.result;
    }

    return {
        /**
         * All the account's keys. Since nearcore 2.14 one answer holds at most
         * 100 (more is refused with TOO_MANY_ACCESS_KEYS), so they come in
         * pages, each going on after the previous page's `last_key`.
         * @returns {Promise<{block_height: number, keys: Array}>}
         */
        viewAccessKeyList: async (accountId) => {
            const keys = [];
            let blockHeight;
            let afterKey;
            for (;;) {
                const page = await rpc(FASTNEAR.rpc, 'query', {
                    request_type: 'view_access_key_list', finality: 'final', account_id: accountId,
                    limit: ACCESS_KEYS_PER_PAGE, ...(afterKey ? { after_key: afterKey } : {}),
                });
                blockHeight ??= page.block_height;
                keys.push(...page.keys);
                if (!page.last_key || page.keys.length === 0) {
                    return { block_height: blockHeight, keys };
                }
                afterKey = page.last_key;
            }
        },
        block: (blockId) => rpc(FASTNEAR.archival, 'block', { block_id: blockId }),
        /** One page of the transactions `accountId` signed, newest first. */
        signedTransactions: async (accountId, resumeToken) => {
            const page = await post(`${FASTNEAR.tx}/v0/account`, {
                account_id: accountId, is_any_signer: true, limit: 200,
                ...(resumeToken ? { resume_token: resumeToken } : {}),
            });
            // An answer without the list is an error, never the end of the
            // index: taken as the end, keys would be marked not indexed.
            if (!Array.isArray(page?.account_txs)) {
                throw new FastNearError(`The signed-transaction index did not answer with a list: ${JSON.stringify(page).substring(0, 200)}`);
            }
            return page;
        },
        /** Full transactions, at most 20 hashes. */
        transactions: async (hashes) => {
            const answer = await post(`${FASTNEAR.tx}/v0/transactions`, { tx_hashes: hashes });
            if (!Array.isArray(answer?.transactions)) {
                throw new FastNearError(`The transactions did not come back: ${JSON.stringify(answer).substring(0, 200)}`);
            }
            return answer.transactions;
        },
    };
}
