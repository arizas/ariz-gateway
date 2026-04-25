import nearApi from 'near-api-js';
import { parseToken, isTokenValidForAccount, isValidSignature } from './tokenverify.js';

class AuthError extends Error {
    constructor(message) {
        super(message);
        this.statusCode = 401;
    }
}

export async function createAuthenticate({ networkId, contractId, nodeUrl }) {
    const near = await nearApi.connect({ networkId, contractId, nodeUrl });
    const account = await near.account();
    const contract = new nearApi.Contract(account, contractId, {
        viewMethods: ['get_account_id_for_token']
    });

    return async function authenticate(req) {
        let parsed;
        try {
            parsed = await parseToken(req.headers.authorization);
        } catch {
            throw new AuthError('failed to parse token');
        }
        const { token_hash_bytes, token_payload, token_signature_bytes } = parsed;

        let accountId;
        try {
            accountId = await contract.get_account_id_for_token({ token_hash: Array.from(token_hash_bytes) });
        } catch {
            throw new AuthError('Unauthorized');
        }

        if (!isTokenValidForAccount(accountId, token_payload) ||
            !isValidSignature(token_payload.publicKey, token_signature_bytes, token_hash_bytes)) {
            throw new AuthError('Unauthorized');
        }
        return { accountId };
    };
}

export { AuthError };
