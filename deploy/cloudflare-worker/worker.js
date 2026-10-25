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

    // === 2b. IMDb ratings lookup (batch) ===
    // GET /api/ratings?ids=tt0084787,tt1179933 -> {"tt0084787":{"r":8.2,"v":530446},...}
    //
    // Backs the rec engine's quality scoring. TMDB's vote counts are thin for the obscure
    // horror this app surfaces — on the live Cosmic Horror pool the median title had 205
    // TMDB votes against 9,730 on IMDb — so ranking on TMDB alone leans almost entirely on
    // the Bayesian prior rather than on real data. Data comes from IMDb's public bulk dump
    // via scripts/load-imdb-ratings.js; there is no free IMDb API to call live.
    //
    // Deliberately unauthenticated, like the TMDB proxy above: IMDb ratings are public
    // data, this reads a table nothing can write to, and requiring the shared password
    // here would break scoring for anyone browsing without having set it.
    if (pathname === '/api/ratings' || pathname === '/api/ratings/') {
      if (!env.RATINGS_DB) {
        return jsonResponse({ error: 'RATINGS_DB binding is not configured on this Worker' }, 500, request);
      }

      // Validate hard, for two reasons. These ids are interpolated into an IN (...) list,
      // so anything that isn't strictly tt+digits has no business reaching the query; and
      // an unbounded list would let one request read the whole table. 400 is the batch the
      // client actually needs (refreshRecPool builds ~350 titles) with a little headroom.
      const raw = (url.searchParams.get('ids') || '').split(',');
      const ids = [...new Set(raw.map(s => s.trim()).filter(s => /^tt\d+$/.test(s)))].slice(0, 400);

      if (!ids.length) {
        // Not an error — a pool where TMDB knew no imdb_ids is legitimately empty.
        return jsonResponse({}, 200, request);
      }

      try {
        // D1 rejects more than 100 bound variables in a single statement
        // ("too many SQL variables"), so a realistic pool — refreshRecPool builds 350 —
        // cannot go in one IN (...) list. Split into chunks of 100 and hand the whole set
        // to .batch(), which runs them in one round trip rather than N sequential awaits.
        const CHUNK = 100;
        const statements = [];
        for (let i = 0; i < ids.length; i += CHUNK) {
          const chunk = ids.slice(i, i + CHUNK);
          statements.push(
            env.RATINGS_DB
              .prepare(`SELECT tconst, rating, votes FROM imdb_ratings WHERE tconst IN (${chunk.map(() => '?').join(',')})`)
              .bind(...chunk)
          );
        }
        const batched = await env.RATINGS_DB.batch(statements);

        // Keyed by tconst so the client can merge by lookup instead of scanning an array.
        // Short field names because this response can carry 400 entries and the whole
        // point is that it costs less than 400 round trips.
        const out = {};
        for (const res of batched) {
          for (const row of (res.results || [])) {
            out[row.tconst] = { r: row.rating, v: row.votes };
          }
        }
        // Missing ids are simply absent rather than null-filled — the caller already has
        // to handle "no IMDb data for this title" (titles below the loader's vote floor,
        // or too new to be in the last dump), so absence is the same case as unknown.
        return jsonResponse(out, 200, request);
      } catch (err) {
        // Fail soft: scoring falls back to TMDB-only if this errors, so a 502 here
        // degrades ranking rather than breaking the grid.
        return jsonResponse({ error: 'ratings lookup failed: ' + (err && err.message || 'unknown') }, 502, request);
      }
    }

    // === 3. LLM Proxy (for The Curator chatbot; OpenAI-compatible, key injected server-side) ===
    if (pathname === '/api/llm' || pathname === '/api/llm/') {
      {
        // Fail closed: without a PASSWORD secret this endpoint stays locked rather than open.
        if (!env.PASSWORD) {
          return jsonError('PASSWORD secret is not configured on this Worker', 500, request);
        }
        if (await isRateLimited(request, env)) {
          return jsonError('Too many failed attempts. Try again in a few minutes.', 429, request);
        }
        if (!(await isAuthenticated(request, env))) {
          await recordFailedAttempt(request, env);
          return jsonError('Unauthorized (wrong or missing password)', 401, request);
        }
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
      {
        // Fail closed: without a PASSWORD secret this endpoint stays locked rather than open.
        if (!env.PASSWORD) {
          return jsonError('PASSWORD secret is not configured on this Worker', 500, request);
        }
        if (await isRateLimited(request, env)) {
          return jsonError('Too many failed attempts. Try again in a few minutes.', 429, request);
        }
        if (!(await isAuthenticated(request, env))) {
          await recordFailedAttempt(request, env);
          return jsonError('Unauthorized (wrong or missing password)', 401, request);
        }
      }
      if (!env.DATA_KV) {
        return jsonResponse({
          error: 'DATA_KV binding not configured',
          instructions: 'In Cloudflare dashboard: Workers & Pages > your Worker > Settings > Variables > KV Namespace Bindings. Bind your KV namespace as DATA_KV. Then redeploy the Worker.',
        }, 501, request);
      }

      // Per-profile storage key. Each person (see js/profiles.js) gets an isolated KV
      // entry, so one profile's sync can never overwrite another's. The primary profile
      // ('me', or a request with no profile param at all) keeps the ORIGINAL unsuffixed
      // key — that's the data that existed before profiles, and it must stay exactly
      // where it is, readable by any client that predates this change.
      //
      // The id is whitelisted rather than interpolated blind: it becomes part of a KV
      // key, so an unvalidated value would let a caller read or clobber arbitrary keys
      // in this namespace (including the _meta/_backup entries and the rate-limit
      // records). Anything not matching the pattern is rejected outright rather than
      // silently coerced to the primary profile, which would misfile a write.
      const profileParam = url.searchParams.get('profile');
      if (profileParam !== null && !/^[a-z0-9_-]{1,24}$/.test(profileParam)) {
        return jsonError('Invalid profile id', 400, request);
      }
      const profileId = profileParam || 'me';
      const DATA_KEY = profileId === 'me' ? 'roki_data_v1' : `roki_data_v1__${profileId}`;

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

    // === 4b. Play queue (phone -> Streaming Engine on the home Mac) ===
    // The Streaming Engine is plain http on the home network, which an https page (and
    // any phone off the Wi-Fi) can't call directly. So the browser drops a "play this"
    // job here, and the engine — which only ever makes OUTBOUND requests — polls for it:
    //   POST /api/play          browser queues {title, year, mediaType, services}
    //   GET  /api/play/status   browser polls one job by ?id=
    //   GET  /api/play/engine   browser asks whether an engine has checked in lately
    //   GET  /api/play/next     engine claims the oldest pending job (also its heartbeat)
    //   POST /api/play/result   engine reports {id, ok, message}
    // Everything needs the shared PASSWORD. D1 is used rather than KV because KV reads can
    // be stale for tens of seconds, which would make Play feel broken.
    if (pathname.startsWith('/api/play')) {
      const denied = await requirePassword(request, env);
      if (denied) return denied;
      if (!env.RATINGS_DB) {
        return jsonError('RATINGS_DB binding is not configured on this Worker', 500, request);
      }
      try {
        await ensurePlaySchema(env.RATINGS_DB);
        return await handlePlayQueue(request, env, pathname, url);
      } catch (err) {
        return jsonError('play queue error: ' + (err && err.message || 'unknown'), 500, request);
      }
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

// Hashes both sides with SHA-256 before comparing so neither the password length
// nor a byte-by-byte early exit can leak timing information to a network attacker.
async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
}

async function isAuthenticated(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return false;
  }

  try {
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = atob(base64Credentials);
    // Only the first colon separates user from password; the password itself may contain ':'.
    const sep = credentials.indexOf(':');
    const password = sep < 0 ? '' : credentials.slice(sep + 1);

    return await timingSafeEqual(password || '', env.PASSWORD);
  } catch (err) {
    return false;
  }
}

// Per-IP rate limiting on failed password attempts, backed by the same DATA_KV
// namespace already required for data sync — no separate setup needed. Only
// FAILED attempts count against the limit; a correct password never gets
// penalized, and past attempts age out automatically via KV's expirationTtl
// (no cleanup job needed). This is a soft limit, not a hard guarantee — Workers
// KV is eventually consistent, so a burst of near-simultaneous requests from the
// same IP could each read the same pre-increment count before any write lands.
// That's an acceptable gap for slowing down casual brute-forcing of a single
// shared password; it isn't meant to be airtight.
const RATE_LIMIT_MAX_ATTEMPTS = 8;
const RATE_LIMIT_WINDOW_SECONDS = 300; // 5 minutes

function rateLimitKeyFor(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return `ratelimit_${ip}`;
}

async function isRateLimited(request, env) {
  if (!env.DATA_KV) return false; // no KV bound — fail open, same posture as the rest of this file when DATA_KV is missing
  try {
    const record = await env.DATA_KV.get(rateLimitKeyFor(request), { type: 'json' });
    return !!(record && record.count >= RATE_LIMIT_MAX_ATTEMPTS);
  } catch (e) {
    return false; // KV read failure shouldn't lock everyone out
  }
}

async function recordFailedAttempt(request, env) {
  if (!env.DATA_KV) return;
  try {
    const key = rateLimitKeyFor(request);
    const record = await env.DATA_KV.get(key, { type: 'json' });
    const count = (record && record.count || 0) + 1;
    await env.DATA_KV.put(key, JSON.stringify({ count }), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  } catch (e) {
    // best-effort — a failed write here shouldn't block returning the 401 to the client
  }
}

// Shared password gate (same rules as /api/llm and /api/data): fail closed when no
// PASSWORD is configured, rate-limit repeated failures. Returns a Response to send back,
// or null when the caller is allowed through.
async function requirePassword(request, env) {
  if (!env.PASSWORD) {
    return jsonError('PASSWORD secret is not configured on this Worker', 500, request);
  }
  if (await isRateLimited(request, env)) {
    return jsonError('Too many failed attempts. Try again in a few minutes.', 429, request);
  }
  if (!(await isAuthenticated(request, env))) {
    await recordFailedAttempt(request, env);
    return jsonError('Unauthorized (wrong or missing password)', 401, request);
  }
  return null;
}

// ===================== Play queue =====================
const PLAY_JOB_TTL_MS = 45 * 1000;       // a job nobody claims in this long is dropped
const ENGINE_ONLINE_MS = 15 * 1000;      // engine counts as online if it polled this recently
const PLAY_MIN_GAP_MS = 2 * 1000;        // at most one new job every couple of seconds

let _playSchemaReady = false;
async function ensurePlaySchema(db) {
  if (_playSchemaReady) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS play_jobs (id TEXT PRIMARY KEY, title TEXT NOT NULL, year TEXT, media_type TEXT, services TEXT, status TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS play_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)'),
  ]);
  _playSchemaReady = true;
}

async function handlePlayQueue(request, env, pathname, url) {
  const db = env.RATINGS_DB;
  const now = Date.now();
  const route = pathname.replace(/\/+$/, '');

  if (route === '/api/play' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch (_) { return jsonError('Invalid JSON', 400, request); }
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (title.length < 2 || title.length > 200) return jsonError('Missing title', 400, request);
    const year = /^\d{4}$/.test(String(body.year || '').slice(0, 4)) ? String(body.year).slice(0, 4) : '';
    const mediaType = body.mediaType === 'tv' ? 'tv' : 'movie';
    const services = (Array.isArray(body.services) ? body.services : [])
      .filter(x => typeof x === 'string' && /^[a-z]{2,12}$/.test(x)).slice(0, 20);

    const recent = await db.prepare('SELECT 1 AS x FROM play_jobs WHERE created_at > ? LIMIT 1').bind(now - PLAY_MIN_GAP_MS).first();
    if (recent) return jsonError('Slow down — a play request just went out', 429, request);

    const id = crypto.randomUUID();
    await db.batch([
      db.prepare('DELETE FROM play_jobs WHERE created_at < ?').bind(now - 24 * 3600 * 1000),
      db.prepare('INSERT INTO play_jobs (id, title, year, media_type, services, status, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, title, year, mediaType, JSON.stringify(services), 'pending', '', now, now),
    ]);
    return jsonResponse({ id }, 200, request);
  }

  if (route === '/api/play/status' && request.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    if (!/^[0-9a-f-]{36}$/.test(id)) return jsonError('Invalid id', 400, request);
    const row = await db.prepare('SELECT status, message, created_at FROM play_jobs WHERE id = ?').bind(id).first();
    if (!row) return jsonError('Unknown job', 404, request);
    if (row.status === 'pending' && now - row.created_at > PLAY_JOB_TTL_MS) {
      const msg = "The Streaming Engine didn't pick this up. Is it running on your Mac?";
      await db.prepare("UPDATE play_jobs SET status = 'expired', message = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(msg, now, id).run();
      return jsonResponse({ status: 'expired', message: msg }, 200, request);
    }
    return jsonResponse({ status: row.status, message: row.message || '' }, 200, request);
  }

  if (route === '/api/play/engine' && request.method === 'GET') {
    const row = await db.prepare("SELECT v FROM play_meta WHERE k = 'engine_seen'").first();
    return jsonResponse({ online: !!(row && now - row.v < ENGINE_ONLINE_MS) }, 200, request);
  }

  if (route === '/api/play/next' && request.method === 'GET') {
    await db.prepare("INSERT INTO play_meta (k, v) VALUES ('engine_seen', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(now).run();
    // Claim in one statement so two pollers can never both get the same job.
    const claimed = await db.prepare(
      "UPDATE play_jobs SET status = 'claimed', updated_at = ? WHERE id = (SELECT id FROM play_jobs WHERE status = 'pending' AND created_at > ? ORDER BY created_at LIMIT 1) RETURNING id, title, year, media_type, services"
    ).bind(now, now - PLAY_JOB_TTL_MS).all();
    const job = claimed.results && claimed.results[0];
    if (!job) return jsonResponse({ job: null }, 200, request);
    let services = [];
    try { services = JSON.parse(job.services || '[]'); } catch (_) {}
    return jsonResponse({ job: { id: job.id, title: job.title, year: job.year || '', mediaType: job.media_type, services } }, 200, request);
  }

  if (route === '/api/play/result' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch (_) { return jsonError('Invalid JSON', 400, request); }
    const id = String(body.id || '');
    if (!/^[0-9a-f-]{36}$/.test(id)) return jsonError('Invalid id', 400, request);
    const message = String(body.message || '').slice(0, 300);
    await db.prepare("UPDATE play_jobs SET status = ?, message = ?, updated_at = ? WHERE id = ? AND status = 'claimed'")
      .bind(body.ok ? 'done' : 'failed', message, now, id).run();
    return jsonResponse({ ok: true }, 200, request);
  }

  return jsonError('Not found', 404, request);
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
