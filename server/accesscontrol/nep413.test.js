import { describe, test } from 'node:test';
import { equal, rejects, deepEqual } from 'node:assert/strict';
import { KeyPair } from 'near-api-js';
import { randomBytes, createHash } from 'node:crypto';
import { serializeNep413Payload, verifyNep413 } from './nep413.js';

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

// viewAccessKeyList stub that reports `keyPair` as a Full Access key on ACCOUNT.
function fakReader(keyPair, permission = 'FullAccess') {
    return async () => [{ public_key: keyPair.getPublicKey().toString(), access_key: { nonce: 0, permission } }];
}

describe('NEP-413 verification', () => {
    test('valid token resolves the accountId', async () => {
        const kp = KeyPair.fromRandom('ed25519');
        const token = makeToken(kp);
        const res = await verifyNep413(token, { recipient: RECIPIENT, viewAccessKeyList: fakReader(kp) });
        deepEqual(res, { accountId: ACCOUNT });
    });

    test('recipient mismatch is rejected', async () => {
        const kp = KeyPair.fromRandom('ed25519');
        const token = makeToken(kp, { recipient: 'evil.near' });
        await rejects(
            verifyNep413(token, { recipient: RECIPIENT, viewAccessKeyList: fakReader(kp) }),
            /recipient mismatch/,
        );
    });

    test('expired token is rejected', async () => {
        const kp = KeyPair.fromRandom('ed25519');
        const token = makeToken(kp, { issuedAt: Date.now() - 2 * 60 * 60 * 1000 });
        await rejects(
            verifyNep413(token, { recipient: RECIPIENT, viewAccessKeyList: fakReader(kp), maxAgeMs: 60 * 60 * 1000 }),
            /token expired/,
        );
    });

    test('future-dated token is rejected', async () => {
        const kp = KeyPair.fromRandom('ed25519');
        const token = makeToken(kp, { issuedAt: Date.now() + 10 * 60 * 1000 });
        await rejects(
            verifyNep413(token, { recipient: RECIPIENT, viewAccessKeyList: fakReader(kp) }),
            /token expired/,
        );
    });

    test('tampered signature is rejected', async () => {
        const kp = KeyPair.fromRandom('ed25519');
        const token = makeToken(kp, { tamper: true });
        await rejects(
            verifyNep413(token, { recipient: RECIPIENT, viewAccessKeyList: fakReader(kp) }),
            /invalid signature/,
        );
    });

    test('signature by a key not on the account is rejected', async () => {
        const kp = KeyPair.fromRandom('ed25519');
        const token = makeToken(kp);
        await rejects(
            verifyNep413(token, { recipient: RECIPIENT, viewAccessKeyList: async () => [] }),
            /public key not on account/,
        );
    });

    test('function-call (non-full-access) key is rejected', async () => {
        const kp = KeyPair.fromRandom('ed25519');
        const token = makeToken(kp);
        const fcReader = async () => [{
            public_key: kp.getPublicKey().toString(),
            access_key: { nonce: 0, permission: { FunctionCall: { allowance: '1', receiver_id: 'x', method_names: [] } } },
        }];
        await rejects(
            verifyNep413(token, { recipient: RECIPIENT, viewAccessKeyList: fcReader }),
            /not a full access key/,
        );
    });

    test('serialize is deterministic', () => {
        const nonce = new Uint8Array(32).fill(7);
        const a = serializeNep413Payload({ message: 'hi', nonce, recipient: RECIPIENT });
        const b = serializeNep413Payload({ message: 'hi', nonce, recipient: RECIPIENT });
        equal(Buffer.from(a).toString('hex'), Buffer.from(b).toString('hex'));
    });
});
