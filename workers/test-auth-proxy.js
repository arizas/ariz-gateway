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

async function testAuthProxy() {
    const WORKER_URL = 'https://near-rpc-proxy-production.arizportfolio.workers.dev';
    
    console.log('Testing NEAR RPC Proxy with Authentication\n');
    
    // Test 1: CORS preflight
    console.log('Test 1: CORS preflight request');
    try {
        const response = await fetch(WORKER_URL, {
            method: 'OPTIONS'
        });
        console.log(`✓ Status: ${response.status}`);
        console.log(`✓ CORS headers present: ${response.headers.get('Access-Control-Allow-Origin') === '*'}`);
    } catch (error) {
        console.error('✗ Failed:', error.message);
    }
    
    // Test 2: Simple RPC request (no auth required in current deployment)
    console.log('\nTest 2: Simple RPC status request');
    try {
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
        const result = await response.json();
        console.log(`✓ Status: ${response.status}`);
        console.log(`✓ Chain ID: ${result.result?.chain_id}`);
        console.log(`✓ Latest block height: ${result.result?.sync_info?.latest_block_height}`);
    } catch (error) {
        console.error('✗ Failed:', error.message);
    }
    
    // Test 3: Account query
    console.log('\nTest 3: Account query');
    try {
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
        const result = await response.json();
        console.log(`✓ Status: ${response.status}`);
        console.log(`✓ Account exists: ${!!result.result}`);
        if (result.result) {
            console.log(`✓ Account balance: ${(BigInt(result.result.amount) / BigInt(1e24)).toString()} NEAR`);
        }
    } catch (error) {
        console.error('✗ Failed:', error.message);
    }
    
    // Test 4: Invalid method (should still work as it's forwarded)
    console.log('\nTest 4: Non-POST request (should fail)');
    try {
        const response = await fetch(WORKER_URL, {
            method: 'GET'
        });
        console.log(`✓ Status: ${response.status} (expected 405)`);
        console.log(`✓ Error: ${await response.text()}`);
    } catch (error) {
        console.error('✗ Failed:', error.message);
    }
    
    // Test 5: Create a test token (for demonstration)
    console.log('\nTest 5: Token creation example');
    try {
        const keyPair = KeyPairEd25519.fromRandom();
        const accountId = 'test.near';
        const { token, tokenHash } = createToken(keyPair, accountId);
        
        console.log('✓ Created test token:');
        console.log(`  Account: ${accountId}`);
        console.log(`  Public Key: ${keyPair.publicKey.toString()}`);
        console.log(`  Token (truncated): ${token.substring(0, 50)}...`);
        console.log(`  Token Hash: ${Buffer.from(tokenHash).toString('hex').substring(0, 16)}...`);
        
        console.log('\nNote: This token would need to be registered in the NEAR contract');
        console.log('before it could be used for authenticated requests.');
    } catch (error) {
        console.error('✗ Failed:', error.message);
    }
}

// Run the tests
testAuthProxy().catch(console.error);