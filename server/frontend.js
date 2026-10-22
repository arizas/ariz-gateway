import { readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

// The frontend bundle carries its Content-Security-Policy as a <meta> tag,
// with a placeholder where the script nonce goes (Ariz-Portfolio csp.js). A
// nonce is only worth anything if nobody knows it before the page loads, so
// it is filled in here, fresh on every request. The placeholder is not valid
// nonce syntax: served any other way — straight off disk by express.static —
// the page runs no script at all rather than one with a nonce everyone knows.
export const CSP_NONCE_PLACEHOLDER = '{{CSP_NONCE}}';

/**
 * Serve `indexPath` with a fresh nonce in every placeholder. Read once and
 * re-read when the file changes, which is a deploy. Never cached downstream:
 * a cached copy is a reused nonce.
 */
export function createFrontendIndexHandler(indexPath, { setHeaders = () => { } } = {}) {
    let cached = { mtimeMs: -1, html: '' };
    return async (req, res, next) => {
        try {
            const { mtimeMs } = await stat(indexPath);
            if (mtimeMs !== cached.mtimeMs) cached = { mtimeMs, html: await readFile(indexPath, 'utf8') };
            // Standard base64: the wallet connector strips anything else from it.
            const nonce = randomBytes(18).toString('base64');
            setHeaders(res);
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(req.method === 'HEAD' ? undefined : cached.html.replaceAll(CSP_NONCE_PLACEHOLDER, nonce));
        } catch (e) {
            next(e);
        }
    };
}
