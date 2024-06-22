import { test, before, after, describe } from 'node:test';
import { fetchCurrencyList } from './prices.js';
import { readFile } from 'fs/promises';
import { deepEqual } from 'assert';

describe('prices', {only: true}, () => {
    before(() => {
        process.env.ARIZ_GATEWAY_COINGECKO_API_KEY = 'COINGECKO_API_KEY';
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
            console.log(init);
            if (input.startsWith('https://pro-api.coingecko.com/api/v3/coins/near') && init.headers['x-cg-pro-api-key'] === 'COINGECKO_API_KEY') {
                return {
                    json: async () => {
                        return JSON.parse((await readFile(new URL('prices.json', import.meta.url))).toString());
                    }
                };
            } else {
                return originalFetch(input, init);
            }
        }
    });
    
    test('fetch currency list', {only: true},  async () => {
        const currencyList = await fetchCurrencyList();
        const referenceCurrencyList = JSON.parse((await readFile(new URL('prices.json', import.meta.url))).toString()).market_data.current_price;
        deepEqual(currencyList, referenceCurrencyList);
    });
});