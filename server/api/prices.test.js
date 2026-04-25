import { afterEach, beforeEach, describe, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deepEqual, equal, ok, rejects } from 'node:assert/strict';

import {
    fetchCurrencyList,
    fetchCurrent,
    fetchPriceHistory,
    runEodUpdate
} from './prices/index.js';

function jsonResponse(body, ok = true, status = 200) {
    return {
        ok,
        status,
        json: async () => body
    };
}

function dayUnix(dateStr) {
    return Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000);
}

describe('prices', () => {
    let dataDir;
    let originalFetch;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'prices-test-'));
        process.env.ARIZ_DATA_DIR = dataDir;
        originalFetch = globalThis.fetch;
    });

    afterEach(async () => {
        globalThis.fetch = originalFetch;
        await rm(dataDir, { recursive: true, force: true });
    });

    test('history reads from persisted cache without hitting network', async () => {
        await mkdir(join(dataDir, 'prices'), { recursive: true });
        await writeFile(join(dataDir, 'prices', 'near.json'), JSON.stringify({
            '2024-06-22': 5.0,
            '2024-06-23': 5.5,
            '2024-06-24': 6.0
        }));
        globalThis.fetch = async (url) => { throw new Error(`unexpected fetch ${url}`); };

        const result = await fetchPriceHistory('NEAR', 'USD', '2024-06-23');

        deepEqual(result, { '2024-06-22': 5.0, '2024-06-23': 5.5 });
    });

    test('history backfills from CryptoCompare on first call and persists cache', async () => {
        const calls = [];
        globalThis.fetch = async (url) => {
            const u = url.toString();
            calls.push(u);
            if (u.includes('cryptocompare.com')) {
                return jsonResponse({
                    Response: 'Success',
                    Data: {
                        Data: [
                            { time: dayUnix('2024-06-22'), close: 5.0 },
                            { time: dayUnix('2024-06-23'), close: 5.5 }
                        ]
                    }
                });
            }
            throw new Error(`unexpected fetch ${u}`);
        };

        const out = await fetchPriceHistory('FOO', 'USD');

        deepEqual(out, { '2024-06-22': 5.0, '2024-06-23': 5.5 });
        const cached = JSON.parse(await readFile(join(dataDir, 'prices', 'foo.json'), 'utf8'));
        deepEqual(cached, { '2024-06-22': 5.0, '2024-06-23': 5.5 });
        ok(calls.some(c => c.includes('cryptocompare.com')));
    });

    test('history converts USD to fiat using forex rates with carry-forward', async () => {
        await mkdir(join(dataDir, 'prices'), { recursive: true });
        await mkdir(join(dataDir, 'forex'), { recursive: true });
        await writeFile(join(dataDir, 'prices', 'near.json'), JSON.stringify({
            '2024-06-22': 1.0,
            '2024-06-23': 2.0,
            '2024-06-24': 3.0
        }));
        await writeFile(join(dataDir, 'forex', 'nok.json'), JSON.stringify({
            '2024-06-21': 10
        }));
        globalThis.fetch = async (url) => { throw new Error(`unexpected fetch ${url}`); };

        const out = await fetchPriceHistory('NEAR', 'NOK');

        deepEqual(out, { '2024-06-22': 10, '2024-06-23': 20, '2024-06-24': 30 });
    });

    test('current returns spot prices and serves repeats from in-memory TTL cache', async () => {
        let calls = 0;
        globalThis.fetch = async () => {
            calls++;
            return jsonResponse({ near: { usd: 5.5 }, 'usd-coin': { usd: 1.0 } });
        };

        const first = await fetchCurrent(['NEAR', 'USDC'], ['USD']);
        const second = await fetchCurrent(['NEAR', 'USDC'], ['USD']);

        deepEqual(first, { NEAR: { usd: 5.5 }, USDC: { usd: 1.0 } });
        deepEqual(second, first);
        equal(calls, 1);
    });

    test('currencylist returns the spot map for the base token', async () => {
        globalThis.fetch = async () => jsonResponse({ near: { usd: 5.5, eur: 5.0, nok: 55 } });

        const list = await fetchCurrencyList('NEAR');

        deepEqual(list, { usd: 5.5, eur: 5.0, nok: 55 });
    });

    test('runEodUpdate appends yesterday close for cached tokens', async () => {
        await mkdir(join(dataDir, 'prices'), { recursive: true });
        await writeFile(join(dataDir, 'prices', 'near.json'), JSON.stringify({
            '2024-06-21': 5.0
        }));
        globalThis.fetch = async (url) => {
            if (url.toString().includes('cryptocompare.com')) {
                return jsonResponse({
                    Response: 'Success',
                    Data: { Data: [{ time: dayUnix('2024-06-22'), close: 5.5 }] }
                });
            }
            throw new Error(`unexpected fetch ${url}`);
        };

        await runEodUpdate({ now: new Date('2024-06-23T01:00:00Z') });

        const cached = JSON.parse(await readFile(join(dataDir, 'prices', 'near.json'), 'utf8'));
        equal(cached['2024-06-22'], 5.5);
        equal(cached['2024-06-21'], 5.0);
    });

    test('runEodUpdate skips up-to-date forex caches', async () => {
        await mkdir(join(dataDir, 'forex'), { recursive: true });
        await writeFile(join(dataDir, 'forex', 'nok.json'), JSON.stringify({
            '2024-06-22': 10.5
        }));
        let fetched = false;
        globalThis.fetch = async () => {
            fetched = true;
            throw new Error('should not fetch when cache is current');
        };

        await runEodUpdate({ now: new Date('2024-06-23T01:00:00Z') });

        equal(fetched, false);
    });

    test('cryptocompare error surfaces to the caller', async () => {
        globalThis.fetch = async () => jsonResponse({
            Response: 'Error',
            Message: 'symbol not found'
        });
        await rejects(() => fetchPriceHistory('UNKNOWN', 'USD'), /symbol not found/);
    });
});
