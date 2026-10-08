import { afterEach, beforeEach, describe, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deepEqual, equal, ok, rejects } from 'node:assert/strict';

import {
    fetchCurrencyList,
    fetchCurrent,
    fetchNoPriceTokens,
    fetchPriceHistory,
    fetchRateTokens,
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

// DeFiLlama /chart response for one coin: { coins: { 'coingecko:<id>': { prices } } }.
function llamaChartResponse(coinGeckoId, priceMap) {
    return jsonResponse({
        coins: {
            [`coingecko:${coinGeckoId}`]: {
                confidence: 0.99,
                prices: Object.entries(priceMap).map(([date, price]) => ({ timestamp: dayUnix(date), price }))
            }
        }
    });
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

    test('history backfills from DeFiLlama on first call and persists cache', async () => {
        const calls = [];
        globalThis.fetch = async (url) => {
            const u = url.toString();
            calls.push(u);
            if (u.includes('coins.llama.fi')) {
                return llamaChartResponse('foo', { '2024-06-22': 5.0, '2024-06-23': 5.5 });
            }
            throw new Error(`unexpected fetch ${u}`);
        };

        const out = await fetchPriceHistory('FOO', 'USD');

        deepEqual(out, { '2024-06-22': 5.0, '2024-06-23': 5.5 });
        const cached = JSON.parse(await readFile(join(dataDir, 'prices', 'foo.json'), 'utf8'));
        deepEqual(cached, { '2024-06-22': 5.0, '2024-06-23': 5.5 });
        ok(calls.some(c => c.includes('coins.llama.fi/chart/coingecko:foo')));
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
            if (url.toString().includes('coins.llama.fi')) {
                return llamaChartResponse('near', { '2024-06-22': 5.5 });
            }
            throw new Error(`unexpected fetch ${url}`);
        };

        await runEodUpdate({ now: new Date('2024-06-23T01:00:00Z') });

        const cached = JSON.parse(await readFile(join(dataDir, 'prices', 'near.json'), 'utf8'));
        equal(cached['2024-06-22'], 5.5);
        equal(cached['2024-06-21'], 5.0);
    });

    test('runEodUpdate bridges a multi-day gap, not just a fixed window', async () => {
        await mkdir(join(dataDir, 'prices'), { recursive: true });
        await writeFile(join(dataDir, 'prices', 'near.json'), JSON.stringify({ '2024-06-10': 5.0 }));
        let spanRequested = null;
        globalThis.fetch = async (url) => {
            const u = url.toString();
            if (u.includes('coins.llama.fi')) {
                spanRequested = Number(new URL(u).searchParams.get('span'));
                return llamaChartResponse('near', { '2024-06-21': 6.0, '2024-06-22': 6.5 });
            }
            throw new Error(`unexpected fetch ${u}`);
        };

        await runEodUpdate({ now: new Date('2024-06-23T01:00:00Z') });

        const cached = JSON.parse(await readFile(join(dataDir, 'prices', 'near.json'), 'utf8'));
        equal(cached['2024-06-22'], 6.5);
        equal(cached['2024-06-21'], 6.0);
        // ~12-day gap -> request must span the gap (not a fixed 7), so 06-30-style
        // holes older than a week still get backfilled.
        ok(spanRequested >= 14, `expected span >= 14 for a ~12-day gap, got ${spanRequested}`);
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

    test('runEodUpdate skips no-price (empty) token caches to avoid rate limits', async () => {
        await mkdir(join(dataDir, 'prices'), { recursive: true });
        await writeFile(join(dataDir, 'prices', 'scamtoken.json'), JSON.stringify({}));
        let fetched = false;
        globalThis.fetch = async () => {
            fetched = true;
            throw new Error('should not fetch for an empty (no-price) token');
        };

        await runEodUpdate({ now: new Date('2024-06-23T01:00:00Z') });

        equal(fetched, false);
    });

    test('basetoken accepts both CoinGecko ids and ticker symbols (regression)', async () => {
        const calls = [];
        globalThis.fetch = async (url) => {
            const u = url.toString();
            calls.push(u);
            if (u.includes('coins.llama.fi')) {
                return llamaChartResponse('ethereum', { '2024-06-23': 3500 });
            }
            throw new Error(`unexpected fetch ${u}`);
        };

        const fromCgId = await fetchPriceHistory('ethereum', 'USD');
        const fromSymbol = await fetchPriceHistory('eth', 'USD');

        deepEqual(fromCgId, { '2024-06-23': 3500 });
        deepEqual(fromSymbol, fromCgId);

        // Both the ticker ('eth') and the CoinGecko id ('ethereum') resolve to the
        // same DeFiLlama coin key.
        const llamaCalls = calls.filter(c => c.includes('coins.llama.fi'));
        ok(llamaCalls.length >= 1, 'expected at least one DeFiLlama call');
        for (const call of llamaCalls) {
            ok(call.includes('coingecko:ethereum'), `DeFiLlama coin should be coingecko:ethereum, got ${call}`);
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
            if (u.includes('coins.llama.fi')) {
                return llamaChartResponse('near', { '2026-06-14': 4.5 });
            }
            throw new Error(`unexpected fetch ${u}`);
        };

        const out = await fetchPriceHistory('wNEAR', 'USD');

        deepEqual(out, { '2026-06-14': 4.5 });
        ok(calls.find(c => c.includes('coins.llama.fi')).includes('coingecko:near'), 'wNEAR should be fetched as coingecko:near');
        const cached = JSON.parse(await readFile(join(dataDir, 'prices', 'near.json'), 'utf8'));
        deepEqual(cached, { '2026-06-14': 4.5 });
        await rejects(() => readFile(join(dataDir, 'prices', 'wnear.json'), 'utf8'));
    });

    test('falls back to CoinGecko market_chart when DeFiLlama lacks the token', async () => {
        globalThis.fetch = async (url) => {
            const u = url.toString();
            if (u.includes('coins.llama.fi')) return llamaChartResponse('npro', {}); // no prices
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
            if (u.includes('coins.llama.fi')) return llamaChartResponse('totallyunknownxyz', {}); // no prices
            if (u.includes('coingecko.com')) return jsonResponse({ error: 'coin not found' });
            throw new Error(`unexpected fetch ${u}`);
        };
        deepEqual(await fetchPriceHistory('TOTALLYUNKNOWNXYZ', 'USD'), {});
    });

    test('nopricetokens lists cached tokens with an empty price map (the no-price set)', async () => {
        await mkdir(join(dataDir, 'prices'), { recursive: true });
        // A token with prices, and two with none (scam token + ARIZ credits).
        await writeFile(join(dataDir, 'prices', 'near.json'), JSON.stringify({ '2024-06-22': 5.0 }));
        await writeFile(join(dataDir, 'prices', 'scamtoken.json'), JSON.stringify({}));
        await writeFile(join(dataDir, 'prices', 'ariz.json'), JSON.stringify({}));
        globalThis.fetch = async (url) => { throw new Error(`unexpected fetch ${url}`); };

        const noPrice = await fetchNoPriceTokens();

        deepEqual([...noPrice].sort(), ['ariz', 'scamtoken']);
    });
});

// The gateway is meant to be the archive: a token's deep history is pulled once
// and kept, and the hourly update only advances it. Before this, loadTokenPrices
// trusted any non-empty cache, so a series that had been seeded shallow answered
// shallow for good — one real store lost 4 252 days of BTC that way, because the
// client overwrote its own copy with the gateway's short answer.
describe('deep history is backfilled once and then kept', () => {
    let dataDir;
    let originalFetch;
    let llamaCalls;

    const DEEP = { '2014-07-18': 500, '2019-01-01': 4000, '2024-01-01': 42000 };
    const SHALLOW = { '2026-06-21': 60000, '2026-06-22': 61000 };

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'prices-backfill-'));
        process.env.ARIZ_DATA_DIR = dataDir;
        originalFetch = globalThis.fetch;
        llamaCalls = 0;
        globalThis.fetch = async (url) => {
            const href = String(url);
            if (href.includes('coins.llama.fi')) {
                llamaCalls++;
                // One window's worth; fetchFullDailyHistory stops when a window
                // adds nothing new.
                return llamaCalls === 1
                    ? llamaChartResponse('bitcoin', DEEP)
                    : llamaChartResponse('bitcoin', {});
            }
            if (href.includes('frankfurter')) return jsonResponse({ rates: {} });
            return jsonResponse({});
        };
        await mkdir(join(dataDir, 'prices'), { recursive: true });
    });

    afterEach(async () => {
        globalThis.fetch = originalFetch;
        await rm(dataDir, { recursive: true, force: true });
    });

    test('a shallow cache is deepened rather than trusted', async () => {
        await writeFile(join(dataDir, 'prices', 'btc.json'), JSON.stringify(SHALLOW));

        const history = await fetchPriceHistory('bitcoin', 'USD');

        // The days already held survive, and the deep ones are added.
        for (const [date, price] of Object.entries(SHALLOW)) equal(history[date], price);
        for (const [date, price] of Object.entries(DEEP)) equal(history[date], price);
        ok(llamaCalls > 0, 'expected a backfill fetch');

        const onDisk = JSON.parse(await readFile(join(dataDir, 'prices', 'btc.json'), 'utf8'));
        equal(Object.keys(onDisk).length, Object.keys(DEEP).length + Object.keys(SHALLOW).length);
    });

    test('the backfill happens once, not on every load', async () => {
        await writeFile(join(dataDir, 'prices', 'btc.json'), JSON.stringify(SHALLOW));
        await fetchPriceHistory('bitcoin', 'USD');
        const afterFirst = llamaCalls;
        ok(afterFirst > 0);

        // A fresh process would re-read from disk; the marker is what stops it.
        const { readPriceMeta, hasFullHistory } = await import('./prices/store.js');
        ok(await hasFullHistory('btc'), 'expected btc to be marked');
        ok((await readPriceMeta()).btc.fullHistoryAt, 'expected a date on the marker');
    });

    test('the marker file is not mistaken for a cached token', async () => {
        await writeFile(join(dataDir, 'prices', 'btc.json'), JSON.stringify(SHALLOW));
        await fetchPriceHistory('bitcoin', 'USD');

        const { listCachedTokens } = await import('./prices/store.js');
        const tokens = await listCachedTokens();
        ok(!tokens.some(t => t.startsWith('.')), `the sidecar leaked into the token listing: ${tokens}`);
        ok(tokens.includes('btc'), 'real tokens are still listed');

        // And the hourly update must not try to advance it either.
        await runEodUpdate({ now: new Date('2026-08-18T00:00:00Z') });
        const onDisk = JSON.parse(await readFile(join(dataDir, 'prices', 'btc.json'), 'utf8'));
        ok(onDisk['2014-07-18'] != null, 'deep history survived the EOD pass');
    });

    test('an empty cache is still marked, so unlisted tokens are not refetched forever', async () => {
        globalThis.fetch = async (url) => String(url).includes('coins.llama.fi')
            ? llamaChartResponse('bitcoin', {})
            : jsonResponse({});
        await fetchPriceHistory('bitcoin', 'USD');
        const { hasFullHistory } = await import('./prices/store.js');
        ok(await hasFullHistory('btc'));
    });
});

// A token priced by its own contract rather than a ticker. lst-pool.near calls
// itself stNEAR, exactly like Meta Pool's token, and CoinGecko's "staked-near"
// is Meta Pool's — priced by ticker, 982 tokens bought at 1.02 NEAR each read
// as worth 1.49. The contract's rate is the price.
describe('contract-rate pricing', () => {
    let dataDir;
    let originalFetch;
    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'prices-rate-'));
        process.env.ARIZ_DATA_DIR = dataDir;
        originalFetch = globalThis.fetch;
        await mkdir(join(dataDir, 'prices'), { recursive: true });
        await mkdir(join(dataDir, 'forex'), { recursive: true });
        await writeFile(join(dataDir, 'prices', 'near.json'), JSON.stringify({ '2026-09-27': 4.7, '2026-09-28': 5.0, '2026-09-29': 5.2 }));
        await writeFile(join(dataDir, 'forex', 'nok.json'), JSON.stringify({ '2026-09-01': 10 }));
        await writeFile(join(dataDir, 'prices', '.meta.json'), JSON.stringify({ fullHistory: { near: '2026-10-01' } }));
    });
    afterEach(async () => {
        globalThis.fetch = originalFetch;
        await rm(dataDir, { recursive: true, force: true });
    });

    // A chain whose blocks are exactly one second apart from 2026-08-31, with a
    // head well past the test days, and a rate of 1.01 + 0.0001 per day since
    // 2026-09-27; nothing before that day.
    const GENESIS = Date.parse('2026-08-31T00:00:00Z');
    const HEAD = 3_000_000;
    const tsOf = h => BigInt(GENESIS + h * 1000) * 1_000_000n;
    const dayOf = h => new Date(GENESIS + h * 1000).toISOString().slice(0, 10);
    const rateOn = date => (date < '2026-09-27' ? null : 1.01 + 0.0001 * Math.round((Date.parse(date) - Date.parse('2026-09-27')) / 86_400_000));
    function rpcMock(calls) {
        return async (url, init) => {
            const body = JSON.parse(init.body);
            calls.push(body.method === 'query' ? `query@${body.params.block_id ?? body.params.finality}` : `block@${body.params.block_id ?? body.params.finality}`);
            if (body.method === 'block') {
                const h = body.params.finality ? HEAD : body.params.block_id;
                return jsonResponse({ result: { header: { height: h, timestamp: tsOf(h).toString() } } });
            }
            if (body.method === 'query') {
                const date = body.params.finality ? dayOf(HEAD) : dayOf(body.params.block_id);
                const rate = rateOn(date);
                if (rate == null) return jsonResponse({ error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } });
                const den = 10n ** 24n;
                const num = BigInt(Math.round(rate * 1e12)) * den / 10n ** 12n;
                return jsonResponse({ result: { result: [...Buffer.from(JSON.stringify({ numerator: num.toString(), denominator: den.toString() }))] } });
            }
            throw new Error(`unexpected rpc ${body.method}`);
        };
    }

    test('history is the base price times the rate read at the last block of each day, and nothing before the token existed', async () => {
        const calls = [];
        globalThis.fetch = rpcMock(calls);
        const out = await fetchPriceHistory('lst-pool.near', 'NOK', '2026-09-29');
        deepEqual(Object.keys(out), ['2026-09-27', '2026-09-28', '2026-09-29']);
        ok(Math.abs(out['2026-09-28'] - 5.0 * 10 * 1.0101) < 1e-9, `got ${out['2026-09-28']}`);
        ok(Math.abs(out['2026-09-29'] - 5.2 * 10 * 1.0102) < 1e-9);
        const rateReads = calls.filter(c => c.startsWith('query@') && !c.endsWith('final'));
        // Every day from the configured start to the requested day, once: the
        // days before the contract existed are remembered as such.
        equal(rateReads.length, 29, `one view call per day: ${rateReads.length}`);
        const cached = JSON.parse(await readFile(join(dataDir, 'rates', 'lst-pool.near.json'), 'utf8'));
        ok(Math.abs(cached['2026-09-28'] - 1.0101) < 1e-9);
        equal(cached['2026-09-26'], null, 'a day before the contract existed is remembered as none');
        const again = [];
        globalThis.fetch = rpcMock(again);
        await fetchPriceHistory('lst-pool.near', 'NOK', '2026-09-29');
        equal(again.filter(c => c.startsWith('query@')).length, 0, 'nothing is asked twice');
    });

    test('a day already read is never read again', async () => {
        await mkdir(join(dataDir, 'rates'), { recursive: true });
        const none = Object.fromEntries(Array.from({ length: 26 }, (_, i) => [new Date(Date.parse('2026-09-01T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10), null]));
        await writeFile(join(dataDir, 'rates', 'lst-pool.near.json'), JSON.stringify({ ...none, '2026-09-27': 1.01, '2026-09-28': 1.0101, '2026-09-29': 1.0102 }));
        const calls = [];
        globalThis.fetch = rpcMock(calls);
        const out = await fetchPriceHistory('lst-pool.near', 'NOK', '2026-09-29');
        equal(calls.filter(c => c.startsWith('query@')).length, 0, 'no view calls');
        ok(Math.abs(out['2026-09-28'] - 50 * 1.0101) < 1e-9);
    });

    test('spot is the base spot times the rate at the chain head', async () => {
        globalThis.fetch = async (url, init) => {
            if (init?.body) return rpcMock([])(url, init);
            return jsonResponse({ near: { usd: 5.5, nok: 55 } });
        };
        const out = await fetchCurrent(['near', 'lst-pool.near'], ['usd', 'nok']);
        const headRate = rateOn(dayOf(HEAD));
        ok(Math.abs(out['lst-pool.near'].nok - 55 * headRate) < 1e-9, `got ${out['lst-pool.near'].nok}`);
        equal(out.near.usd, 5.5);
    });

    test('the contracts priced this way are listed', () => {
        deepEqual(fetchRateTokens(), ['lst-pool.near']);
    });
});
