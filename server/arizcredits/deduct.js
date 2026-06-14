import nearApi from 'near-api-js';

const DEFAULT_GAS = '300000000000000'; // 300 Tgas

/**
 * Client for the arizcredits.near operator-deduction methods.
 *
 * The operator is the contract account itself (`current_account_id`), so this
 * signs `call_js_func({function_name:'deduct', ...})` AS the contract account
 * using a function-call access key. The on-chain JS `deduct` is dispatched via
 * the Rust `call_js_func` method, so the function-call key must allow
 * `call_js_func` (it cannot be narrowed to `deduct` alone without an upstream
 * Rust method) — still far safer than a full-access key (no post_javascript,
 * no key management, no NEAR-balance transfers). Deducted ARIZ returns to the
 * contract treasury.
 *
 * @param {object} cfg
 * @param {string} cfg.networkId
 * @param {string} cfg.nodeUrl
 * @param {string} cfg.contractId      arizcredits.near (also the signer/operator)
 * @param {string} cfg.operatorKey     function-call private key for contractId ("ed25519:...")
 */
export async function createDeductClient({ networkId, nodeUrl, contractId, operatorKey }) {
    const keyStore = new nearApi.keyStores.InMemoryKeyStore();
    await keyStore.setKey(networkId, contractId, nearApi.KeyPair.fromString(operatorKey));
    const near = await nearApi.connect({ networkId, nodeUrl, keyStore });
    const account = await near.account(contractId);
    const viewContract = new nearApi.Contract(account, contractId, {
        viewMethods: ['view_js_func'],
    });

    return {
        /**
         * Deduct a batch of {user, amount, description?} entries in one
         * transaction. Returns the contract's per-entry result array:
         * [{user, status: 'deducted'|'skipped', amount?, reason?}].
         */
        async deduct(deductions, { gas = DEFAULT_GAS } = {}) {
            if (!Array.isArray(deductions) || deductions.length === 0) return [];
            const outcome = await account.functionCall({
                contractId,
                methodName: 'call_js_func',
                args: { function_name: 'deduct', deductions },
                gas,
            });
            return nearApi.providers.getTransactionLastResult(outcome) ?? [];
        },

        /** Read a user's authorisation entry (or null). */
        async viewAuthorisation(user, operatorAccount = contractId) {
            return viewContract.view_js_func({
                function_name: 'view_authorisation',
                user,
                operator_account: operatorAccount,
            });
        },
    };
}
