const BASE = 'https://api.frankfurter.dev/v1';
const EARLIEST_DATE = '1999-01-04';

export async function fetchHistoryRange(currency, { from = EARLIEST_DATE, to } = {}) {
    const range = to ? `${from}..${to}` : `${from}..`;
    const url = `${BASE}/${range}?from=USD&to=${currency.toUpperCase()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Frankfurter ${res.status} for ${currency}`);
    const json = await res.json();
    const code = currency.toUpperCase();
    const out = {};
    for (const [date, rates] of Object.entries(json.rates ?? {})) {
        const rate = rates?.[code];
        if (rate != null) out[date] = rate;
    }
    return out;
}
