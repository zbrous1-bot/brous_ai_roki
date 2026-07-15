    // ===================== UI HELPERS =====================
    // Generic, cross-feature UI plumbing: overflow menus, toasts, skeleton loading
    // states, swipe gestures, and the shared apiFetch() wrapper used by every TMDB
    // call in the file. Genre/provider/curator-mood constants also live here since
    // several of the helpers below reference them.

    // Shared overflow-menu wiring for movie cards: toggles the [data-act-menu] panel
    // open/closed via the [data-act="more"] button, and closes it on outside click.
    // Used by the recs-grid card templates (the browse-results card builds its own
    // menu directly in JS since it isn't an HTML string template).
    function wireMoreMenu(card) {
      const moreBtn = card.querySelector('[data-act="more"]');
      const menu = card.querySelector('[data-act-menu]');
      if (!moreBtn || !menu) return;
      function close() {
        menu.classList.add('hidden');
        moreBtn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('click', onDocClick);
      }
      function onDocClick(ev) {
        if (!menu.contains(ev.target) && ev.target !== moreBtn) close();
      }
      moreBtn.onclick = (e) => {
        e.stopPropagation();
        const isHidden = menu.classList.contains('hidden');
        if (isHidden) {
          menu.classList.remove('hidden');
          moreBtn.setAttribute('aria-expanded', 'true');
          document.addEventListener('click', onDocClick);
        } else {
          close();
        }
      };
      // Clicking a menu item should also close the menu afterward.
      menu.querySelectorAll('button[data-act]').forEach(item => {
        item.addEventListener('click', close);
      });
    }

    // Discover data
    const GENRES = [
      {id: 28, name: 'Action'}, {id: 12, name: 'Adventure'}, {id: 16, name: 'Animation'},
      {id: 35, name: 'Comedy'}, {id: 80, name: 'Crime'}, {id: 99, name: 'Documentary'},
      {id: 18, name: 'Drama'}, {id: 10751, name: 'Family'}, {id: 14, name: 'Fantasy'},
      {id: 27, name: 'Horror'}, {id: 9648, name: 'Mystery'}, {id: 10749, name: 'Romance'},
      {id: 878, name: 'Sci-Fi'}, {id: 53, name: 'Thriller'}
    ];

    // Nice colors for provider pills (still used in modal for "where to watch")
    // Provider colors for the "where to watch" modal (My Services UI removed, but modal still shows availability)
    const PROVIDER_COLORS = {
      'Netflix': 'bg-red-600 text-white',
      'Hulu': 'bg-green-600 text-white',
      'Max': 'bg-purple-700 text-white',
      'Prime Video': 'bg-sky-600 text-white',
      'Peacock': 'bg-violet-600 text-white',
      'Apple TV+': 'bg-zinc-600 text-white',
      'Paramount+': 'bg-blue-700 text-white',
      'Disney+': 'bg-indigo-700 text-white',
    };

    let selectedGenres = new Set();
    let currentDiscoverType = 'movie';
    let minRating = 0;
    let selectedDecade = null; // {label, gte, lte} or null
    let currentSearchType = 'movie';
    let _liveSearchTimer = null; // debounce for search-as-you-type
    let _searchGen = 0; // bumped on every performSearch call so a slow/stale response can't clobber a newer one's results

    // Fires on every keystroke in the search box. Debounced so we don't fire a full
    // search (which also does similar/providers/external_ids lookups per result) on
    // every single character — only after typing pauses for a moment.
    function handleSearchInput() {
      clearTimeout(_liveSearchTimer);
      const query = document.getElementById('search-input').value.trim();
      if (query.length === 0) {
        // Box cleared — reset back to the initial empty state instead of leaving stale results up.
        const container = document.getElementById('results');
        const initial = document.getElementById('initial-state');
        if (container) container.innerHTML = '';
        if (initial) initial.style.display = '';
        return;
      }
      if (query.length < 2) return; // too short to bother searching yet
      _liveSearchTimer = setTimeout(performSearch, 450);
    }
    let currentDiscoverPage = 1;
    let currentDiscoverResults = [];

    // Watchlist (legacy quick list, kept working for existing search/discover "My List" flows)
    let watchlist = [];
    try {
      watchlist = JSON.parse(Store.getItem('brous_watchlist') || '[]');
    } catch (e) {
      console.warn('brous_watchlist parse failed (data may be corrupted or cleared):', e);
    }
    // Use composite key to safely handle movie vs tv with potentially overlapping numeric ids
    let watchedIds = new Set(watchlist.map(w => `${w.id}:${w._mediaType || 'movie'}`));
    let lastRenderedItems = [];
    // Remembers the opts renderResults was last called with (e.g. { keepLibraryItems: true }
    // for a title search) so a post-action refresh (removeFromCurrentResults) re-renders
    // in the same mode instead of silently reverting to Discover's default of hiding
    // every title already in the library — which made search results look like they'd
    // changed to different movies whenever one was already watched/queued/etc.
    let lastRenderedOpts = {};

    // === Horror Roki full personal state (from Streamlit current setup) ===
    // Stored only in browser (localStorage). Matches backup/restore contract (lists + chat_history + llm_config no secrets).
    let toWatchList = [];
    let watchedList = [];
    let dislikedList = [];
    let notInterestedList = [];
    let chatHistory = [];
    let llmConfig = { provider: 'xAI', base_url: 'https://api.x.ai/v1', model: 'grok-4.3', max_history_turns: 12, max_response_tokens: 900 };
    // Each key gets its own try/catch — previously these shared one, so a single
    // corrupted key (e.g. horror_roki_disliked) would throw partway through and
    // silently leave every key AFTER it in the list at its empty default, even
    // though those keys' own data was perfectly fine.
    function loadJSON(key, fallback) {
      try {
        const raw = Store.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        console.warn(`[Store] ${key} parse failed (data may be corrupted), using default:`, e);
        return fallback;
      }
    }
    toWatchList = loadJSON('horror_roki_towatch', []);
    watchedList = loadJSON('horror_roki_watched', []);
    dislikedList = loadJSON('horror_roki_disliked', []);
    notInterestedList = loadJSON('horror_roki_not_interested', []);
    chatHistory = loadJSON('horror_roki_chat', []);
    llmConfig = loadJSON('horror_roki_llm', llmConfig);
    let currentRecPool = [];
    let _recPoolLastRefreshed = null; // Date of the last full pool load — shown on the home dashboard's Recommendations card
    let recPageCursor = 1;
    let currentMood = 'All';
    let curatorPicks = []; // parsed SUGGESTED for cards + optional BATCH_RATE items
    let lastGrounding = {}; // title -> metadata for curator turns

    // Combined exclusion for recs / search results (watched + disliked + to_watch + not interested)
    function getExcludedKeys() {
      const keys = new Set();
      [...watchlist, ...toWatchList, ...watchedList, ...dislikedList, ...notInterestedList].forEach(it => {
        const k = `${it.id}:${it._mediaType || 'movie'}`;
        keys.add(k);
      });
      return keys;
    }

    // Which list (if any) a title is already in — used to badge search results that
    // would otherwise just be silently excluded (see renderResults' keepLibraryItems).
    function getLibraryStatusBadge(id, mediaType) {
      const key = `${id}:${mediaType || 'movie'}`;
      const has = list => list.some(w => `${w.id}:${w._mediaType || 'movie'}` === key);
      if (has(watchedList)) return { label: '✓ Watched', cls: 'bg-emerald-700 text-white' };
      if (has(toWatchList)) return { label: '📌 In Queue', cls: 'bg-indigo-700 text-white' };
      if (has(dislikedList)) return { label: '👎 Disliked', cls: 'bg-red-900 text-red-200' };
      if (has(notInterestedList)) return { label: '✕ Hidden', cls: 'bg-zinc-700 text-zinc-300' };
      return null;
    }

    // === Password for Cloudflare Worker (Basic Auth) ===
    // The Worker requires a shared password on all /api/tmdb and /api/llm calls.
    // We store it in localStorage (per-browser). Username is ignored by the Worker.
    let apiPassword = Store.getItem('brous_password') || '';

    // Optional: Custom API base for direct Worker access (useful for local testing, tunnels,
    // or falling back to the standalone horror-roki Worker if the Pages Function ever needs
    // to be bypassed). Example: 'https://your-worker.your-account.workers.dev'
    // DEFAULT_WORKER_URL is kept only as a manual escape hatch via ?apiBase= (below) — it is
    // NOT the default anymore. As of the Worker+Pages consolidation, /api/* is served by
    // deploy/functions/api/[[path]].js on this SAME domain, so the default is relative paths
    // (apiBase = ''), which is both simpler and avoids CORS entirely (same-origin).
    const DEFAULT_WORKER_URL = 'https://horror-roki.zbrous1.workers.dev';
    // Clear any stale overrides from localStorage so a relative-path default actually applies
    // for everyone, not just new browsers.
    Store.removeItem('brous_api_base');
    // NOTE: do NOT remove 'brous_password' here. This line previously wiped the saved
    // password on every page load — the password was read into apiPassword above (line
    // ~2943) and then immediately deleted from storage, so it never survived a reload.
    // That silently broke cloud sync (every save/load 401'd) and caused devices to drift
    // apart. The password must persist across loads for sync to work.
    let apiBase = '';
    Store.removeItem('brous_cloud_pin');
    // Support URL param for shareable links (e.g. ?apiBase=https://your-worker.workers.dev)
    // This "bakes" the endpoint into the shared URL so others don't need to set it manually.
    //
    // SECURITY: this param repoints every API call — including the Authorization
    // header that carries the shared password — at whatever origin it names. An
    // unrestricted value means a crafted link (?apiBase=https://evil.example) can
    // silently exfiltrate the password to an attacker's server and persist that
    // redirect. So we hard-allowlist the hosts we actually deploy to / develop
    // against, and require an explicit user confirm before persisting anything.
    const ALLOWED_API_HOSTS = [
      'horror-roki.pages.dev',
      'brous-movie-engine.pages.dev',
      'horror-roki.zbrous1.workers.dev',
      'localhost',
      '127.0.0.1',
    ];
    function isAllowedApiBase(candidate) {
      try {
        const u = new URL(candidate, window.location.origin);
        // Only https (or http on localhost for dev) to an allowlisted host.
        const hostOk = ALLOWED_API_HOSTS.includes(u.hostname);
        const schemeOk = u.protocol === 'https:' ||
          (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
        return hostOk && schemeOk;
      } catch (e) {
        return false;
      }
    }
    const urlParams = new URLSearchParams(window.location.search);
    const urlApiBase = urlParams.get('apiBase');
    if (urlApiBase) {
      if (!isAllowedApiBase(urlApiBase)) {
        console.warn('[Horror Roki] Ignoring ?apiBase — not an allowlisted host:', urlApiBase);
      } else if (window.confirm(
          'This link wants to point the app at a different API endpoint:\n\n' +
          urlApiBase + '\n\nOnly continue if you trust the source of this link. Use it?')) {
        apiBase = urlApiBase;
        Store.setItem('brous_api_base', apiBase); // persist for this visitor too
        console.log('[Horror Roki] apiBase overridden from URL param:', apiBase);
      } else {
        console.log('[Horror Roki] User declined ?apiBase override.');
      }
    }
    console.log('[Horror Roki] Current apiBase at load:', apiBase || '(relative)');

    // Curator mood lines for personality (subtle, rotates occasionally)
    const CURATOR_MOODS = [
      'THE REELS ARE RESTLESS',
      'SLOW BURNS ONLY',
      'GORE IS IN THE AIR',
      'FOLK HORROR SEASON',
      'THE SHADOWS ARE TALKING',
      'CLASSICS AWAKENING'
    ];

    function setCuratorMood() {
      const el = document.getElementById('curator-mood');
      if (el) {
        el.textContent = CURATOR_MOODS[Math.floor(Math.random() * CURATOR_MOODS.length)];
      }
    }

    // Contextual quick replies for Curator (rotates based on recent watched)
    function refreshCuratorQuickReplies() {
      const container = document.getElementById('curator-quick-replies');
      if (!container) return;
      container.innerHTML = '';
      const base = [
        {q: 'Something slow burn and psychological', label: 'Slow burn'},
        {q: 'Recommend something really gory but actually good', label: 'Gory but good'},
        {q: 'What should I watch next? Pick one title and explain why', label: 'Pick one'},
        {q: 'Folk horror or supernatural, preferably underseen', label: 'Folk shadows'}
      ];
      // Add one contextual from recent watched genres if possible
      let contextual = null;
      if (watchedList.length) {
        const last = watchedList[0];
        if (last.genre_ids && last.genre_ids.includes(27)) contextual = {q: 'More horror like the last one', label: 'More like last'};
        else if (last.genre_ids && last.genre_ids.includes(9648)) contextual = {q: 'Psychological thriller please', label: 'Mind bender'};
      }
      const picks = contextual ? [contextual, ...base.slice(0,3)] : base;
      picks.forEach(p => {
        const b = document.createElement('button');
        b.textContent = p.label;
        b.className = 'text-[9px] px-2 py-px rounded-full border border-zinc-700 hover:bg-zinc-800';
        b.dataset.q = p.q;
        b.onclick = () => {
          const inp = document.getElementById('curator-input');
          if (inp) { inp.value = p.q; sendToCurator(); }
        };
        container.appendChild(b);
      });
    }

    function toggleCuratorChips() {
      const chips = document.getElementById('curator-quick-replies');
      const toggle = document.getElementById('curator-chips-toggle');
      if (!chips) return;
      const opening = chips.style.display === 'none' || chips.style.display === '';
      chips.style.display = opening ? 'flex' : 'none';
      if (toggle) toggle.textContent = opening ? 'Suggestions ▴' : 'Suggestions ▾';
    }

    function toggleCuratorDeck() {
      const deck = document.getElementById('curator-prompt-deck');
      const arrow = document.getElementById('curator-deck-arrow');
      if (!deck) return;
      const opening = deck.style.display === 'none' || deck.style.display === '';
      deck.style.display = opening ? 'grid' : 'none';
      if (arrow) arrow.textContent = opening ? '▴' : '▾';
    }

    // Simple toast system for action feedback (used by lists, curator, etc.)

    function showSkeletons(containerId, count = 4) {
      const c = document.getElementById(containerId);
      if (!c) return;
      c.innerHTML = '';
      const initial = document.getElementById('initial-state');
      if (initial) initial.style.display = 'none';
      const isPoster = containerId === 'recs-grid';
      for (let i = 0; i < count; i++) {
        const card = document.createElement('div');
        card.className = 'skeleton-card';
        card.style.animationDelay = (i * 0.07) + 's';
        if (isPoster) {
          card.style.padding = '10px';
          card.innerHTML = `
            <div class="skeleton-poster" style="width:100%;aspect-ratio:2/3;height:unset;border-radius:16px;margin-bottom:10px;"></div>
            <div class="skeleton-line" style="width:85%;height:12px;margin-bottom:6px;"></div>
            <div class="skeleton-line" style="width:55%;height:10px;margin-bottom:0;"></div>`;
        } else {
          card.innerHTML = `
            <div style="display:flex;gap:14px;">
              <div class="skeleton-poster" style="width:80px;height:120px;"></div>
              <div style="flex:1;">
                <div class="skeleton-line" style="width:80%;height:14px;margin-bottom:10px;"></div>
                <div class="skeleton-line" style="width:55%;height:10px;margin-bottom:8px;"></div>
                <div class="skeleton-line" style="width:40%;height:10px;margin-bottom:16px;"></div>
                <div style="display:flex;gap:6px;">
                  <div class="skeleton-line" style="width:70px;height:28px;border-radius:9999px;margin:0;"></div>
                  <div class="skeleton-line" style="width:60px;height:28px;border-radius:9999px;margin:0;"></div>
                </div>
              </div>
            </div>`;
        }
        c.appendChild(card);
      }
    }

    // ── Share menu toggle ──
    function toggleShareMenu() {
      const d = document.getElementById('share-menu-dropdown');
      if (!d) return;
      d.style.display = d.style.display === 'none' ? 'block' : 'none';
    }
    document.addEventListener('click', e => {
      const wrap = document.getElementById('share-menu-wrap');
      const d = document.getElementById('share-menu-dropdown');
      if (wrap && d && !wrap.contains(e.target)) d.style.display = 'none';

      // Close taste dropdown when clicking outside
      const tastePanel = document.getElementById('taste-dropdown');
      const tasteCard = document.getElementById('taste-profile-card');
      if (tastePanel && !tastePanel.classList.contains('hidden')) {
        if (!tastePanel.contains(e.target) && (!tasteCard || !tasteCard.contains(e.target))) {
          closeTasteDropdown();
        }
      }
    });

    function showToast(message, type = 'success') {
      const container = document.getElementById('toast-container');
      if (!container) return;
      const toast = document.createElement('div');
      toast.className = `toast ${type}`;
      toast.innerHTML = `
        <span>${escapeHtml(message)}</span>
      `;
      container.appendChild(toast);
      // Auto dismiss
      setTimeout(() => {
        toast.classList.add('out');
        setTimeout(() => toast.remove(), 150);
      }, 2400);
      // Tap to dismiss early
      toast.onclick = () => {
        toast.classList.add('out');
        setTimeout(() => toast.remove(), 100);
      };
    }

    // Swipe actions for library items (mobile only, nice dense UX)
    function setupSwipeActions(container, listType) {
      if (!container) return;
      const isMobile = window.innerWidth < 640 || 'ontouchstart' in window;
      if (!isMobile) return;

      const items = container.querySelectorAll('.library-item');
      items.forEach((item) => {
        const itemId = Number(item.dataset.id);
        const mediaType = item.dataset.mediaType || 'movie';
        let startX = 0;
        let startY = 0;
        let currentX = 0;
        let isDragging = false;
        let isScrolling = null;

        const onStart = (e) => {
          if (e.touches) {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            isDragging = true;
            isScrolling = null;
            item.classList.add('swiping');
          }
        };
        const onMove = (e) => {
          if (!isDragging || !e.touches) return;
          const dx = e.touches[0].clientX - startX;
          const dy = e.touches[0].clientY - startY;
          // Determine scroll vs swipe on first significant move
          if (isScrolling === null && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
            isScrolling = Math.abs(dy) > Math.abs(dx);
          }
          // Let browser handle vertical scroll — don't apply transform
          if (isScrolling) return;
          currentX = dx;
          // limit drag
          const limited = Math.max(Math.min(currentX, 120), -120);
          item.style.transform = `translateX(${limited}px)`;
          // subtle bg hint
          if (limited > 40) item.style.background = 'rgba(52, 211, 153, 0.15)';
          else if (limited < -40) item.style.background = 'rgba(248, 113, 113, 0.15)';
          else item.style.background = '';
        };
        const onEnd = () => {
          if (!isDragging) return;
          isDragging = false;
          isScrolling = null;
          item.classList.remove('swiping');
          const threshold = 60;

          if (currentX > threshold) {
            // swipe right
            item.style.transition = 'transform 0.2s, opacity 0.2s';
            item.style.transform = 'translateX(100%)';
            item.style.opacity = '0';
            setTimeout(() => {
              handleSwipeRight(listType, itemId, mediaType, item);
            }, 180);
          } else if (currentX < -threshold) {
            item.style.transition = 'transform 0.2s, opacity 0.2s';
            item.style.transform = 'translateX(-100%)';
            item.style.opacity = '0';
            setTimeout(() => {
              handleSwipeLeft(listType, itemId, mediaType, item);
            }, 180);
          } else {
            // reset
            item.style.transition = 'transform 0.2s ease';
            item.style.transform = '';
            item.style.background = '';
          }
          currentX = 0;
        };

        item.addEventListener('touchstart', onStart, {passive: true});
        item.addEventListener('touchmove', onMove, {passive: true});
        item.addEventListener('touchend', onEnd);
        item.addEventListener('touchcancel', onEnd);
      });
    }

    function handleSwipeRight(listType, id, mediaType, itemEl) {
      if (listType === 'towatch') {
        markWatchedFromToWatch(id, mediaType);
      } else if (listType === 'disliked') {
        // move disliked back to to watch — addressed by id, immune to re-sort/re-filter
        const item = dislikedList.find(d => d.id === id && (d._mediaType || 'movie') === mediaType);
        if (item) {
          toWatchList.unshift(item);
          dislikedList = dislikedList.filter(d => d !== item);
          saveToWatch();
          saveDisliked();
          showToast('Moved to To Watch');
        }
      } else {
        itemEl.style.transform = '';
        itemEl.style.background = '';
      }
    }

    function handleSwipeLeft(listType, id, mediaType, itemEl) {
      if (listType === 'towatch') {
        dislikeFromToWatch(id, mediaType);
      } else if (listType === 'watched') {
        // from watched to disliked — addressed by id, immune to re-sort/re-filter
        const item = watchedList.find(w => w.id === id && (w._mediaType || 'movie') === mediaType);
        if (item) {
          dislikedList.unshift(item);
          watchedList = watchedList.filter(w => w !== item);
          saveWatched();
          saveDisliked();
          showToast('Moved to Disliked');
        }
      } else {
        itemEl.style.transform = '';
        itemEl.style.background = '';
      }
    }

    // Returns auth headers silently (no prompt). Use requireAuthHeaders() when a password is mandatory.
    function getAuthHeaders() {
      if (!apiPassword) return {};
      return { 'Authorization': 'Basic ' + btoa('user:' + apiPassword) };
    }

    async function apiFetch(path, options = {}) {
      // TMDB routes are open (token protected server-side); /api/data and /api/llm require the shared password.
      const isDataPath = path.startsWith('/api/data');
      const headers = { ...getAuthHeaders() };
      if (options.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
      // apiBase is '' by default (relative /api/* on this same domain, via Pages
      // Functions) — only non-empty if overridden via ?apiBase= for the standalone
      // Worker fallback.
      const base = apiBase.replace(/\/+$/, '');
      const p = path.startsWith('/') ? path : '/' + path;
      const url = base + p;
      const fetchOptions = {
        method: options.method || 'GET',
        headers,
      };
      if (options.body) {
        fetchOptions.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      }
      // Abort hung requests so Promise.all batches can never stall forever
      const timeoutMs = options.timeoutMs || 15000;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      fetchOptions.signal = ac.signal;
      let res;
      try {
        res = await fetch(url, fetchOptions);
      } finally {
        clearTimeout(timer);
      }
      console.log('[Horror Roki] apiFetch to:', url, 'status will be checked next');
      if (res.status === 401) {
        // Only wipe password for non-data routes.
        if (!isDataPath) {
          Store.removeItem('brous_password');
          apiPassword = '';
        }
        const err = new Error('Unauthorized (wrong or missing password)');
        err.status = 401;
        throw err;
      }
      if (!res.ok) {
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('text/html')) {
          // Likely hit Pages static 404 instead of Worker route
          const err = new Error('API call failed: received HTML instead of JSON. This usually means the Worker Route is not set up for this domain (or wrong domain). Check Cloudflare Worker Routes for your Pages URL + /api/*');
          err.status = res.status;
          err.isRouteError = true;
          throw err;
        }
        let msg = 'API error ' + res.status;
        let errData = null;
        try {
          errData = await res.json();
          if (errData && errData.error) {
            msg = errData.error;
          } else if (errData && errData.status_message) {
            msg = errData.status_message;
          }
        } catch (_) {}
        const err = new Error(msg);
        err.status = res.status;
        err.details = errData;
        throw err;
      }
      // For non-JSON responses (rare), just return the response
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        return res.json();
      }
      return res;
    }

