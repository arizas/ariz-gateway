import { describe, test, beforeEach, afterEach } from 'node:test';
import { equal, notEqual, ok } from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFrontendIndexHandler, CSP_NONCE_PLACEHOLDER } from './frontend.js';

function serve(handler, method = 'GET') {
    return new Promise((resolve, reject) => {
        const headers = {};
        const res = {
            setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
            end: (body) => resolve({ headers, body }),
        };
        handler({ method }, res, reject);
    });
}

describe('the frontend page', () => {
    let dir, index;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'frontend-test-'));
        index = join(dir, 'index.html');
        await writeFile(index, `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${CSP_NONCE_PLACEHOLDER}'"><script nonce="${CSP_NONCE_PLACEHOLDER}"></script>`);
    });
    afterEach(() => rm(dir, { recursive: true, force: true }));

    test('carries a nonce in the policy and on the script, the same in both', async () => {
        const { body } = await serve(createFrontendIndexHandler(index));
        const nonce = body.match(/nonce="([^"]+)"/)[1];
        ok(!body.includes(CSP_NONCE_PLACEHOLDER));
        ok(body.includes(`'nonce-${nonce}'`));
        // Only what the wallet connector keeps: it strips anything else.
        ok(/^[A-Za-z0-9+/=]{24}$/.test(nonce), nonce);
    });

    // A nonce known in advance is no nonce: a token name carrying
    // <script nonce="…"> would run.
    test('has a new nonce on every request, and is never cached', async () => {
        const handler = createFrontendIndexHandler(index);
        const a = await serve(handler);
        const b = await serve(handler);
        notEqual(a.body.match(/nonce="([^"]+)"/)[1], b.body.match(/nonce="([^"]+)"/)[1]);
        equal(a.headers['cache-control'], 'no-store');
        equal(a.headers['content-type'], 'text/html; charset=utf-8');
    });

    test('picks up a new bundle without a restart', async () => {
        const handler = createFrontendIndexHandler(index);
        await serve(handler);
        await new Promise(r => setTimeout(r, 20));
        await writeFile(index, `<p>new bundle</p>`);
        ok((await serve(handler)).body.includes('new bundle'));
    });

    test('keeps the headers it is given', async () => {
        const handler = createFrontendIndexHandler(index, { setHeaders: (res) => res.setHeader('Cross-Origin-Opener-Policy', 'same-origin') });
        equal((await serve(handler)).headers['cross-origin-opener-policy'], 'same-origin');
    });
});
