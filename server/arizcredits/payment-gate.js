/**
 * A gate that remembers its answer for a while, so a page making many
 * requests does not make as many authorisation lookups.
 */
export function cachedGate(gate, ttlMillis = 5 * 60_000, now = Date.now) {
    const cache = new Map();
    return async (accountId) => {
        const hit = cache.get(accountId);
        if (hit && now() - hit.at < ttlMillis) return hit.ok;
        let ok;
        try { ok = await gate(accountId); } catch { ok = false; } // fail closed
        cache.set(accountId, { ok, at: now() });
        return ok;
    };
}

/**
 * Express middleware for routes that cost FastNear requests: with billing on,
 * refuse with 402 when the signed-in account cannot pay. Runs after `auth`,
 * which sets req.accountId.
 */
export function createPaymentGate(accountGate) {
    const gate = accountGate ? cachedGate(accountGate) : null;
    return async (req, res, next) => {
        if (gate && !(await gate(req.accountId))) {
            return res.status(402).json({
                error: 'authorization_required',
                accountId: req.accountId,
                message: 'This is paid in ARIZ. Authorize the gateway (authorize_deduction on arizcredits.near) with an account that holds ARIZ, and sign in with it.',
            });
        }
        next();
    };
}
