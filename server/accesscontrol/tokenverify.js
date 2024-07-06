import { PublicKey } from 'near-api-js/lib/utils/key_pair.js';
import crypto from 'node:crypto';

export const TOKEN_EXPIRY_MILLIS = 5 * 60 * 1000;

export async function parseToken(authorizationHeader) {
    const token_parts = authorizationHeader.substring('Bearer '.length).split('.');
    const token_payload_bytes = Buffer.from(token_parts[0], 'base64');
    const token_signature_bytes = Buffer.from(token_parts[1], 'base64');
    const token_payload = JSON.parse(new TextDecoder().decode(token_payload_bytes));
    const token_hash_bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", token_payload_bytes))

    return { token_payload, token_hash_bytes, token_signature_bytes, token_payload_bytes };
}

export function isTokenValidForAccount(accountId, tokenPayload) {
    return accountId == tokenPayload.accountId && tokenPayload.iat <= new Date().getTime() &&
        tokenPayload.iat > (new Date().getTime() - TOKEN_EXPIRY_MILLIS)
}

export function isValidSignature(publicKey, signatureBuffer, messageBuffer) {
    return PublicKey.from(publicKey).verify(messageBuffer, signatureBuffer);
}
