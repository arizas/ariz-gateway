import { test, before, after, describe } from 'node:test';
import { fetchCurrencyList, fetchPriceHistory } from './prices.js';
import { readFile } from 'fs/promises';
import { deepEqual } from 'assert';

export function mockCoinGeckoFetch() {
    process.env.ARIZ_GATEWAY_COINGECKO_API_KEY = 'COINGECKO_API_KEY';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        if (input.startsWith('https://pro-api.coingecko.com/api/v3/coins/near/market_chart') && init.headers['x-cg-pro-api-key'] === 'COINGECKO_API_KEY') {
            return {
                json: async () => {
                    return JSON.parse((await readFile(new URL('nearpricehistory.json', import.meta.url))).toString());
                }
            };
        } else if (input === 'https://pro-api.coingecko.com/api/v3/coins/near' && init.headers['x-cg-pro-api-key'] === 'COINGECKO_API_KEY') {
            return {
                json: async () => {
                    return JSON.parse((await readFile(new URL('coins.json', import.meta.url))).toString());
                }
            };
        } else {
            return originalFetch(input, init);
        }
    }
}

describe('prices', {only: false}, () => {
    before(() => {
        mockCoinGeckoFetch();
    });
    
    test('fetch currency list', {only: false},  async () => {
        const currencyList = await fetchCurrencyList();
        const referenceCurrencyList = JSON.parse((await readFile(new URL('coins.json', import.meta.url))).toString()).market_data.current_price;
        deepEqual(currencyList, referenceCurrencyList);
    });
    test('fetch eod prices', {only: false}, async() => {
        await fetchPriceHistory(undefined, 'USD', new Date('2024-06-23'));
    });
});