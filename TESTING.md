# Testing Guide

This project has tests organized into two main areas:

## Server Tests

Located in `server/` directory. These test the Node.js gateway server functionality.

### Running Server Tests

```bash
# Run unit tests only (fast)
npm test

# Run integration tests (requires NEAR sandbox)
npm run test:integration

# Run all server tests
npm test && npm run test:integration
```

### Test Files
- `server/accesscontrol/tokenverify.test.js` - Token verification and signature tests
- `server/api/prices.test.js` - Price API tests  
- `server/index.test.js` - Integration tests (requires NEAR sandbox setup)

## Worker Tests

Located in `workers/` directory. These test the Cloudflare Worker functionality.

### Running Worker Tests

```bash
# From root directory
npm run test:workers

# Or from workers directory
cd workers && npm test
```

### Test Files
- `workers/base58.test.js` - Base58 encoding/decoding tests
- `workers/signature.test.js` - ED25519 signature verification tests
- `workers/auth-proxy.test.js` - Live proxy integration tests
- `workers/near-rpc-proxy.test.js` - Worker unit tests with auth

## Running All Tests

To run all tests across the entire project:

```bash
npm run test:all
```

This will run:
1. Server unit tests
2. Worker tests

Note: Integration tests are excluded from `test:all` as they require special setup.

## Test Dependencies

- Server tests require `near-workspaces` for integration testing
- Worker tests require `wrangler` for local worker simulation
- Both use Node.js built-in test runner (`node --test`)

## CI/CD Integration

For CI/CD pipelines, use:

```bash
# Quick tests (unit tests only)
npm test && npm run test:workers

# Full test suite (if NEAR sandbox is available)
npm run test:all && npm run test:integration
```