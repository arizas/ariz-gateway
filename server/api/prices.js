export async function fetchCurrencyList() {
    const apiKey = process.env.ARIZ_GATEWAY_COINGECKO_API_KEY;
    const result = await fetch('https://pro-api.coingecko.com/api/v3/coins/near', {
        headers: {
            "x-cg-pro-api-key": `${apiKey}`
        }
    }).then(r => r.json());
    return result.market_data.current_price;
}
