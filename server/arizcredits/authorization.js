import nearApi from 'near-api-js';

/**
 * Build a read-only checker that decides whether an account may be enrolled/
 * synced: it must have an active `authorize_deduction` (operator = the contract
 * account) AND a positive ARIZ balance. Results are cached per account with a
 * short TTL to bound RPC. No signing key required.
 *
 * @param {object} cfg
 * @param {string} cfg.networkId
 * @param {string} cfg.nodeUrl
 * @param {string} cfg.contractId   arizcredits.near (also the operator account)
 * @param {number} [cfg.ttlMs]
 */
export async function createAuthorizationChecker({ networkId, nodeUrl, contractId, ttlMs = 5 * 60 * 1000 }) {
    const near = await nearApi.connect({ networkId, nodeUrl });
    const account = await near.account(contractId); // view-only; no key needed
    const view = new nearApi.Contract(account, contractId, {
        viewMethods: ['view_js_func', 'ft_balance_of'],
    });
    const cache = new Map(); // accountId -> { ok, expiresAt }

    // Resolves true (authorised + funded) / false (definitively not), and
    // THROWS on RPC/parse failure so callers can distinguish "not allowed" from
    // "couldn't check" (request gate fails closed; reconciliation never prunes on
    // error). Only definitive results are cached.
    return async function isAuthorizedAndFunded(accountId) {
        const cached = cache.get(accountId);
        if (cached && cached.expiresAt > Date.now()) return cached.ok;
        const auth = await view.view_js_func({
            function_name: 'view_authorisation',
            user: accountId,
            operator_account: contractId,
        });
        let ok = false;
        if (auth) {
            const balance = await view.ft_balance_of({ account_id: accountId });
            ok = BigInt(balance || '0') > 0n;
        }
        cache.set(accountId, { ok, expiresAt: Date.now() + ttlMs });
        return ok;
    };
}
