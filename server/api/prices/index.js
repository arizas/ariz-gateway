import { fetchSimplePrice } from './providers/coingecko.js';
import { fetchRecentDailyClose } from './providers/cryptocompare.js';
import { fetchHistoryRange as fetchForexHistoryRange } from './providers/frankfurter.js';
import { getPriceHistory } from './getDailyPrice.js';
import {
    listCachedCurrencies,
    listCachedTokens,
    readForex,
    readTokenPrices,
    writeForex,
    writeTokenPrices
} from './store.js';

const COIN_IDS = {
    '$wif': 'dogwifcoin',
    aave: 'aave',
    abg: 'ab-group',
    ada: 'cardano',
    adi: 'adi-token',
    aleo: 'aleo',
    apt: 'aptos',
    arb: 'arbitrum',
    aster: 'aster-2',
    aurora: 'aurora-near',
    avax: 'avalanche-2',
    bch: 'bitcoin-cash',
    bera: 'berachain-bera',
    blackdragon: 'black-dragon',
    bnb: 'binancecoin',
    bome: 'book-of-meme',
    brett: 'based-brett',
    btc: 'bitcoin',
    cbbtc: 'coinbase-wrapped-btc',
    cfi: 'consumerfi-protocol',
    cow: 'cow-protocol',
    dai: 'dai',
    dash: 'dash',
    doge: 'dogecoin',
    eth: 'ethereum',
    eure: 'monerium-eur-money-2',
    evaa: 'evaa-protocol',
    frax: 'frax',
    gbpe: 'monerium-gbp-emoney',
    gmx: 'gmx',
    gno: 'gnosis',
    hapi: 'hapi',
    itlx: 'intellex',
    jambo: 'jambo-2',
    kaito: 'kaito',
    knc: 'kyber-network-crystal',
    link: 'chainlink',
    loud: 'loud',
    ltc: 'litecoin',
    melania: 'melania-meme',
    mog: 'mog-coin',
    mon: 'monad',
    mpdao: 'meta-pool',
    near: 'near',
    npro: 'npro',
    okb: 'okb',
    op: 'optimism',
    pengu: 'pudgy-penguins',
    pepe: 'pepe',
    pol: 'matic-network',
    public: 'publicai',
    rhea: 'rhea-2',
    safe: 'safe',
    shib: 'shiba-inu',
    shitzu: 'shitzu',
    sol: 'solana',
    spx: 'spx6900',
    stnear: 'staked-near',
    strk: 'starknet',
    sui: 'sui',
    sweat: 'sweatcoin',
    titn: 'thor-wallet',
    ton: 'the-open-network',
    trump: 'official-trump',
    trx: 'tron',
    turbo: 'turbo',
    uni: 'uniswap',
    usad: 'usad',
    usd1: 'usd1-wlfi',
    usdc: 'usd-coin',
    usdcx: 'usdcx',
    usdf: 'falcon-finance',
    usdt: 'tether',
    usdt0: 'usdt0',
    wbtc: 'wrapped-bitcoin',
    weth: 'weth',
    wnear: 'wrapped-near',
    xaut: 'tether-gold',
    xbtc: 'xbtc-2',
    xdai: 'xdai',
    xlm: 'stellar',
    xpl: 'plasma',
    xrp: 'ripple',
    zec: 'zcash'
};

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

function coinId(token) {
    const key = token.toLowerCase();
    return COIN_IDS[key] ?? key;
}

async function spotCached(key, fetcher) {
    const entry = spotCache.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    const value = await fetcher();
    spotCache.set(key, { value, expiresAt: Date.now() + SPOT_TTL_MS });
    return value;
}

export async function fetchCurrencyList(token = 'NEAR') {
    return spotCached(`currencylist:${token.toLowerCase()}`, async () => {
        const id = coinId(token);
        const data = await fetchSimplePrice([id], CURRENCYLIST_VS);
        return data[id] ?? {};
    });
}

export async function fetchPriceHistory(baseToken = 'NEAR', currency = 'USD', todate) {
    return getPriceHistory(baseToken, currency, todate);
}

export async function fetchCurrent(tokens, vsCurrencies) {
    if (!tokens || tokens.length === 0) return {};
    const vs = vsCurrencies && vsCurrencies.length > 0 ? vsCurrencies : ['usd'];
    const ids = tokens.map(coinId);
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
            const lastDate = Object.keys(data).sort().at(-1);
            if (lastDate && lastDate >= yesterday) continue;
            const fresh = await fetchRecentDailyClose(symbol, 7);
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
