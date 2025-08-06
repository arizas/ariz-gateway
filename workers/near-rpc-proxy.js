export default {
  async fetch(request, env) {
    // Enable CORS
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { 
        status: 204,
        headers: corsHeaders 
      });
    }

    // Only accept POST requests
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { 
        status: 405,
        headers: corsHeaders 
      });
    }

    try {
      // Get request body
      const requestBody = await request.text();
      
      // Forward request to NEAR RPC endpoint (URL includes API key in path)
      const upstreamUrl = env.NEAR_RPC_URL || 'https://rpc.mainnet.near.org';
      const upstreamResponse = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: requestBody,
      });

      // Get response body
      const responseBody = await upstreamResponse.text();

      // Return response with CORS headers
      return new Response(responseBody, {
        status: upstreamResponse.status,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache', // Disable caching for RPC responses
        },
      });
    } catch (error) {
      console.error('Proxy error:', error);
      return new Response(
        JSON.stringify({ error: 'Internal proxy error' }), 
        {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      );
    }
  },
};