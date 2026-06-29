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
            .filter(f => f.endsWith('.json'))
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
