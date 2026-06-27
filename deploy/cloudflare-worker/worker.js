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

// Allowed origins for browser calls to this Worker. Add any domain you self-host
// the static site on (custom domains, other pages.dev previews, localhost for dev).
// Wildcard CORS ('*') let any website on the internet call /api/data and /api/llm
// using a visitor's browser as a relay — restricting Allow-Origin to known hosts closes
// that off without affecting normal use of the app from its real site(s).
const ALLOWED_ORIGINS = [
  'https://horror-roki.pages.dev',
  'https://brous-movie-engine.pages.dev',
  'http://localhost:8788',   // wrangler pages dev default port
  'http://localhost:3000',
  'http://127.0.0.1:8788',
];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const CORS_HEADERS = corsHeaders(request);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    // TMDB proxy below is intentionally open (no password) — the TMDB token is
    // protected server-side and TMDB data is not sensitive. /api/data and
    // /api/llm DO require the shared PASSWORD (via isAuthenticated below) since
    // they expose your synced library and can incur xAI usage costs.

    // === 2. Generic TMDB Proxy ===
    if (pathname.startsWith('/api/tmdb/')) {
      const tmdbPath = pathname.replace('/api/tmdb', ''); // e.g. /3/discover/movie?...
      const tmdbUrl = new URL(`https://api.themoviedb.org${tmdbPath}${url.search}`);

      const headers = {
        'Accept': 'application/json',
      };

      // Add TMDB authentication
      if (!env.TMDB_TOKEN) {
        // Note: deliberately NOT echoing Object.keys(env) here — that would hand an
        // attacker the exact names of every secret configured on this Worker (e.g.
        // confirming XAI_TOKEN exists) for free. Check the Cloudflare dashboard instead.
        return jsonResponse({
          error: 'TMDB_TOKEN secret is not configured',
          note: 'The secret must be named exactly "TMDB_TOKEN" (case sensitive) in the dashboard for THIS Worker. If you see it listed but the error persists, redeploy the Worker code.'
        }, 500, request);
      }

      if (env.TMDB_TOKEN.startsWith('eyJ')) {
        // v4 Read Access Token
        headers['Authorization'] = `Bearer ${env.TMDB_TOKEN}`;
      } else {
        // v3 API Key
        tmdbUrl.searchParams.set('api_key', env.TMDB_TOKEN);
      }

      // Per-endpoint cache TTL. Static-ish TMDB data (a film's details, credits,
      // keywords, genre list, collections) effectively never changes, so it can be
      // cached at Cloudflare's edge for a long time — repeated detail/affinity lookups
      // then return instantly and don't burn the TMDB rate limit. Time-sensitive feeds
      // (trending, discover, popular, top_rated) get a short TTL so the pool still
      // refreshes. Only GETs are cached.
      function tmdbCacheTtl(path) {
        if (request.method !== 'GET') return 0;
        if (/\/(credits|keywords|videos|images|watch\/providers|external_ids)(\?|$)/.test(path)) return 86400; // 1 day
        if (/\/collection\//.test(path)) return 86400;
        if (/\/genre\/.*\/list/.test(path)) return 604800; // 7 days — genre list is basically static
        if (/\/(movie|tv)\/\d+(\?|$)/.test(path)) return 21600; // 6h — a title's core details
        if (/\/(trending|discover|popular|top_rated|now_playing|airing_today|on_the_air|upcoming)/.test(path)) return 600; // 10 min
        if (/\/search\//.test(path)) return 600;
        return 300; // sensible default for anything else
      }
      const cacheTtl = tmdbCacheTtl(tmdbPath);

      // Forward the request to TMDB. Wrap in try/catch with one retry so a
      // transient TMDB failure (rate limit / connection reset) returns a clean
      // JSON error WITH CORS headers instead of crashing the Worker — a crash
      // produces a response with no CORS headers, which the browser reports as
      // "Failed to fetch" and which hangs the client UI.
      async function fetchTmdb() {
        const resp = await fetch(tmdbUrl.toString(), {
          method: request.method,
          headers,
          body: request.body,
          cf: cacheTtl > 0 ? { cacheTtl, cacheEverything: true } : { cacheTtl: 0 },
        });
        const text = await resp.text();
        let json;
        try { json = JSON.parse(text); }
        catch (_) { throw new Error('TMDB returned non-JSON (status ' + resp.status + ')'); }
        return { status: resp.status, json };
      }

      try {
        let result;
        try {
          result = await fetchTmdb();
        } catch (e1) {
          // brief backoff then one retry
          await new Promise(r => setTimeout(r, 350));
          result = await fetchTmdb();
        }
        return new Response(JSON.stringify(result.json), {
          status: result.status,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      } catch (err) {
        return jsonResponse({ error: 'TMDB upstream error: ' + (err && err.message || 'unknown') }, 502, request);
      }
    }

    // === 3. LLM Proxy (for The Curator chatbot; OpenAI-compatible, key injected server-side) ===
    if (pathname === '/api/llm' || pathname === '/api/llm/') {
      if (env.PASSWORD && !isAuthenticated(request, env)) {
        return jsonError('Unauthorized (wrong or missing password)', 401, request);
      }
      if (request.method !== 'POST') {
        return jsonError('Method not allowed for /api/llm; use POST with chat.completions payload', 405, request);
      }
      if (!env.XAI_TOKEN) {
        return jsonError('XAI_TOKEN secret not configured (Curator requires it in Worker env)', 500, request);
      }

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return jsonError('Invalid JSON in request body', 400, request);
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

    // === 4. Server side Data Sync ===
    // GET  /api/data         load the shared library
    // POST /api/data         save the shared library
    // GET  /api/data/check   check whether shared data exists
    // GET  /api/data/backup  recover the previous snapshot
    if (pathname === '/api/data' || pathname === '/api/data/check' || pathname === '/api/data/backup') {
      if (env.PASSWORD && !isAuthenticated(request, env)) {
        return jsonError('Unauthorized (wrong or missing password)', 401, request);
      }
      if (!env.DATA_KV) {
        return jsonResponse({
          error: 'DATA_KV binding not configured',
          instructions: 'In Cloudflare dashboard: Workers & Pages > your Worker > Settings > Variables > KV Namespace Bindings. Bind your KV namespace as DATA_KV. Then redeploy the Worker.',
        }, 501, request);
      }

      const DATA_KEY = 'roki_data_v1';

      if (pathname === '/api/data/check') {
        const meta = await env.DATA_KV.get(DATA_KEY + '_meta', { type: 'json' });
        if (!meta) return jsonResponse({ exists: false }, 200, request);
        return jsonResponse({ exists: true, saved_at: meta.saved_at, count: meta.count }, 200, request);
      }

      // GET /api/data/backup — recover the previous snapshot (the version that existed
      // right before the most recent save). Manual disaster-recovery escape hatch.
      if (pathname === '/api/data/backup') {
        if (request.method !== 'GET') {
          return jsonError('Method not allowed (use GET)', 405, request);
        }
        const backup = await env.DATA_KV.get(DATA_KEY + '_backup', { type: 'json' });
        if (!backup) return jsonResponse({ exists: false }, 200, request);
        return jsonResponse(backup, 200, request);
      }

      if (request.method === 'GET') {
        const data = await env.DATA_KV.get(DATA_KEY, { type: 'json' }) || {};
        return jsonResponse(data, 200, request);
      }

      if (request.method === 'POST') {
        let payload;
        try { payload = await request.json(); } catch (e) {
          return jsonError('Invalid JSON payload', 400, request);
        }

        // Stale-write guard (optimistic concurrency): the client must tell us which
        // server version it last pulled, via base_synced_at. If the server's current
        // saved_at doesn't match, someone else has written since this client last synced
        // — reject so we don't silently clobber those changes. Pass ?force=1 to bypass
        // (used for explicit user-initiated overwrite actions, e.g. first-time setup).
        const force = url.searchParams.get('force') === '1';
        if (!force) {
          const existingMeta = await env.DATA_KV.get(DATA_KEY + '_meta', { type: 'json' });
          if (existingMeta && existingMeta.saved_at) {
            if (payload.base_synced_at !== existingMeta.saved_at) {
              return jsonError(
                'Stale write rejected: server data has changed since this client last synced. Pull the latest data and retry.',
                409,
                request
              );
            }
          }
        }

        // Snapshot the current value as a backup before overwriting, so a bad/partial
        // push is always recoverable. Best-effort — never blocks the save.
        try {
          const previous = await env.DATA_KV.get(DATA_KEY);
          if (previous) {
            await env.DATA_KV.put(DATA_KEY + '_backup', previous);
          }
        } catch (e) {
          // Backup failure should never block a save.
        }

        const count = (payload.watched||[]).length + (payload.to_watch||[]).length;
        const saved_at = new Date().toISOString();
        await env.DATA_KV.put(DATA_KEY, JSON.stringify(payload));
        await env.DATA_KV.put(DATA_KEY + '_meta', JSON.stringify({ saved_at, count }));
        return jsonResponse({ success: true, saved_at, count }, 200, request);
      }

      return jsonError('Method not allowed (use GET or POST)', 405, request);
    }

    // === 5. Health Check / Info ===
    if (pathname === '/' || pathname === '/api' || pathname === '/api/health') {
      return jsonResponse({
        ok: true,
        service: 'Brous / Horror Roki - TMDB + LLM Proxy + Auth + KV Data',
        version: '3.4.0',
        note: 'TMDB via /api/tmdb/* (open, no password). LLM (Curator) via POST /api/llm and data sync via GET/POST /api/data both require the shared PASSWORD secret when one is configured.',
        features: ['tmdb-proxy', 'llm-proxy-xai', 'basic-auth', 'kv-data-sync'],
      }, 200, request);
    }

    return jsonError('Not found', 404, request);
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

function jsonResponse(data, status = 200, request = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Explicit no-store: API responses must never be cached at Cloudflare's edge
      // or by browsers. Without this, default cache heuristics on workers.dev can
      // serve a stale snapshot of /api/health (or worse, stale /api/data) long
      // after the Worker has been redeployed with new code.
      'Cache-Control': 'no-store',
      ...(request ? corsHeaders(request) : {}),
    },
  });
}

function jsonError(message, status = 400, request = null) {
  return jsonResponse({ error: message }, status, request);
}
