// DeFiLlama coins API (https://coins.llama.fi) — free, no API key required.
// Primary source of daily USD price history. Coins are addressed as
// `coingecko:<id>`, so it plugs straight into the CoinGecko-id resolution the rest
// of the price code already uses, and it covers NEAR-ecosystem tokens.

const CHART_URL = 'https://coins.llama.fi/chart';
// DeFiLlama caps a chart request at 500 data points (coins × timestamps).
const MAX_SPAN = 500;

// One chart request: `span` daily points starting at `start` (unix seconds).
// Returns { 'YYYY-MM-DD': price } (USD), dropping non-positive/low-confidence points.
async function fetchChart(coinGeckoId, start, span) {
    const key = `coingecko:${coinGeckoId}`;
    // Keep the `coingecko:` colon literal (DeFiLlama's coin-key separator); only the
    // id itself needs escaping.
    const url = new URL(`${CHART_URL}/coingecko:${encodeURIComponent(coinGeckoId)}`);
    url.searchParams.set('start', String(start));
    url.searchParams.set('span', String(span));
    url.searchParams.set('period', '1d');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`DeFiLlama chart ${res.status} for ${coinGeckoId}`);
    const json = await res.json();
    const coin = json?.coins?.[key];
    if (!coin || !Array.isArray(coin.prices)) return {};
    const out = {};
    for (const { timestamp, price } of coin.prices) {
        if (price > 0) out[new Date(timestamp * 1000).toISOString().slice(0, 10)] = price;
    }
    return out;
}

/**
 * Full daily USD close history for a CoinGecko coin id, as { 'YYYY-MM-DD': price }.
 * Pages backward in <=500-point windows so tokens with multi-year history are fully
 * covered (CoinGecko's free tier caps at 365 days). Stops once a window adds nothing
 * new (reached the token's inception).
 */
export async function fetchFullDailyHistory(coinGeckoId) {
    const out = {};
    let end = Math.floor(Date.now() / 1000);
    for (let window = 0; window < 12; window++) {
        const start = end - MAX_SPAN * 86400;
        const batch = await fetchChart(coinGeckoId, start, MAX_SPAN);
        const dates = Object.keys(batch).sort();
        if (dates.length === 0) break;
        let added = 0;
        for (const d of dates) {
            if (out[d] == null) { out[d] = batch[d]; added++; }
        }
        if (added === 0) break;
        end = Math.floor(new Date(`${dates[0]}T00:00:00Z`).getTime() / 1000) - 86400;
    }
    return out;
}

/**
 * Recent daily USD closes (last `days`), as { 'YYYY-MM-DD': price }. One request.
 */
export async function fetchRecentDailyClose(coinGeckoId, days = 7) {
    const span = Math.min(days, MAX_SPAN);
    const start = Math.floor(Date.now() / 1000) - span * 86400;
    return fetchChart(coinGeckoId, start, span);
}
