// Base58 alphabet used by Bitcoin and NEAR
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE = ALPHABET.length;

// Create a lookup table for faster decoding
const ALPHABET_MAP = {};
for (let i = 0; i < ALPHABET.length; i++) {
  ALPHABET_MAP[ALPHABET[i]] = i;
}

/**
 * Decode a base58 string to a Uint8Array
 * @param {string} string - Base58 encoded string
 * @returns {Uint8Array} - Decoded bytes
 */
export function base58Decode(string) {
  if (string.length === 0) return new Uint8Array(0);
  
  const bytes = [0];
  for (let i = 0; i < string.length; i++) {
    const value = ALPHABET_MAP[string[i]];
    if (value === undefined) {
      throw new Error(`Invalid base58 character: ${string[i]}`);
    }
    
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * BASE;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  
  // Handle leading zeros
  for (let i = 0; string[i] === '1' && i < string.length - 1; i++) {
    bytes.push(0);
  }
  
  return new Uint8Array(bytes.reverse());
}

/**
 * Encode a Uint8Array to a base58 string
 * @param {Uint8Array} bytes - Bytes to encode
 * @returns {string} - Base58 encoded string
 */
export function base58Encode(bytes) {
  if (bytes.length === 0) return '';
  
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % BASE;
      carry = Math.floor(carry / BASE);
    }
    
    while (carry > 0) {
      digits.push(carry % BASE);
      carry = Math.floor(carry / BASE);
    }
  }
  
  let string = '';
  
  // Handle leading zeros
  for (let i = 0; bytes[i] === 0 && i < bytes.length - 1; i++) {
    string += '1';
  }
  
  // Convert digits to base58 string
  for (let i = digits.length - 1; i >= 0; i--) {
    string += ALPHABET[digits[i]];
  }
  
  return string;
}