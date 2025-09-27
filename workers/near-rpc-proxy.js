import { base58Decode } from './base58.js';

const TOKEN_EXPIRY_MILLIS = 24 * 60 * 60 * 1000;

async function parseToken(authorizationHeader) {
  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
    throw new Error('Missing or invalid authorization header');
  }
  
  const fullToken = authorizationHeader.substring('Bearer '.length);
  
  // Debug: Check for any special characters
  const hasInvalidChars = /[^A-Za-z0-9+/=.]/.test(fullToken);
  if (hasInvalidChars) {
    const invalidChars = fullToken.match(/[^A-Za-z0-9+/=.]/g);
    throw new Error(`Token contains invalid characters: ${invalidChars.join(', ')}`);
  }
  
  const tokenParts = fullToken.split('.');
  if (tokenParts.length !== 2) {
    throw new Error(`Invalid token format: got ${tokenParts.length} parts`);
  }
  
  // Decode base64 - try to handle atob quirks in Cloudflare Workers
  const decodeBase64 = (str, name) => {
    try {
      // For Cloudflare Workers, we need to ensure the string is clean
      // Remove any whitespace and ensure proper padding
      const cleaned = str.replace(/\s/g, '');
      const padded = cleaned + '=='.slice(0, (4 - cleaned.length % 4) % 4);
      
      // Now atob should work
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch (e) {
      throw new Error(`Failed to decode ${name}: ${e.message}. Input: ${str.substring(0, 50)}`);
    }
  };
  
  const tokenPayloadBytes = decodeBase64(tokenParts[0], 'payload');
  const tokenSignatureBytes = decodeBase64(tokenParts[1], 'signature');
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
  const rpcUrl = env.NEAR_RPC_URL;
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
        // Encode to base64 without using btoa
        args_base64: (() => {
          const str = JSON.stringify({ token_hash: Array.from(tokenHashBytes) });
          const bytes = new TextEncoder().encode(str);
          const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
          let result = '';
          
          for (let i = 0; i < bytes.length; i += 3) {
            const byte1 = bytes[i];
            const byte2 = i + 1 < bytes.length ? bytes[i + 1] : 0;
            const byte3 = i + 2 < bytes.length ? bytes[i + 2] : 0;
            
            result += chars[byte1 >> 2];
            result += chars[((byte1 & 3) << 4) | (byte2 >> 4)];
            result += i + 1 < bytes.length ? chars[((byte2 & 15) << 2) | (byte3 >> 6)] : '=';
            result += i + 2 < bytes.length ? chars[byte3 & 63] : '=';
          }
          
          return result;
        })()
      }
    })
  });
  
  const result = await response.json();
  if (result.error) {
    throw new Error(result.error.message);
  }
  
  // Decode the result
  // Convert result array to string without using atob
  const resultString = result.result.result.map(code => String.fromCharCode(code)).join('');
  const accountId = JSON.parse(resultString);
  return accountId;
}

async function isValidSignature(publicKey, signatureBuffer, messageBuffer) {
  try {
    // Parse the NEAR public key format (e.g., "ed25519:base58encodedkey")
    const [keyType, keyData] = publicKey.split(':');
    if (keyType !== 'ed25519') {
      throw new Error('Only ED25519 keys are supported');
    }
    
    // Convert base58 to raw bytes
    const publicKeyBytes = base58Decode(keyData);
    
    // Import the public key for ED25519 verification
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
        const tokenValid = isTokenValidForAccount(accountId, tokenPayload);
        const signatureValid = await isValidSignature(tokenPayload.publicKey, tokenSignatureBytes, tokenHashBytes);
        
        if (!tokenValid || !signatureValid) {
          const debugInfo = {
            tokenValid,
            signatureValid,
            accountId,
            tokenAccountId: tokenPayload.accountId,
            tokenAge: Math.floor((Date.now() - tokenPayload.iat) / 1000)
          };
          return new Response(`Authentication failed: ${JSON.stringify(debugInfo)}`, {
            status: 401,
            headers: corsHeaders
          });
        }
        
        // Token is valid, proceed with the request
      } catch (error) {
        console.error('Auth error:', error);
        return new Response(`Authentication failed: ${error.message}`, {
          status: 401,
          headers: corsHeaders
        });
      }
    }

    try {
      // Get request body
      const requestBody = await request.text();
      
      // Forward request to NEAR RPC endpoint (URL includes API key in path)
      const upstreamUrl = env.NEAR_RPC_URL;
      if (!upstreamUrl) {
        return new Response(
          JSON.stringify({ error: 'Missing NEAR_RPC_URL value' }), 
          {
            status: 500,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json',
            },
          }
        );
      }
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