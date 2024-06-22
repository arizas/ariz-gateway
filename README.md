Ariz gateway
============

Gateway to APIs used by Ariz Portfolio.

- Coingecko
- Pikespeak

# Local development setup

Before starting you need to set up the environment variables in a file named `.env`, which you should create as it is [ignored by git](./.gitignore).
This file points to server hosting port and contract id / network, but also contains your API keys, which should be kept secret.

```bash
ARIZ_GATEWAY_PORT=15000
ARIZ_GATEWAY_CONTRACT_ID=arizportfolio.testnet
ARIZ_GATEWAY_NEAR_NETWORK_ID=testnet
```
