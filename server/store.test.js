import { test, before, after, describe } from 'node:test';
import { equal, deepEqual, ok, notEqual, match } from 'node:assert/strict';
import express from 'express';
import { createStoreMount } from './store-mount.js';
import { makeStoreRepoId } from './store-id.js';

// Tests drive the REAL /store composition (server/store-mount.js — the same
// module index.js mounts): NEP-413-style auth scoping via blinded ids, the
// unauthenticated CORS preflight bypass, the /me alias, the writes-only billing
// gate, key wraps, and refs round-trips — against an in-memory fake S3, so no
// MinIO is needed in this repo's CI (the library's own CI covers real S3
// semantics).
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

// Auth stub with the same contract as the real middleware: sets req.accountId or
// responds 401 (like git.test.js, the account comes from a header).
function stubAuth(req, res, next) {
    const account = req.headers['x-test-account'];
    if (!account) return res.status(401).send('failed to parse token');
    req.accountId = account;
    next();
}

async function startMount({ accountGate = null } = {}) {
    const s3 = fakeS3();
    const storeRepoId = makeStoreRepoId('test-blinding-secret');
    const app = express();
    app.use('/store', createStoreMount({
        s3, bucket: 'test', allowedOrigins: [ORIGIN], auth: stubAuth, accountGate, storeRepoId,
    }));
    const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    return { s3, storeRepoId, server, base: `http://localhost:${server.address().port}/store` };
}

const asAlice = { 'x-test-account': 'alice.near' };

describe('encrypted store mount (/store)', () => {
    let s3, storeRepoId, server, base, aliceId;

    before(async () => {
        ({ s3, storeRepoId, server, base } = await startMount());
        aliceId = storeRepoId('alice.near');
    });
    after(() => server?.close());

    test('CORS preflight is answered without authentication', async () => {
        const res = await fetch(`${base}/me/refs`, {
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
        equal((await fetch(`${base}/me/refs`)).status, 401);
    });

    test('an account only reaches its own store (blinded ids)', async () => {
        equal((await fetch(`${base}/bob.near/refs`, { headers: asAlice })).status, 403);
        equal((await fetch(`${base}/${storeRepoId('bob.near')}/refs`, { headers: asAlice })).status, 403);
        // The plain own account name doesn't address the store either.
        equal((await fetch(`${base}/alice.near/refs`, { headers: asAlice })).status, 403);
    });

    test('refs round-trip via the /me alias, keys land under the blinded prefix', async () => {
        const put = await fetch(`${base}/me/refs`, {
            method: 'PUT',
            headers: { ...asAlice, 'if-none-match': '*', 'content-type': 'application/octet-stream' },
            body: Buffer.from('ciphertext-refs-v1'),
        });
        equal(put.status, 204);

        const get = await fetch(`${base}/me/refs`, { headers: asAlice });
        equal(get.status, 200);
        equal(Buffer.from(await get.arrayBuffer()).toString(), 'ciphertext-refs-v1');
        equal((await fetch(`${base}/${aliceId}/refs`, { headers: asAlice })).status, 200);

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

    test('key wraps: create-once, read back, races resolve via 412', async () => {
        const wrapId = 'a'.repeat(32);
        equal((await fetch(`${base}/me/keys/${wrapId}`, { headers: asAlice })).status, 404);

        const put = await fetch(`${base}/me/keys/${wrapId}`, {
            method: 'PUT',
            headers: { ...asAlice, 'content-type': 'application/octet-stream' },
            body: Buffer.from('wrapped-dek-ciphertext'),
        });
        equal(put.status, 204);

        const get = await fetch(`${base}/me/keys/${wrapId}`, { headers: asAlice });
        equal(get.status, 200);
        equal(Buffer.from(await get.arrayBuffer()).toString(), 'wrapped-dek-ciphertext');
        ok(s3.objects.has(`${aliceId}/keys/${wrapId}`), 'wrap stored under the blinded prefix');

        // Wraps are immutable — a second create (setup race) gets 412.
        const race = await fetch(`${base}/me/keys/${wrapId}`, {
            method: 'PUT', headers: { ...asAlice }, body: Buffer.from('other-dek'),
        });
        equal(race.status, 412);
        equal(s3.objects.get(`${aliceId}/keys/${wrapId}`).body.toString(), 'wrapped-dek-ciphertext');
    });

    test("key wraps: another account's wraps are unreachable", async () => {
        const wrapId = 'a'.repeat(32);
        const res = await fetch(`${base}/${storeRepoId('bob.near')}/keys/${wrapId}`, { headers: asAlice });
        equal(res.status, 403);
    });
});

describe('billing gate: reads stay available to lapsed accounts', () => {
    let server, base;

    before(async () => {
        // Every account is lapsed/unfunded.
        ({ server, base } = await startMount({ accountGate: async () => false }));
    });
    after(() => server?.close());

    test('lapsed account: writes are 402 (refs, packs, wraps, deletes)', async () => {
        for (const [path, method] of [['/me/refs', 'PUT'], ['/me/packs/0', 'PUT'], [`/me/keys/${'b'.repeat(32)}`, 'PUT'], ['/me/packs/0', 'DELETE']]) {
            const res = await fetch(`${base}${path}`, {
                method, headers: { ...asAlice, 'if-none-match': '*' }, body: method === 'DELETE' ? undefined : Buffer.from('x'),
            });
            equal(res.status, 402, `${method} ${path}`);
        }
    });

    test('lapsed account: reads reach the store (clone/fetch stays possible)', async () => {
        // 404 (not 402) proves the request passed the gate and hit the empty store.
        equal((await fetch(`${base}/me/refs`, { headers: asAlice })).status, 404);
        equal((await fetch(`${base}/me/packs`, { headers: asAlice })).status, 200);
        equal((await fetch(`${base}/me/keys/${'b'.repeat(32)}`, { headers: asAlice })).status, 404);
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
