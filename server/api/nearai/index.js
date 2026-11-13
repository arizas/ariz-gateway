import express from 'express';

// NVIDIA's verdict on a NEAR AI model enclave's GPUs, for the app's AI
// assistant (arizas/Ariz-Portfolio, "AI assistant: verify the model").
//
//   POST /api/nearai/gpu-attestation   { nonce, arch, evidence_list: [{ certificate, evidence, nonce, arch }] }
//        → NVIDIA's answer, unchanged: [["JWT", "<signed verdict>"], { "GPU-0": "<signed claims>", ... }]
//
// The browser verifies a model itself: NEAR AI's report, Intel's quote and the
// key and nonce it binds. Only the GPU evidence needs NVIDIA's attestation
// service, which does not answer browsers (no CORS). So this passes the evidence
// on and the answer back, and nothing else: it is not a proxy for NVIDIA's API.
// The gateway adds no trust: NVIDIA signs its verdict, and the browser checks
// that signature against NVIDIA's published key and finds its own nonce in it.

export const NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
const NONCE = /^[0-9a-f]{64}$/i;
const ARCHES = new Set(['HOPPER', 'BLACKWELL']);
export const MAX_GPUS = 16;
const MAX_FIELD = 64 * 1024;
const TIMEOUT_MS = 30000;

/** Why a payload is not GPU evidence, or null. */
function invalidEvidence(body) {
    if (!body || typeof body !== 'object') return 'the body must be NVIDIA GPU evidence';
    const { nonce, arch, evidence_list: list } = body;
    if (!NONCE.test(nonce ?? '')) return 'nonce must be 32 bytes of hex';
    if (!ARCHES.has(arch)) return `arch must be one of ${[...ARCHES].join(', ')}`;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_GPUS) return `evidence_list must hold 1 to ${MAX_GPUS} GPUs`;
    for (const item of list) {
        if (!item || typeof item !== 'object') return 'each GPU is { certificate, evidence }';
        for (const field of ['certificate', 'evidence']) {
            if (typeof item[field] !== 'string' || item[field].length === 0 || item[field].length > MAX_FIELD) return `each GPU needs a ${field} string`;
        }
    }
    return null;
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl]
 * @param {string} [opts.nrasUrl]
 */
export function createNearAiRouter({ fetchImpl = fetch, nrasUrl = NRAS_URL } = {}) {
    const router = express.Router();
    router.post('/gpu-attestation', express.json({ limit: '2mb' }), async (req, res) => {
        const problem = invalidEvidence(req.body);
        if (problem) return res.status(400).json({ error: 'bad_evidence', message: problem });
        // Only the fields NVIDIA's service takes go on.
        const { nonce, arch, evidence_list: list } = req.body;
        const evidence = {
            nonce, arch,
            evidence_list: list.map(({ certificate, evidence: e, nonce: n, arch: a }) => ({
                certificate, evidence: e, ...(n !== undefined ? { nonce: n } : {}), ...(a !== undefined ? { arch: a } : {}),
            })),
        };
        try {
            const answer = await fetchImpl(nrasUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify(evidence),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            const text = await answer.text();
            res.status(answer.ok ? 200 : 502).type('application/json').setHeader('cache-control', 'no-store');
            res.send(answer.ok ? text : JSON.stringify({ error: 'nvidia', status: answer.status, message: text.slice(0, 500) }));
        } catch (e) {
            console.error('[nearai] NVIDIA attestation service:', e);
            res.status(502).json({ error: 'nvidia', message: String(e?.message ?? e).slice(0, 200) });
        }
    });
    return router;
}
