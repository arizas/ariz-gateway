const TOKEN_EXPIRY_MILLIS = 5 * 60 * 1000;

async function parseToken(authorizationHeader) {
  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
    throw new Error('Missing or invalid authorization header');
  }
  
  const tokenParts = authorizationHeader.substring('Bearer '.length).split('.');
  if (tokenParts.length !== 2) {
    throw new Error('Invalid token format');
  }
  
  const tokenPayloadBytes = Uint8Array.from(atob(tokenParts[0]), c => c.charCodeAt(0));
  const tokenSignatureBytes = Uint8Array.from(atob(tokenParts[1]), c => c.charCodeAt(0));
  const tokenPayload = JSON.parse(new TextDecoder().decode(tokenPayloadBytes));
  const tokenHashBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', tokenPayloadBytes));
  
  return { tokenPayload, tokenHashBytes, tokenSignatureBytes, tokenPayloadBytes };
}

function isTokenValidForAccount(accountId, tokenPayload) {
  const now = Date.now();
  return accountId === tokenPayload.accountId && 
         tokenPayload.iat <= now &&
         tokenPayload.iat > (now - TOKEN_EXPIRY_MILLIS);
}

async function verifyNearContract(tokenHashBytes, env) {
  // Call NEAR RPC to check if token exists in contract
  const rpcUrl = env.NEAR_NODE_URL || 'https://rpc.mainnet.near.org';
  const contractId = env.CONTRACT_ID || 'arizportfolio.near';
  
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'dontcare',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: contractId,
        method_name: 'get_account_id_for_token',
        args_base64: btoa(JSON.stringify({ token_hash: Array.from(tokenHashBytes) }))
      }
    })
  });
  
  const result = await response.json();
  if (result.error) {
    throw new Error(result.error.message);
  }
  
  // Decode the result
  const accountId = JSON.parse(atob(result.result.result.join('')));
  return accountId;
}

async function isValidSignature(publicKey, signatureBuffer, messageBuffer) {
  try {
    // Parse the NEAR public key format (e.g., "ed25519:base58encodedkey")
    const [keyType, keyData] = publicKey.split(':');
    if (keyType !== 'ed25519') {
      throw new Error('Only ED25519 keys are supported');
    }
    
    // Convert base58 to raw bytes (NEAR uses base58 for public keys)
    // For a full implementation, you'd need a base58 decoder
    // For now, we'll use a simplified approach assuming the key is already in the right format
    
    // Import the public key for ED25519 verification
    const publicKeyBytes = base58ToBytes(keyData); // You'd need to implement base58ToBytes
    
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      {
        name: 'Ed25519',
        namedCurve: 'Ed25519',
      },
      false,
      ['verify']
    );
    
    // Verify the signature
    return await crypto.subtle.verify(
      'Ed25519',
      cryptoKey,
      signatureBuffer,
      messageBuffer
    );
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
}

// Helper function to decode base58 (simplified - you'd want a proper implementation)
function base58ToBytes(base58String) {
  // This is a placeholder - in production, use a proper base58 decoder
  // For now, this will throw an error to indicate it needs implementation
  throw new Error('Base58 decoding not implemented - use a library like bs58');
}

export default {
  async fetch(request, env) {
    // Enable CORS
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

    // Check if authentication is enabled
    if (env.ENABLE_AUTH === 'true') {
      try {
        // Parse and validate token
        const authHeader = request.headers.get('Authorization');
        const { tokenPayload, tokenHashBytes, tokenSignatureBytes } = await parseToken(authHeader);
        
        // Verify token with NEAR contract
        const accountId = await verifyNearContract(tokenHashBytes, env);
        
        // Validate token
        if (!isTokenValidForAccount(accountId, tokenPayload) ||
            !await isValidSignature(tokenPayload.publicKey, tokenSignatureBytes, tokenHashBytes)) {
          return new Response('Unauthorized', {
            status: 401,
            headers: corsHeaders
          });
        }
        
        // Token is valid, proceed with the request
      } catch (error) {
        console.error('Auth error:', error);
        return new Response('Authentication failed', {
          status: 401,
          headers: corsHeaders
        });
      }
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