/**
 * The gateway's blanket CORS middleware.
 *
 * Most mounts here are safe to open to any origin: they are either public
 * (prices) or authenticated by a NEP-413 bearer token, which a hostile page
 * cannot obtain. So the default is the wildcard, and preflights are answered
 * here rather than by each route.
 *
 * The exception is a mount that does its own CORS. `/store` does: the
 * encrypted-git-storage proxy carries an explicit origin allow-list and, on top
 * of the origin header, sets `Vary: Origin` and — the part that matters —
 * `Access-Control-Expose-Headers: ETag`, which the refs compare-and-swap client
 * reads via `res.headers.get('etag')`. Answering its preflights here silently
 * pre-empted all of that: the allow-list never ran, and ETag was never exposed,
 * so a cross-origin client read `null` and every CAS write degraded to
 * create-if-absent.
 *
 * Hence `bypass`. A mount listed there is left entirely alone — this middleware
 * sets no header and does not answer its preflight.
 *
 * @param {{bypass?: string[]}} [options] path prefixes to leave untouched
 * @returns {(req, res, next) => void} express middleware
 */
export function createCorsMiddleware({ bypass = [] } = {}) {
    return function corsMiddleware(req, res, next) {
        if (isBypassed(req.path, bypass)) return next();

        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.method === 'OPTIONS') {
            // Reflect the requested headers rather than '*': per the Fetch spec the
            // wildcard does NOT cover Authorization (Firefox/Safari enforce this;
            // Chrome is lenient), and every authenticated call — /api, /git — sends it.
            res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ?? '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.end();
            return;
        }
        next();
    };
}

/**
 * Whether `path` is inside one of the bypassed mounts. Matches the mount itself
 * and everything under it, but not a sibling that merely shares a prefix —
 * `/store` must not capture `/storefront`.
 */
export function isBypassed(path, bypass) {
    return bypass.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}
