import nearApi from 'near-api-js';
import { verifyNep413, makeAccessKeyListReader } from './nep413.js';

class AuthError extends Error {
    constructor(message) {
        super(message);
        this.statusCode = 401;
    }
}

/**
 * Build the request authenticator. Auth is NEP-413: the client sends a
 * `Bearer <base64(JSON)>` signed message; we verify the signature, the
 * recipient, a stateless timestamp window, and that the signing key is a Full
 * Access key on the claimed account (via cached `view_access_key_list`).
 *
 * @param {object} opts
 * @param {string} opts.networkId
 * @param {string} opts.contractId
 * @param {string} opts.nodeUrl
 * @param {string} [opts.recipient] expected NEP-413 recipient (defaults to contractId)
 */
export async function createAuthenticate({ networkId, contractId, nodeUrl, recipient }) {
    const near = await nearApi.connect({ networkId, contractId, nodeUrl });
    const provider = near.connection.provider;
    const viewAccessKeyList = makeAccessKeyListReader(provider);
    const expectedRecipient = recipient ?? contractId;

    return async function authenticate(req) {
        const header = req.headers.authorization;
        if (!header || !header.startsWith('Bearer ')) {
            throw new AuthError('failed to parse token');
        }
        const token = header.slice('Bearer '.length).trim();
        try {
            return await verifyNep413(token, { recipient: expectedRecipient, viewAccessKeyList });
        } catch (err) {
            throw new AuthError(err.message || 'Unauthorized');
        }
    };
}

export async function createAuthMiddleware(opts) {
    const authenticate = await createAuthenticate(opts);
    return async function authMiddleware(req, res, next) {
        try {
            const { accountId } = await authenticate(req);
            req.accountId = accountId;
            next();
        } catch (err) {
            // The reason also goes to the response body, but clients rarely
            // surface it — log it so auth failures are diagnosable server-side.
            console.warn(`auth failed: ${req.method} ${req.originalUrl ?? req.url} — ${err.message}`);
            res.status(err.statusCode ?? 401).send(err.message);
        }
    };
}

export { AuthError };
