import { readForex, readTokenPrices, writeForex, writeTokenPrices } from './store.js';
import { fetchFullDailyHistory } from './providers/cryptocompare.js';
import { fetchHistoryRange as fetchForexHistoryRange } from './providers/frankfurter.js';

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
        if (cached && Object.keys(cached).length > 0) return cached;
        const fresh = await fetchFullDailyHistory(key);
        await writeTokenPrices(key, fresh);
        return fresh;
    });
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
