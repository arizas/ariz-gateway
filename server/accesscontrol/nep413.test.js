import { describe, test } from 'node:test';
import { equal, rejects, deepEqual } from 'node:assert/strict';
import { KeyPair } from 'near-api-js';
import { randomBytes, createHash } from 'node:crypto';
import { serializeNep413Payload, verifyNep413, makeAccessKeyReader } from './nep413.js';

const RECIPIENT = 'arizportfolio.near';
const ACCOUNT = 'alice.near';

function makeToken(keyPair, { accountId = ACCOUNT, recipient = RECIPIENT, issuedAt = Date.now(), tamper = false } = {}) {
    const message = JSON.stringify({ issuedAt });
    const nonce = new Uint8Array(randomBytes(32));
    const serialized = serializeNep413Payload({ message, nonce, recipient, callbackUrl: null });
    const digest = new Uint8Array(createHash('sha256').update(serialized).digest());
    const { signature } = keyPair.sign(digest);
    const sig = Buffer.from(signature);
    if (tamper) sig[0] ^= 0xff;
    const payload = {
        accountId,
        publicKey: keyPair.getPublicKey().toString(),
        signature: sig.toString('base64'),
        message,
        nonce: Buffer.from(nonce).toString('base64'),
        recipient,
    };
    return Buffer.from(JSON.stringify(payload)).toString('base64');
}

// viewAccessKey stub that reports `keyPair` as a Full Access key on ACCOUNT.
function fakReader(keyPair, permission = 'FullAccess') {
    return async (accountId, publicKey) =>
        accountId === ACCOUNT && publicKey === keyPair.getPublicKey().toString() ? { nonce: 0, permission } : null;
}

describe('NEP-413 verification', () => {
    test('valid token resolves the accountId', async () => {
        const kp = KeyPair.fromRandom('ed25519');
        const token = makeToken(kp);
        const res = await verifyNep413(token, { recipient: RECIPIENT, viewAccessKey: fakReader(kp) });
        deepEqual(res, { accountId: ACCOUNT });
    });

    test('recipient mismatch is rejected', async () => {
        const kp = KeyPair.fromRandom('ed25519');
        const token = makeToken(kp, { recipient: 'evil.near' });
        await rejects(
            verifyNep413(token, { recipient: RECIPIENT, viewAccessKey: fakReader(kp) }),
            /recipient mismatch/,
        );
    });

    test('expired token is rejected', async () => {
        const kp = KeyPair.fromRandom('ed25519');
        const token = makeToken(kp, { issuedAt: Date.now() - 2 * 60 * 60 * 1000 });
        await rejects(
            verifyNep413(token, { recipient: RECIPIENT, viewAccessKey: fakReader(kp), maxAgeMs: 60 * 60 * 1000 }),
            /token expired/,
        );
    });

    // The window is the replay window, and also how often the browser has to put
    // a wallet QR code on screen. At an hour that happened several times a day,
    // and an app doing background work while it waits looks like it has hung.
    test('a signed message stays valid for a day', async () => {
        const kp = KeyPair.fromRandom('ed25519');
        const token = makeToken(kp, { issuedAt: Date.now() - 23 * 60 * 60 * 1000 });
        const res = await verifyNep413(token, { recipient: RECIPIENT, viewAccessKey: fakReader(kp) });
        deepEqual(res, { accountId: ACCOUNT });
    });

    test('and no longer than that', async () => {
        const kp = KeyPair.fromRandom('ed25519');
        const token = makeToken(kp, { issuedAt: Date.now() - 25 * 60 * 60 * 1000 });
        await rejects(
            verifyNep413(token, { recipient: RECIPIENT, viewAccessKey: fakReader(kp) }),
            /token expired/,
        );
    });

    test('future-dated token is rejected', async () => {
        const kp = KeyPair.fromRandom('ed25519');
        const token = makeToken(kp, { issuedAt: Date.now() + 10 * 60 * 1000 });
        await rejects(
            verifyNep413(token, { recipient: RECIPIENT, viewAccessKey: fakReader(kp) }),
            /token expired/,
        );
    });

    test('tampered signature is rejected', async () => {
        const kp = KeyPair.fromRandom('ed25519');
        const token = makeToken(kp, { tamper: true });
        await rejects(
            verifyNep413(token, { recipient: RECIPIENT, viewAccessKey: fakReader(kp) }),
            /invalid signature/,
        );
    });

    test('signature by a key not on the account is rejected', async () => {
        const kp = KeyPair.fromRandom('ed25519');
        const token = makeToken(kp);
        await rejects(
            verifyNep413(token, { recipient: RECIPIENT, viewAccessKey: async () => null }),
            /public key not on account/,
        );
    });

    test('function-call (non-full-access) key is rejected', async () => {
        const kp = KeyPair.fromRandom('ed25519');
        const token = makeToken(kp);
        const fcReader = fakReader(kp, { FunctionCall: { allowance: '1', receiver_id: 'x', method_names: [] } });
        await rejects(
            verifyNep413(token, { recipient: RECIPIENT, viewAccessKey: fcReader }),
            /not a full access key/,
        );
    });

    test('the key reader asks for the one key, so an account with any number of keys can sign in', async () => {
        const asked = [];
        const provider = {
            async query(params) {
                asked.push(params);
                // Since nearcore 2.14 a list of more than 100 keys is refused.
                if (params.request_type === 'view_access_key_list') throw new Error('TOO_MANY_ACCESS_KEYS');
                if (params.public_key === 'ed25519:GONE') {
                    const e = new Error('access key ed25519:GONE does not exist while viewing');
                    e.type = 'AccessKeyDoesNotExist';
                    throw e;
                }
                return { block_hash: 'H', block_height: 1, nonce: 5, permission: 'FullAccess' };
            },
        };
        let t = 0;
        const viewAccessKey = makeAccessKeyReader(provider, { ttlMs: 1000, now: () => t });
        deepEqual(await viewAccessKey('a.near', 'ed25519:K'), { nonce: 5, permission: 'FullAccess' });
        deepEqual(asked[0], { request_type: 'view_access_key', finality: 'final', account_id: 'a.near', public_key: 'ed25519:K' });
        equal(await viewAccessKey('a.near', 'ed25519:GONE'), null);

        // Cached for its time, then asked again.
        await viewAccessKey('a.near', 'ed25519:K');
        equal(asked.length, 2);
        t = 2000;
        await viewAccessKey('a.near', 'ed25519:K');
        equal(asked.length, 3);
    });

    test('an RPC failure is not taken as "no such key"', async () => {
        const viewAccessKey = makeAccessKeyReader({ async query() { throw new Error('rate limited'); } });
        await rejects(viewAccessKey('a.near', 'ed25519:K'), /rate limited/);
    });

    test('serialize is deterministic', () => {
        const nonce = new Uint8Array(32).fill(7);
        const a = serializeNep413Payload({ message: 'hi', nonce, recipient: RECIPIENT });
        const b = serializeNep413Payload({ message: 'hi', nonce, recipient: RECIPIENT });
        equal(Buffer.from(a).toString('hex'), Buffer.from(b).toString('hex'));
    });
});
