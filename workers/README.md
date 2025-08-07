# NEAR RPC Proxy Worker

This Cloudflare Worker provides a secure proxy for NEAR RPC calls, allowing you to use a paid RPC endpoint without exposing the API key (which is embedded in the URL) to the client.

The proxy includes optional NEAR-based authentication that matches the access control mechanism used in the Node.js server.

## Setup

1. Install dependencies:
```bash
cd workers
npm install
```

2. Configure your Cloudflare account:
```bash
npx wrangler login
```

3. Set your NEAR RPC URL (with API key) as a secret:
```bash
npm run secret:set-rpc-url
# Enter your full RPC URL when prompted, e.g.: https://near.lava.build/your-api-key-here
```

4. (Optional) Enable authentication:
```bash
npm run secret:enable-auth
# Enter 'true' to enable authentication
```

## Development

Run the worker locally:
```bash
npm run dev
```

This will start a local server (usually at http://localhost:8787) that proxies requests to the NEAR RPC endpoint.

## Deployment

Deploy to Cloudflare Workers:
```bash
npm run deploy:production
```

## Usage

Once deployed, your client applications can make RPC calls to your worker URL instead of directly to the NEAR RPC endpoint:

```javascript
// Instead of: https://near.lava.build/your-api-key-here
// Use: https://near-rpc-proxy-production.arizportfolio.workers.dev

const response = await fetch('https://near-rpc-proxy-production.arizportfolio.workers.dev', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 'dontcare',
    method: 'query',
    params: {
      request_type: 'view_account',
      finality: 'final',
      account_id: 'example.near'
    }
  })
});
```

## Environment Variables

- `NEAR_RPC_URL`: The full upstream NEAR RPC endpoint URL including the API key (stored as a Cloudflare secret)
- `ENABLE_AUTH`: Set to `'true'` to enable authentication (default: `'false'`)
- `CONTRACT_ID`: NEAR contract that stores access tokens (default: 'arizportfolio.near')
- `NEAR_NODE_URL`: NEAR RPC for contract verification (default: 'https://rpc.mainnet.near.org')
- `NEAR_NETWORK_ID`: Network ID (default: 'mainnet')

## Authentication Mechanism (Optional)

When authentication is enabled (`ENABLE_AUTH='true'`), the proxy implements the same access control as the Node.js server:

1. **Token Format**: Bearer token with base64-encoded payload and signature
2. **Contract Verification**: Checks if token hash exists in NEAR smart contract
3. **Token Expiry**: Tokens valid for 5 minutes
4. **Signature Validation**: Full ED25519 signature verification using Web Crypto API

### Token Payload Structure
```json
{
  "accountId": "user.near",
  "publicKey": "ed25519:...",
  "iat": 1234567890000
}
```

## Cost

Cloudflare Workers pricing:
- Free tier: 100,000 requests/day
- Paid: $5/month for 10M requests included, then $0.50 per additional million requests