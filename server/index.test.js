import { test, before, after, describe } from 'node:test';
import { fork } from 'child_process';
import { equal, ok } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'near-workspaces';
import nearApi from 'near-api-js';
import { createToken } from './accesscontrol/tokenverify.test.js';

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

    async function registerToken() {
        const created = createToken(contactAccountKeyPair, contract.accountId);
        await contract.call(contract.accountId, 'register_token', {
            token_hash: Array.from(created.tokenHash),
            signature: Array.from(created.signatureBytes),
            public_key: Array.from(created.publicKeyBytes)
        }, {
            attachedDeposit: nearApi.utils.format.parseNearAmount('0.2')
        });
        return created;
    }

    test('connect and get default response', async () => {
        const response = await fetch(baseUrl());
        equal(await response.text(), 'nothing here');
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

    test('/api with token whose account is not registered is Unauthorized', async () => {
        const { token } = createToken(contactAccountKeyPair, 'unknown.near');
        const response = await fetch(`${baseUrl()}/api/prices/currencylist`, {
            headers: { 'authorization': `Bearer ${token}` }
        });

        equal(response.status, 401);
        equal(await response.text(), 'Unauthorized');
    });

    test('get price history with registered token', async () => {
        const { token } = await registerToken();

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

    test('unauthenticated /api/accounting/status is rejected', async () => {
        const response = await fetch(`${baseUrl()}/api/accounting/status`);
        equal(response.status, 401);
    });

    test('authenticated /api/accounting/status returns 200 and lazy-enrolls account', async () => {
        const { token } = await registerToken();

        const response = await fetch(`${baseUrl()}/api/accounting/status`, {
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

    test('/api/accounting respects accountId from token, ignoring x-account-id header', async () => {
        const { token } = await registerToken();

        const response = await fetch(`${baseUrl()}/api/accounting/status`, {
            headers: {
                'authorization': `Bearer ${token}`,
                'x-account-id': 'attacker.near'
            }
        });

        equal(response.status, 200);
        const body = await response.json();
        equal(body.accountId, contract.accountId);
    });

    test('/rpc forwards authenticated request to upstream node', async () => {
        const { token } = await registerToken();

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
