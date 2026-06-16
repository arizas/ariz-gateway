// Symbol/CoinGecko-id resolution shared by the spot and history price paths.

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

// Symbols that should be priced as another symbol (same/known-equivalent price).
// - wNEAR (wrapped NEAR) tracks NEAR 1:1, and NEAR has long CryptoCompare history.
// - Rainbow-bridged stablecoins (USDT.e / USDC.e) are priced as their canonical
//   tokens.
const SYMBOL_ALIASES = {
    wnear: 'near',
    'usdt.e': 'usdt',
    'usdc.e': 'usdc'
};

const SYMBOL_BY_COIN_ID = Object.fromEntries(
    Object.entries(COIN_IDS).map(([symbol, cgId]) => [cgId, symbol])
);

function normalize(token) {
    const key = String(token).toLowerCase();
    return SYMBOL_ALIASES[key] ?? key;
}

/** Resolve a token (ticker or CoinGecko id) to its CoinGecko id. */
export function coinId(token) {
    const key = normalize(token);
    return COIN_IDS[key] ?? key;
}

/** Resolve a token (ticker or CoinGecko id) to its ticker symbol. */
export function toSymbol(token) {
    const key = normalize(token);
    return SYMBOL_BY_COIN_ID[key] ?? key;
}

export { COIN_IDS };
