import { describe, test, beforeEach } from 'node:test';
import { deepEqual } from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneAccounts } from './enrollment.js';

function writeAccounts(dir, ids) {
    const accounts = {};
    for (const id of ids) accounts[id] = { accountId: id, registeredAt: 'x' };
    writeFileSync(join(dir, 'accounts.json'), JSON.stringify({ accounts }));
}
const idsIn = (dir) => Object.keys(JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8')).accounts).sort();

describe('pruneAccounts', () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ariz-enroll-')); });

    test('prunes only the disallowed accounts', async () => {
        writeAccounts(dir, ['a.near', 'b.near', 'c.near']);
        const allowed = new Set(['a.near', 'c.near']);
        const pruned = await pruneAccounts(dir, async (id) => allowed.has(id));
        deepEqual(pruned, ['b.near']);
        deepEqual(idsIn(dir), ['a.near', 'c.near']);
    });

    test('no-op when all allowed', async () => {
        writeAccounts(dir, ['a.near', 'b.near']);
        const pruned = await pruneAccounts(dir, async () => true);
        deepEqual(pruned, []);
        deepEqual(idsIn(dir), ['a.near', 'b.near']);
    });

    test('fail-safe: keeps accounts when the check throws (RPC error)', async () => {
        writeAccounts(dir, ['a.near', 'b.near']);
        const pruned = await pruneAccounts(dir, async () => { throw new Error('rpc down'); });
        deepEqual(pruned, []);
        deepEqual(idsIn(dir), ['a.near', 'b.near'], 'a transient failure must not wipe the enrolled set');
    });

    test('missing accounts.json returns []', async () => {
        const pruned = await pruneAccounts(dir, async () => false);
        deepEqual(pruned, []);
    });
});
