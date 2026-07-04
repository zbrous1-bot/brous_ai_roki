// Cloudflare Pages Function — catches every request under /api/* (the [[path]]
// filename is Pages' catch-all-segments syntax) and hands it straight to the same
// fetch handler the standalone horror-roki Worker uses. This is what lets the
// Pages project and the Worker be combined onto one domain: index.html can call
// relative /api/... paths instead of a separate workers.dev URL, with no CORS
// needed since everything becomes same-origin.
//
// Deliberately a thin adapter rather than a rewrite — worker.js stays the single
// source of truth for the actual proxy/auth/sync logic (and can still be deployed
// standalone via `npm run deploy:worker` if ever needed), so this file has almost
// nothing of its own to go wrong.
import worker from '../../cloudflare-worker/worker.js';

export const onRequest = (context) => worker.fetch(context.request, context.env);
