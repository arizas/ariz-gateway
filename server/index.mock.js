import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'ariz-gateway-mock-'));
process.env.ARIZ_DATA_DIR = dataDir;
process.env.ARIZ_GATEWAY_DISABLE_ACCOUNTING_WORKER = 'true';
console.log(`ARIZ_DATA_DIR=${dataDir}`);

await mkdir(join(dataDir, 'prices'), { recursive: true });

const history = JSON.parse(
    readFileSync(new URL('./api/nearpricehistory.json', import.meta.url), 'utf8')
);
const nearPrices = {};
for (const [ts, price] of history.prices) {
    nearPrices[new Date(ts).toISOString().slice(0, 10)] = price;
}
await writeFile(join(dataDir, 'prices', 'near.json'), JSON.stringify(nearPrices));

const PROVIDER_HOSTS = ['min-api.cryptocompare.com', 'api.coingecko.com', 'api.frankfurter.dev'];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (PROVIDER_HOSTS.some(host => url.includes(host))) {
        throw new Error(`unexpected upstream call in test mock: ${url}`);
    }
    return originalFetch(input, init);
};

await import('./index.js');
