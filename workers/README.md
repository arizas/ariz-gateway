# NEAR RPC Proxy Worker

This Cloudflare Worker provides a secure proxy for NEAR RPC calls, allowing you to use a paid RPC endpoint without exposing the API key (which is embedded in the URL) to the client.

## Available Versions

1. **`near-rpc-proxy.js`** - Simple proxy without authentication (current production)
2. **`near-rpc-proxy-with-auth.js`** - Enhanced proxy with NEAR-based access control (same as Node.js server)

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
# Enter your full RPC URL when prompted, e.g.: https://near.nownodes.io/your-api-key-here
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
// Instead of: https://near.nownodes.io/your-api-key-here
// Use: https://near-rpc-proxy.your-subdomain.workers.dev

const response = await fetch('https://near-rpc-proxy.your-subdomain.workers.dev', {
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

### Basic Proxy (`near-rpc-proxy.js`)
- `NEAR_RPC_URL`: The full upstream NEAR RPC endpoint URL including the API key in the path (stored as a Cloudflare secret)

### Authenticated Proxy (`near-rpc-proxy-with-auth.js`)
- `NEAR_RPC_URL`: The full upstream NEAR RPC endpoint URL including the API key
- `ENABLE_AUTH`: Set to `'true'` to enable authentication (optional, defaults to no auth)
- `CONTRACT_ID`: NEAR contract that stores access tokens (default: 'arizportfolio.near')
- `NEAR_NODE_URL`: NEAR RPC for contract verification (default: 'https://rpc.mainnet.near.org')
- `NEAR_NETWORK_ID`: Network ID (default: 'mainnet')

## Authentication Mechanism

The authenticated version implements the same access control as the Node.js server:

1. **Token Format**: Bearer token with base64-encoded payload and signature
2. **Contract Verification**: Checks if token hash exists in NEAR smart contract
3. **Token Expiry**: Tokens valid for 5 minutes
4. **Signature Validation**: ED25519 signature verification (requires base58 decoder library)

### Note on Signature Verification

The Cloudflare Worker version includes the structure for ED25519 signature verification using the Web Crypto API, but requires a base58 decoder library (like `bs58`) to fully implement it. The Node.js version uses `near-api-js` which includes this functionality.

For production use with full signature verification, you would need to:
1. Add a base58 decoder library compatible with Cloudflare Workers
2. Or use a WASM-compiled version of the verification logic
3. Or rely solely on the contract verification for security

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