import { createServer } from 'node:http';
import nearApi from 'near-api-js';
import { fetchPriceHistory } from './api/prices.js';

const SERVER_PORT = process.env.ARIZ_GATEWAY_PORT;
const contractId = process.env.ARIZ_GATEWAY_CONTRACT_ID;
const networkId = process.env.ARIZ_GATEWAY_NEAR_NETWORK_ID;
const nodeUrl = process.env.ARIZ_GATEWAY_NODE_URL;

const near = await nearApi.connect({
    networkId,
    contractId,
    nodeUrl
});

const server = createServer(async (req, res) => {
    if (req.url.startsWith('/api')) {
        let errorMessage;
        try {
            errorMessage = 'failed to parse token';
            const token_bytes = Buffer.from(req.headers.authorization.substring('Bearer '.length), 'base64');
            const token_payload = JSON.parse(new TextDecoder().decode(token_bytes));
            const token_hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", token_bytes)));

            errorMessage = 'failed to connect to access control contract';
            const contract = new nearApi.Contract(await near.account(), contractId, {
                viewMethods: ['get_token_permission_for_resource']
            });

            errorMessage = 'failed to call access control contract';
            try {
                const permission = await contract.get_token_permission_for_resource({ token_hash, resource_id: token_payload.resource_id });
                if (permission !== 'none') {
                    const [url, querystring] = req.url.split('?');
                    switch (url) {
                        case '/api/prices/currencylist':
                            res.setHeader('content-type', 'application/json');
                            res.write(JSON.stringify(await fetchCurrencyList(), null, 1));
                            break;
                        case '/api/prices/history':
                            const search = new URLSearchParams(querystring);
                            res.setHeader('content-type', 'application/json');
                            res.write(JSON.stringify(await fetchPriceHistory(search.get('basetoken'), search.get('currency'), search.get('todate')), null, 1));
                            break;
                        default:
                            res.write(`Your permission to ${token_payload.resource_id} is: ${permission}`);
                    }
                } else {
                    res.statusCode = 403;
                    res.write(`Your permission to ${token_payload.resource_id} is: ${permission}`); 
                }
            } catch(e) {
                errorMessage = e.toString();
                throw(e);
            }
        } catch (e) {
            res.statusCode = 401;
            res.write(errorMessage);
        }
        res.end();

    } else {
        res.write('nothing here');
        res.end();
    }
});
await new Promise(resolve => server.listen(SERVER_PORT, () => resolve()));
console.log('server listening at port', SERVER_PORT);
