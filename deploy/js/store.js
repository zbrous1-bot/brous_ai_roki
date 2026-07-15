    // ============================================================================
    // TABLE OF CONTENTS — search for the "// ===== NAME =====" heading to jump in.
    //   Store              single point of access for localStorage (key naming,
    //                       one-time migration, per-key JSON parse safety)
    //   UI Helpers          overflow menus, toasts, skeletons, swipe gestures,
    //                       the shared apiFetch() TMDB wrapper
    //   Discover + Filters  Browse tab's genre/rating/decade chips + Discover feed
    //   Watchlist           legacy quick-add "My List" (search/discover context)
    //   Full Library        To Watch / Watched / Disliked / Not Interested lists
    //   Server Sync         cross-device sync against the Worker's /api/data
    //   Main Page Tabs      For You / Curator / Browse / Library tab switching
    //   Modal               the detail modal (poster, overview, availability)
    //   Search              title search, director/writer/actor name fallback
    //   Horror Roki Recs + Taste   taste profile, scoring, the recs grid
    //   The Curator         chat history, streaming /api/llm, SUGGESTED parsing
    //   Device Transfer     QR/link-based data transfer (no server needed)
    // Settings, boot/init, and password management follow after Device Transfer
    // and aren't individually labeled below this line.
    // ============================================================================

    // Single source of truth for the frontend's version marker — shown in the
    // footer and logged on boot. Previously the footer text was just a hardcoded
    // string with no relationship to anything else; update this one constant
    // instead (the footer's static fallback text below should still match it,
    // in case JS hasn't finished booting when someone checks).
    const APP_VERSION = 'v2026-07';

    // Global error catcher to show genuine init failures visibly.
    window.addEventListener('error', function(e) {
      console.error('Global JS error:', e);
      // Ignore sanitized cross-origin errors ("Script error." with no filename).
      // These come from CDN scripts (Tailwind/pako/qrcode), are non-actionable,
      // and do NOT mean the app failed — showing a scary banner for them is a
      // false alarm. Also ignore once the app has successfully initialized.
      var isCrossOriginNoise = (e.message === 'Script error.' || !e.message) && !e.filename;
      if (isCrossOriginNoise || window.__appInitialized) return;
      var banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#b91c1c;color:#fff;padding:10px 15px;z-index:999999;font-size:13px;font-family:monospace;';
      banner.innerHTML = 'JS ERROR: ' + (e.message || e) + ' (see browser Console F12 for details). App may not have initialized.';
      if (document.body) document.body.insertBefore(banner, document.body.firstChild);
      else document.addEventListener('DOMContentLoaded', function() { document.body.insertBefore(banner, document.body.firstChild); });
    });

    // ===================== Store: single point of access for localStorage =====================
    // This app accumulated three inconsistent key-naming schemes over time
    // (brous_*, horror_roki_*, and two bare names — tasteProfileCollapsed,
    // roki_rec_tune). Store maps every one of them to a single consistent
    // brous_* name internally, and every localStorage.getItem/setItem/removeItem
    // call in the file goes through Store instead so there's one place that
    // understands the actual key names in use. On first load after this change,
    // migrate() copies each old key's value forward (if the new key doesn't
    // already have one) and removes the old key, guarded by brous_migrated_v1 so
    // it only ever runs once per browser. Existing call sites keep using the OLD
    // key string as the argument — Store resolves it to the real, migrated key —
    // so this was a drop-in swap (localStorage. -> Store.) with no call sites
    // needing to change their key names.
    const Store = (() => {
      const KEY_MAP = {
        'brous_password': 'brous_password',
        'brous_watchlist': 'brous_watchlist',
        'brous_api_base': 'brous_api_base',
        'brous_cloud_pin': 'brous_cloud_pin',
        'horror_roki_towatch': 'brous_towatch',
        'horror_roki_watched': 'brous_watched',
        'horror_roki_disliked': 'brous_disliked',
        'horror_roki_not_interested': 'brous_not_interested',
        'horror_roki_chat': 'brous_chat',
        'horror_roki_llm': 'brous_llm_config',
        'horror_roki_lists_collapsed': 'brous_lists_collapsed',
        'tasteProfileCollapsed': 'brous_taste_profile_collapsed',
        'roki_rec_tune': 'brous_rec_tune',
      };

      function resolve(key) {
        return KEY_MAP[key] || key; // unrecognized keys pass through unchanged
      }

      function migrate() {
        try {
          if (localStorage.getItem('brous_migrated_v1')) return;
        } catch (e) { return; } // localStorage unavailable (private mode, etc.) — nothing to migrate
        try {
          Object.entries(KEY_MAP).forEach(([oldKey, newKey]) => {
            if (oldKey === newKey) return; // already the canonical name
            try {
              if (localStorage.getItem(newKey) === null) {
                const oldVal = localStorage.getItem(oldKey);
                if (oldVal !== null) localStorage.setItem(newKey, oldVal);
              }
              localStorage.removeItem(oldKey);
            } catch (e) {
              console.warn(`[Store] migrating ${oldKey} -> ${newKey} failed:`, e);
            }
          });
        } finally {
          try { localStorage.setItem('brous_migrated_v1', '1'); } catch (e) {}
        }
      }
      migrate();

      return {
        getItem(key) {
          try { return localStorage.getItem(resolve(key)); }
          catch (e) { console.warn(`[Store] getItem(${key}) failed:`, e); return null; }
        },
        setItem(key, value) {
          try { localStorage.setItem(resolve(key), value); }
          catch (e) { console.warn(`[Store] setItem(${key}) failed:`, e); }
        },
        removeItem(key) {
          try { localStorage.removeItem(resolve(key)); }
          catch (e) { console.warn(`[Store] removeItem(${key}) failed:`, e); }
        },
      };
    })();

    // ===================== escapeHtml (canonical, global) =====================
    // Escapes text before it is interpolated into an innerHTML string. Defined
    // here in store.js — the FIRST script loaded — so it is guaranteed to exist
    // for every later module that renders TMDB/LLM-sourced text. It was previously
    // defined only inside curator.js and merely happened to be global because the
    // scripts share scope; if curator.js ever moved, reordered, or errored on load,
    // every other module's escapeHtml(...) call would throw. Keeping the single
    // source of truth in the earliest-loading file removes that fragility.
    // Guarded so a stray later re-definition can't clobber it.
    if (typeof window.escapeHtml !== 'function') {
      window.escapeHtml = function escapeHtml(s) {
        return (s == null ? '' : String(s)).replace(/[&<>"']/g, m => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[m]));
      };
    }

