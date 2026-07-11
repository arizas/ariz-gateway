import { createHmac } from 'node:crypto';

// Blinded store ids: the encrypted store's object keys use
// HMAC-SHA256(secret, accountId) instead of the account name, so someone with
// bucket-level access (storage provider staff, a leaked bucket credential)
// cannot map objects back to NEAR accounts. A plain unkeyed hash would not do:
// account names are public and enumerable, so it falls to a dictionary attack.
//
// The secret (ARIZ_STORE_ID_SECRET) must stay stable: changing it orphans every
// existing store (the mapping to the old prefixes is lost). Keep it a Fly
// secret; never write it to the bucket.
//
// Clients can't compute their own id (they don't hold the secret), so the
// /store router accepts the literal segment `me` and rewrites it to the
// authenticated account's id after NEP-413 auth.
export function makeStoreRepoId(secret) {
    if (!secret) return (accountId) => accountId; // blinding off (dev/tests)
    return (accountId) =>
        'r' + createHmac('sha256', secret).update(String(accountId)).digest('hex').slice(0, 32);
}
