import { createHash } from 'crypto';
import { KeyPairEd25519 } from 'near-api-js/lib/utils/key_pair.js';
import { base58Decode } from './base58.js';

// Test base58 decoding and signature verification
async function testSignatureVerification() {
  console.log('Testing Base58 Decoding and Signature Verification\n');
  
  // Create a test keypair
  const keyPair = KeyPairEd25519.fromRandom();
  const publicKeyString = keyPair.publicKey.toString();
  console.log('Public Key:', publicKeyString);
  
  // Parse the public key
  const [keyType, keyData] = publicKeyString.split(':');
  console.log('Key Type:', keyType);
  console.log('Key Data (base58):', keyData);
  
  // Test base58 decoding
  try {
    const decodedBytes = base58Decode(keyData);
    console.log('✓ Base58 decoded to', decodedBytes.length, 'bytes');
    console.log('  First 8 bytes:', Array.from(decodedBytes.slice(0, 8)));
    
    // Compare with near-api-js data
    const expectedBytes = keyPair.publicKey.data;
    const match = decodedBytes.length === expectedBytes.length &&
                  decodedBytes.every((byte, i) => byte === expectedBytes[i]);
    console.log('✓ Decoded bytes match near-api-js:', match);
  } catch (error) {
    console.error('✗ Base58 decoding failed:', error.message);
  }
  
  // Test signature creation and verification
  console.log('\nTesting Signature Verification:');
  
  const message = Buffer.from('Hello, NEAR!');
  const hash = createHash('sha256');
  hash.update(message);
  const messageHash = new Uint8Array(hash.digest());
  
  // Sign the message
  const signature = keyPair.sign(messageHash);
  console.log('✓ Created signature:', signature.signature.length, 'bytes');
  
  // Test Web Crypto API verification (if available in Node.js 20+)
  try {
    const publicKeyBytes = base58Decode(keyData);
    
    // Import the public key
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      {
        name: 'Ed25519',
        namedCurve: 'Ed25519',
      },
      false,
      ['verify']
    );
    console.log('✓ Imported public key to Web Crypto');
    
    // Verify the signature
    const isValid = await crypto.subtle.verify(
      'Ed25519',
      cryptoKey,
      signature.signature,
      messageHash
    );
    console.log('✓ Signature verification result:', isValid);
  } catch (error) {
    console.log('⚠ Web Crypto API test skipped:', error.message);
    console.log('  (Ed25519 may not be available in this Node.js version)');
  }
  
  // Test token creation
  console.log('\nTesting Token Creation:');
  
  const accountId = 'test.near';
  const token = JSON.stringify({ 
    iat: new Date().getTime(), 
    accountId, 
    publicKey: publicKeyString 
  });
  const tokenBytes = Buffer.from(token, 'utf8');
  const tokenHash = createHash('sha256');
  tokenHash.update(tokenBytes);
  const tokenHashBytes = new Uint8Array(tokenHash.digest());
  const tokenSignature = keyPair.sign(tokenHashBytes);
  
  const fullToken = `${tokenBytes.toString('base64')}.${Buffer.from(tokenSignature.signature).toString('base64')}`;
  console.log('✓ Created token (truncated):', fullToken.substring(0, 50) + '...');
  console.log('  Account:', accountId);
  console.log('  Public key in token:', publicKeyString);
}

testSignatureVerification().catch(console.error);