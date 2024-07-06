import { test, before, after, describe } from 'node:test';
import { fork } from 'child_process';
import { equal } from 'node:assert/strict';
import { Worker } from 'near-workspaces';
import { createHash } from 'crypto';
import nearApi from 'near-api-js';
import { createToken } from './accesscontrol/tokenverify.test.js';

describe('server', { only: false }, () => {
    let serverProcess;
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
            serverProcess.stdout.on('data', (data) => {
                if (data.toString().includes('server listening at port')) {
                    resolve();
                }
            });

            serverProcess.stderr.on('data', (data) => {
                console.error('stderr:', data.toString());
                reject(data.toString());
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

    test('connect and get default response', async () => {
        const response = await fetch(`http://localhost:${serverEnvironment.ARIZ_GATEWAY_PORT}`);
        equal(await response.text(), 'nothing here');
    });

    test('unauthenticated connection to api', async () => {
        const response = await fetch(`http://localhost:${serverEnvironment.ARIZ_GATEWAY_PORT}/api`);
        equal(response.status, 401);
        equal(await response.text(), 'failed to parse token');
    });

    test('connection to api with token that does not have access', async () => {
        const { token } = createToken(contactAccountKeyPair, 'unknown.near');
        const response = await fetch(`http://localhost:${serverEnvironment.ARIZ_GATEWAY_PORT}/api`, {
            headers: {
                'authorization': `Bearer ${token}`
            }
        });

        equal(response.status, 401);
        equal(await response.text(), 'Unauthorized');
    });

    test('connection to api with token that has read access', async () => {
        const { token, tokenHash, signatureBytes, publicKeyBytes } = createToken(contactAccountKeyPair, contract.accountId);

        await contract.call(contract.accountId, 'register_token', {
            token_hash: Array.from(tokenHash),
            signature: Array.from(signatureBytes), public_key: Array.from(publicKeyBytes)
        }, {
            attachedDeposit: nearApi.utils.format.parseNearAmount('0.2')
        });
        const response = await fetch(`http://localhost:${serverEnvironment.ARIZ_GATEWAY_PORT}/api`, {
            headers: {
                'authorization': `Bearer ${token}`
            }
        });

        equal(await response.text(), `Hello ${contract.accountId}`);
        equal(response.status, 200);
    });

    test('get price history', async () => {
        const { token, tokenHash, signatureBytes, publicKeyBytes } = createToken(contactAccountKeyPair, contract.accountId);

        await contract.call(contract.accountId, 'register_token', {
            token_hash: Array.from(tokenHash),
            signature: Array.from(signatureBytes),
            public_key: Array.from(publicKeyBytes)
        }, {
            attachedDeposit: nearApi.utils.format.parseNearAmount('0.2')
        });

        const response = await fetch(`http://localhost:${serverEnvironment.ARIZ_GATEWAY_PORT}/api/prices/history?basetoken=near&currency=usd&todate=2024-06-23`, {
            headers: {
                'authorization': `Bearer ${token}`
            }
        });

        equal(response.status, 200);
        const prices = await response.json();
        equal(prices["2021-09-26"], 7.68236523127079);
        equal(prices["2024-06-14"], 5.910628180317743);
        equal(prices["2024-06-23"], 5.172866304874715);
    });
});

