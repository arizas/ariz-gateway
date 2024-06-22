import { test, before, after, describe } from 'node:test';
import { fork } from 'child_process';
import { equal } from 'node:assert/strict';
import { Worker } from 'near-workspaces';
import { createHash } from 'crypto';
import nearApi from 'near-api-js';

describe('server', () => {
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
        await contract.call(contract.accountId, 'register_resource', { resource_id: 'ariz_gateway' }, {
            attachedDeposit: nearApi.utils.format.parseNearAmount('0.1')
        });
        serverEnvironment.ARIZ_GATEWAY_CONTRACT_ID = contract.accountId;

        serverProcess = fork(new URL('index.js', import.meta.url), {
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
        const token = Buffer.from(JSON.stringify({ resource_id: 'arizgateway' }), 'utf8').toString('base64');
        const response = await fetch(`http://localhost:${serverEnvironment.ARIZ_GATEWAY_PORT}/api`, {
            headers: {
                'authorization': `Bearer ${token}`
            }
        });

        equal(response.status, 403);
        equal(await response.text(), 'Your permission to arizgateway is: none');
    });

    test('connection to api with token that has read access', async () => {
        const token = JSON.stringify({ resource_id: 'ariz_gateway' });
        const tokenBytes = Buffer.from(token, 'utf8');
        const hash = createHash('sha256');
        hash.update(tokenBytes);
        const token_hash = new Uint8Array(hash.digest());
        const signature = Array.from(contactAccountKeyPair.sign(token_hash).signature);

        await contract.call(contract.accountId, 'register_token', { token_hash: Array.from(token_hash), signature });
        const response = await fetch(`http://localhost:${serverEnvironment.ARIZ_GATEWAY_PORT}/api`, {
            headers: {
                'authorization': `Bearer ${tokenBytes.toString('base64')}`
            }
        });

        equal(response.status, 200);
        equal(await response.text(), 'Your permission to ariz_gateway is: owner');
    });
});

