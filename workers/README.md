# NEAR RPC Proxy Worker

This Cloudflare Worker provides a secure proxy for NEAR RPC calls, allowing you to use a paid RPC endpoint without exposing the API key (which is embedded in the URL) to the client.

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

- `NEAR_RPC_URL`: The full upstream NEAR RPC endpoint URL including the API key in the path (stored as a Cloudflare secret)

## Cost

Cloudflare Workers pricing:
- Free tier: 100,000 requests/day
- Paid: $5/month for 10M requests included, then $0.50 per additional million requests