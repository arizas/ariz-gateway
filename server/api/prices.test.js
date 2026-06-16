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

    test('basetoken accepts both CoinGecko ids and ticker symbols (regression)', async () => {
        const calls = [];
        globalThis.fetch = async (url) => {
            const u = url.toString();
            calls.push(u);
            if (u.includes('cryptocompare.com')) {
                return jsonResponse({
                    Response: 'Success',
                    Data: { Data: [{ time: dayUnix('2024-06-23'), close: 3500 }] }
                });
            }
            throw new Error(`unexpected fetch ${u}`);
        };

        const fromCgId = await fetchPriceHistory('ethereum', 'USD');
        const fromSymbol = await fetchPriceHistory('eth', 'USD');

        deepEqual(fromCgId, { '2024-06-23': 3500 });
        deepEqual(fromSymbol, fromCgId);

        const cryptoCompareCalls = calls.filter(c => c.includes('cryptocompare.com'));
        ok(cryptoCompareCalls.length >= 1, 'expected at least one CryptoCompare call');
        for (const call of cryptoCompareCalls) {
            const fsym = new URL(call).searchParams.get('fsym');
            equal(fsym, 'ETH', `CryptoCompare fsym should be ETH, got ${fsym}`);
        }

        const cached = JSON.parse(await readFile(join(dataDir, 'prices', 'eth.json'), 'utf8'));
        deepEqual(cached, { '2024-06-23': 3500 });
        await rejects(() => readFile(join(dataDir, 'prices', 'ethereum.json'), 'utf8'));
    });

    test('current accepts CoinGecko ids and forwards them to CoinGecko (regression)', async () => {
        const calls = [];
        globalThis.fetch = async (url) => {
            calls.push(url.toString());
            return jsonResponse({ ethereum: { usd: 3500 } });
        };

        const out = await fetchCurrent(['ethereum'], ['usd']);

        deepEqual(out, { ethereum: { usd: 3500 } });
        equal(calls.length, 1);
        equal(new URL(calls[0]).searchParams.get('ids'), 'ethereum');
    });

    test('wNEAR is priced as NEAR (alias) and cached as near', async () => {
        const calls = [];
        globalThis.fetch = async (url) => {
            const u = url.toString();
            calls.push(u);
            if (u.includes('cryptocompare.com')) {
                return jsonResponse({ Response: 'Success', Data: { Data: [{ time: dayUnix('2026-06-14'), close: 4.5 }] } });
            }
            throw new Error(`unexpected fetch ${u}`);
        };

        const out = await fetchPriceHistory('wNEAR', 'USD');

        deepEqual(out, { '2026-06-14': 4.5 });
        const fsym = new URL(calls.find(c => c.includes('cryptocompare.com'))).searchParams.get('fsym');
        equal(fsym, 'NEAR', 'wNEAR should be fetched as NEAR');
        const cached = JSON.parse(await readFile(join(dataDir, 'prices', 'near.json'), 'utf8'));
        deepEqual(cached, { '2026-06-14': 4.5 });
        await rejects(() => readFile(join(dataDir, 'prices', 'wnear.json'), 'utf8'));
    });

    test('falls back to CoinGecko market_chart when CryptoCompare lacks the symbol', async () => {
        globalThis.fetch = async (url) => {
            const u = url.toString();
            if (u.includes('cryptocompare.com')) return jsonResponse({ Response: 'Error', Message: 'fsym not found' });
            if (u.includes('coingecko.com') && u.includes('market_chart')) {
                return jsonResponse({ prices: [
                    [Date.parse('2026-06-14T00:00:00Z'), 0.30],
                    [Date.parse('2026-06-15T00:00:00Z'), 0.31]
                ] });
            }
            throw new Error(`unexpected fetch ${u}`);
        };

        const out = await fetchPriceHistory('NPRO', 'USD');

        deepEqual(out, { '2026-06-14': 0.30, '2026-06-15': 0.31 });
        const cached = JSON.parse(await readFile(join(dataDir, 'prices', 'npro.json'), 'utf8'));
        deepEqual(cached, { '2026-06-14': 0.30, '2026-06-15': 0.31 });
    });

    test('unknown token returns empty when neither source has it', async () => {
        globalThis.fetch = async (url) => {
            const u = url.toString();
            if (u.includes('cryptocompare.com')) return jsonResponse({ Response: 'Error', Message: 'symbol not found' });
            if (u.includes('coingecko.com')) return jsonResponse({ error: 'coin not found' });
            throw new Error(`unexpected fetch ${u}`);
        };
        deepEqual(await fetchPriceHistory('TOTALLYUNKNOWNXYZ', 'USD'), {});
    });
});
