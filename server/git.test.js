import { test, before, after, describe } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGitHandler } from './git.js';

const pexec = promisify(execFile);

// Run a git command (async, so the in-process server stays responsive — a sync
// child would block the event loop and deadlock against its own HTTP server).
// A fixed identity + no prompts keeps it hermetic.
async function git(args, cwd) {
    const { stdout } = await pexec('git', args, {
        cwd,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
            GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
            GIT_TERMINAL_PROMPT: '0',
        },
    });
    return stdout;
}

describe('gateway git server', () => {
    let dataDir, work, server, base;

    before(async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'git-srv-'));
        work = mkdtempSync(join(tmpdir(), 'git-work-'));
        const app = express();
        // Stub the auth middleware: the account comes from a header so we can
        // exercise per-account isolation. In production this is req.accountId set
        // by the NEP-413 auth middleware.
        app.use('/git', (req, res, next) => {
            req.accountId = req.headers['x-test-account'] || 'alice.near';
            next();
        }, createGitHandler({ dataDir }));
        await new Promise((r) => { server = app.listen(0, r); });
        base = `http://localhost:${server.address().port}/git`;
    });

    after(() => {
        server?.close();
        rmSync(dataDir, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
    });

    test('clone (lazy-init) -> commit -> push -> re-clone sees the data', async () => {
        const a = join(work, 'a');
        await git(['clone', `${base}/nearsight`, a]); // lazily creates an empty bare repo
        writeFileSync(join(a, 'hello.txt'), 'hello from the gateway git server');
        await git(['add', 'hello.txt'], a);
        await git(['commit', '-m', 'first'], a);
        await git(['push', 'origin', 'HEAD:master'], a);

        const b = join(work, 'b');
        await git(['clone', `${base}/nearsight`, b]);
        equal(readFileSync(join(b, 'hello.txt'), 'utf8'), 'hello from the gateway git server');
    });

    test('repos are isolated per authenticated account', async () => {
        // bob clones the same repo *name* — but it resolves under bob's own dir,
        // so it is a different (empty) repo and must not see alice's file.
        const c = join(work, 'c');
        await git(['-c', 'http.extraHeader=X-Test-Account: bob.near', 'clone', `${base}/nearsight`, c]);
        ok(!existsSync(join(c, 'hello.txt')), "bob must not see alice's repo");
    });

    test('refuses when no account is present (defensive)', () => {
        const handler = createGitHandler({ dataDir });
        const res = { statusCode: 200, body: null, end(b) { this.body = b; } };
        handler({ url: '/nearsight/info/refs', accountId: undefined }, res);
        equal(res.statusCode, 401);
    });
});
