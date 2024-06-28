import { createServer } from 'node:http';
import nearApi from 'near-api-js';
import { fetchPriceHistory } from './api/prices.js';
import { parseToken, isTokenValidForAccount, isValidSignature } from './accesscontrol/tokenverify.js';

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
            const contract = new nearApi.Contract(await near.account(), contractId, {
                viewMethods: ['get_account_id_for_token']
            });

            errorMessage = 'failed to parse token';
            const {token_hash_bytes, token_payload, token_signature_bytes } = await parseToken(req.headers.authorization);
            
            errorMessage = 'failed to call access control contract';
            try {
                const account_id = await contract.get_account_id_for_token({ token_hash: Array.from(token_hash_bytes) });
                if (
                    isTokenValidForAccount(account_id, token_payload) &&
                    isValidSignature(token_payload.publicKey, token_signature_bytes, token_hash_bytes)
                ) {
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
                            res.write(`Hello ${account_id}`);
                    }
                } else {
                    res.statusCode = 401;
                    res.write(`Unauthorized`); 
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
