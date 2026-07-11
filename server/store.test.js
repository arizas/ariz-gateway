import { test, before, after, describe } from 'node:test';
import { equal, deepEqual, ok } from 'node:assert/strict';
import express from 'express';
import { createProxy as createStoreProxy } from 'encrypted-git-storage/gateway';

// Wiring tests for the /store mount (encrypted-git-storage): NEP-413-style auth
// scoping (repoId = authenticated account), the unauthenticated CORS preflight
// bypass, and a refs round-trip — against an in-memory fake S3, so no MinIO is
// needed in this repo's CI (the library's own CI covers the real S3 semantics).
function fakeS3() {
    const objects = new Map(); // key -> { body: Buffer, etag: string }
    let etagCounter = 0;
    return {
        objects,
        async send(cmd) {
            const { Key, Body, IfMatch, IfNoneMatch, Prefix } = cmd.input;
            switch (cmd.constructor.name) {
                case 'PutObjectCommand': {
                    const existing = objects.get(Key);
                    if (IfNoneMatch === '*' && existing) throw Object.assign(new Error('exists'), { name: 'PreconditionFailed' });
                    if (IfMatch && (!existing || existing.etag !== IfMatch)) throw Object.assign(new Error('mismatch'), { name: 'PreconditionFailed' });
                    const etag = `"e${++etagCounter}"`;
                    objects.set(Key, { body: Buffer.from(Body), etag });
                    return { ETag: etag };
                }
                case 'GetObjectCommand': {
                    const o = objects.get(Key);
                    if (!o) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
                    return { ETag: o.etag, Body: { transformToByteArray: async () => new Uint8Array(o.body) } };
                }
                case 'ListObjectsV2Command':
                    return {
                        Contents: [...objects.entries()]
                            .filter(([k]) => k.startsWith(Prefix))
                            .map(([k, v]) => ({ Key: k, Size: v.body.length, LastModified: new Date() })),
                    };
                case 'DeleteObjectCommand':
                    objects.delete(Key);
                    return {};
                default:
                    throw new Error(`fake s3: unhandled ${cmd.constructor.name}`);
            }
        },
    };
}

const ORIGIN = 'https://arizportfolio.near.page';

describe('encrypted store mount (/store)', () => {
    let server, base, s3;

    before(async () => {
        s3 = fakeS3();
        const storeProxy = createStoreProxy({
            s3,
            bucket: 'test',
            allowedOrigins: [ORIGIN],
            auth: (req) => req.accountId ?? null,
        });
        const app = express();
        // Same composition as server/index.js: OPTIONS bypasses auth (a CORS
        // preflight carries no Authorization header); everything else must
        // authenticate. Auth is stubbed like git.test.js: account from a header.
        app.use('/store', (req, res, next) => {
            if (req.method === 'OPTIONS') return storeProxy(req, res, next);
            const account = req.headers['x-test-account'];
            if (!account) return res.status(401).send('failed to parse token');
            req.accountId = account;
            storeProxy(req, res, next);
        });
        await new Promise((r) => { server = app.listen(0, r); });
        base = `http://localhost:${server.address().port}/store`;
    });

    after(() => server?.close());

    const asAlice = { 'x-test-account': 'alice.near' };

    test('CORS preflight is answered without authentication', async () => {
        const res = await fetch(`${base}/alice.near/refs`, {
            method: 'OPTIONS',
            headers: {
                Origin: ORIGIN,
                'Access-Control-Request-Method': 'PUT',
                'Access-Control-Request-Headers': 'authorization,content-type,if-match',
            },
        });
        equal(res.status, 204);
        equal(res.headers.get('access-control-allow-origin'), ORIGIN);
        ok(res.headers.get('access-control-allow-methods').includes('PUT'));
        ok(res.headers.get('access-control-expose-headers').includes('ETag'));
    });

    test('unauthenticated requests are rejected', async () => {
        equal((await fetch(`${base}/alice.near/refs`)).status, 401);
    });

    test('an account only reaches its own store (repoId = account)', async () => {
        equal((await fetch(`${base}/bob.near/refs`, { headers: asAlice })).status, 403);
    });

    test('refs round-trip: create (If-None-Match) then read back', async () => {
        const put = await fetch(`${base}/alice.near/refs`, {
            method: 'PUT',
            headers: { ...asAlice, 'if-none-match': '*', 'content-type': 'application/octet-stream' },
            body: Buffer.from('ciphertext-refs-v1'),
        });
        equal(put.status, 204);

        const get = await fetch(`${base}/alice.near/refs`, { headers: asAlice });
        equal(get.status, 200);
        equal(Buffer.from(await get.arrayBuffer()).toString(), 'ciphertext-refs-v1');
        // …and it landed under the account's own key prefix.
        deepEqual([...s3.objects.keys()], ['alice.near/refs']);
    });

    test('stale refs CAS is rejected with 412', async () => {
        const res = await fetch(`${base}/alice.near/refs`, {
            method: 'PUT',
            headers: { ...asAlice, 'if-match': '"stale"', 'content-type': 'application/octet-stream' },
            body: Buffer.from('clobber'),
        });
        equal(res.status, 412);
        equal(s3.objects.get('alice.near/refs').body.toString(), 'ciphertext-refs-v1');
    });
});
