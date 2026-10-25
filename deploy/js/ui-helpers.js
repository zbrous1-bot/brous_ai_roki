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

    // ---- Found Footage (shared by the Browse filter and the For You pool) ----
    // Found footage is a TMDB *keyword*, not a genre, so it can never come from GENRES
    // above — it has to be queried with `with_keywords`. These constants live here rather
    // than inside either consumer so the Browse chip (discover-filters.js) and the For You
    // pool (loadFoundFootage in recs.js) can't drift apart on what "found footage" means.
    //
    // Keyword set verified against TMDB's keyword search (search/keyword?query=...):
    // 163053 found footage · 342857 found footage horror · 340385 found footage story ·
    // 345179 found footage mystery · 365923 found footage adjacent · 357207 foundfootage ·
    // 322394 horror mockumentary · 272745 screenlife · 376138 screenlife horror ·
    // 272686 screen life · 11665 handheld camera · 365784 faux documentary ·
    // 160517 fake documentary. Deliberately excludes plain "mockumentary"/"point of view" —
    // those are dominated by non-horror comedy/wildlife content that dilutes rather than
    // expands the pool. Pipe-delimited = OR in TMDB's discover API.
    const FF_KEYWORD_IDS = '163053|342857|340385|345179|365923|357207|322394|272745|376138|272686|11665|365784|160517';

    // The broad keywords needed for recall ("faux documentary", "handheld camera",
    // "screenlife") also catch things that aren't fictional found footage: real
    // documentaries, mockumentary sitcoms, news/reality TV. Requiring at least one
    // narrative-fiction genre keeps genuine FF across horror/thriller/sci-fi/crime/action
    // (End of Watch, Cloverfield) while cutting the non-fiction noise.
    const FF_NARRATIVE_GENRES = new Set([
      27,    // Horror
      53,    // Thriller
      9648,  // Mystery
      878,   // Science Fiction
      80,    // Crime
      28,    // Action
      18,    // Drama
      10752, // War
      14,    // Fantasy
      10765, // Sci-Fi & Fantasy (TV)
    ]);

    // Manual denylist for specific mockumentary/shaky-cam titles that clear the genre gate
    // (they carry Crime/Drama/Action) but aren't fictional found footage. Keyed by
    // `id:mediaType` because TMDB movie and TV IDs share a numeric space. Kept deliberately
    // small and title-commented — this is a curated exception list, not a heuristic. Add an
    // entry only for a clear, recurring false positive that can't be excluded by genre
    // without also dropping genuine found footage.
    const FF_DENYLIST = new Set([
      '73126:tv',    // American Vandal — mockumentary comedy-crime, not found footage
      '1999:tv',     // The Comeback — showbiz mockumentary sitcom
      '347375:movie',// Mile 22 — shaky-cam action thriller, not found footage
      // Woody Allen marital drama. Carries TMDB's "handheld camera" keyword — one of the
      // broad tags the pool needs for recall — and clears the genre gate on Drama, so
      // neither existing mechanism can catch it. It sat harmlessly low while scoring ran on
      // TMDB's thin vote counts; once bayesianRating started pooling IMDb's 33,082 votes it
      // rose into the pool's top 6, which is what made it worth an entry here.
      '28384:movie', // Husbands and Wives
    ]);

    // Shared keyword false-positive gate. `genreIds` is TMDB's genre_ids array.
    // Documentary (99) is dropped outright; Animation (16) too. Returns true if the item
    // should be kept as plausible fictional found footage.
    function isPlausibleFoundFootage(id, mediaType, genreIds) {
      const gids = genreIds || [];
      if (FF_DENYLIST.has(`${id}:${mediaType || 'movie'}`)) return false;
      if (gids.includes(99) || gids.includes(16)) return false;
      return gids.some(g => FF_NARRATIVE_GENRES.has(g));
    }

    // ---- Non-narrative genres (For You rec pool only) ----
    // The rec pool is meant to answer "what should I watch tonight" for a horror/thriller
    // audience, and concert films, stand-up specials and documentaries aren't that — but
    // they rate extremely well, so they place high on any quality-ranked feed. Measured
    // against a live 350-title pool, 50 titles (14%) were Documentary or Music, against
    // only 35 Horror.
    //
    // Applied client-side as well as via `without_genres` because half the pool comes from
    // /movie/popular, /movie/top_rated and /trending, which aren't Discover endpoints and
    // take no genre filter at all — the server-side parameter alone would miss them.
    //
    // Scoped to the rec pool deliberately. The Browse tab has explicit Documentary and
    // Animation genre chips, and someone who taps Documentary there means it.
    //
    // TV Movie (10770) is NOT excluded: it catches real genre films (Cast a Deadly Spell,
    // Witch Hunt both surface in the Cosmic Horror pool as 10770), not just filler.
    const REC_POOL_EXCLUDED_GENRES = {
      movie: new Set([
        16,    // Animation — long-standing app-wide exclusion
        99,    // Documentary
        10402, // Music (concert films: Nirvana Unplugged, Michael Jackson Live)
      ]),
      tv: new Set([
        16,    // Animation
        99,    // Documentary
        10763, // News
        10764, // Reality
        10767, // Talk
      ]),
    };

    // True if the title belongs in the For You rec pool. `genreIds` is TMDB's genre_ids.
    function isRecPoolEligible(mediaType, genreIds) {
      const banned = REC_POOL_EXCLUDED_GENRES[mediaType === 'tv' ? 'tv' : 'movie'];
      return !(genreIds || []).some(g => banned.has(g));
    }

    // Renders the yellow IMDb chip on a rec card. Two things beyond the old bare-logo
    // version, both only possible now that attachImdbRatings runs:
    //
    // - Shows the actual IMDb score next to the logo. The chip already existed, so this
    //   adds no new element to an already-dense card — it just stops being decoration.
    //   Paired with the ★ TMDB badge it makes the two numbers directly comparable, which
    //   is the point: where they diverge (Iron Lung is 6.9 on TMDB from 353 votes, 5.8 on
    //   IMDb from 30,159) the gap explains why a title ranks where it does.
    // - Links to the actual title page rather than a title-text search, since the real
    //   imdb_id is now on the item. Falls back to the search URL when it isn't.
    //
    // Degrades cleanly: with no IMDb data the chip renders exactly as it did before.
    // The displayable IMDb score for an item, or null when there's no usable data.
    // Shared so the rec-card chip and the Browse/Search chip can't drift on what counts as
    // "has a rating" — they render at different sizes and can't share markup, but the
    // condition behind the number should be one thing.
    function imdbScoreText(item) {
      if (!item) return null;
      const votes = item.imdb_votes || 0;
      return (typeof item.imdb_rating === 'number' && votes > 0) ? item.imdb_rating.toFixed(1) : null;
    }

    function imdbBadgeHtml(item, domId) {
      const title = item.title || item.name || '';
      const year = String(item.release_date || item.first_air_date || '').slice(0, 4);
      // Validated rather than trusted — this goes straight into an href, and the id comes
      // from an upstream API rather than from our own table.
      const validId = /^tt\d+$/.test(item.imdb_id || '') ? item.imdb_id : null;
      const href = validId
        ? `https://www.imdb.com/title/${validId}/`
        : `https://www.imdb.com/find/?q=${encodeURIComponent(title + (year ? ' ' + year : ''))}&s=tt&ttype=ft`;
      const score = imdbScoreText(item) || '';
      const hasScore = !!score;
      const label = hasScore
        ? `IMDb rating ${score} out of 10 for ${title}`
        : `Find ${title} on IMDb`;
      return `<a ${domId ? `id="${domId}" ` : ''}href="${href}" target="_blank" rel="noopener" `
        + `title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" `
        + `class="inline-flex items-center gap-1 text-[11px] px-1.5 py-1 rounded bg-[#f5c518] text-black font-bold no-underline">`
        + `${hasScore ? `<span>${score}</span>` : 'IMDb'}</a>`;
    }

    // ---- Cosmic Horror (shared by the Browse filter and the For You pool) ----
    // Same shape as the Found Footage block above — a TMDB keyword, not a genre — but a
    // far narrower pool: the whole thing is ~70 titles against found footage's ~4,000
    // (see loadCosmicHorror in recs.js for what that changes about how it's fetched).
    //
    // Keyword set verified against TMDB's keyword search (search/keyword?query=...):
    // 215959 cosmic horror · 287274 lovecraftian · 375719 lovecraftian horror ·
    // 173386 cthulhu. Checked and deliberately excluded:
    //   306925 eldritch        — only 3 titles, and 2 are junk (Thumbelina, Fun in
    //                            Balloon Land); its one real film (Iron Lung) already
    //                            carries "cosmic horror", so it adds noise and no recall.
    //   229863 ancient evil    — generic supernatural, not cosmic: Aquaman and the Lost
    //                            Kingdom, The Nun, Ghostbusters: Afterlife.
    //   374048 cosmic entity   — superhero usage (The Fantastic 4: First Steps).
    //   275024 existential horror, 364532 weird fiction, 363056 unknown entity
    //                          — 0–3 titles each, none of them cosmic horror.
    // Pipe-delimited = OR in TMDB's discover API.
    const COSMIC_KEYWORD_IDS = '215959|287274|375719|173386';

    // Cosmic horror sits in a tighter genre range than found footage — there's no
    // Crime/War/Action-only cosmic horror the way there's End of Watch — so this gate is
    // narrower than FF_NARRATIVE_GENRES. It's what drops the handful of non-fiction and
    // oddity false positives ("The Blood", a 1971 Drama; an untagged YouTube-hacks upload)
    // while keeping everything genuine, including the Fantasy-led ones (Hellboy, Dagon).
    const COSMIC_GENRES = new Set([
      27,    // Horror
      878,   // Science Fiction
      53,    // Thriller
      9648,  // Mystery
      14,    // Fantasy
      10765, // Sci-Fi & Fantasy (TV)
    ]);

    // Same curated-exception role as FF_DENYLIST — empty because the genre gate above
    // already clears every false positive in the current pool (verified against all 72
    // titles the keyword set returns). Kept as a named hook so a future bad tag has an
    // obvious home instead of prompting a second mechanism.
    const COSMIC_DENYLIST = new Set([]);

    // Mirrors isPlausibleFoundFootage: Documentary (99) and Animation (16) are dropped
    // outright, then at least one plausible genre is required.
    function isPlausibleCosmicHorror(id, mediaType, genreIds) {
      const gids = genreIds || [];
      if (COSMIC_DENYLIST.has(`${id}:${mediaType || 'movie'}`)) return false;
      if (gids.includes(99) || gids.includes(16)) return false;
      return gids.some(g => COSMIC_GENRES.has(g));
    }

    // tmdb_id -> imdb_id cache, persisted so the per-title /external_ids lookups in
    // attachImdbRatings are paid once rather than on every pool refresh. Capped because
    // localStorage is a shared, smallish budget and this competes with the user's actual
    // library data — when it overflows the oldest half is dropped, which just means those
    // titles get re-fetched if they come back around.
    const IMDB_ID_CACHE_KEY = 'brous_imdb_ids';
    const IMDB_ID_CACHE_MAX = 4000;
    function loadImdbIdCache() {
      try {
        const raw = Store.getItem(IMDB_ID_CACHE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
      } catch (_) { return {}; }
    }
    function saveImdbIdCache(cache) {
      try {
        let toStore = cache;
        const keys = Object.keys(cache);
        if (keys.length > IMDB_ID_CACHE_MAX) {
          // Object key order is insertion order for string keys, so the tail is the most
          // recently added — keep that half.
          toStore = {};
          keys.slice(-Math.floor(IMDB_ID_CACHE_MAX / 2)).forEach(k => { toStore[k] = cache[k]; });
        }
        Store.setItem(IMDB_ID_CACHE_KEY, JSON.stringify(toStore));
      } catch (_) { /* quota or private mode — enrichment still works, just uncached */ }
    }

    // ---- Watch-provider lookup (For You cards) ----
    // The rec pool is built entirely from TMDB list endpoints, which carry no provider
    // data, so availability has to be fetched per title. That's why this is lazy and only
    // ever runs for cards actually on screen (~40) rather than the whole 350-title pool.
    //
    // Cached because provider deals change on the order of weeks, not minutes, and without
    // it every scroll and every Recompute would re-request the same titles. A week's TTL
    // keeps it honest — a title leaving Netflix shows up within a week rather than being
    // wrong until localStorage is cleared.
    const PROVIDER_CACHE_KEY = 'brous_providers';
    const PROVIDER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    const PROVIDER_CACHE_MAX = 1500;

    function loadProviderCache() {
      try {
        const raw = Store.getItem(PROVIDER_CACHE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
      } catch (_) { return {}; }
    }
    function saveProviderCache(cache) {
      try {
        let toStore = cache;
        const keys = Object.keys(cache);
        if (keys.length > PROVIDER_CACHE_MAX) {
          toStore = {};
          keys.slice(-Math.floor(PROVIDER_CACHE_MAX / 2)).forEach(k => { toStore[k] = cache[k]; });
        }
        Store.setItem(PROVIDER_CACHE_KEY, JSON.stringify(toStore));
      } catch (_) { /* quota — availability still works, just uncached */ }
    }

    // Returns { stream: [names], rentable: bool } for one title, or null if unknown.
    // Stores only what the availability line needs — provider names and a rentable flag —
    // rather than TMDB's full response, which is large and mostly logo URLs.
    async function fetchWatchProviders(id, mediaType, cache) {
      const key = `${mediaType === 'tv' ? 'tv' : 'movie'}:${id}`;
      const hit = cache[key];
      if (hit && (Date.now() - (hit.t || 0)) < PROVIDER_CACHE_TTL_MS) return hit.d;
      try {
        const mt = mediaType === 'tv' ? 'tv' : 'movie';
        const res = await apiFetch(`/api/tmdb/3/${mt}/${id}/watch/providers`);
        const us = res && res.results && res.results.US ? res.results.US : null;
        const d = {
          stream: (us && us.flatrate ? us.flatrate : []).map(p => p.provider_name),
          rentable: !!(us && ((us.rent && us.rent.length) || (us.buy && us.buy.length))),
        };
        cache[key] = { t: Date.now(), d };
        return d;
      } catch (_) {
        return null; // transient failure — leave the line blank rather than claim anything
      }
    }

    // ---- Unified "Where to watch" block (every poster surface) ----
    // Markup is shared across For You, Tonight hero, Browse, and Library so the
    // dashboard always shows the same labeled availability strip under a title.

    const WTW_JW = '<span class="wtw-jw" title="Streaming availability data by JustWatch">JustWatch</span>';

    function wtwSlotId(id, mediaType) {
      return `wtw-rec-${id}-${mediaType === 'tv' ? 'tv' : 'movie'}`;
    }

    /** Static HTML shell with label + body slot (body fills async).
     *  Uses data-wtw-id/type so multiple surfaces can show the same title without
     *  colliding on a single DOM id (e.g. Library Next up + queue row). */
    function wtwBlockHtml(id, mediaType, opts) {
      const mt = mediaType === 'tv' ? 'tv' : 'movie';
      const compact = opts && opts.compact;
      const pending = (opts && opts.pendingHtml) || '<span class="wtw-pending">…</span>';
      // Keep id on body for legacy paintAvailabilitySlot lookups (For You still uses it).
      // When duplicates exist, fillWtwForItems paints every matching data attribute.
      return `<div class="wtw-block${compact ? ' wtw-block-compact' : ''}" data-wtw-id="${id}" data-wtw-type="${mt}">`
        + `<div class="wtw-block-label">Where to watch</div>`
        + `<div class="wtw-block-body wtw-rec-slot" id="${wtwSlotId(id, mt)}">${pending}</div>`
        + `</div>`;
    }

    function paintAllWtwFor(id, mediaType, data, opts) {
      const mt = mediaType === 'tv' ? 'tv' : 'movie';
      const idStr = String(id);
      // Match both string and numeric attribute forms
      const blocks = document.querySelectorAll(
        `.wtw-block[data-wtw-id="${idStr}"][data-wtw-type="${mt}"], .wtw-block[data-wtw-id="${id}"][data-wtw-type="${mt}"]`
      );
      blocks.forEach(block => {
        const body = block.querySelector('.wtw-block-body');
        const compact = block.classList.contains('wtw-block-compact');
        if (body) paintWtwBody(body, data, { compact });
      });
    }

    /** Normalize Browse/modal provider objects into { stream, rentable }. */
    function normalizeProvidersData(providers) {
      if (!providers) return null;
      if (Array.isArray(providers.stream) || typeof providers.rentable === 'boolean') {
        return {
          stream: providers.stream || [],
          rentable: !!providers.rentable,
        };
      }
      const flat = providers.flatrate || [];
      return {
        stream: flat.map(p => p.provider_name || p),
        rentable: !!(
          (providers.rent && providers.rent.length)
          || (providers.buy && providers.buy.length)
        ),
      };
    }

    /**
     * Paint a WTW body element from provider data.
     * Always leaves a visible status (services / rent / not listed) — never blank.
     */
    function paintWtwBody(bodyEl, data, opts) {
      if (!bodyEl) return;
      const compact = !!(opts && opts.compact);
      const maxMine = compact ? 2 : 3;
      const maxOther = compact ? 1 : 2;

      if (data === undefined) {
        bodyEl.innerHTML = '<span class="wtw-pending">…</span>';
        return;
      }
      if (data === null) {
        bodyEl.innerHTML = '<span class="wtw-muted">Unavailable</span>';
        return;
      }

      const streamNames = data.stream || [];
      const mine = [];
      const other = [];
      const seen = new Set();
      streamNames.forEach(n => {
        const label = PROVIDER_NAME_TO_SERVICE[n] || n;
        if (!label || seen.has(label)) return;
        seen.add(label);
        if (myServices && myServices.size && myServices.has(label)) mine.push(label);
        else other.push(label);
      });

      const pills = [];
      mine.slice(0, maxMine).forEach(label => {
        pills.push(`<span class="wtw-pill wtw-pill-mine">${escapeHtml(label)}</span>`);
      });
      // If user has no services configured, surface general streamers so the row isn't empty.
      const showOther = other.slice(0, mine.length ? maxOther : maxMine);
      showOther.forEach(label => {
        pills.push(`<span class="wtw-pill wtw-pill-other">${escapeHtml(label)}</span>`);
      });

      // Freshness note rides with JustWatch credit (providers can lag a few days)
      const JW = (typeof WTW_JW !== 'undefined' ? WTW_JW : '')
        || '<span class="wtw-jw" title="Streaming data by JustWatch — may lag a few days">JustWatch</span>';
      if (pills.length) {
        bodyEl.innerHTML = `<div class="wtw-pills">${pills.join('')}${JW}</div>`;
      } else if (data.rentable) {
        bodyEl.innerHTML = `<div class="wtw-pills"><span class="wtw-pill wtw-pill-rent">Rent / Buy</span>${JW}</div>`;
      } else {
        bodyEl.innerHTML = '<span class="wtw-muted">No US streaming listed</span>';
      }
      // Never leave a blank body (CSS clip / race can clear content)
      if (!bodyEl.textContent || !bodyEl.textContent.trim()) {
        bodyEl.innerHTML = '<span class="wtw-muted">No US streaming listed</span>';
      }
    }

    function paintWtwSlotById(id, mediaType, data, opts) {
      paintAllWtwFor(id, mediaType, data, opts);
    }

    /** Fill every matching WTW slot for a list of items (sequential, cache-backed). */
    let _wtwFillRun = 0;
    async function fillWtwForItems(items, opts) {
      if (!Array.isArray(items) || !items.length) return;
      const run = ++_wtwFillRun;
      const cache = loadProviderCache();
      // Dedupe fetches when the same title appears twice (Next up + queue row)
      const seen = new Set();
      for (const item of items) {
        // Only cancel if a *newer* fill fully replaced this run after we finished
        // an item — still paint anything we already fetched so library rows don't
        // stay stuck on "…" when Next-up and To Watch both kick off fills.
        if (!item || item.id == null) continue;
        const mt = (item._mediaType === 'tv' || item._mediaType === 'TV') ? 'tv' : 'movie';
        const key = `${item.id}:${mt}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Stringify id — data attributes are always strings in the DOM
        const idStr = String(item.id);
        const hasSlot = document.querySelector(`.wtw-block[data-wtw-id="${idStr}"][data-wtw-type="${mt}"]`)
          || document.querySelector(`.wtw-block[data-wtw-id="${item.id}"][data-wtw-type="${mt}"]`);
        if (!hasSlot) continue;

        // Show pending while fetching so the body is never blank mid-request
        paintAllWtwFor(item.id, mt, undefined, opts);

        let data = null;
        try {
          if (item.providers) data = normalizeProvidersData(item.providers);
          // Empty stream+rent object is still truthy — only skip fetch if we got real signal
          if (!data || (!data.stream.length && !data.rentable)) {
            data = await fetchWatchProviders(item.id, mt, cache);
          }
        } catch (_) {
          data = null;
        }
        if (run !== _wtwFillRun && run < _wtwFillRun - 1) {
          // A much newer run superseded us — still paint this one title, then stop
          paintAllWtwFor(item.id, mt, data, opts);
          break;
        }
        paintAllWtwFor(item.id, mt, data, opts);
      }
      try { saveProviderCache(cache); } catch (_) {}
    }

    function refreshAllWtwSlots() {
      const cache = loadProviderCache();
      document.querySelectorAll('.wtw-block[data-wtw-id]').forEach(block => {
        const id = block.getAttribute('data-wtw-id');
        const mt = block.getAttribute('data-wtw-type') || 'movie';
        const body = block.querySelector('.wtw-block-body');
        if (!body) return;
        const hit = cache[`${mt}:${id}`];
        paintWtwBody(body, hit && hit.d ? hit.d : null, {
          compact: block.classList.contains('wtw-block-compact'),
        });
      });
    }

    // ---- IMDb ratings enrichment ----
    // Attaches imdb_rating / imdb_votes to every item in a rec pool, in place, so
    // bayesianRating (js/recs.js) can score on IMDb's vote counts instead of TMDB's much
    // thinner ones. Data comes from /api/ratings, backed by the D1 table that
    // scripts/load-imdb-ratings.js populates from IMDb's public bulk dump.
    //
    // Two round trips per pool, not two per title: one TMDB call per item to resolve its
    // imdb_id (TMDB's list endpoints don't return it — only /external_ids and the details
    // response do), then ONE batched /api/ratings call for the whole set.
    //
    // Fails soft everywhere. If the id lookup or the ratings call errors, items simply keep
    // no imdb_votes and bayesianRating degrades to its old TMDB-only behaviour — a ranking
    // that's slightly worse, never an empty grid.
    async function attachImdbRatings(pool) {
      if (!Array.isArray(pool) || !pool.length) return pool;
      try {
        // Resolve imdb_ids, cache-first. TMDB's list endpoints don't carry imdb_id, so each
        // unknown title costs a /external_ids call — 350 of them on a cold main pool, which
        // would be a real regression given refreshRecPool otherwise uses list endpoints
        // only. A tmdb_id -> imdb_id mapping never changes though, so it's cached in
        // localStorage: the first pool build pays, and because successive pools overlap
        // heavily the steady-state cost drops to a handful of lookups.
        const cache = loadImdbIdCache();
        const misses = [];
        pool.forEach(item => {
          const key = `${item._mediaType === 'tv' ? 'tv' : 'movie'}:${item.id}`;
          if (item.imdb_id) { cache[key] = item.imdb_id; return; }
          if (cache[key] !== undefined) { if (cache[key]) item.imdb_id = cache[key]; return; }
          misses.push({ item, key });
        });

        if (misses.length) {
          // Parallel, and apiFetch failures resolve to null rather than rejecting so one
          // bad title can't take out the whole enrichment.
          const fetched = await Promise.all(misses.map(async ({ item }) => {
            const mt = item._mediaType === 'tv' ? 'tv' : 'movie';
            try {
              const d = await apiFetch(`/api/tmdb/3/${mt}/${item.id}/external_ids`);
              return d && d.imdb_id ? d.imdb_id : null;
            } catch (_) { return null; }
          }));
          fetched.forEach((id, i) => {
            const { item, key } = misses[i];
            // Cache the null too — a title with no IMDb id shouldn't be re-requested on
            // every refresh forever.
            cache[key] = id || null;
            if (id) item.imdb_id = id;
          });
          saveImdbIdCache(cache);
        }

        const ids = [...new Set(pool.map(i => i.imdb_id).filter(Boolean))];
        if (!ids.length) return pool;

        // /api/ratings caps each request at 400 ids (and chunks internally to stay under
        // D1's 100-bound-variable limit), so batch here to match rather than relying on
        // the endpoint silently truncating anything past the cap.
        const BATCH = 400;
        const merged = {};
        for (let i = 0; i < ids.length; i += BATCH) {
          const chunk = ids.slice(i, i + BATCH);
          try {
            const d = await apiFetch(`/api/ratings?ids=${chunk.join(',')}`);
            if (d && !d.error) Object.assign(merged, d);
          } catch (_) { /* keep whatever earlier batches returned */ }
        }
        pool.forEach(item => {
          const r = item.imdb_id ? merged[item.imdb_id] : null;
          if (r) { item.imdb_rating = r.r; item.imdb_votes = r.v; }
        });
      } catch (_) {
        // Enrichment is strictly an improvement — never let it break pool loading.
      }
      return pool;
    }

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
      // Added for the For You availability pills, which key off STREAMING_SERVICES labels
      // rather than raw TMDB names — 'Max' above predates the HBO Max rename, and the rest
      // are services the picker offers that had no colour. Without an entry the pill still
      // renders, just in the grey fallback.
      'HBO Max': 'bg-purple-700 text-white',
      'Shudder': 'bg-red-900 text-red-100',
      'AMC+': 'bg-amber-800 text-amber-100',
      'Starz': 'bg-zinc-800 text-zinc-100',
      'Criterion': 'bg-stone-700 text-stone-100',
      'Tubi': 'bg-orange-700 text-white',
      'Pluto TV': 'bg-slate-700 text-white',
    };

    // ---- My streaming services ----
    // The set the user subscribes to, chosen in Settings. Drives the availability line on
    // For You cards: a title counts as "streamable" only if TMDB lists it on one of these.
    //
    // Profile-scoped (see PROFILE_SCOPED_KEYS in js/store.js) because two people sharing
    // this app don't necessarily share subscriptions — the same title can legitimately be
    // "on Netflix" for one profile and rent-only for the other.
    //
    // Each entry is a service you can subscribe to, paired with every name TMDB actually
    // uses for it. Both halves matter and neither is guessable:
    //
    // - TMDB's names are not the marketing names. It returns "Amazon Prime Video" (not
    //   "Prime Video"), "Disney Plus" (not "Disney+"), "HBO Max" (not "Max"), "Peacock
    //   Premium", "Tubi TV". Matching on the label alone would silently never fire — the
    //   line would read Rent for everything, which looks like working code.
    // - One service appears under several names because TMDB lists resold channels
    //   separately: Shudder is also "Shudder Amazon Channel" and "Shudder Apple TV
    //   Channel". If you subscribe to Shudder you can watch it regardless of billing route,
    //   so all variants count as the same tick.
    //
    // Verified against /watch/providers/movie?watch_region=US (290 entries) rather than
    // written from memory. Shudder and AMC+ are included despite being niche because this
    // is a horror app and they carry a lot of what it recommends.
    const STREAMING_SERVICES = [
      { label: 'Netflix',    match: ['Netflix'] },
      { label: 'Hulu',       match: ['Hulu'] },
      { label: 'HBO Max',    match: ['HBO Max', 'HBO Max Amazon Channel'] },
      { label: 'Prime Video',match: ['Amazon Prime Video'] },
      { label: 'Disney+',    match: ['Disney Plus'] },
      { label: 'Apple TV+',  match: ['Apple TV'] },
      { label: 'Paramount+', match: ['Paramount Plus Essential', 'Paramount Plus Premium', 'Paramount+ Amazon Channel', 'Paramount+ Roku Premium Channel'] },
      { label: 'Peacock',    match: ['Peacock Premium', 'Peacock Premium Plus', 'Peacock Premium Plus Amazon Channel'] },
      { label: 'Shudder',    match: ['Shudder', 'Shudder Amazon Channel', 'Shudder Apple TV Channel'] },
      { label: 'AMC+',       match: ['AMC+', 'AMC+ Amazon Channel', 'AMC+ Roku Premium Channel', 'AMC Plus Apple TV Channel'] },
      { label: 'Starz',      match: ['Starz', 'Starz Apple TV Channel', 'Starz Roku Premium Channel'] },
      { label: 'Criterion',  match: ['Criterion Channel'] },
      { label: 'Tubi',       match: ['Tubi TV'] },
      { label: 'Pluto TV',   match: ['Pluto TV'] },
    ];

    // TMDB provider name -> the service label the user picked, so a lookup is one map hit
    // rather than a scan across every service's variants for every title.
    const PROVIDER_NAME_TO_SERVICE = (() => {
      const m = {};
      STREAMING_SERVICES.forEach(s => s.match.forEach(n => { m[n] = s.label; }));
      return m;
    })();

    const MY_SERVICES_KEY = 'brous_my_services';
    function loadMyServices() {
      try {
        const raw = Store.getItem(MY_SERVICES_KEY);
        const arr = raw ? JSON.parse(raw) : null;
        return new Set(Array.isArray(arr) ? arr.filter(s => typeof s === 'string') : []);
      } catch (_) { return new Set(); }
    }
    function saveMyServices(set) {
      try { Store.setItem(MY_SERVICES_KEY, JSON.stringify([...set])); } catch (_) {}
    }
    let myServices = loadMyServices();

    let selectedGenres = new Set();
    let currentDiscoverType = 'movie';
    let minRating = 0;
    let selectedDecade = null; // {label, gte, lte} or null
    // Browse "Style" filters — each adds with_keywords to Discover. Mutually exclusive
    // (see renderStyleChips): the two keyword sets AND-combine to 10 titles, 9 of them
    // zero-vote, so letting both be on at once only ever produces a dead end.
    let foundFootageOnly = false;
    let cosmicHorrorOnly = false;
    let currentSearchType = 'all';
    let _liveSearchTimer = null; // debounce for search-as-you-type
    let _searchGen = 0; // bumped on every performSearch call so a slow/stale response can't clobber a newer one's results

    // Fires on every keystroke in the search box. Debounced so we don't fire a full
    // search (which also does similar/providers/external_ids lookups per result) on
    // every single character — only after typing pauses for a moment.
    function handleSearchInput() {
      clearTimeout(_liveSearchTimer);
      const input = document.getElementById('search-input');
      const query = (input && input.value || '').trim();
      const clearBtn = document.getElementById('search-clear-btn');
      if (clearBtn) clearBtn.classList.toggle('hidden', !query);
      if (query.length === 0) {
        document.querySelectorAll('.search-chip.active').forEach(c => c.classList.remove('active'));
        // Box cleared — reset back to the initial empty state instead of leaving stale results up.
        const container = document.getElementById('results');
        const initial = document.getElementById('initial-state');
        const meta = document.getElementById('browse-results-meta');
        if (container) { container.innerHTML = ''; container.className = 'browse-results'; }
        if (initial) initial.style.display = '';
        if (meta) meta.classList.add('hidden');
        return;
      }
      if (query.length < 2) return; // too short to bother searching yet
      _liveSearchTimer = setTimeout(performSearch, 450);
    }
    let currentDiscoverPage = 1;
    let currentDiscoverResults = [];

    // Watchlist (legacy quick list, kept working for existing search/discover "My List" flows).
    // Populated — along with the four library lists below — by loadPersonalStateFromStore(),
    // which is defined further down and runs both at boot and on every profile switch.
    let watchlist = [];
    // Use composite key to safely handle movie vs tv with potentially overlapping numeric ids
    let watchedIds = new Set();
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
    // Load every personal list out of Store into the in-memory globals. Called once at
    // boot, and again by switchProfile() — because Store resolves these keys against the
    // active profile, re-running this is all it takes to swap one person's library for
    // another's. (llmConfig is deliberately excluded: it's shared device config, not
    // personal state, so it's loaded once below and never reloaded on a switch.)
    function loadPersonalStateFromStore() {
      toWatchList = sanitizeLibraryList(loadJSON('horror_roki_towatch', []));
      watchedList = sanitizeLibraryList(loadJSON('horror_roki_watched', []));
      dislikedList = sanitizeLibraryList(loadJSON('horror_roki_disliked', []));
      notInterestedList = sanitizeLibraryList(loadJSON('horror_roki_not_interested', []));
      chatHistory = loadJSON('horror_roki_chat', []);
      try {
        watchlist = sanitizeLibraryList(JSON.parse(Store.getItem('brous_watchlist') || '[]'));
      } catch (e) {
        console.warn('brous_watchlist parse failed (data may be corrupted or cleared):', e);
        watchlist = [];
      }
      // Same composition the boot init uses (see transfer.js) — all four library lists
      // plus the legacy watchlist — so a profile switch lands on exactly the state a
      // fresh page load of that profile would produce.
      watchedIds = new Set([...toWatchList, ...watchedList, ...dislikedList, ...notInterestedList, ...watchlist]
        .map(w => `${w.id}:${w._mediaType || 'movie'}`));
    }
    loadPersonalStateFromStore();
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
      if (has(notInterestedList)) return { label: 'Passed', cls: 'bg-zinc-700 text-zinc-300' };
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

    // ── Micro-animations (queue fly, tonight reveal, rate stars, A–D) ─────────
    function prefersReducedMotion() {
      try {
        return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch (_) { return false; }
    }

    /** Stagger card-enter so grids cascade (cap so long lists don't wait forever). */
    function applyCardStagger(card, index) {
      if (!card) return;
      if (typeof prefersReducedMotion === 'function' && prefersReducedMotion()) {
        card.style.removeProperty('--card-stagger');
        return;
      }
      const i = Math.max(0, Number(index) || 0);
      const delay = Math.min(i, 14) * 32; // 0–448ms
      card.style.setProperty('--card-stagger', delay + 'ms');
    }

    /**
     * Watched exit: check burst + scale/fade, then resolve so caller can mutate data.
     * mode: 'watched' | 'hide' (hide is subtler desaturate)
     */
    function animateCardExit(card, mode) {
      return new Promise((resolve) => {
        if (!card || !card.isConnected) {
          resolve();
          return;
        }
        const reduced = typeof prefersReducedMotion === 'function' && prefersReducedMotion();
        if (reduced) {
          resolve();
          return;
        }
        card.style.pointerEvents = 'none';
        const cls = mode === 'hide' ? 'card-exit-hide' : 'card-exit-watched';
        card.classList.remove('card-exit-watched', 'card-exit-hide');
        void card.offsetWidth;
        card.classList.add(cls);
        if (mode !== 'hide') {
          let check = card.querySelector('.card-exit-check');
          if (!check) {
            check = document.createElement('div');
            check.className = 'card-exit-check';
            check.setAttribute('aria-hidden', 'true');
            check.textContent = '✓';
            // Ensure positioning context
            const prevPos = getComputedStyle(card).position;
            if (prevPos === 'static') card.style.position = 'relative';
            card.appendChild(check);
          }
        }
        setTimeout(resolve, mode === 'hide' ? 240 : 300);
      });
    }

    /** Soft flash on cards that stay on screen after rate (e.g. Browse). */
    function flashCardWatched(card) {
      if (!card || (typeof prefersReducedMotion === 'function' && prefersReducedMotion())) return;
      card.classList.remove('card-watched-flash');
      void card.offsetWidth;
      card.classList.add('card-watched-flash');
      setTimeout(() => card.classList.remove('card-watched-flash'), 520);
    }

    /** Bounce the home Queue status chip after an add. */
    function popQueueChip() {
      const chip = document.getElementById('home-queue-card');
      const count = document.getElementById('home-queue-count');
      if (chip) {
        chip.classList.remove('queue-chip-pop');
        // reflow to restart animation
        void chip.offsetWidth;
        chip.classList.add('queue-chip-pop');
        setTimeout(() => chip.classList.remove('queue-chip-pop'), 520);
      }
      if (count) {
        count.classList.remove('queue-count-bump');
        void count.offsetWidth;
        count.classList.add('queue-count-bump');
        setTimeout(() => count.classList.remove('queue-count-bump'), 420);
      }
    }

    /**
     * Fly a mini poster from a source element (or viewport center) to the Queue chip.
     * sourceEl: optional Element — poster/card that was just queued.
     */
    /** Undo queue: mini poster flies back out of the Queue chip. */
    function reverseFlyFromQueue(item) {
      if (prefersReducedMotion()) { popQueueChip(); return; }
      const start = document.getElementById('home-queue-card')
        || document.getElementById('bnav-watched');
      if (!start) return;
      const s = start.getBoundingClientRect();
      const flyer = document.createElement('div');
      flyer.className = 'queue-flyer queue-flyer-reverse';
      flyer.setAttribute('aria-hidden', 'true');
      const posterUrl = item && item.poster_path
        ? `https://image.tmdb.org/t/p/w92${item.poster_path}` : '';
      flyer.innerHTML = posterUrl
        ? `<img src="${posterUrl}" alt="">`
        : `<span class="queue-flyer-fallback">↩</span>`;
      const w = 40, h = 60;
      flyer.style.width = w + 'px';
      flyer.style.height = h + 'px';
      flyer.style.left = (s.left + s.width / 2 - w / 2) + 'px';
      flyer.style.top = (s.top + s.height / 2 - h / 2) + 'px';
      flyer.style.opacity = '1';
      document.body.appendChild(flyer);
      requestAnimationFrame(() => {
        flyer.style.setProperty('--fly-x', '0px');
        flyer.style.setProperty('--fly-y', Math.min(120, window.innerHeight * 0.12) + 'px');
        flyer.classList.add('queue-flyer-go');
        flyer.style.opacity = '0';
      });
      setTimeout(() => flyer.remove(), 420);
      popQueueChip();
    }

    function flyPosterToQueue(item, sourceEl) {
      popQueueChip();
      if (prefersReducedMotion()) return;

      const target = document.getElementById('home-queue-card')
        || document.getElementById('bnav-watched')
        || document.getElementById('nav-watched');
      if (!target) return;

      let startRect = null;
      if (sourceEl && sourceEl.getBoundingClientRect) {
        startRect = sourceEl.getBoundingClientRect();
      }
      // Prefer an img inside the source
      if (sourceEl) {
        const img = sourceEl.tagName === 'IMG' ? sourceEl : sourceEl.querySelector && sourceEl.querySelector('img');
        if (img) startRect = img.getBoundingClientRect();
      }
      if (!startRect || (startRect.width < 4 && startRect.height < 4)) {
        startRect = {
          left: window.innerWidth / 2 - 28,
          top: window.innerHeight / 2 - 42,
          width: 56,
          height: 84,
        };
      }

      const endRect = target.getBoundingClientRect();
      const flyer = document.createElement('div');
      flyer.className = 'queue-flyer';
      flyer.setAttribute('aria-hidden', 'true');
      const posterUrl = item && item.poster_path
        ? `https://image.tmdb.org/t/p/w92${item.poster_path}`
        : '';
      if (posterUrl) {
        flyer.innerHTML = `<img src="${posterUrl}" alt="">`;
      } else {
        flyer.innerHTML = `<span class="queue-flyer-fallback">▶</span>`;
      }

      const w = Math.min(56, Math.max(36, startRect.width * 0.35));
      const h = w * 1.5;
      flyer.style.width = w + 'px';
      flyer.style.height = h + 'px';
      flyer.style.left = startRect.left + startRect.width / 2 - w / 2 + 'px';
      flyer.style.top = startRect.top + startRect.height / 2 - h / 2 + 'px';
      document.body.appendChild(flyer);

      const endX = endRect.left + endRect.width / 2 - w / 2;
      const endY = endRect.top + endRect.height / 2 - h / 2;
      // Force layout then animate via CSS variables
      void flyer.offsetWidth;
      flyer.style.setProperty('--fly-x', (endX - (startRect.left + startRect.width / 2 - w / 2)) + 'px');
      flyer.style.setProperty('--fly-y', (endY - (startRect.top + startRect.height / 2 - h / 2)) + 'px');
      flyer.classList.add('queue-flyer-go');

      setTimeout(() => {
        flyer.remove();
        popQueueChip();
      }, 520);
    }

    /** Find a reasonable source element for a just-queued item (poster if visible). */
    function findQueueAnimSource(item) {
      if (!item || item.id == null) return null;
      const mt = item._mediaType === 'tv' ? 'tv' : 'movie';
      const id = String(item.id);
      // Match a visible card by WTW slot id (recs/browse/hero use wtw-rec-{id}-{type})
      const slot = document.getElementById(`wtw-rec-${id}-${mt}`)
        || document.querySelector(`.wtw-block[data-wtw-id="${id}"][data-wtw-type="${mt}"]`);
      if (slot) {
        const card = slot.closest('.movie-card, .browse-card, .rec-card, .tonight-hero, .library-item');
        const img = card && card.querySelector('img');
        if (img) return img;
      }
      // Tonight hero only when it is this exact title
      const hero = document.getElementById('tonight-hero');
      if (hero && !hero.classList.contains('hidden') && hero.dataset.tonightKey === `${id}:${mt}`) {
        const img = hero.querySelector('.tonight-hero-poster');
        if (img) return img;
      }
      return null;
    }

    // Simple toast system continues below — skeletons

    function showSkeletons(containerId, count = 4) {
      const c = document.getElementById(containerId);
      if (!c) return;
      c.innerHTML = '';
      if (containerId === 'results') c.className = 'browse-results';
      const initial = document.getElementById('initial-state');
      if (initial) initial.style.display = 'none';
      const meta = document.getElementById('browse-results-meta');
      if (meta && containerId === 'results') meta.classList.add('hidden');
      const isPoster = containerId === 'recs-grid';
      const isBrowse = containerId === 'results';
      for (let i = 0; i < count; i++) {
        const card = document.createElement('div');
        card.className = isBrowse ? 'skeleton-card browse-skel-card' : 'skeleton-card';
        card.style.animationDelay = (i * 0.07) + 's';
        if (isPoster) {
          card.style.padding = '10px';
          card.innerHTML = `
            <div class="skeleton-poster" style="width:100%;aspect-ratio:2/3;height:unset;border-radius:16px;margin-bottom:10px;"></div>
            <div class="skeleton-line" style="width:85%;height:12px;margin-bottom:6px;"></div>
            <div class="skeleton-line" style="width:55%;height:10px;margin-bottom:0;"></div>`;
        } else if (isBrowse) {
          card.innerHTML = `
            <div class="browse-card-inner">
              <div class="skeleton-poster browse-skel-poster"></div>
              <div class="browse-skel-body">
                <div class="skeleton-line" style="width:72%;height:15px;margin-bottom:10px;"></div>
                <div class="skeleton-line" style="width:40%;height:11px;margin-bottom:12px;"></div>
                <div class="skeleton-line" style="width:95%;height:11px;margin-bottom:6px;"></div>
                <div class="skeleton-line" style="width:80%;height:11px;margin-bottom:14px;"></div>
                <div style="display:flex;gap:8px;">
                  <div class="skeleton-line" style="width:72px;height:32px;border-radius:9999px;margin:0;"></div>
                  <div class="skeleton-line" style="width:72px;height:32px;border-radius:9999px;margin:0;"></div>
                </div>
              </div>
            </div>`;
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

    function showToast(message, type = 'success', options = {}) {
      const container = document.getElementById('toast-container');
      if (!container) return;
      const toast = document.createElement('div');
      toast.className = `toast ${type}${options.actionLabel ? ' toast-with-action' : ''}`;
      const msg = document.createElement('span');
      msg.className = 'toast-msg';
      msg.textContent = message == null ? '' : String(message);
      toast.appendChild(msg);

      let settled = false;
      const dismiss = () => {
        if (settled) return;
        settled = true;
        toast.classList.add('out');
        setTimeout(() => toast.remove(), 150);
      };

      if (options.actionLabel && typeof options.onAction === 'function') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'toast-action';
        btn.textContent = options.actionLabel;
        btn.onclick = (e) => {
          e.stopPropagation();
          if (settled) return;
          try { options.onAction(); } catch (err) { console.warn('[toast] undo failed', err); }
          dismiss();
        };
        toast.appendChild(btn);
      }

      container.appendChild(toast);
      const ttl = options.durationMs || (options.actionLabel ? 5000 : 2400);
      setTimeout(dismiss, ttl);
      // Tap message area to dismiss early (not the action button)
      toast.addEventListener('click', (e) => {
        if (e.target.closest && e.target.closest('.toast-action')) return;
        dismiss();
      });
    }

    // ── Shared mobile swipe (Queue / Hide / library actions) ─────────────────
    // One feel across For You cards and Library rows:
    //  • clear horizontal lock (doesn't fight vertical scroll)
    //  • resistance past the commit line
    //  • snappy commit / spring-back
    //  • labeled feedback (Queue / Hide / Watched / …)
    const SWIPE = {
      // commit distance in px — short enough to feel intentional, long enough to avoid accidents
      threshold: 72,
      // max drag with rubber-band beyond this
      maxDrag: 132,
      // must be this much more horizontal than vertical to lock as a swipe
      dirRatio: 1.25,
      // ignore tiny finger noise
      lockPx: 8,
      // ignore swipes that start on interactive chrome
      ignoreSel: 'button, a, input, select, textarea, [role="button"], .wtw-block',
    };

    function swipeRubber(dx) {
      const max = SWIPE.maxDrag;
      const sign = dx < 0 ? -1 : 1;
      const abs = Math.abs(dx);
      if (abs <= max) return dx;
      // diminishing returns past max so the card doesn't fly off-screen mid-drag
      return sign * (max + (abs - max) * 0.28);
    }

    function ensureSwipeOverlay(el) {
      let overlay = el.querySelector('.swipe-overlay');
      if (overlay) return overlay;
      overlay = document.createElement('div');
      overlay.className = 'swipe-overlay';
      overlay.setAttribute('aria-hidden', 'true');
      // Library rows need a positioned host for the absolute overlay
      const cs = window.getComputedStyle(el);
      if (cs.position === 'static') el.style.position = 'relative';
      el.appendChild(overlay);
      return overlay;
    }

    function resetSwipeVisual(el, overlay) {
      el.style.transition = 'transform 0.2s cubic-bezier(0.2,0.85,0.25,1), opacity 0.16s ease, background 0.16s ease';
      el.style.transform = '';
      el.style.opacity = '';
      el.style.background = '';
      el.classList.remove('swiping', 'swipe-commit');
      if (overlay) {
        overlay.style.opacity = '0';
        overlay.textContent = '';
        overlay.classList.remove('swipe-right', 'swipe-left');
      }
    }

    /**
     * Attach a polished swipe handler to a card/row.
     * opts: { rightLabel, leftLabel, onRight, onLeft, removeOnCommit }
     */
    function attachCardSwipe(el, opts) {
      if (!el || el.dataset.swipeBound === '1') return;
      // Touch devices only
      if (!('ontouchstart' in window) && !navigator.maxTouchPoints) return;

      el.dataset.swipeBound = '1';
      el.classList.add('swipeable');
      el.style.touchAction = 'pan-y';

      const overlay = ensureSwipeOverlay(el);
      const rightLabel = (opts && opts.rightLabel) || '+ Queue';
      const leftLabel = (opts && opts.leftLabel) || 'Hide';
      const removeOnCommit = !!(opts && opts.removeOnCommit);

      let startX = 0, startY = 0, lastX = 0, lastT = 0, velX = 0;
      let mode = 'undecided'; // undecided | swipe | scroll
      let active = false;
      let committed = false;

      const onStart = (e) => {
        if (!e.touches || e.touches.length !== 1) return;
        // Don't steal taps on buttons / links / WTW
        if (e.target.closest && e.target.closest(SWIPE.ignoreSel)) {
          active = false;
          return;
        }
        active = true;
        committed = false;
        mode = 'undecided';
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        lastX = startX;
        lastT = Date.now();
        velX = 0;
        el.classList.add('swiping');
        el.style.transition = 'none';
      };

      const onMove = (e) => {
        if (!active || !e.touches || e.touches.length !== 1) return;
        const x = e.touches[0].clientX;
        const y = e.touches[0].clientY;
        const dx = x - startX;
        const dy = y - startY;
        const now = Date.now();
        const dt = Math.max(1, now - lastT);
        velX = (x - lastX) / dt; // px/ms
        lastX = x;
        lastT = now;

        if (mode === 'undecided') {
          if (Math.abs(dx) < SWIPE.lockPx && Math.abs(dy) < SWIPE.lockPx) return;
          // Lock: need clearly horizontal intent
          if (Math.abs(dx) > Math.abs(dy) * SWIPE.dirRatio) {
            mode = 'swipe';
          } else {
            mode = 'scroll';
            el.classList.remove('swiping');
            return;
          }
        }
        if (mode !== 'swipe') return;

        // Once locked horizontal, block vertical scroll jank
        if (e.cancelable) e.preventDefault();

        const limited = swipeRubber(dx);
        const rot = Math.max(-7, Math.min(7, limited * 0.018));
        el.style.transform = `translate3d(${limited}px,0,0) rotate(${rot}deg)`;

        const progress = Math.min(1, Math.abs(limited) / SWIPE.threshold);
        if (overlay) {
          overlay.style.opacity = String(0.2 + progress * 0.75);
          overlay.classList.toggle('swipe-right', limited > 0);
          overlay.classList.toggle('swipe-left', limited < 0);
          overlay.textContent = limited > 0 ? rightLabel : leftLabel;
        }
        if (limited > SWIPE.threshold * 0.55) {
          el.style.background = 'rgba(16,185,129,0.12)';
        } else if (limited < -SWIPE.threshold * 0.55) {
          el.style.background = 'rgba(239,68,68,0.12)';
        } else {
          el.style.background = '';
        }
      };

      const commit = (dir) => {
        if (committed) return;
        committed = true;
        el.classList.add('swipe-commit');
        el.style.transition = 'transform 0.16s cubic-bezier(0.2,0.9,0.2,1), opacity 0.14s ease';
        el.style.transform = dir === 'right'
          ? 'translate3d(112%,0,0) rotate(6deg)'
          : 'translate3d(-112%,0,0) rotate(-6deg)';
        el.style.opacity = '0';
        if (overlay) overlay.style.opacity = '0.95';
        try { if (navigator.vibrate) navigator.vibrate(8); } catch (_) {}

        setTimeout(() => {
          try {
            if (dir === 'right' && opts && typeof opts.onRight === 'function') opts.onRight();
            if (dir === 'left' && opts && typeof opts.onLeft === 'function') opts.onLeft();
          } catch (err) {
            console.warn('[swipe] action failed', err);
          }
          if (removeOnCommit && el.parentNode) {
            el.remove();
          } else {
            // Library lists re-render themselves; just clear residual styles
            resetSwipeVisual(el, overlay);
          }
        }, 150);
      };

      const onEnd = () => {
        if (!active) return;
        active = false;
        if (mode !== 'swipe' || committed) {
          el.classList.remove('swiping');
          if (!committed) resetSwipeVisual(el, overlay);
          return;
        }
        const dx = lastX - startX;
        // Fast flick can commit slightly under distance threshold
        const flick = Math.abs(velX) > 0.65;
        const pass = Math.abs(dx) >= SWIPE.threshold || (flick && Math.abs(dx) >= SWIPE.threshold * 0.62);

        const canRight = opts && typeof opts.onRight === 'function';
        const canLeft = opts && typeof opts.onLeft === 'function';
        if (pass && dx > 0 && canRight) commit('right');
        else if (pass && dx < 0 && canLeft) commit('left');
        else resetSwipeVisual(el, overlay);
      };

      el.addEventListener('touchstart', onStart, { passive: true });
      // non-passive so we can preventDefault once horizontal is locked
      el.addEventListener('touchmove', onMove, { passive: false });
      el.addEventListener('touchend', onEnd);
      el.addEventListener('touchcancel', onEnd);
    }

    // Swipe actions for library items (mobile only)
    function setupSwipeActions(container, listType) {
      if (!container) return;
      const isMobile = window.innerWidth < 720 || 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      if (!isMobile) return;

      const items = container.querySelectorAll('.library-item');
      items.forEach((row) => {
        const itemId = Number(row.dataset.id);
        const mediaType = row.dataset.mediaType || 'movie';

        let rightLabel = '+ Queue';
        let leftLabel = 'Hide';
        let onRight = null;
        let onLeft = null;
        if (listType === 'towatch') {
          rightLabel = 'Watched';
          leftLabel = 'Pass';
          onRight = () => handleSwipeRight(listType, itemId, mediaType, row);
          onLeft = () => handleSwipeLeft(listType, itemId, mediaType, row);
        } else if (listType === 'watched') {
          // Only left = dislike (no right action)
          leftLabel = 'Dislike';
          onLeft = () => handleSwipeLeft(listType, itemId, mediaType, row);
        } else if (listType === 'disliked') {
          rightLabel = '+ Queue';
          onRight = () => handleSwipeRight(listType, itemId, mediaType, row);
        }

        attachCardSwipe(row, {
          rightLabel,
          leftLabel,
          removeOnCommit: true,
          onRight,
          onLeft,
        });
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
          showToast('Moved to Queue', 'success', {
            actionLabel: 'Undo',
            onAction: () => {
              // best-effort undo: pull back from queue if still first match
              const moved = toWatchList.find(t => t.id === id && (t._mediaType || 'movie') === mediaType);
              if (moved) {
                toWatchList = toWatchList.filter(t => t !== moved);
                dislikedList.unshift(moved);
                saveToWatch();
                saveDisliked();
              }
            },
          });
        }
      } else if (itemEl) {
        resetSwipeVisual(itemEl, itemEl.querySelector('.swipe-overlay'));
      }
    }

    function handleSwipeLeft(listType, id, mediaType, itemEl) {
      if (listType === 'towatch') {
        if (typeof passFromToWatch === 'function') passFromToWatch(id, mediaType);
        else dislikeFromToWatch(id, mediaType);
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
      } else if (itemEl) {
        resetSwipeVisual(itemEl, itemEl.querySelector('.swipe-overlay'));
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

