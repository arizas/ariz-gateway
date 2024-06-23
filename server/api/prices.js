export async function fetchCurrencyList() {
    const apiKey = process.env.ARIZ_GATEWAY_COINGECKO_API_KEY;
    const result = await fetch('https://pro-api.coingecko.com/api/v3/coins/near', {
        headers: {
            "x-cg-pro-api-key": `${apiKey}`
        }
    }).then(r => r.json());
    return result.market_data.current_price;
}

export async function fetchPriceHistory(baseToken = "NEAR", currency, todate = new Date().getTime().toJSON()) {
    const apiKey = process.env.ARIZ_GATEWAY_COINGECKO_API_KEY;
    const url = `https://pro-api.coingecko.com/api/v3/coins/${baseToken.toLowerCase()}/market_chart/range?vs_currency=${currency}&from=0&to=${Math.floor(new Date(todate).getTime() / 1000)}`;

    const pricesresponse = (await fetch(url, {
        headers: {
            "x-cg-pro-api-key": `${apiKey}`
        }
    }).then(r => r.json()));

    const pricesMap = {};

    pricesresponse.prices.forEach(priceEntry => {
        const datestring = new Date(priceEntry[0]).toJSON().substring(0, 'yyyy-MM-dd'.length);
        const price = priceEntry[1];
        pricesMap[datestring] = price;
    });

    return pricesMap;
}