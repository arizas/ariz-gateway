import { test, it, before, after, describe } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import express from 'express';

import { createCorsMiddleware, isBypassed } from './cors.js';
import { createStoreMount } from './store-mount.js';
import { makeStoreRepoId } from './store-id.js';

const STORE_ORIGIN = 'https://arizportfolio.near.page';
// fly.toml also allows the development origin. Now that /store answers its own
// CORS, that entry is what the encrypted store reaches on localhost — a test
// exists here because removing it once already broke development silently.
const DEV_ORIGIN = 'http://localhost:8081';

// Minimal S3 double: the store mount only needs GET/PUT to not explode here,
// since these tests never get past the preflight or the 401.
function fakeS3() {
    return { send: async () => { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; } };
}

describe('isBypassed', () => {
    it('matches the mount itself and everything under it', () => {
        equal(isBypassed('/store', ['/store']), true);
        equal(isBypassed('/store/me/refs', ['/store']), true);
    });

    it('does not capture a sibling that merely shares the prefix', () => {
        equal(isBypassed('/storefront', ['/store']), false);
        equal(isBypassed('/storage', ['/store']), false);
    });

    it('is false with nothing bypassed', () => {
        equal(isBypassed('/store', []), false);
    });
});

// This is the composition that was broken in production: the blanket middleware
// answered every preflight, including /store's, so the store's own CORS layer —
// origin allow-list, Vary, and Access-Control-Expose-Headers: ETag — never ran.
// The mount was covered in isolation; the wiring was not. These tests exercise
// the two together.
describe('CORS composition: blanket middleware + /store mount', () => {
    let server, base;

    before(async () => {
        const app = express();
        app.use(createCorsMiddleware({ bypass: ['/store'] }));
        app.use('/store', createStoreMount({
            s3: fakeS3(),
            bucket: 'test',
            allowedOrigins: [STORE_ORIGIN, DEV_ORIGIN],
            auth: (req, res, next) => {
                if (!req.headers['x-test-account']) return res.status(401).send('unauthenticated');
                req.accountId = req.headers['x-test-account'];
                next();
            },
            accountGate: null,
            storeRepoId: makeStoreRepoId('test-blinding-secret'),
        }));
        app.get('/api/prices/currencylist', (req, res) => res.json(['nok']));
        server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
        base = `http://localhost:${server.address().port}`;
    });

    after(() => server?.close());

    const preflight = (path, origin) => fetch(`${base}${path}`, {
        method: 'OPTIONS',
        headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'PUT',
            'Access-Control-Request-Headers': 'authorization,if-match',
        },
    });

    it('answers a non-store preflight itself, with the wildcard', async () => {
        const res = await preflight('/api/prices/currencylist', STORE_ORIGIN);
        equal(res.headers.get('access-control-allow-origin'), '*');
        equal(res.headers.get('access-control-allow-methods'), 'GET, POST, PUT, DELETE, OPTIONS');
    });

    it('leaves a /store preflight to the store mount', async () => {
        const res = await preflight('/store/me/refs', STORE_ORIGIN);
        equal(res.status, 204);
        // The specific origin, not the wildcard — the store carries an allow-list.
        equal(res.headers.get('access-control-allow-origin'), STORE_ORIGIN);
        equal(res.headers.get('vary'), 'Origin');
        equal(res.headers.get('access-control-allow-methods'), 'GET, PUT, DELETE, OPTIONS');
        equal(res.headers.get('access-control-max-age'), '600');
    });

    // The regression that motivated all of this: the refs compare-and-swap client
    // reads res.headers.get('etag'), which a browser returns as null unless the
    // response says the header may be exposed. The blanket middleware never set
    // it, so every cross-origin CAS write degraded to create-if-absent.
    it('exposes ETag on an authenticated /store response', async () => {
        const res = await fetch(`${base}/store/me/refs`, {
            headers: { Origin: STORE_ORIGIN, 'x-test-account': 'alice.near' },
        });
        equal(res.headers.get('access-control-expose-headers'), 'ETag');
        equal(res.headers.get('access-control-allow-origin'), STORE_ORIGIN);
    });

    // Auth and the billing gate answer before the proxy runs. Without headers on
    // those responses a browser reports an opaque network failure instead of the
    // status, so an expired token stops looking like "sign in again".
    it('keeps a 401 readable by the browser', async () => {
        const res = await fetch(`${base}/store/me/refs`, { headers: { Origin: STORE_ORIGIN } });
        equal(res.status, 401);
        equal(res.headers.get('access-control-allow-origin'), STORE_ORIGIN);
        equal(res.headers.get('access-control-expose-headers'), 'ETag');
    });

    it('does not expose ETag or an origin for a store origin that is not allowed', async () => {
        const res = await fetch(`${base}/store/me/refs`, {
            headers: { Origin: 'https://evil.example', 'x-test-account': 'alice.near' },
        });
        equal(res.headers.get('access-control-allow-origin'), null);
        equal(res.headers.get('access-control-expose-headers'), null);
    });

    it('still reaches auth on /store — the bypass is about headers, not access', async () => {
        const res = await fetch(`${base}/store/me/refs`, { headers: { Origin: STORE_ORIGIN } });
        equal(res.status, 401);
    });

    it('lets the development origin through, as fly.toml configures', async () => {
        const res = await preflight('/store/me/keys/abc', DEV_ORIGIN);
        equal(res.status, 204);
        equal(res.headers.get('access-control-allow-origin'), DEV_ORIGIN);
    });

    it('a bypassed preflight is never answered with the wildcard', async () => {
        for (const origin of [STORE_ORIGIN, 'https://evil.example']) {
            const res = await preflight('/store/me/refs', origin);
            ok(res.headers.get('access-control-allow-origin') !== '*',
                `wildcard leaked to /store for ${origin}`);
        }
    });
});
