import { describe, test, beforeEach, afterEach } from 'node:test';
import { equal, deepEqual, match } from 'node:assert/strict';
import express from 'express';
import { createNearAiRouter, MAX_GPUS, NRAS_URL } from './index.js';

const NONCE = 'ab'.repeat(32);
const gpu = (over = {}) => ({ certificate: 'CERT', evidence: 'EVIDENCE', nonce: NONCE, arch: 'HOPPER', ...over });
const evidence = (over = {}) => ({ nonce: NONCE, arch: 'HOPPER', evidence_list: [gpu(), gpu()], ...over });

describe('POST /api/nearai/gpu-attestation', () => {
    let server, base, calls, nvidiaAnswer;
    beforeEach(async () => {
        calls = [];
        nvidiaAnswer = () => new Response(JSON.stringify([['JWT', 'header.claims.signature'], { 'GPU-0': 'a.b.c' }]), { status: 200 });
        const fetchImpl = async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            return nvidiaAnswer();
        };
        const app = express();
        app.use('/api/nearai', createNearAiRouter({ fetchImpl }));
        await new Promise((resolve) => { server = app.listen(0, resolve); });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    afterEach(() => server.close());

    const post = (body) => fetch(`${base}/api/nearai/gpu-attestation`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    test('passes the evidence to NVIDIA and its answer back unchanged', async () => {
        const res = await post(evidence());
        equal(res.status, 200);
        deepEqual(await res.json(), [['JWT', 'header.claims.signature'], { 'GPU-0': 'a.b.c' }]);
        equal(calls.length, 1);
        equal(calls[0].url, NRAS_URL);
        deepEqual(calls[0].body, evidence());
    });

    test('sends on only the fields NVIDIA takes', async () => {
        await post({ ...evidence({ evidence_list: [{ ...gpu(), extra: 'x' }] }), url: 'https://elsewhere.example' });
        deepEqual(calls[0].body, { nonce: NONCE, arch: 'HOPPER', evidence_list: [gpu()] });
    });

    test('takes nothing but GPU evidence', async () => {
        for (const [body, message] of [
            [evidence({ nonce: 'nope' }), /nonce/],
            [evidence({ arch: 'AMPERE' }), /arch/],
            [evidence({ evidence_list: [] }), /1 to/],
            [evidence({ evidence_list: Array.from({ length: MAX_GPUS + 1 }, () => gpu()) }), /1 to/],
            [evidence({ evidence_list: [gpu({ certificate: 7 })] }), /certificate/],
        ]) {
            const res = await post(body);
            equal(res.status, 400);
            match((await res.json()).message, message);
        }
        equal(calls.length, 0);
    });

    test('says when NVIDIA refuses or cannot be reached', async () => {
        nvidiaAnswer = () => new Response('bad evidence', { status: 400 });
        let res = await post(evidence());
        equal(res.status, 502);
        deepEqual(await res.json(), { error: 'nvidia', status: 400, message: 'bad evidence' });
        nvidiaAnswer = () => { throw new Error('connect ECONNREFUSED'); };
        res = await post(evidence());
        equal(res.status, 502);
        match((await res.json()).message, /ECONNREFUSED/);
    });
});
