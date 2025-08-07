import { describe, test } from 'node:test';
import { equal } from 'node:assert/strict';
import { createHash } from 'crypto';
import { KeyPairEd25519 } from 'near-api-js/lib/utils/key_pair.js';

// Helper to create test tokens
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

describe('Live Proxy Tests', () => {
  const WORKER_URL = 'https://near-rpc-proxy-production.arizportfolio.workers.dev';
  
  test('should handle CORS preflight requests', async () => {
    const response = await fetch(WORKER_URL, {
      method: 'OPTIONS'
    });
    
    equal(response.status, 204, 'OPTIONS should return 204');
    equal(response.headers.get('Access-Control-Allow-Origin'), '*', 'Should have CORS origin header');
    equal(response.headers.get('Access-Control-Allow-Methods').includes('POST'), true, 'Should allow POST');
  });

  test('should reject non-POST requests', async () => {
    const response = await fetch(WORKER_URL, {
      method: 'GET'
    });
    
    equal(response.status, 405, 'GET should return 405');
    const text = await response.text();
    equal(text, 'Method not allowed', 'Should return error message');
  });

  test('should forward RPC status request', async () => {
    const response = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'test',
        method: 'status',
        params: []
      })
    });
    
    equal(response.status, 200, 'Status request should succeed');
    const result = await response.json();
    equal(result.jsonrpc, '2.0', 'Should be valid JSON-RPC response');
    equal(result.id, 'test', 'Should preserve request ID');
    equal(typeof result.result, 'object', 'Should have result object');
    equal(result.result.chain_id, 'mainnet', 'Should be mainnet');
  });

  test('should forward account query requests', async () => {
    const response = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'test',
        method: 'query',
        params: {
          request_type: 'view_account',
          finality: 'final',
          account_id: 'relay.aurora'
        }
      })
    });
    
    equal(response.status, 200, 'Account query should succeed');
    const result = await response.json();
    equal(result.jsonrpc, '2.0', 'Should be valid JSON-RPC response');
    equal(typeof result.result, 'object', 'Should have result object');
    equal(typeof result.result.amount, 'string', 'Should have account balance');
  });

  test('should handle invalid RPC methods gracefully', async () => {
    const response = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'test',
        method: 'invalid_method',
        params: []
      })
    });
    
    // RPC errors can return various status codes depending on the upstream
    equal([200, 400].includes(response.status), true, 'Should return 200 or 400 for RPC error');
    const result = await response.json();
    equal(typeof result.error, 'object', 'Should have error object');
  });
});

describe('Token Creation', () => {
  test('should create valid token format', () => {
    const keyPair = KeyPairEd25519.fromRandom();
    const accountId = 'test.near';
    const { token, tokenHash } = createToken(keyPair, accountId);
    
    equal(token.includes('.'), true, 'Token should have two parts');
    const parts = token.split('.');
    equal(parts.length, 2, 'Token should have exactly two parts');
    
    // Decode and verify payload
    const payload = JSON.parse(Buffer.from(parts[0], 'base64').toString());
    equal(payload.accountId, accountId, 'Payload should contain account ID');
    equal(payload.publicKey, keyPair.publicKey.toString(), 'Payload should contain public key');
    equal(typeof payload.iat, 'number', 'Payload should contain timestamp');
    
    // Check token hash
    equal(tokenHash.length, 32, 'Token hash should be 32 bytes (SHA-256)');
  });

  test('should create different tokens for different accounts', () => {
    const keyPair = KeyPairEd25519.fromRandom();
    const { token: token1 } = createToken(keyPair, 'user1.near');
    const { token: token2 } = createToken(keyPair, 'user2.near');
    
    equal(token1 !== token2, true, 'Tokens should be different for different accounts');
  });

  test('should create different tokens at different times', async () => {
    const keyPair = KeyPairEd25519.fromRandom();
    const { token: token1 } = createToken(keyPair, 'test.near');
    
    // Wait a bit to ensure different timestamp
    await new Promise(resolve => setTimeout(resolve, 10));
    
    const { token: token2 } = createToken(keyPair, 'test.near');
    
    equal(token1 !== token2, true, 'Tokens should be different at different times');
  });
});