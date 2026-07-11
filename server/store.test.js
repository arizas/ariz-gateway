import { test, before, after, describe } from 'node:test';
import { equal, deepEqual, ok, notEqual, match } from 'node:assert/strict';
import express from 'express';
import { createProxy as createStoreProxy } from 'encrypted-git-storage/gateway';
import { makeStoreRepoId } from './store-id.js';

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

    const storeRepoId = makeStoreRepoId('test-blinding-secret');
    const aliceId = storeRepoId('alice.near');

    before(async () => {
        s3 = fakeS3();
        const storeProxy = createStoreProxy({
            s3,
            bucket: 'test',
            allowedOrigins: [ORIGIN],
            auth: (req) => req.storeRepoId ?? null,
        });
        const app = express();
        // Same composition as server/index.js: OPTIONS bypasses auth (a CORS
        // preflight carries no Authorization header); everything else must
        // authenticate (stubbed like git.test.js: account from a header), gets a
        // blinded store id, and may address itself as /store/me/….
        app.use('/store', (req, res, next) => {
            if (req.method === 'OPTIONS') return storeProxy(req, res, next);
            const account = req.headers['x-test-account'];
            if (!account) return res.status(401).send('failed to parse token');
            req.accountId = account;
            req.storeRepoId = storeRepoId(account);
            if (req.url === '/me' || req.url.startsWith('/me/')) {
                req.url = `/${req.storeRepoId}${req.url.slice('/me'.length)}`;
            }
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

    test('an account only reaches its own store (blinded ids)', async () => {
        // Neither another account's plain name nor its blinded id is reachable.
        equal((await fetch(`${base}/bob.near/refs`, { headers: asAlice })).status, 403);
        equal((await fetch(`${base}/${storeRepoId('bob.near')}/refs`, { headers: asAlice })).status, 403);
        // The plain own account name no longer addresses the store either.
        equal((await fetch(`${base}/alice.near/refs`, { headers: asAlice })).status, 403);
    });

    test('refs round-trip via the /me alias, keys land under the blinded prefix', async () => {
        const put = await fetch(`${base}/me/refs`, {
            method: 'PUT',
            headers: { ...asAlice, 'if-none-match': '*', 'content-type': 'application/octet-stream' },
            body: Buffer.from('ciphertext-refs-v1'),
        });
        equal(put.status, 204);

        // Readable via the alias and via the literal blinded id.
        const get = await fetch(`${base}/me/refs`, { headers: asAlice });
        equal(get.status, 200);
        equal(Buffer.from(await get.arrayBuffer()).toString(), 'ciphertext-refs-v1');
        equal((await fetch(`${base}/${aliceId}/refs`, { headers: asAlice })).status, 200);

        // The bucket sees only the blinded prefix — no account name anywhere.
        deepEqual([...s3.objects.keys()], [`${aliceId}/refs`]);
        ok(!aliceId.includes('alice'), 'blinded id must not contain the account name');
    });

    test('stale refs CAS is rejected with 412', async () => {
        const res = await fetch(`${base}/me/refs`, {
            method: 'PUT',
            headers: { ...asAlice, 'if-match': '"stale"', 'content-type': 'application/octet-stream' },
            body: Buffer.from('clobber'),
        });
        equal(res.status, 412);
        equal(s3.objects.get(`${aliceId}/refs`).body.toString(), 'ciphertext-refs-v1');
    });
});

describe('store-id blinding (makeStoreRepoId)', () => {
    test('keyed, deterministic, and account-name-free', () => {
        const id = makeStoreRepoId('s1');
        equal(id('alice.near'), id('alice.near'));
        notEqual(id('alice.near'), id('bob.near'));
        notEqual(makeStoreRepoId('s2')('alice.near'), id('alice.near'), 'different secret -> different id');
        match(id('alice.near'), /^r[0-9a-f]{32}$/);
    });

    test('no secret -> identity (blinding off for dev/tests)', () => {
        equal(makeStoreRepoId(undefined)('alice.near'), 'alice.near');
    });
});

describe('billing gate: reads stay available to lapsed accounts', () => {
    let server, base;

    before(async () => {
        const storeProxy = createStoreProxy({
            s3: fakeS3(),
            bucket: 'test',
            auth: (req) => req.storeRepoId ?? null,
        });
        const gate = async () => false; // every account is lapsed/unfunded
        const id = makeStoreRepoId('gate-secret');
        const app = express();
        // Mirrors server/index.js: writes are billing-gated, reads are not — a
        // user's encrypted backup must never be hostage to their ARIZ balance.
        app.use('/store', (req, res, next) => {
            if (req.method === 'OPTIONS') return storeProxy(req, res, next);
            const account = req.headers['x-test-account'];
            if (!account) return res.status(401).send('failed to parse token');
            req.accountId = account;
            (async () => {
                if (req.method !== 'GET' && req.method !== 'HEAD') {
                    if (!(await gate(account))) {
                        return res.status(402).json({ error: 'authorization_required' });
                    }
                }
                req.storeRepoId = id(account);
                if (req.url === '/me' || req.url.startsWith('/me/')) {
                    req.url = `/${req.storeRepoId}${req.url.slice('/me'.length)}`;
                }
                storeProxy(req, res, next);
            })();
        });
        await new Promise((r) => { server = app.listen(0, r); });
        base = `http://localhost:${server.address().port}/store`;
    });

    after(() => server?.close());

    const asAlice = { 'x-test-account': 'alice.near' };

    test('lapsed account: writes are 402', async () => {
        const res = await fetch(`${base}/me/refs`, {
            method: 'PUT',
            headers: { ...asAlice, 'if-none-match': '*', 'content-type': 'application/octet-stream' },
            body: Buffer.from('x'),
        });
        equal(res.status, 402);
    });

    test('lapsed account: reads reach the store (clone/fetch stays possible)', async () => {
        // 404 (not 402) proves the request passed the gate and hit the empty store.
        equal((await fetch(`${base}/me/refs`, { headers: asAlice })).status, 404);
        equal((await fetch(`${base}/me/packs`, { headers: asAlice })).status, 200);
    });

    test('lapsed account: maintenance deletes are gated too', async () => {
        equal((await fetch(`${base}/me/packs/0`, { method: 'DELETE', headers: asAlice })).status, 402);
    });
});
