import { createHash } from 'crypto';
import nearApi from 'near-api-js';

const keyStore = new nearApi.keyStores.UnencryptedFileSystemKeyStore(process.env.HOME + '/.near-credentials');
const connectionConfig = {
    networkId: 'testnet',
    keyStore,
    nodeUrl: 'https://rpc.testnet.near.org'
};

const accountId = 'devhublink.testnet';
const keyPair = await keyStore.getKey('testnet', accountId);

const token = JSON.stringify({ iat: new Date().getTime(), accountId, publicKey: keyPair.publicKey.toString() });
const tokenBytes = Buffer.from(token, 'utf8');
const hash = createHash('sha256');
hash.update(tokenBytes);
const tokenHash = new Uint8Array(hash.digest());
const signatureBytes = Buffer.from(keyPair.sign(tokenHash).signature);
const tokenObj = { token: `${tokenBytes.toString('base64')}.${signatureBytes.toString('base64')}`, tokenHash, signatureBytes };

const connection = await nearApi.connect(connectionConfig);
const account = await connection.account(accountId);

const args = {
    token_hash: Array.from(tokenHash), signature: Array.from(signatureBytes)
};

await account.functionCall({
    contractId: 'arizportfolio.testnet',
    methodName: 'register_token',
    args,
    attachedDeposit: nearApi.utils.format.parseNearAmount('0.2')
});
const response = await fetch(`https://arizgateway.azurewebsites.net/api/prices/history?basetoken=near&currency=nok&todate=2024-07-05`, {
    headers: {
        'authorization': `Bearer ${tokenObj.token}`
    }
}).then(r => r.text());
console.log(response);
console.log(tokenObj.token);
