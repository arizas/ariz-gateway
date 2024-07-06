import { describe, test } from 'node:test';
import { isTokenValidForAccount, isValidSignature, parseToken, TOKEN_EXPIRY_MILLIS } from './tokenverify.js';
import { equal } from 'node:assert/strict';
import { KeyPairEd25519 } from 'near-api-js/lib/utils/key_pair.js';
import { createHash } from 'crypto';

export function createToken(keyPair, accountId) {
    const token = JSON.stringify({ iat: new Date().getTime(), accountId, publicKey: keyPair.publicKey.toString() });
    const tokenBytes = Buffer.from(token, 'utf8');
    const hash = createHash('sha256');
    hash.update(tokenBytes);
    const tokenHash = new Uint8Array(hash.digest());
    const signatureBytes = Buffer.from(keyPair.sign(tokenHash).signature);
    return { token: `${tokenBytes.toString('base64')}.${signatureBytes.toString('base64')}`, tokenHash, signatureBytes, publicKeyBytes: keyPair.publicKey.data };
}

describe.only('verify tokens', () => {
    test('valid token', () => {
        equal(isTokenValidForAccount('peter.near', { 'accountId': 'peter.near', iat: new Date().getTime() }), true);
    });

    test('token issued too far in the future', () => {
        equal(isTokenValidForAccount('peter.near', { 'accountId': 'peter.near', iat: new Date().getTime() + TOKEN_EXPIRY_MILLIS }), false);
    });

    test('token is expired', () => {
        equal(isTokenValidForAccount('peter.near', { 'accountId': 'peter.near', iat: new Date().getTime() - TOKEN_EXPIRY_MILLIS }), false);
    });

    test('token is near expiry', () => {
        equal(isTokenValidForAccount('peter.near', { 'accountId': 'peter.near', iat: new Date().getTime() - (TOKEN_EXPIRY_MILLIS + 10) }), false);
    });

    test('token for other account', () => {
        equal(isTokenValidForAccount('johan.near', { 'accountId': 'peter.near', iat: new Date().getTime() }), false);
    });

    test('verify signature', () => {
        const keypair = KeyPairEd25519.fromRandom();
        const message = Buffer.from('Hello');
        const signature = keypair.sign(message);

        equal(isValidSignature(keypair.publicKey.toString(), signature.signature, message), true);
    });

    test.only('parse full token', async () => {
        const accountId = 'test.near';
        const { token } = await createToken(KeyPairEd25519.fromRandom(), accountId);
        const { token_payload, token_hash_bytes, token_signature_bytes } = await parseToken(`Bearer ${token}`);
        equal(isTokenValidForAccount(accountId, token_payload), true);
        equal(isValidSignature(token_payload.publicKey, token_signature_bytes, token_hash_bytes), true);
    });
});
