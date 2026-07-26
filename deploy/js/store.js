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
        // tmdb_id -> imdb_id lookup cache (see attachImdbRatings in js/ui-helpers.js).
        // Listed here for visibility rather than migration — it's new, so it has no legacy
        // name to map from. Deliberately absent from PROFILE_SCOPED_KEYS below: which IMDb
        // id a TMDB title has is an objective fact, identical for every profile, so scoping
        // it would just make each person re-fetch the same mapping.
        'brous_imdb_ids': 'brous_imdb_ids',
        'brous_my_services': 'brous_my_services',
      };

      // ---- Profile scoping ----
      // Each person (Zach / Bradlee) gets their own copy of the personal keys below,
      // so switching profiles swaps the whole library and — because the taste profile
      // is *derived* from these lists rather than stored — the recommendations with it.
      //
      // The primary profile deliberately uses the UNSUFFIXED key names, i.e. exactly the
      // keys that already exist today. Adding a second profile therefore touches none of
      // the existing data: there is nothing to migrate and nothing to lose. Additional
      // profiles get `<key>__<profileId>`.
      //
      // Only genuinely personal state is scoped. Device/account-level keys (the API
      // password, the endpoint override, the cloud PIN, UI collapse prefs, and the LLM
      // config) stay shared — scoping those would force you to re-enter the password
      // once per profile for no benefit.
      const PRIMARY_PROFILE = 'me';
      const PROFILE_SCOPED_KEYS = new Set([
        'brous_watched',
        'brous_towatch',
        'brous_disliked',
        'brous_not_interested',
        'brous_watchlist',
        'brous_rec_tune',
        'brous_chat',
        // Two people sharing this app don't necessarily share subscriptions, so the same
        // title can be streaming for one profile and rent-only for the other.
        'brous_my_services',
      ]);
      const ACTIVE_PROFILE_KEY = 'brous_active_profile';

      // Which profile this browser is currently acting as. Read once at load, before
      // any module reads its lists. Deliberately NOT synced to the server: each phone
      // pins itself to its owner, so a sync can never silently repoint your device at
      // someone else's library mid-session.
      let activeProfile = PRIMARY_PROFILE;
      try {
        const stored = localStorage.getItem(ACTIVE_PROFILE_KEY);
        if (stored && /^[a-z0-9_-]{1,24}$/.test(stored)) activeProfile = stored;
      } catch (e) { /* localStorage unavailable — stay on the primary profile */ }

      function resolve(key) {
        const canonical = KEY_MAP[key] || key; // unrecognized keys pass through unchanged
        if (activeProfile === PRIMARY_PROFILE) return canonical;
        return PROFILE_SCOPED_KEYS.has(canonical) ? `${canonical}__${activeProfile}` : canonical;
      }

      // Resolve a key as some OTHER profile would see it, without switching. This is what
      // lets one device hold a read-only mirror of the other person's library (needed by
      // Together mode, which has to score against both taste profiles at once).
      function resolveFor(key, profileId) {
        const canonical = KEY_MAP[key] || key;
        if (profileId === PRIMARY_PROFILE) return canonical;
        return PROFILE_SCOPED_KEYS.has(canonical) ? `${canonical}__${profileId}` : canonical;
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

        // ---- Profile API ----
        PRIMARY_PROFILE,
        getProfile() { return activeProfile; },

        // Point every subsequent personal-key read/write at `profileId`. Callers are
        // responsible for reloading in-memory state afterwards (see switchProfile in
        // profiles.js) — this only moves the pointer, it does not touch the app's state.
        setProfile(profileId) {
          if (!/^[a-z0-9_-]{1,24}$/.test(profileId)) {
            console.warn(`[Store] refusing invalid profile id: ${profileId}`);
            return false;
          }
          activeProfile = profileId;
          try { localStorage.setItem(ACTIVE_PROFILE_KEY, profileId); } catch (e) {}
          return true;
        },

        // Read/write another profile's copy of a key without switching to it. Used to
        // maintain the read-only mirror of the other person's library for Together mode.
        getItemFor(key, profileId) {
          try { return localStorage.getItem(resolveFor(key, profileId)); }
          catch (e) { console.warn(`[Store] getItemFor(${key}, ${profileId}) failed:`, e); return null; }
        },
        setItemFor(key, profileId, value) {
          try { localStorage.setItem(resolveFor(key, profileId), value); }
          catch (e) { console.warn(`[Store] setItemFor(${key}, ${profileId}) failed:`, e); }
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

