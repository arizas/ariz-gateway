import { readForex, readTokenPrices, writeForex, writeTokenPrices, hasFullHistory, markFullHistoryFetched } from './store.js';
import { fetchFullDailyHistory as fetchDefiLlamaFullDailyHistory } from './providers/defillama.js';
import { fetchDailyHistory as fetchCoinGeckoDailyHistory } from './providers/coingecko.js';
import { fetchHistoryRange as fetchForexHistoryRange } from './providers/frankfurter.js';
import { coinId } from './token-map.js';

const tokenLoads = new Map();
const forexLoads = new Map();

function once(map, key, fn) {
    let p = map.get(key);
    if (!p) {
        p = fn().finally(() => map.delete(key));
        map.set(key, p);
    }
    return p;
}

async function loadTokenPrices(symbol) {
    const key = symbol.toLowerCase();
    return once(tokenLoads, key, async () => {
        const cached = await readTokenPrices(key);
        if (cached && Object.keys(cached).length > 0) {
            // A non-empty cache used to be trusted outright, which meant a series
            // seeded shallow stayed shallow for good — the gateway would keep
            // answering with a handful of days for a token the provider has years
            // of. Backfill once, then never again: the marker is what stops this
            // becoming a repeated fetch for tokens that are genuinely young.
            if (await hasFullHistory(key)) return cached;
            const deep = await fetchDeepHistory(key);
            // Cached entries win. They came from the same providers earlier, and
            // keeping them makes the backfill idempotent.
            const merged = { ...deep, ...cached };
            if (Object.keys(merged).length > Object.keys(cached).length) {
                await writeTokenPrices(key, merged);
            }
            await markFullHistoryFetched(key);
            return merged;
        }

        // DeFiLlama (no API key, multi-year history via pagination) is the primary
        // source; CoinGecko market_chart (365 days) is the fallback for anything it
        // doesn't have. Both are addressed by CoinGecko id. If neither has it, cache
        // empty (no price) rather than erroring the whole report.
        const fresh = await fetchDeepHistory(key);
        await writeTokenPrices(key, fresh);
        // Marked even when empty: an unlisted token has no history to find, and
        // retrying it on every load is what rate-limits the providers.
        await markFullHistoryFetched(key);
        return fresh;
    });
}

// DeFiLlama (no API key, multi-year history via pagination) is the primary
// source; CoinGecko market_chart (365 days) is the fallback for anything it
// doesn't have. Both are addressed by CoinGecko id. If neither has it, the
// result is empty (no price) rather than an error that fails the whole report.
async function fetchDeepHistory(key) {
    const id = coinId(key);
    let fresh = {};
    try {
        fresh = await fetchDefiLlamaFullDailyHistory(id);
    } catch {
        fresh = {};
    }
    if (Object.keys(fresh).length === 0) {
        try {
            fresh = await fetchCoinGeckoDailyHistory(id);
        } catch {
            fresh = {};
        }
    }
    return fresh;
}

async function loadForex(currency) {
    const key = currency.toLowerCase();
    return once(forexLoads, key, async () => {
        const cached = await readForex(key);
        if (cached && Object.keys(cached).length > 0) return cached;
        const fresh = await fetchForexHistoryRange(key);
        await writeForex(key, fresh);
        return fresh;
    });
}

function carryForwardLookup(map, sortedDates, target) {
    if (map[target] != null) return map[target];
    let lo = 0;
    let hi = sortedDates.length - 1;
    let best = null;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sortedDates[mid] <= target) {
            best = sortedDates[mid];
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return best != null ? map[best] : null;
}

export async function getDailyPrice(token, currency, date) {
    const usd = await loadTokenPrices(token);
    const usdSorted = Object.keys(usd).sort();
    const tokenUsd = carryForwardLookup(usd, usdSorted, date);
    if (tokenUsd == null) return null;
    if (currency.toUpperCase() === 'USD') return tokenUsd;

    const forex = await loadForex(currency);
    const forexSorted = Object.keys(forex).sort();
    const rate = carryForwardLookup(forex, forexSorted, date);
    return rate != null ? tokenUsd * rate : null;
}

export async function getPriceHistory(token, currency, todate) {
    const usd = await loadTokenPrices(token);
    const todateStr = todate ? new Date(todate).toISOString().slice(0, 10) : null;
    const upper = currency.toUpperCase();

    if (upper === 'USD') {
        const out = {};
        for (const date of Object.keys(usd)) {
            if (!todateStr || date <= todateStr) out[date] = usd[date];
        }
        return out;
    }

    const forex = await loadForex(currency);
    const forexSorted = Object.keys(forex).sort();
    const out = {};
    let cursor = 0;
    let lastRate = null;
    for (const date of Object.keys(usd).sort()) {
        if (todateStr && date > todateStr) break;
        while (cursor < forexSorted.length && forexSorted[cursor] <= date) {
            lastRate = forex[forexSorted[cursor]];
            cursor++;
        }
        if (lastRate != null) out[date] = usd[date] * lastRate;
    }
    return out;
}
