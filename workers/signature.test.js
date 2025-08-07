import { describe, test } from 'node:test';
import { equal } from 'node:assert/strict';
import { createHash } from 'crypto';
import { KeyPairEd25519 } from 'near-api-js/lib/utils/key_pair.js';
import { base58Decode } from './base58.js';

describe('Signature Verification', () => {
  test('should verify ED25519 signatures with Web Crypto API', async () => {
    const keyPair = KeyPairEd25519.fromRandom();
    const publicKeyString = keyPair.publicKey.toString();
    const [keyType, keyData] = publicKeyString.split(':');
    
    equal(keyType, 'ed25519', 'Key type should be ed25519');
    
    // Create a message and sign it
    const message = Buffer.from('Test message for signature');
    const hash = createHash('sha256');
    hash.update(message);
    const messageHash = new Uint8Array(hash.digest());
    
    const signature = keyPair.sign(messageHash);
    equal(signature.signature.length, 64, 'Signature should be 64 bytes');
    
    // Verify using Web Crypto API
    const publicKeyBytes = base58Decode(keyData);
    
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
    
    const isValid = await crypto.subtle.verify(
      'Ed25519',
      cryptoKey,
      signature.signature,
      messageHash
    );
    
    equal(isValid, true, 'Signature should be valid');
  });

  test('should reject invalid signatures', async () => {
    const keyPair = KeyPairEd25519.fromRandom();
    const publicKeyString = keyPair.publicKey.toString();
    const [, keyData] = publicKeyString.split(':');
    
    // Create a message and sign it
    const message = Buffer.from('Original message');
    const hash = createHash('sha256');
    hash.update(message);
    const messageHash = new Uint8Array(hash.digest());
    
    const signature = keyPair.sign(messageHash);
    
    // Try to verify with a different message
    const wrongMessage = Buffer.from('Different message');
    const wrongHash = createHash('sha256');
    wrongHash.update(wrongMessage);
    const wrongMessageHash = new Uint8Array(wrongHash.digest());
    
    const publicKeyBytes = base58Decode(keyData);
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
    
    const isValid = await crypto.subtle.verify(
      'Ed25519',
      cryptoKey,
      signature.signature,
      wrongMessageHash
    );
    
    equal(isValid, false, 'Signature should be invalid for wrong message');
  });

  test('should reject signatures from different keys', async () => {
    const keyPair1 = KeyPairEd25519.fromRandom();
    const keyPair2 = KeyPairEd25519.fromRandom();
    
    const [, keyData2] = keyPair2.publicKey.toString().split(':');
    
    // Sign with keyPair1
    const message = Buffer.from('Test message');
    const hash = createHash('sha256');
    hash.update(message);
    const messageHash = new Uint8Array(hash.digest());
    
    const signature = keyPair1.sign(messageHash);
    
    // Try to verify with keyPair2's public key
    const publicKeyBytes = base58Decode(keyData2);
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
    
    const isValid = await crypto.subtle.verify(
      'Ed25519',
      cryptoKey,
      signature.signature,
      messageHash
    );
    
    equal(isValid, false, 'Signature should be invalid for different key');
  });
});