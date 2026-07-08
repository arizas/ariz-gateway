import { fetchSimplePrice, fetchDailyHistory as fetchCoinGeckoDailyHistory } from './providers/coingecko.js';
import { fetchRecentDailyClose as fetchDefiLlamaRecentDailyClose } from './providers/defillama.js';
import { fetchHistoryRange as fetchForexHistoryRange } from './providers/frankfurter.js';
import { getPriceHistory } from './getDailyPrice.js';
import { coinId, toSymbol } from './token-map.js';
import {
    listCachedCurrencies,
    listCachedTokens,
    readForex,
    readTokenPrices,
    writeForex,
    writeTokenPrices
} from './store.js';


const CURRENCYLIST_VS = [
    'aed', 'ars', 'aud', 'bch', 'bdt', 'bhd', 'bmd', 'bnb', 'brl', 'btc',
    'cad', 'chf', 'clp', 'cny', 'czk', 'dkk', 'dot', 'eos', 'eth', 'eur',
    'gbp', 'gel', 'hkd', 'huf', 'idr', 'ils', 'inr', 'jpy', 'krw', 'kwd',
    'lkr', 'ltc', 'mmk', 'mxn', 'myr', 'ngn', 'nok', 'nzd', 'php', 'pkr',
    'pln', 'rub', 'sar', 'sek', 'sgd', 'thb', 'try', 'twd', 'uah', 'usd',
    'vef', 'vnd', 'xag', 'xau', 'xdr', 'xlm', 'xrp', 'yfi', 'zar', 'bits',
    'link', 'sats'
];

const SPOT_TTL_MS = 60_000;
const spotCache = new Map();

async function spotCached(key, fetcher) {
    const entry = spotCache.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    const value = await fetcher();
    spotCache.set(key, { value, expiresAt: Date.now() + SPOT_TTL_MS });
    return value;
}

export async function fetchCurrencyList(token = 'NEAR') {
    const symbol = toSymbol(token);
    return spotCached(`currencylist:${symbol}`, async () => {
        const id = coinId(symbol);
        const data = await fetchSimplePrice([id], CURRENCYLIST_VS);
        return data[id] ?? {};
    });
}

export async function fetchPriceHistory(baseToken = 'NEAR', currency = 'USD', todate) {
    return getPriceHistory(toSymbol(baseToken), currency, todate);
}

// Tokens we've fetched for but found no price anywhere (DeFiLlama + CoinGecko both
// empty) - e.g. scam tokens and ARIZ credits. Derived live from the cache: a token
// that later starts listing drops off this set once loadTokenPrices re-fetches it
// on demand (the hourly EOD updater skips empty entries to avoid rate limits).
// Returned as the lowercase cache keys, which match the CoinGecko id the client
// sends for unlisted tokens.
export async function fetchNoPriceTokens() {
    return spotCached('nopricetokens', async () => {
        const tokens = await listCachedTokens();
        const noPrice = [];
        for (const symbol of tokens) {
            const data = await readTokenPrices(symbol);
            if (!data || Object.keys(data).length === 0) {
                noPrice.push(symbol);
            }
        }
        return noPrice;
    });
}

export async function fetchCurrent(tokens, vsCurrencies) {
    if (!tokens || tokens.length === 0) return {};
    const vs = vsCurrencies && vsCurrencies.length > 0 ? vsCurrencies : ['usd'];
    const ids = tokens.map(t => coinId(toSymbol(t)));
    const sortedIds = [...ids].sort();
    const sortedVs = [...vs.map(v => v.toLowerCase())].sort();
    const cacheKey = `current:${sortedIds.join(',')}:${sortedVs.join(',')}`;
    const data = await spotCached(cacheKey, () => fetchSimplePrice(ids, vs));
    const out = {};
    tokens.forEach((token, i) => {
        out[token] = data[ids[i]] ?? {};
    });
    return out;
}

export async function runEodUpdate({ now = new Date() } = {}) {
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);

    const tokens = await listCachedTokens();
    for (const symbol of tokens) {
        try {
            const data = await readTokenPrices(symbol);
            if (!data) continue;
            // Skip known no-price tokens (empty cache) - re-fetching them every hour
            // is what rate-limits the providers, and there's nothing to advance. A
            // token that later starts listing is retried on-demand by loadTokenPrices.
            if (Object.keys(data).length === 0) continue;
            const lastDate = Object.keys(data).sort().at(-1);
            if (lastDate && lastDate >= yesterday) continue;
            // DeFiLlama (no key) for recent closes; CoinGecko fallback. Both by id.
            const id = coinId(symbol);
            let fresh;
            try {
                fresh = await fetchDefiLlamaRecentDailyClose(id, 7);
            } catch {
                fresh = await fetchCoinGeckoDailyHistory(id, { days: 7 });
            }
            let changed = false;
            for (const [date, price] of Object.entries(fresh)) {
                if (data[date] == null) {
                    data[date] = price;
                    changed = true;
                }
            }
            if (changed) await writeTokenPrices(symbol, data);
        } catch (err) {
            console.error(`EOD update failed for token ${symbol}:`, err);
        }
    }

    const currencies = await listCachedCurrencies();
    for (const currency of currencies) {
        try {
            const data = await readForex(currency);
            if (!data) continue;
            const lastDate = Object.keys(data).sort().at(-1);
            if (lastDate && lastDate >= yesterday) continue;
            const from = lastDate
                ? new Date(new Date(lastDate + 'T00:00:00Z').getTime() + 86_400_000).toISOString().slice(0, 10)
                : undefined;
            if (from && from > yesterday) continue;
            const fresh = await fetchForexHistoryRange(currency, { from, to: yesterday });
            let changed = false;
            for (const [date, rate] of Object.entries(fresh)) {
                if (data[date] == null) {
                    data[date] = rate;
                    changed = true;
                }
            }
            if (changed) await writeForex(currency, data);
        } catch (err) {
            console.error(`EOD update failed for forex ${currency}:`, err);
        }
    }
}

const EOD_INTERVAL_MS = 60 * 60 * 1000;
let eodIntervalId = null;

export function startEodScheduler() {
    if (eodIntervalId) return;
    runEodUpdate().catch(err => console.error('EOD update error:', err));
    eodIntervalId = setInterval(() => {
        runEodUpdate().catch(err => console.error('EOD update error:', err));
    }, EOD_INTERVAL_MS);
    eodIntervalId.unref?.();
}

export function stopEodScheduler() {
    if (eodIntervalId) {
        clearInterval(eodIntervalId);
        eodIntervalId = null;
    }
}
