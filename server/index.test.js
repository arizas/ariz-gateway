import { test, before, after, describe } from 'node:test';
import { fork } from 'child_process';
import { equal, ok } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker, KeyPair } from 'near-workspaces';
import { randomBytes, createHash } from 'node:crypto';
import { serializeNep413Payload } from './accesscontrol/nep413.js';

// Build a NEP-413 bearer token (base64(JSON)) signed by `keyPair`, matching
// what the frontend produces via @hot-labs/near-connect signMessage.
function createNep413Token(keyPair, accountId, recipient, { issuedAt = Date.now() } = {}) {
    const message = JSON.stringify({ issuedAt });
    const nonce = new Uint8Array(randomBytes(32));
    const serialized = serializeNep413Payload({ message, nonce, recipient, callbackUrl: null });
    const digest = new Uint8Array(createHash('sha256').update(serialized).digest());
    const { signature } = keyPair.sign(digest);
    const payload = {
        accountId,
        publicKey: keyPair.getPublicKey().toString(),
        signature: Buffer.from(signature).toString('base64'),
        message,
        nonce: Buffer.from(nonce).toString('base64'),
        recipient,
    };
    return Buffer.from(JSON.stringify(payload)).toString('base64');
}

describe('server', { only: false }, () => {
    let serverProcess;
    let serverDataDir;
    let worker;
    let root;
    let contract;
    let contactAccountKeyPair;
    const serverEnvironment = {
        ARIZ_GATEWAY_PORT: 15000,
        ARIZ_GATEWAY_NEAR_NETWORK_ID: 'sandbox'
    };

    before(async () => {
        worker = await Worker.init();
        serverEnvironment.ARIZ_GATEWAY_NODE_URL = worker.provider.connection.url;
        root = worker.rootAccount;

        contract = await root.devDeploy('contract/target/wasm32-unknown-unknown/release/ariz_gateway.wasm');
        contactAccountKeyPair = await contract.getKey();

        await contract.call(contract.accountId, 'init', {});
        serverEnvironment.ARIZ_GATEWAY_CONTRACT_ID = contract.accountId;

        serverProcess = fork(new URL('index.mock.js', import.meta.url), {
            env: serverEnvironment,
            stdio: ['pipe', 'pipe', 'pipe', 'ipc']
        });

        await new Promise((resolve, reject) => {
            const onStdout = (data) => {
                const text = data.toString();
                const match = text.match(/ARIZ_DATA_DIR=([^\s]+)/);
                if (match) {
                    serverDataDir = match[1];
                }
                if (text.includes('server listening at port')) {
                    resolve();
                }
            };

            serverProcess.stdout.on('data', onStdout);

            serverProcess.stderr.on('data', (data) => {
                process.stderr.write(`[server stderr] ${data}`);
            });

            serverProcess.on('error', (error) => {
                console.error('error:', error);
                reject(error);
            });
            serverProcess.on('exit', (code) => {
                if (code !== 0) {
                    reject(new Error(`Server process exited with code ${code}`));
                }
            });
        });
    });

    after(async () => {
        serverProcess.kill();
        await worker.tearDown();
    });

    const baseUrl = () => `http://localhost:${serverEnvironment.ARIZ_GATEWAY_PORT}`;

    // The contract account is the recipient (middleware defaults recipient to
    // the contract id) and its full-access key signs the NEP-413 message.
    const authToken = () =>
        createNep413Token(contactAccountKeyPair, contract.accountId, contract.accountId);

    test('serves the bundled frontend at the root', async () => {
        const response = await fetch(baseUrl());
        equal(response.status, 200);
        ok(response.headers.get('content-type')?.includes('text/html'));
        ok((await response.text()).includes('<html'));
    });

    test('client-routed path falls back to the frontend index (SPA)', async () => {
        const response = await fetch(`${baseUrl()}/accounts`);
        equal(response.status, 200);
        ok(response.headers.get('content-type')?.includes('text/html'));
    });

    test('unauthenticated /api/prices/currencylist is rejected', async () => {
        const response = await fetch(`${baseUrl()}/api/prices/currencylist`);
        equal(response.status, 401);
        equal(await response.text(), 'failed to parse token');
    });

    test('unauthenticated /rpc is rejected', async () => {
        const response = await fetch(`${baseUrl()}/rpc`, { method: 'POST', body: '{}' });
        equal(response.status, 401);
        equal(await response.text(), 'failed to parse token');
    });

    test('/api with a token signed by a key not on the account is rejected', async () => {
        // Random key that is not an access key on the contract account.
        const stranger = KeyPair.fromRandom('ed25519');
        const token = createNep413Token(stranger, contract.accountId, contract.accountId);
        const response = await fetch(`${baseUrl()}/api/prices/currencylist`, {
            headers: { 'authorization': `Bearer ${token}` }
        });

        equal(response.status, 401);
        equal(await response.text(), 'public key not on account');
    });

    test('get price history with NEP-413 token', async () => {
        const token = authToken();

        const response = await fetch(
            `${baseUrl()}/api/prices/history?basetoken=near&currency=usd&todate=2024-06-23`,
            { headers: { 'authorization': `Bearer ${token}` } }
        );

        equal(response.status, 200);
        const prices = await response.json();
        equal(prices["2021-09-26"], 7.68236523127079);
        equal(prices["2024-06-14"], 5.910628180317743);
        equal(prices["2024-06-23"], 5.172866304874715);
    });

    test('unauthenticated /api/accounting/<accountId>/status is rejected', async () => {
        const response = await fetch(`${baseUrl()}/api/accounting/${contract.accountId}/status`);
        equal(response.status, 401);
    });

    test('authenticated /api/accounting/<accountId>/status returns 200 and lazy-enrolls account', async () => {
        const token = authToken();

        const response = await fetch(`${baseUrl()}/api/accounting/${contract.accountId}/status`, {
            headers: { 'authorization': `Bearer ${token}` }
        });

        equal(response.status, 200);
        const body = await response.json();
        equal(body.accountId, contract.accountId);
        equal(body.hasData, false);

        const accountsRaw = await readFile(join(serverDataDir, 'accounts.json'), 'utf8');
        const accountsDb = JSON.parse(accountsRaw);
        ok(accountsDb.accounts[contract.accountId], `expected ${contract.accountId} in accounts.json`);
    });

    test('authenticated user can fetch accounting data for any accountId in the path', async () => {
        // Open read access by design: the gateway can't cryptographically verify
        // account ownership, so any signed-in user can request data for any
        // accountId. Restriction belongs in worker enrollment, not at the read API.
        const token = authToken();
        const otherAccountId = 'someoneelse.near';

        const response = await fetch(`${baseUrl()}/api/accounting/${otherAccountId}/status`, {
            headers: { 'authorization': `Bearer ${token}` }
        });

        equal(response.status, 200);
        const body = await response.json();
        equal(body.accountId, otherAccountId);
        equal(body.hasData, false);

        const accountsRaw = await readFile(join(serverDataDir, 'accounts.json'), 'utf8');
        const accountsDb = JSON.parse(accountsRaw);
        ok(accountsDb.accounts[otherAccountId], `expected ${otherAccountId} in accounts.json`);
    });

    test('/rpc forwards authenticated request to upstream node', async () => {
        const token = authToken();

        const response = await fetch(`${baseUrl()}/rpc`, {
            method: 'POST',
            headers: {
                'authorization': `Bearer ${token}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'test',
                method: 'status',
                params: []
            })
        });

        equal(response.status, 200);
        const body = await response.json();
        equal(body.jsonrpc, '2.0');
        equal(body.id, 'test');
    });
});
