const SIMPLE_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price';

export async function fetchSimplePrice(ids, vsCurrencies) {
    const url = new URL(SIMPLE_PRICE_URL);
    url.searchParams.set('ids', ids.map(s => s.toLowerCase()).join(','));
    url.searchParams.set('vs_currencies', vsCurrencies.map(s => s.toLowerCase()).join(','));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    return res.json();
}
