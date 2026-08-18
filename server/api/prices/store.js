import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

function dataDir() {
    return process.env.ARIZ_DATA_DIR ?? './data';
}

function pricesDir() {
    return join(dataDir(), 'prices');
}

function forexDir() {
    return join(dataDir(), 'forex');
}

async function readJson(path) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

async function writeJsonAtomic(path, dir, data) {
    await mkdir(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, path);
}

// Token symbols are not safe to use directly as file names: scam tokens can embed
// a whole URL or sentence in their symbol (e.g. "Claim Near Airdrop at
// https://..."), and the "/" then makes join() treat it as a path into a
// non-existent directory, so the write throws ENOENT and crashes the process.
// encodeURIComponent strips path separators while leaving normal symbols
// (near, usd-coin) unchanged, so it's safe and backward-compatible with existing
// cache files. Pair it with decodeKey on the way out so listed names round-trip.
function fileKey(name) {
    return encodeURIComponent(name.toLowerCase());
}

function decodeKey(name) {
    try {
        return decodeURIComponent(name);
    } catch {
        return name;
    }
}

async function listJsonFiles(dir) {
    try {
        return (await readdir(dir))
            .filter(f => f.endsWith('.json') && !f.startsWith('.'))
            .map(f => decodeKey(f.slice(0, -'.json'.length)));
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}

export async function readTokenPrices(symbol) {
    return readJson(join(pricesDir(), `${fileKey(symbol)}.json`));
}

export async function writeTokenPrices(symbol, data) {
    const dir = pricesDir();
    await writeJsonAtomic(join(dir, `${fileKey(symbol)}.json`), dir, data);
}

export async function readForex(currency) {
    return readJson(join(forexDir(), `${currency.toLowerCase()}.json`));
}

export async function writeForex(currency, data) {
    const dir = forexDir();
    await writeJsonAtomic(join(dir, `${currency.toLowerCase()}.json`), dir, data);
}

export async function listCachedTokens() {
    return listJsonFiles(pricesDir());
}

export async function listCachedCurrencies() {
    return listJsonFiles(forexDir());
}

// Which tokens have had their full history pulled from the provider. Kept beside
// the price files rather than inside them: every consumer iterates a price map as
// { date: price }, so a marker key in there would have to be filtered in each of
// them, and the one that got missed would silently corrupt a series.
//
// The point of this file is that the gateway is the archive. A token's deep
// history is fetched once, ever; after that the store is authoritative and the
// hourly update only advances it. Without it, loadTokenPrices returns whatever
// is cached the moment it is non-empty, so a series that was seeded shallow
// stays shallow for good.
function metaPath() {
    return join(pricesDir(), '.history-meta.json');
}

export async function readPriceMeta() {
    return (await readJson(metaPath())) ?? {};
}

// Serialised: entries for different tokens land in one file, and a plain
// read-modify-write would drop whichever concurrent update lost the race.
let metaQueue = Promise.resolve();
export function markFullHistoryFetched(symbol, at = new Date().toISOString().slice(0, 10)) {
    metaQueue = metaQueue.then(async () => {
        const meta = await readPriceMeta();
        meta[fileKey(symbol)] = { fullHistoryAt: at };
        const dir = pricesDir();
        await writeJsonAtomic(metaPath(), dir, meta);
    }).catch(err => {
        console.error('failed to record full-history marker', err);
    });
    return metaQueue;
}

export async function hasFullHistory(symbol) {
    const meta = await readPriceMeta();
    return !!meta[fileKey(symbol)]?.fullHistoryAt;
}
