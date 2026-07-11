import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createProxy as createStoreProxy } from 'encrypted-git-storage/gateway';

/**
 * The /store mount: encrypted-git-storage proxy + Ariz policy, composed once and
 * shared by server/index.js and the tests (so what's tested is what runs).
 *
 *  - CORS preflights bypass auth (they carry no Authorization header by spec).
 *  - `auth` (express middleware) authenticates and sets req.accountId.
 *  - Billing (`accountGate`) gates WRITES only: reads of the caller's own
 *    encrypted data stay available to lapsed accounts — a backup is never
 *    hostage to billing.
 *  - `storeRepoId(account)` blinds the account into the object-key prefix; the
 *    `me` alias is rewritten after auth (clients can't compute their own id).
 *  - `keys/<wrapId>`: consumer-side key management (arizas/Ariz-Portfolio#76) —
 *    small AES-GCM wraps of the repo master key, one per enrolled wallet key,
 *    named by an HKDF id derived from the wallet signature (NOT a public-key
 *    fingerprint: access keys are public on-chain and pk-named blobs would
 *    de-blind the store). Immutable create-only; enrollment races resolve via 412.
 */
export function createStoreMount({ s3, bucket, allowedOrigins, auth, accountGate, storeRepoId }) {
    const storeProxy = createStoreProxy({
        s3,
        bucket,
        allowedOrigins,
        auth: (req) => req.storeRepoId ?? null,
    });

    return function storeMount(req, res, next) {
        if (req.method === 'OPTIONS') return storeProxy(req, res, next);
        auth(req, res, async () => {
            try {
                if (accountGate && req.method !== 'GET' && req.method !== 'HEAD') {
                    let authorized = false;
                    try { authorized = await accountGate(req.accountId); } catch { authorized = false; } // fail closed
                    if (!authorized) {
                        return res.status(402).json({
                            error: 'authorization_required',
                            accountId: req.accountId,
                            message: 'Writing to the encrypted store requires an account that has authorized the gateway (authorize_deduction on arizcredits.near) and holds ARIZ. Reading your existing data remains available.',
                        });
                    }
                }
                req.storeRepoId = storeRepoId(req.accountId);
                if (req.url === '/me' || req.url.startsWith('/me/')) {
                    req.url = `/${req.storeRepoId}${req.url.slice('/me'.length)}`;
                }

                const wrapMatch = req.url.match(/^\/([^/]+)\/keys\/([0-9a-f]{32,64})$/);
                if (wrapMatch) {
                    if (wrapMatch[1] !== req.storeRepoId) return res.status(403).json({ error: 'forbidden' });
                    const key = `${req.storeRepoId}/keys/${wrapMatch[2]}`;
                    try {
                        if (req.method === 'GET') {
                            const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
                            return res.type('application/octet-stream').send(Buffer.from(await r.Body.transformToByteArray()));
                        }
                        if (req.method === 'PUT') {
                            // Read the (small) wrap body directly — a mount-level raw
                            // parser would consume/limit the proxy's pack uploads.
                            const chunks = [];
                            let size = 0;
                            for await (const c of req) {
                                size += c.length;
                                if (size > 64 * 1024) return res.status(413).json({ error: 'wrap too large' });
                                chunks.push(c);
                            }
                            await s3.send(new PutObjectCommand({
                                Bucket: bucket, Key: key, Body: Buffer.concat(chunks), IfNoneMatch: '*',
                            }));
                            return res.status(204).end();
                        }
                        return res.status(405).json({ error: 'method not allowed' });
                    } catch (e) {
                        const status = e?.$metadata?.httpStatusCode;
                        if (status === 404 || e?.name === 'NoSuchKey') return res.status(404).json({ error: 'not found' });
                        if (status === 412 || e?.name === 'PreconditionFailed') return res.status(412).json({ error: 'wrap already exists' });
                        throw e;
                    }
                }

                storeProxy(req, res, next);
            } catch (e) {
                next(e);
            }
        });
    };
}
