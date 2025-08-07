import { describe, test, before, after } from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { KeyPairEd25519 } from 'near-api-js/lib/utils/key_pair.js';
import { createHash } from 'crypto';
import { unstable_dev } from 'wrangler';

// Helper to create test tokens (same as server test)
function createToken(keyPair, accountId) {
    const token = JSON.stringify({ 
        iat: new Date().getTime(), 
        accountId, 
        publicKey: keyPair.publicKey.toString() 
    });
    const tokenBytes = Buffer.from(token, 'utf8');
    const hash = createHash('sha256');
    hash.update(tokenBytes);
    const tokenHash = new Uint8Array(hash.digest());
    const signatureBytes = Buffer.from(keyPair.sign(tokenHash).signature);
    return { 
        token: `${tokenBytes.toString('base64')}.${signatureBytes.toString('base64')}`, 
        tokenHash, 
        signatureBytes, 
        publicKeyBytes: keyPair.publicKey.data 
    };
}

// Mock NEAR RPC responses
function createMockRPCResponse(method, result) {
    return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 'dontcare',
        result
    }), {
        headers: { 'Content-Type': 'application/json' }
    });
}

describe('NEAR RPC Proxy with Auth', () => {
    let worker;
    const mockContractId = 'test-contract.near';
    const mockAccountId = 'test-user.near';
    const keyPair = KeyPairEd25519.fromRandom();
    
    before(async () => {
        // Start the worker with test configuration
        worker = await unstable_dev(
            'near-rpc-proxy.js',
            {
                experimental: { disableExperimentalWarning: true },
                vars: {
                    ENABLE_AUTH: 'true',
                    CONTRACT_ID: mockContractId,
                    NEAR_NODE_URL: 'http://mock-rpc',
                    NEAR_RPC_URL: 'http://mock-upstream-rpc'
                }
            }
        );
    });

    after(async () => {
        await worker.stop();
    });

    test('should handle CORS preflight', async () => {
        const response = await worker.fetch('/', {
            method: 'OPTIONS'
        });
        
        equal(response.status, 204);
        equal(response.headers.get('Access-Control-Allow-Origin'), '*');
        equal(response.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
    });

    test('should reject non-POST requests', async () => {
        const response = await worker.fetch('/', {
            method: 'GET'
        });
        
        equal(response.status, 405);
        equal(await response.text(), 'Method not allowed');
    });

    test('should reject requests without auth header when auth is enabled', async () => {
        const response = await worker.fetch('/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'test',
                method: 'status',
                params: []
            })
        });
        
        equal(response.status, 401);
        equal(await response.text(), 'Authentication failed');
    });

    test('should reject invalid token format', async () => {
        const response = await worker.fetch('/', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': 'Bearer invalid-token'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'test',
                method: 'status',
                params: []
            })
        });
        
        equal(response.status, 401);
        equal(await response.text(), 'Authentication failed');
    });

    test('should reject expired token', async () => {
        // Create an expired token
        const expiredKeyPair = KeyPairEd25519.fromRandom();
        const expiredToken = JSON.stringify({ 
            iat: new Date().getTime() - (6 * 60 * 1000), // 6 minutes ago
            accountId: mockAccountId, 
            publicKey: expiredKeyPair.publicKey.toString() 
        });
        const tokenBytes = Buffer.from(expiredToken, 'utf8');
        const hash = createHash('sha256');
        hash.update(tokenBytes);
        const tokenHash = new Uint8Array(hash.digest());
        const signatureBytes = Buffer.from(expiredKeyPair.sign(tokenHash).signature);
        const fullToken = `${tokenBytes.toString('base64')}.${signatureBytes.toString('base64')}`;

        const response = await worker.fetch('/', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${fullToken}`
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'test',
                method: 'status',
                params: []
            })
        });
        
        equal(response.status, 401);
    });

    test('should forward RPC request when auth is disabled', async () => {
        // Create a worker with auth disabled
        const noAuthWorker = await unstable_dev(
            'near-rpc-proxy.js',
            {
                experimental: { disableExperimentalWarning: true },
                vars: {
                    ENABLE_AUTH: 'false',
                    NEAR_RPC_URL: 'https://rpc.mainnet.near.org'
                }
            }
        );

        const response = await noAuthWorker.fetch('/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'test',
                method: 'status',
                params: []
            })
        });
        
        equal(response.status, 200);
        const result = await response.json();
        equal(result.jsonrpc, '2.0');
        equal(result.id, 'test');
        
        await noAuthWorker.stop();
    });

    test('should handle proxy errors gracefully', async () => {
        // Create a worker with invalid upstream URL
        const errorWorker = await unstable_dev(
            'near-rpc-proxy.js',
            {
                experimental: { disableExperimentalWarning: true },
                vars: {
                    ENABLE_AUTH: 'false',
                    NEAR_RPC_URL: 'http://invalid-url-that-does-not-exist'
                }
            }
        );

        const response = await errorWorker.fetch('/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'test',
                method: 'status',
                params: []
            })
        });
        
        equal(response.status, 500);
        const error = await response.json();
        equal(error.error, 'Internal proxy error');
        
        await errorWorker.stop();
    });
});

// Integration test that would require a real NEAR testnet contract
describe.skip('Integration with NEAR Contract', () => {
    test('should accept valid token registered in contract', async () => {
        // This would require:
        // 1. Deploy a test contract to NEAR testnet
        // 2. Register a token in the contract
        // 3. Use that token to authenticate
        // 4. Verify the request is forwarded successfully
        
        // Example implementation would be similar to the server test
        // but using the Cloudflare Worker instead
    });
});