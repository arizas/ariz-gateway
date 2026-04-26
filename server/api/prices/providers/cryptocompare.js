const HISTODAY_URL = 'https://min-api.cryptocompare.com/data/v2/histoday';

async function fetchHistoday(symbol, { toTs, limit = 2000 } = {}) {
    const url = new URL(HISTODAY_URL);
    url.searchParams.set('fsym', symbol.toUpperCase());
    url.searchParams.set('tsym', 'USD');
    url.searchParams.set('limit', String(limit));
    if (toTs) url.searchParams.set('toTs', String(toTs));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CryptoCompare ${res.status} for ${symbol}`);
    const json = await res.json();
    if (json.Response === 'Error') throw new Error(`CryptoCompare error for ${symbol}: ${json.Message}`);
    return json.Data?.Data ?? [];
}

function entryDate(unixSeconds) {
    return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export async function fetchFullDailyHistory(symbol) {
    const out = {};
    let toTs;
    while (true) {
        const batch = await fetchHistoday(symbol, { toTs });
        if (batch.length === 0) break;

        let appended = 0;
        for (const { time, close } of batch) {
            if (close > 0) {
                out[entryDate(time)] = close;
                appended++;
            }
        }
        if (appended === 0) break;

        const earliest = batch[0].time;
        if (toTs && earliest >= toTs) break;
        toTs = earliest - 86400;
    }
    return out;
}

export async function fetchRecentDailyClose(symbol, limit = 1) {
    const batch = await fetchHistoday(symbol, { limit });
    const out = {};
    for (const { time, close } of batch) {
        if (close > 0) out[entryDate(time)] = close;
    }
    return out;
}
