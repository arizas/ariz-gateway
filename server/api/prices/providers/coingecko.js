const SIMPLE_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price';

export async function fetchSimplePrice(ids, vsCurrencies) {
    const url = new URL(SIMPLE_PRICE_URL);
    url.searchParams.set('ids', ids.map(s => s.toLowerCase()).join(','));
    url.searchParams.set('vs_currencies', vsCurrencies.map(s => s.toLowerCase()).join(','));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    return res.json();
}

/**
 * Daily USD close history for a CoinGecko coin id via market_chart, as
 * { 'YYYY-MM-DD': price }. History source for tokens CryptoCompare doesn't list
 * (NEAR-ecosystem tokens like NPRO, stNEAR, SHITZU). The free tier caps `days`
 * at 365, so older history isn't available this way.
 */
export async function fetchDailyHistory(id, { days = 365 } = {}) {
    const url = new URL(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart`);
    url.searchParams.set('vs_currency', 'usd');
    url.searchParams.set('days', String(days));
    url.searchParams.set('interval', 'daily');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CoinGecko market_chart ${res.status} for ${id}`);
    const json = await res.json();
    if (json.error || !Array.isArray(json.prices)) {
        throw new Error(`CoinGecko market_chart for ${id}: ${JSON.stringify(json.error ?? json).slice(0, 120)}`);
    }
    const out = {};
    for (const [ms, price] of json.prices) {
        if (price > 0) out[new Date(ms).toISOString().slice(0, 10)] = price; // last point per day wins
    }
    return out;
}
