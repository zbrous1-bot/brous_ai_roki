/**
 * Brous - Cloudflare Worker (Generic TMDB Proxy + LLM Proxy + Basic Auth)
 *
 * This Worker acts as a secure proxy for TMDB and xAI LLM while requiring a simple shared password.
 *
 * Secrets required:
 * - TMDB_TOKEN: Your TMDB v3 API Key or v4 Read Access Token
 * - XAI_TOKEN: Your xAI API key (for the Curator chatbot)
 * - PASSWORD: The shared password for Basic Auth
 *
 * TMDB calls: /api/tmdb/{path}
 * LLM calls (POST): /api/llm  (body = OpenAI compatible chat.completions payload, key injected server-side)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // === 1. Authentication Check ===
    if (!isAuthenticated(request, env)) {
      return new Response('Unauthorized - Please log in', {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          'WWW-Authenticate': 'Basic realm="Brous"',
        },
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    // === 2. Generic TMDB Proxy ===
    if (pathname.startsWith('/api/tmdb/')) {
      const tmdbPath = pathname.replace('/api/tmdb', ''); // e.g. /3/discover/movie?...
      const tmdbUrl = new URL(`https://api.themoviedb.org${tmdbPath}${url.search}`);

      const headers = {
        'Accept': 'application/json',
      };

      // Add TMDB authentication
      if (!env.TMDB_TOKEN) {
        const available = Object.keys(env).filter(k => !k.startsWith('CF_') && !k.startsWith('__'));
        return jsonResponse({ 
          error: 'TMDB_TOKEN secret is not configured', 
          availableSecrets: available,
          note: 'The secret must be named exactly "TMDB_TOKEN" (case sensitive) in the dashboard for THIS Worker. If you see it listed but the error persists, redeploy the Worker code.'
        }, 500);
      }

      if (env.TMDB_TOKEN.startsWith('eyJ')) {
        // v4 Read Access Token
        headers['Authorization'] = `Bearer ${env.TMDB_TOKEN}`;
      } else {
        // v3 API Key
        tmdbUrl.searchParams.set('api_key', env.TMDB_TOKEN);
      }

      // Forward the request to TMDB
      const tmdbResponse = await fetch(tmdbUrl.toString(), {
        method: request.method,
        headers,
        body: request.body,
        cf: {
          cacheTtl: 300,           // Cache for 5 minutes
          cacheEverything: true,
        },
      });

      const data = await tmdbResponse.json();

      return new Response(JSON.stringify(data), {
        status: tmdbResponse.status,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        },
      });
    }

    // === 3. LLM Proxy (for The Curator chatbot; OpenAI-compatible, key injected server-side) ===
    if (pathname === '/api/llm' || pathname === '/api/llm/') {
      if (request.method !== 'POST') {
        return jsonError('Method not allowed for /api/llm; use POST with chat.completions payload', 405);
      }
      if (!env.XAI_TOKEN) {
        return jsonError('XAI_TOKEN secret not configured (Curator requires it in Worker env)', 500);
      }

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return jsonError('Invalid JSON in request body', 400);
      }

      // Never trust/forward any key from client
      delete body.api_key;
      delete body.key;
      delete body.openai_api_key;

      // Default to xAI endpoint (supports other OpenAI-compat if you extend worker with more secrets + routing)
      const llmUrl = 'https://api.x.ai/v1/chat/completions';

      const llmResponse = await fetch(llmUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.XAI_TOKEN}`,
        },
        body: JSON.stringify(body),
      });

      const contentType = llmResponse.headers.get('content-type') || '';
      if (contentType.includes('text/event-stream') || (body && body.stream)) {
        // Pipe streaming response for real-time tokens in chat
        return new Response(llmResponse.body, {
          status: llmResponse.status,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...CORS_HEADERS,
          },
        });
      }

      const data = await llmResponse.json();
      return new Response(JSON.stringify(data), {
        status: llmResponse.status,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        },
      });
    }

    // === 4. Server-side Data Sync (for cross-device persistence of watched / disliked / to-watch / chat) ===
    // Requires a KV namespace bound as DATA_KV in the Worker settings.
    // After attaching the binding (even from the KV namespace page), you MUST click "Deploy" on the Worker.
    if (pathname === '/api/data') {
      if (!env.DATA_KV) {
        return jsonResponse({
          error: 'DATA_KV binding not configured',
          instructions: 'In Cloudflare dashboard: Workers & Pages > your Worker > Settings > Variables > KV Namespace Bindings. Create a KV namespace (e.g. HORROR_ROKI_DATA) and bind it as DATA_KV. Then redeploy the Worker.',
        }, 501);
      }

      const DATA_KEY = 'roki_data_v1';

      if (request.method === 'GET') {
        const data = await env.DATA_KV.get(DATA_KEY, { type: 'json' }) || {};
        return jsonResponse(data);
      }

      if (request.method === 'POST') {
        let payload;
        try {
          payload = await request.json();
        } catch (e) {
          return jsonError('Invalid JSON payload for /api/data', 400);
        }
        // Store the full backup-style object (watched, to_watch, disliked, chat_history, etc.)
        await env.DATA_KV.put(DATA_KEY, JSON.stringify(payload));
        return jsonResponse({ success: true, saved_at: new Date().toISOString() });
      }

      return jsonError('Method not allowed for /api/data (use GET or POST)', 405);
    }

    // === 5. Health Check / Info ===
    if (pathname === '/' || pathname === '/api' || pathname === '/api/health') {
      return jsonResponse({
        ok: true,
        service: 'Brous / Horror Roki - TMDB + LLM Proxy + Auth + KV Data',
        version: '3.1.0',
        note: 'TMDB via /api/tmdb/* ; LLM (Curator) via POST /api/llm ; Data sync via GET/POST /api/data . Password required.',
        features: ['tmdb-proxy', 'llm-proxy-xai', 'basic-auth', 'kv-data-sync'],
      });
    }

    return jsonError('Not found', 404);
  },
};

// ===================== Helpers =====================

function isAuthenticated(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return false;
  }

  try {
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = atob(base64Credentials);
    const [, password] = credentials.split(':');

    return password === env.PASSWORD;
  } catch (err) {
    return false;
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

function jsonError(message, status = 400) {
  return jsonResponse({ error: message }, status);
}
