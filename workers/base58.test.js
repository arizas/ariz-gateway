import { describe, test } from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { KeyPairEd25519 } from 'near-api-js/lib/utils/key_pair.js';
import { base58Decode, base58Encode } from './base58.js';

describe('Base58 Encoding/Decoding', () => {
  test('should decode NEAR public keys correctly', () => {
    const keyPair = KeyPairEd25519.fromRandom();
    const publicKeyString = keyPair.publicKey.toString();
    const [, keyData] = publicKeyString.split(':');
    
    // Decode using our implementation
    const decodedBytes = base58Decode(keyData);
    
    // Compare with near-api-js data
    const expectedBytes = keyPair.publicKey.data;
    equal(decodedBytes.length, expectedBytes.length, 'Decoded length should match');
    deepEqual(Array.from(decodedBytes), Array.from(expectedBytes), 'Decoded bytes should match near-api-js');
  });

  test('should handle empty strings', () => {
    const result = base58Decode('');
    equal(result.length, 0, 'Empty string should decode to empty array');
  });

  test('should throw on invalid characters', () => {
    let errorThrown = false;
    try {
      base58Decode('0OIl'); // Contains invalid base58 characters
    } catch (error) {
      errorThrown = true;
      equal(error.message.includes('Invalid base58 character'), true);
    }
    equal(errorThrown, true, 'Should throw on invalid characters');
  });

  test('should encode and decode round-trip correctly', () => {
    const testBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const encoded = base58Encode(testBytes);
    const decoded = base58Decode(encoded);
    deepEqual(Array.from(decoded), Array.from(testBytes), 'Round-trip should preserve data');
  });

  test('should handle leading zeros correctly', () => {
    const testBytes = new Uint8Array([0, 0, 0, 1, 2, 3]);
    const encoded = base58Encode(testBytes);
    equal(encoded.startsWith('111'), true, 'Leading zeros should encode as "1"s');
    
    const decoded = base58Decode(encoded);
    deepEqual(Array.from(decoded), Array.from(testBytes), 'Leading zeros should be preserved');
  });

  test('should decode known base58 strings correctly', () => {
    // Test with a known base58 string and its bytes
    // "Hello World" in base58
    const knownBase58 = 'JxF12TrwUP45BMd';
    const expectedText = 'Hello World';
    
    const decoded = base58Decode(knownBase58);
    const decodedText = new TextDecoder().decode(decoded);
    equal(decodedText, expectedText, 'Should decode known string correctly');
  });
});