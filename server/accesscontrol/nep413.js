import { PublicKey } from 'near-api-js/lib/utils/key_pair.js';
import crypto from 'node:crypto';

// NEP-413 (signMessage) verification.
//
// The wallet signs ed25519 over sha256(borsh(payload)) where payload is:
//   { tag: u32 = 2^31 + 413, message: string, nonce: [u8;32],
//     recipient: string, callbackUrl: Option<string> }
// The 2^31 prefix tag guarantees the signed bytes can never be a valid NEAR
// transaction. See https://github.com/near/NEPs/blob/master/neps/nep-0413.md
//
// The bearer token is base64(JSON) of:
//   { accountId, publicKey, signature(base64), message, nonce(base64),
//     recipient, callbackUrl? }
// `message` is itself JSON `{ issuedAt }` (ms epoch) giving a stateless replay
// window — the same approach as the previous `iat`-based scheme.

export const NEP413_TAG = 2147484061; // 2^31 + 413
export const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1h signed-message validity

function u32le(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
}

function concat(chunks) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
}

/** Borsh-serialize the NEP-413 payload. `nonce` must be a 32-byte Uint8Array. */
export function serializeNep413Payload({ message, nonce, recipient, callbackUrl = null }) {
    if (!(nonce instanceof Uint8Array) || nonce.length !== 32) {
        throw new Error('nonce must be 32 bytes');
    }
    const enc = new TextEncoder();
    const str = (s) => { const b = enc.encode(s); return [u32le(b.length), b]; };
    const chunks = [
        u32le(NEP413_TAG),
        ...str(message),
        nonce, // [u8;32] — fixed length, no prefix
        ...str(recipient),
        callbackUrl == null ? new Uint8Array([0]) : new Uint8Array([1]),
    ];
    if (callbackUrl != null) chunks.push(...str(callbackUrl));
    return concat(chunks);
}

class AuthError extends Error {}

/**
 * Verify a NEP-413 bearer token.
 *
 * @param {string} token            base64(JSON) bearer value (no "Bearer " prefix)
 * @param {object} opts
 * @param {string} opts.recipient   the recipient this gateway expects
 * @param {(accountId:string)=>Promise<Array>} opts.viewAccessKeyList
 *        resolves the account's access keys (RPC `view_access_key_list` `.keys`)
 * @param {number} [opts.maxAgeMs]
 * @param {number} [opts.now]       injectable clock for tests
 * @returns {Promise<{accountId:string}>}
 */
export async function verifyNep413(token, { recipient, viewAccessKeyList, maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() }) {
    let payload;
    try {
        payload = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    } catch {
        throw new AuthError('failed to parse token');
    }
    const { accountId, publicKey, signature, message, nonce, recipient: tokenRecipient, callbackUrl } = payload;
    if (!accountId || !publicKey || !signature || !message || !nonce || !tokenRecipient) {
        throw new AuthError('incomplete token');
    }
    if (tokenRecipient !== recipient) {
        throw new AuthError('recipient mismatch');
    }

    let issuedAt;
    try {
        issuedAt = JSON.parse(message).issuedAt;
    } catch {
        throw new AuthError('bad message');
    }
    if (!(typeof issuedAt === 'number' && issuedAt <= now && issuedAt > now - maxAgeMs)) {
        throw new AuthError('token expired');
    }

    const nonceBytes = new Uint8Array(Buffer.from(nonce, 'base64'));
    let serialized;
    try {
        serialized = serializeNep413Payload({ message, nonce: nonceBytes, recipient: tokenRecipient, callbackUrl: callbackUrl ?? null });
    } catch {
        throw new AuthError('bad payload');
    }
    const digest = new Uint8Array(crypto.createHash('sha256').update(serialized).digest());
    const sigBytes = new Uint8Array(Buffer.from(signature, 'base64'));
    let ok = false;
    try {
        ok = PublicKey.from(publicKey).verify(digest, sigBytes);
    } catch {
        ok = false;
    }
    if (!ok) throw new AuthError('invalid signature');

    const keys = await viewAccessKeyList(accountId);
    const match = (keys || []).find((k) => k.public_key === publicKey);
    if (!match) throw new AuthError('public key not on account');
    if (match.access_key?.permission !== 'FullAccess') throw new AuthError('not a full access key');

    return { accountId };
}

/**
 * Build a `viewAccessKeyList(accountId)` reader from a near-api-js provider,
 * with a short TTL cache per account so we don't hit RPC on every request.
 */
export function makeAccessKeyListReader(provider, { ttlMs = 60 * 1000, now = () => Date.now() } = {}) {
    const cache = new Map(); // accountId -> { keys, expiresAt }
    return async (accountId) => {
        const cached = cache.get(accountId);
        if (cached && cached.expiresAt > now()) return cached.keys;
        const res = await provider.query({
            request_type: 'view_access_key_list',
            finality: 'final',
            account_id: accountId,
        });
        const keys = res.keys || [];
        cache.set(accountId, { keys, expiresAt: now() + ttlMs });
        return keys;
    };
}
