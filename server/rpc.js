export function createRpcHandler({ nodeUrl }) {
    return async function handleRpc(req, res) {
        if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end('Method not allowed');
            return;
        }

        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);

        let upstream;
        try {
            upstream = await fetch(nodeUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
            });
        } catch {
            res.statusCode = 502;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: 'Internal proxy error' }));
            return;
        }

        const responseBody = await upstream.text();
        res.statusCode = upstream.status;
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-cache');
        res.end(responseBody);
    };
}
