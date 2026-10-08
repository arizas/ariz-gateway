// Tokens priced by their own contract, not by a ticker.
//
// A liquid-staking token is worth what it redeems for: the contract says how
// much NEAR one token is, and that rate only drifts upward as rewards accrue.
// Pricing such a token by its ticker is a trap — lst-pool.near calls itself
// "stNEAR", exactly like Meta Pool's token, and CoinGecko's "staked-near" is
// Meta Pool's. On one real account that valued 982 tokens bought at 1.02 NEAR
// each as if they were worth 1.49, some 23 700 NOK out of thin air.
//
// So these are keyed by contract id, and the price of a day is the base
// token's price that day times the rate read from the contract at the last
// block of that day: one archival view call per token per day, cached for good.

import { readBlockOfDay, readRates, writeBlockOfDay, writeRates } from './store.js';

/**
 * contract id -> how to read its rate. `since` is the first day worth asking
 * for; `parse` turns the view result into NEAR per token.
 */
export const RATE_TOKENS = {
    'lst-pool.near': {
        base: 'near',
        method: 'get_exchange_rate',
        since: '2026-09-01',
        parse: v => Number(BigInt(v.numerator) * 10n ** 12n / BigInt(v.denominator)) / 1e12,
    },
};

export function isRateToken(token) {
    return Object.prototype.hasOwnProperty.call(RATE_TOKENS, String(token).toLowerCase());
}

export function rateTokenIds() {
    return Object.keys(RATE_TOKENS);
}

function rpcEndpoint() {
    return process.env.PRICE_RPC_ENDPOINT ?? 'https://archival-rpc.mainnet.fastnear.com';
}

async function rpc(method, params) {
    const headers = { 'content-type': 'application/json' };
    if (process.env.FASTNEAR_API_KEY) headers['Authorization'] = `Bearer ${process.env.FASTNEAR_API_KEY}`;
    const res = await fetch(rpcEndpoint(), { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 'dontcare', method, params }) });
    if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) {
        // The node answered and said no: the contract did not exist at that
        // block, or has no such method. Asking again will not change it.
        const err = new Error(`rpc ${method}: ${JSON.stringify(json.error).slice(0, 200)}`);
        err.permanent = true;
        throw err;
    }
    return json.result;
}

async function blockHeader(ref) {
    const r = await rpc('block', ref);
    return { height: r.header.height, ts: BigInt(r.header.timestamp) };
}

/** Rate of one token in the base, at a block (or at the chain head when blockId is 'final'). */
export async function readRate(contract, blockId = 'final') {
    const spec = RATE_TOKENS[contract];
    const args = Buffer.from('{}').toString('base64');
    const params = { request_type: 'call_function', account_id: contract, method_name: spec.method, args_base64: args };
    if (blockId === 'final') params.finality = 'final'; else params.block_id = blockId;
    const r = await rpc('query', params);
    const raw = JSON.parse(Buffer.from(r.result).toString());
    return spec.parse(raw);
}

const NS_PER_S = 1_000_000_000n;

/**
 * The last block of a UTC day. Estimated from the chain head and corrected
 * against real block timestamps until it lands within a few minutes before
 * midnight — the rate moves by parts per million in that time. Remembered per
 * day, so every token priced this way shares the lookup.
 */
export async function blockAtEndOfDay(date) {
    const known = await readBlockOfDay(date);
    if (known != null) return known;

    const target = BigInt(Date.parse(`${date}T23:59:59.999Z`)) * 1_000_000n;
    const head = await blockHeader({ finality: 'final' });
    if (head.ts <= target) return null; // the day is not over

    let avgNs = 1_100_000_000n; // a NEAR block is a little over a second
    let h = head.height - Number((head.ts - target) / avgNs);
    let b = null;
    for (let i = 0; i < 8; i++) {
        b = null;
        for (let miss = 0; miss < 6 && !b; miss++) {
            try { b = await blockHeader({ block_id: h - miss }); } catch { /* skipped height */ }
        }
        if (!b) throw new Error(`no block around height ${h}`);
        const behind = target - b.ts;
        if (behind >= 0n && behind < 300n * NS_PER_S) break;
        const span = head.ts - b.ts;
        const blocks = BigInt(head.height - b.height);
        if (blocks > 0n && span > 0n) avgNs = span / blocks;
        h = b.height + Number(behind / avgNs) - (behind < 0n ? 1 : 0);
    }
    if (b.ts > target) {
        // Overshot after the last correction: walk back to the day.
        while (b.ts > target) b = await blockHeader({ block_id: b.height - Number((b.ts - target) / avgNs) - 1 });
    }
    await writeBlockOfDay(date, b.height);
    return b.height;
}

function daysBetween(from, to) {
    const out = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
        out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
}

const rateLoads = new Map();

/**
 * The contract's rate per day, from `since` up to `todate` (yesterday when
 * omitted), each day read once and kept. A day the contract answers with an
 * error — before it existed — is kept as null, so it is never asked again; a
 * day the network failed on is left out and asked again next time. The price
 * lookup carries the previous day's rate forward over either.
 */
export async function loadRateHistory(contract, todate) {
    const key = `${contract}|${todate ?? ''}`;
    let p = rateLoads.get(key);
    if (p) return p;
    p = (async () => {
        const spec = RATE_TOKENS[contract];
        const rates = (await readRates(contract)) ?? {};
        const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
        const to = todate && todate < yesterday ? todate : yesterday;
        let changed = false;
        for (const date of daysBetween(spec.since, to)) {
            if (Object.prototype.hasOwnProperty.call(rates, date)) continue; // read before, with or without an answer
            try {
                const block = await blockAtEndOfDay(date);
                if (block == null) continue;
                rates[date] = await readRate(contract, block);
                changed = true;
            } catch (err) {
                if (err.permanent) {
                    rates[date] = null;
                    changed = true;
                } else {
                    console.error(`rate for ${contract} on ${date} not read:`, err.message);
                }
            }
        }
        if (changed) await writeRates(contract, rates);
        return rates;
    })().finally(() => rateLoads.delete(key));
    rateLoads.set(key, p);
    return p;
}
