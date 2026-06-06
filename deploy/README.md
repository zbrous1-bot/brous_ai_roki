# Horror Roki

**Horror Roki** is a beautiful, installable, no-server personal horror movie companion.

- Personalized "Recommended for you" (taste boost from your Watched library, mood chips: Slow burn / Folk / etc.)
- Explicit To Watch + Watched + Disliked lists (items disappear from recs/search — the reliable title/id filter)
- Full "The Curator" chatbot (streaming, strictly grounded, no spoilers, list-respecting, SUGGESTED cards + BATCH_RATE with partial apply)
- Search + Discover (with "My services" filter for where to watch)
- Stats via your lists, full JSON backup/restore (incl. chat history + llm config), Letterboxd-friendly import
- All data in browser only. TMDB + xAI calls proxied via your Cloudflare Worker (keys never in browser).

**Live:** https://horror-roki.pages.dev/

Converted from the rich Streamlit Brous Movie Dashboard + Curator to this immersive static experience matching the superior look & feel.

## Features

- **Recommended for you** — client-side taste boost from Watched (with rating love weighting) + mood filters
- **To Watch / Watched / Disliked** full library management with reliable removal from recs (title+id filter)
- **The Curator** 👻 — full featured horror chatbot (grok-4.3 via Worker, per-turn grounding + live TMDB, SUGGESTED actionable cards, BATCH_RATE UI, explicit 🧹/🪦 clears, history persisted)
- **Search + Discover** horror titles, "My services only", providers/availability
- **Backup & Import** — one JSON holds everything (lists + chat + llm prefs); tolerant of old versions
- PWA installable, mobile-first, beautiful dark horror aesthetic (Tailwind + custom cards)
- Worker proxies both TMDB and LLM (xAI_TOKEN + PASSWORD secrets) — keys never exposed

## Getting Started

1. Open the app using the password-protected Worker URL
2. Check the services you subscribe to in **My Services**
3. Start searching or using Discover

**Note:** The TMDB API key is now stored securely in a Cloudflare Worker (not exposed in the browser). You no longer need to enter it in the app.

## Self-Hosting / Deployment

Brous is a completely static site (no backend). You can host it anywhere that supports static files.

### Recommended: Cloudflare Pages (Current Setup)
- Unlimited bandwidth on the free plan
- Automatic deployments from GitHub
- Excellent global performance

**Exact setup for this repo:**

1. In Cloudflare dashboard → Pages → Create a project → Connect to Git → select the `brous-streaming` repo.
2. Set:
   - **Root directory**: `deploy`
   - **Build command**: (leave empty or `echo "static site"`)
   - **Build output directory**: `.` (or `deploy` depending on your Pages config — the files in `deploy/` become the site root)
3. Save and deploy. Future `git push` to `main` will auto-deploy.

**Important: The Cloudflare Worker (required for TMDB + The Curator)**

The app calls `/api/tmdb/...` and `POST /api/llm` (for Curator). Worker must:
- Inject real TMDB key + XAI_TOKEN (for grok-4.3 Curator)
- Enforce Basic Auth password (shared secret)

- Worker source: `deploy/cloudflare-worker/worker.js` (now includes full LLM streaming proxy)
- Deploy as Cloudflare Worker (Wrangler or dashboard).
- **Secrets** (Worker settings):
  - `TMDB_TOKEN` (v3 key or `eyJ...` v4)
  - `XAI_TOKEN` (your x.ai key for The Curator; optional if you don't use chat)
  - `PASSWORD` (shared; e.g. `mysecret123`)
- **Routes** (Worker → Triggers → Routes):
  - `your-project.pages.dev/api/tmdb*`
  - `your-project.pages.dev/api/llm*`
  (add for custom domains too)

On first visit: click 🔐 Pass (or Settings) and enter the PASSWORD. Then use Search/Discover/Refresh Pool/Curator.

Once deployed:
- Visit your Pages URL.
- Click the **🔐 Pass** button (top right) and enter the exact `PASSWORD` you set in the Worker secret.
- The first time you use Discover or Search it will also prompt.
- The button turns into "🔐 OK" when a password is saved for that browser.

If you see "Error loading results..." it almost always means:
- Password not entered yet in the app (use the button), or
- Wrong value for the `PASSWORD` secret, or
- `TMDB_TOKEN` secret missing, or
- The Worker Route is not set (so /api calls 404 or hit Pages directly).

### Other Good Options
- GitHub Pages
- Netlify
- Vercel
- Render Static Sites

## Tech Stack

- Vanilla HTML, CSS, and JavaScript
- Tailwind CSS (via CDN)
- The Movie Database (TMDB) API

## Credits

Movie and TV data provided by [The Movie Database (TMDB)](https://www.themoviedb.org/).

---

This project started as a personal tool to solve inconsistent search results across streaming apps. It is no longer tied to any specific device or remote control features.