import { describe, test, beforeEach } from 'node:test';
import { equal } from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPayer, setPayer, removeMonitor, loadMonitors } from './monitors.js';

describe('monitors store', () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ariz-monitors-')); });

    test('set / get / remove a payer mapping', () => {
        equal(getPayer(dir, 'x.near'), null);
        setPayer(dir, 'x.near', 'p.near');
        equal(getPayer(dir, 'x.near'), 'p.near');
        setPayer(dir, 'y.near', 'p.near');
        equal(Object.keys(loadMonitors(dir)).length, 2);
        removeMonitor(dir, 'x.near');
        equal(getPayer(dir, 'x.near'), null);
        equal(getPayer(dir, 'y.near'), 'p.near');
    });

    test('missing file -> empty map', () => {
        equal(getPayer(dir, 'anything.near'), null);
    });
});
