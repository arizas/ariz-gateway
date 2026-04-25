Ariz gateway
============

Gateway to APIs used by Ariz Portfolio.

- Coingecko
- Pikespeak
- NEAR RPC (via Cloudflare Workers)

# Local development setup

Before starting you need to set up the environment variables in a file named `.env`, which you should create as it is [ignored by git](./.gitignore).
This file points to server hosting port and contract id / network, but also contains your API keys, which should be kept secret.

```bash
ARIZ_GATEWAY_PORT=15000
ARIZ_GATEWAY_CONTRACT_ID=arizportfolio.testnet
ARIZ_GATEWAY_NEAR_NETWORK_ID=testnet
```

You can then start the server like this

```bash
env $(grep -v '^#' .env) yarn start
```

# NEAR RPC Proxy (Cloudflare Workers)

For high-volume NEAR RPC requests, we use a Cloudflare Worker proxy to securely handle API keys. See the [workers/README.md](./workers/README.md) for setup and deployment instructions.

This allows the near-account-report application to make RPC calls without exposing API keys on the client side.