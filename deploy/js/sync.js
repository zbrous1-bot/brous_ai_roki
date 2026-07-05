    // ===================== SERVER SYNC (for cross-device / phone persistence) =====================
    // Uses the same Worker + PASSWORD. Requires you to:
    // 1. Create a KV namespace in Cloudflare (Workers & Pages → KV)
    // 2. Bind it to your Worker as DATA_KV (Worker → Settings → Variables → KV Namespace Bindings)
    // 3. Redeploy the Worker.
    // The frontend falls back gracefully to localStorage if the binding isn't set up yet.
    // Data shape is the same as the existing backup JSON.

    let _syncTimeout = null;
    let _lastServerSyncedAt = null; // server's synced_at as of our last successful pull — used to detect stale writes

    // Relative — /api/* is now served on this same domain via Pages Functions
    // (deploy/functions/api/[[path]].js), so no separate Worker origin is needed.
    const SYNC_URL = '';

    async function _dataFetch(path, options = {}) {
      const fetchOptions = { method: options.method || 'GET', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() } };
      if (options.body) fetchOptions.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      const res = await fetch(SYNC_URL + path, fetchOptions);
      if (!res.ok && res.status !== 404) {
        const err = new Error('Sync error ' + res.status);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }

    // Snapshot of list contents from the last point where local state was known to
    // match the server exactly (right after a clean push or pull). Used by
    // _mergeItemLists to tell "this item is genuinely new from another device" apart
    // from "I deliberately removed/moved this item locally and the server just
    // hasn't heard about it yet" — without it, a plain union merge resurrects any
    // local removal that loses a write race (e.g. a 409 conflict mid-delete).
    let _syncBaseline = null; // { watched, to_watch, disliked, not_interested } — each a Set of "id:mediaType" keys
    function _itemKey(w) { return `${w.id}:${w._mediaType || 'movie'}`; }
    function _captureSyncBaseline() {
      _syncBaseline = {
        watched: new Set((watchedList || []).map(_itemKey)),
        to_watch: new Set((toWatchList || []).map(_itemKey)),
        disliked: new Set((dislikedList || []).map(_itemKey)),
        not_interested: new Set((notInterestedList || []).map(_itemKey))
      };
    }

    // Union-merge two item lists by id+mediaType, preferring the local copy on
    // overlap (local edits like rating/notes are assumed more recent than whatever
    // the server has, since this merge only runs right after a losing race).
    // baselineKeys (optional): keys present the last time local matched the server —
    // a server-only item whose key is in baselineKeys was deliberately removed
    // locally since then, so it's excluded instead of resurrected.
    function _mergeItemLists(localList, serverList, baselineKeys) {
      const key = _itemKey;
      const localKeys = new Set((localList || []).map(key));
      const merged = new Map((localList || []).map(w => [key(w), w]));
      for (const item of (serverList || [])) {
        const k = key(item);
        if (localKeys.has(k)) continue; // local already has it and wins on conflict
        if (baselineKeys && baselineKeys.has(k)) continue; // deliberately removed locally — don't resurrect
        merged.set(k, item);
      }
      return Array.from(merged.values());
    }

    let _pushInFlight = null; // promise for the currently-running doPush, or null when idle
    let _pushQueued = null;   // { force } for one pending re-run requested while a push was in flight

    async function pushToServer(immediate = false, force = false) {
      const doPush = async (retried = false, forceThisAttempt = force) => {
        // Build the payload fresh on each attempt so a retry after a merge reflects
        // base_synced_at and list contents as of right now, not whatever was queued first.
        const payload = {
          watched: watchedList,
          to_watch: toWatchList,
          disliked: dislikedList,
          not_interested: notInterestedList,
          chat_history: chatHistory.slice(-30),
          llm_config: llmConfig,
          synced_at: new Date().toISOString(),
          base_synced_at: _lastServerSyncedAt // server version we last pulled — lets the Worker detect conflicts
        };
        try {
          const path = forceThisAttempt ? '/api/data?force=1' : '/api/data';
          const r = await _dataFetch(path, { method: 'POST', body: payload });
          _lastServerSyncedAt = r.saved_at || payload.synced_at;
          console.log('[Brous] Cloud save OK:', r);
          setSyncLabel('✓ Saved', '#4ade80');
          _captureSyncBaseline(); // local now matches server exactly
        } catch (e) {
          if (e.status === 409 && !retried) {
            // Someone else saved since we last pulled (e.g. another device, or another
            // tab of this same app). Pull their version and merge it with our current
            // in-memory lists so neither side's additions are lost — but anything
            // present in _syncBaseline that's now missing locally was a deliberate
            // local removal/move, not data to resurrect, so the merge excludes it.
            console.warn('[Brous] Stale write detected, merging with server before retry...');
            try {
              const serverData = await _dataFetch('/api/data');
              if (serverData && typeof serverData === 'object') {
                watchedList = _mergeItemLists(watchedList, serverData.watched, _syncBaseline?.watched);
                toWatchList = _mergeItemLists(toWatchList, serverData.to_watch, _syncBaseline?.to_watch);
                dislikedList = _mergeItemLists(dislikedList, serverData.disliked, _syncBaseline?.disliked);
                notInterestedList = _mergeItemLists(notInterestedList, serverData.not_interested, _syncBaseline?.not_interested);
                Store.setItem('horror_roki_watched', JSON.stringify(watchedList));
                Store.setItem('horror_roki_towatch', JSON.stringify(toWatchList));
                Store.setItem('horror_roki_disliked', JSON.stringify(dislikedList));
                Store.setItem('horror_roki_not_interested', JSON.stringify(notInterestedList));
                watchedIds = new Set([...toWatchList,...watchedList,...dislikedList,...notInterestedList].map(w=>`${w.id}:${w._mediaType||'movie'}`));
                if (serverData.synced_at) _lastServerSyncedAt = serverData.synced_at;
                updateAllLibraryRenders(); renderPersonalStats();
              }
            } catch (mergeErr) {
              console.warn('[Brous] Merge pull failed:', mergeErr.message);
            }
            // Retry as a FORCE write. We've just pulled + union-merged the server's copy
            // into our lists, so nothing is lost — but the plain retry kept 409'ing because
            // the GET payload's synced_at doesn't equal the server's authoritative saved_at
            // (the value the conflict guard checks), so base_synced_at never matched. Forcing
            // the reconciled write resolves the conflict cleanly instead of dead-ending.
            await doPush(true, true);
            return;
          }
          console.warn('[Brous] Cloud save failed:', e.message);
          setSyncLabel(e.status === 409 ? 'Conflict — reload' : 'Save failed', '#f87171');
        }
      };

      // Run doPush() serially: if a push is already in flight (its GET-merge-retry
      // sequence on a 409 can take a few round trips), don't start a second one
      // concurrently — both would build payloads off the same in-memory lists,
      // race their own merge-and-retry, and could clobber each other's writes.
      // Instead, queue at most one follow-up run that fires once the current
      // push settles (later queue requests just upgrade `force`, no need to stack more).
      const runSerially = async () => {
        if (_pushInFlight) {
          _pushQueued = { force: !!(_pushQueued && _pushQueued.force) || force };
          return _pushInFlight;
        }
        _pushInFlight = (async () => {
          await doPush();
          while (_pushQueued) {
            const next = _pushQueued;
            _pushQueued = null;
            await doPush(false, next.force);
          }
        })().finally(() => { _pushInFlight = null; });
        return _pushInFlight;
      };

      if (immediate) { await runSerially(); }
      else { clearTimeout(_syncTimeout); _syncTimeout = setTimeout(runSerially, 1200); }
    }

    async function syncFromServer() {
      // If a local edit is mid-flight to the server (debounced or already sending),
      // flush it first. Otherwise this pull's GET can land on the server's pre-edit
      // copy and blind-overwrite the in-memory lists with it — e.g. remove a title
      // from To Watch, then the periodic auto-sync (650ms after page load) pulls the
      // not-yet-saved server copy back over it and the removal silently reappears
      // (and then gets re-pushed, undoing the removal on the server too).
      if (_syncTimeout || _pushInFlight) {
        clearTimeout(_syncTimeout);
        _syncTimeout = null;
        try { await pushToServer(true); } catch (e) {}
      }
      try {
        const serverData = await _dataFetch('/api/data');
        if (!serverData || typeof serverData !== 'object') return null;
        if (serverData.synced_at) _lastServerSyncedAt = serverData.synced_at;
        let changed = false;
        if (Array.isArray(serverData.watched)) { watchedList = serverData.watched; Store.setItem('horror_roki_watched', JSON.stringify(watchedList)); changed = true; }
        if (Array.isArray(serverData.to_watch)) { toWatchList = serverData.to_watch; Store.setItem('horror_roki_towatch', JSON.stringify(toWatchList)); changed = true; }
        if (Array.isArray(serverData.disliked)) { dislikedList = serverData.disliked; Store.setItem('horror_roki_disliked', JSON.stringify(dislikedList)); changed = true; }
        if (Array.isArray(serverData.not_interested)) { notInterestedList = serverData.not_interested; Store.setItem('horror_roki_not_interested', JSON.stringify(notInterestedList)); changed = true; }
        if (Array.isArray(serverData.chat_history) && serverData.chat_history.length > 0) { chatHistory = serverData.chat_history; Store.setItem('horror_roki_chat', JSON.stringify(chatHistory)); changed = true; }
        if (changed) {
          watchedIds = new Set([...toWatchList,...watchedList,...dislikedList,...notInterestedList].map(w=>`${w.id}:${w._mediaType||'movie'}`));
          updateAllLibraryRenders(); renderPersonalStats();
          if (typeof updateHomeSnapshot === 'function') updateHomeSnapshot();
          try { renderCuratorMessages(); } catch(e){}
          setSyncLabel('✓ Synced', '#4ade80');
          console.log('[Brous] Cloud load OK ✓');
        }
        _captureSyncBaseline(); // local now matches server exactly
        return serverData;
      } catch (e) {
        console.warn('[Brous] Cloud sync failed:', e.message);
        setSyncLabel('Sync failed', '#f87171');
        setTimeout(() => setSyncLabel('Sync', '#a1a1aa'), 3000);
        return null;
      }
    }

    function setSyncLabel(text, color) {
      const lbl = document.getElementById('nav-sync-label');
      const icon = document.getElementById('nav-sync-icon');
      if (lbl) { lbl.textContent = text; lbl.style.color = color; }
      if (icon) { icon.style.color = color; }
      if (text !== 'Sync') setTimeout(() => setSyncLabel('Sync', '#a1a1aa'), 2500);
    }

    async function navSync() {
      const icon = document.getElementById('nav-sync-icon');
      if (icon) { icon.style.animation = 'spin 1s linear infinite'; }
      setSyncLabel('Syncing...', '#fbbf24');
      try {
        // Pull remote changes first and merge them into our local lists, then push.
        // This way a manual sync picks up edits made on other devices instead of
        // always overwriting them — pushToServer's own 409 handling is a backstop
        // for the rare race where another device saves in between these two calls.
        const before = { watchedList: [...watchedList], toWatchList: [...toWatchList], dislikedList: [...dislikedList], notInterestedList: [...notInterestedList] };
        const result = await syncFromServer();
        if (!result) {
          // syncFromServer returned null — KV not bound or Worker not configured
          setSyncLabel('No KV — use Transfer ↑', '#f87171');
          setTimeout(() => setSyncLabel('Sync', '#a1a1aa'), 4000);
        } else {
          // Merge back in any local-only items the pull would otherwise have dropped
          // (e.g. something added in the brief window before this sync ran). Baseline
          // keeps this from resurrecting something deliberately removed in that window.
          watchedList = _mergeItemLists(before.watchedList, watchedList, _syncBaseline?.watched);
          toWatchList = _mergeItemLists(before.toWatchList, toWatchList, _syncBaseline?.to_watch);
          dislikedList = _mergeItemLists(before.dislikedList, dislikedList, _syncBaseline?.disliked);
          notInterestedList = _mergeItemLists(before.notInterestedList, notInterestedList, _syncBaseline?.not_interested);
          watchedIds = new Set([...toWatchList,...watchedList,...dislikedList,...notInterestedList].map(w=>`${w.id}:${w._mediaType||'movie'}`));
          updateAllLibraryRenders(); renderPersonalStats();
          await pushToServer(true);
        }
      } catch(e) {
        setSyncLabel('Failed — use Transfer ↑', '#f87171');
        setTimeout(() => setSyncLabel('Sync', '#a1a1aa'), 4000);
      }
      if (icon) { icon.style.animation = ''; }
    }

    // ── Library search + sort state and helpers ──────────────────────────────────
    // The Library lists used to render only a truncated head (24 watched / 12 disliked
    // / 50 hidden) with a "+N more" label and no way to reach the rest. These helpers
    // let search + sort operate across the ENTIRE list so a 700-item library is
    // actually browsable. Re-rendering the active pane on every keystroke/sort change.
    let librarySearch = '';
    let librarySort = 'added';
    const LIBRARY_DISPLAY_CAP = 120; // cap rendered nodes for performance; search narrows further

    function onLibrarySearch() {
      const el = document.getElementById('library-search');
      librarySearch = (el ? el.value : '').trim().toLowerCase();
      rerenderActivePersonalPane();
    }
    function onLibrarySort() {
      const el = document.getElementById('library-sort');
      librarySort = el ? el.value : 'added';
      rerenderActivePersonalPane();
    }
    // Re-run only the render for whichever personal pane is currently visible.
    function rerenderActivePersonalPane() {
      if (!document.getElementById('pane-towatch')?.classList.contains('hidden')) { renderToWatch(); return; }
      if (!document.getElementById('pane-watched')?.classList.contains('hidden')) { renderWatched(); return; }
      if (!document.getElementById('pane-disliked')?.classList.contains('hidden')) { renderDisliked(); return; }
      if (!document.getElementById('pane-notinterested')?.classList.contains('hidden')) { renderNotInterested(); return; }
    }
    // Apply the active search term + sort order to a list, returning a new array.
    // `opts.preserveOrder` keeps the list's own order for the "added" sort (lists are
    // unshift-ordered = most-recent-first already), so we don't disturb queue order.
    function applyLibraryView(list) {
      let out = list.slice();
      if (librarySearch) {
        out = out.filter(it => {
          const t = (it.title || it.name || it.original_title || it.original_name || '').toLowerCase();
          return t.includes(librarySearch);
        });
      }
      switch (librarySort) {
        case 'rating':
          out.sort((a, b) => (b.rating || 0) - (a.rating || 0));
          break;
        case 'title':
          out.sort((a, b) => (a.title || a.name || '').localeCompare(b.title || b.name || ''));
          break;
        case 'year': {
          const yr = x => parseInt((x.release_date || x.first_air_date || '0').slice(0, 4)) || 0;
          out.sort((a, b) => yr(b) - yr(a));
          break;
        }
        // 'added' → leave in native (most-recent-first) order
      }
      return out;
    }
    // Small helper: the "+N more" footer, only shown when not searching and the list
    // exceeds the display cap.
    function libraryMoreFooter(total, shown) {
      if (librarySearch || total <= shown) return '';
      return `<div class="col-span-2 sm:col-span-3 text-[10px] text-zinc-500 px-1">Showing ${shown} of ${total} — use search to find any title</div>`;
    }

    function renderToWatch() {
      const c = document.getElementById('to-watch-content');
      if (!c) return;
      if (!toWatchList.length) {
        c.innerHTML = `<div class="empty-state"><span class="empty-state-icon">🎬</span><div class="text-sm font-medium text-zinc-400">Your queue is empty</div><div class="text-xs text-zinc-600 mt-1">Add from recommendations, search, or ask the Curator.</div></div>`;
        return;
      }
      // Filter + sort across the WHOLE queue, then cap for rendering. Each rendered
      // row is addressed by item id + media type (not array index), so it stays
      // correct after sorting/searching and after concurrent swipe/click actions.
      const view = applyLibraryView(toWatchList);
      if (!view.length) {
        c.innerHTML = `<div class="empty-state col-span-full"><span class="empty-state-icon">🔍</span><div class="text-sm font-medium text-zinc-400">No matches in your queue</div></div>`;
        return;
      }
      const shown = view.slice(0, LIBRARY_DISPLAY_CAP);
      let html = '';
      shown.forEach(item => {
        const mediaType = item._mediaType || 'movie';
        const year = (item.release_date || '').slice(0,4);
        const topGenre = (item.genre_ids && item.genre_ids.length) ? (GENRES.find(g=>g.id===item.genre_ids[0])?.name || '') : '';
        const itemTitleSafe = escapeHtml(item.title || item.name || 'Untitled');
        const posterImg = item.poster_path
          ? `<img src="https://image.tmdb.org/t/p/w342${item.poster_path}" loading="lazy" alt="${itemTitleSafe} poster" style="width:100%;height:100%;object-fit:cover;display:block;">`
          : `🎬`;
        const itemTitle = item.title || item.name || '';
        const imdbSearchUrl = `https://www.imdb.com/find/?q=${encodeURIComponent(itemTitle + (year ? ' ' + year : ''))}&s=tt&ttype=ft`;
        const rtSearchUrl = rtUrl(itemTitle, mediaType);
        html += `<div class="library-item library-item-v2 library-card" data-id="${item.id}" data-media-type="${mediaType}" style="position:relative;">
          <button onclick="removeFromToWatch(${item.id}, '${mediaType}')" aria-label="Remove ${itemTitleSafe} from To Watch" title="Remove from To Watch" style="position:absolute;top:7px;right:8px;width:18px;height:18px;font-size:11px;line-height:1;background:rgba(39,39,42,0.85);border:1px solid #3f3f46;border-radius:50%;color:#f87171;display:flex;align-items:center;justify-content:center;z-index:1;">×</button>
          <div class="lib-poster">${posterImg}</div>
          <div class="lib-body flex-1">
            <div class="lib-title" style="padding-right:18px;">${itemTitleSafe}</div>
            <div class="lib-meta">
              ${year ? `<span class="text-[10px] text-zinc-500">${year}</span>` : ''}
              ${topGenre ? `<span class="library-genre-tag">${topGenre}</span>` : ''}
            </div>
            <div class="lib-actions">
              <button onclick="markWatchedFromToWatch(${item.id}, '${mediaType}')" class="bg-emerald-900 border border-emerald-700/50 text-emerald-300">Rate</button>
              <button id="tw-trailer-${item.id}" class="border border-zinc-700 text-zinc-600 hidden">▶</button>
              <button onclick="dislikeFromToWatch(${item.id}, '${mediaType}')" class="border border-zinc-700 text-zinc-400">👎</button>
            </div>
            <div class="lib-external-links">
              <a href="${imdbSearchUrl}" target="_blank" rel="noopener" title="Find on IMDb" aria-label="Find ${itemTitleSafe} on IMDb" class="bg-[#f5c518] text-black"><i class="fa-brands fa-imdb"></i></a>
              <a href="${rtSearchUrl}" target="_blank" rel="noopener" title="Find on Rotten Tomatoes" aria-label="Find ${itemTitleSafe} on Rotten Tomatoes" class="bg-[#fa320a] text-white">RT</a>
            </div>
          </div>
        </div>`;
      });
      html += libraryMoreFooter(toWatchList.length, shown.length);
      c.innerHTML = html;

      // Async: fetch trailers for each visible To Watch item and show button if found
      shown.forEach(item => {
        const mediaPath = (item._mediaType || 'movie') === 'tv' ? 'tv' : 'movie';
        apiFetch(`/api/tmdb/3/${mediaPath}/${item.id}/videos`).then(vdata => {
          const trailer = (vdata?.results || []).find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
                          (vdata?.results || []).find(v => v.site === 'YouTube');
          if (trailer) {
            const btn = document.getElementById(`tw-trailer-${item.id}`);
            if (btn) {
              btn.classList.remove('hidden', 'text-zinc-600');
              btn.classList.add('text-red-400');
              btn.onclick = (e) => { e.stopPropagation(); window.open(`https://www.youtube.com/watch?v=${trailer.key}`, '_blank', 'noopener'); };
            }
          }
        }).catch(() => {});
      });

      // Make poster area clickable to open detail modal
      const toWatchRows = c.querySelectorAll('.library-item');
      shown.forEach((item, i) => {
        if (i >= toWatchRows.length) return;
        const posterEl = toWatchRows[i].querySelector('.lib-poster');
        if (posterEl && item) {
          posterEl.style.cursor = 'pointer';
          posterEl.title = 'View details';
          posterEl.onclick = (e) => {
            if (e.target.closest('a')) return; // let the IMDb/RT badge links navigate instead of opening the modal
            e.stopPropagation();
            openModal(item).catch(()=>{});
          };
        }
      });

      // Swipe gestures on mobile
      setupSwipeActions(c, 'towatch');
    }

    let activeRatingPromptCleanup = null;

    function closeActiveRatingPrompt() {
      if (typeof activeRatingPromptCleanup === 'function') activeRatingPromptCleanup();
    }

    function openInlineRatingPrompt(anchor, item, onRated, options = {}) {
      if (!anchor || !item) return;
      closeActiveRatingPrompt();

      const hiddenButtons = options.hideButtons || [];
      hiddenButtons.forEach(b => { if (b) b.style.display = 'none'; });

      const libraryRow = anchor.closest('.library-item');
      const curatorRow = anchor.closest('.curator-pick-row');
      const browseCard = anchor.closest('.movie-card-v2');
      const overlayHost = libraryRow || curatorRow || browseCard;

      const rateBar = document.createElement('div');
      rateBar.className = 'inline-rating-bar';
      if (curatorRow) {
        // Full-cover overlay over the compact Curator pick card — replaces the
        // row content with a clean row of 5 even star buttons (matches To Watch).
        rateBar.style.cssText = 'position:absolute;inset:0;z-index:20;display:flex;gap:4px;align-items:center;padding:6px 8px;background:rgba(10,8,14,0.96);border:1px solid rgba(245,158,11,0.3);border-radius:14px;';
      } else if (browseCard) {
        // Full-width bar across the bottom of the Browse card so the 5 stars are
        // large and evenly spaced instead of cramped into the narrow text column.
        rateBar.style.cssText = 'position:absolute;left:0;right:0;bottom:0;z-index:20;display:flex;gap:8px;align-items:center;padding:12px 16px;background:rgba(10,8,14,0.97);border-top:1px solid rgba(245,158,11,0.3);border-radius:0 0 24px 24px;';
      } else if (libraryRow) {
        // Absolute overlay at bottom of row — does not push poster or expand height
        rateBar.style.cssText = 'position:absolute;bottom:0;left:0;right:0;z-index:20;display:flex;gap:4px;align-items:center;padding:4px 6px;background:rgba(10,8,14,0.93);border-top:1px solid rgba(245,158,11,0.25);border-radius:0 0 8px 8px;';
      } else {
        rateBar.style.cssText = 'display:flex;gap:4px;align-items:center;width:100%;margin-top:6px;flex-wrap:nowrap;';
      }
      rateBar.addEventListener('pointerdown', ev => ev.stopPropagation());
      rateBar.addEventListener('click', ev => ev.stopPropagation());

      const cleanup = () => {
        rateBar.remove();
        hiddenButtons.forEach(b => { if (b) b.style.display = ''; });
        document.removeEventListener('pointerdown', outsideHandler, true);
        if (activeRatingPromptCleanup === cleanup) activeRatingPromptCleanup = null;
        if (overlayHost) { overlayHost.style.position = ''; overlayHost.style.overflow = ''; }
      };

      const outsideHandler = ev => {
        if (!rateBar.contains(ev.target)) cleanup();
      };

      for (let r = 1; r <= 5; r++) {
        const b = document.createElement('button');
        b.textContent = r + '★';
        b.className = 'flex-1 rounded-lg bg-amber-500/20 hover:bg-amber-500 active:bg-amber-400 text-amber-300 hover:text-white border border-amber-500/30 font-semibold transition-colors';
        b.style.cssText = 'min-height:0 !important; font-size:13px !important; line-height:1.4; padding:4px 2px !important; min-width:0;';
        b.onclick = ev => {
          ev.stopImmediatePropagation();
          cleanup();
          onRated(r);
        };
        rateBar.appendChild(b);
      }

      if (overlayHost) {
        // Mount on the row itself so absolute positioning works correctly
        overlayHost.style.position = 'relative';
        overlayHost.style.overflow = 'visible';
        overlayHost.appendChild(rateBar);
      } else {
        anchor.appendChild(rateBar);
      }
      activeRatingPromptCleanup = cleanup;

      setTimeout(() => document.addEventListener('pointerdown', outsideHandler, true), 0);
    }

    function markWatchedFromToWatch(id, mediaType = 'movie') {
      const item = toWatchList.find(x => x.id === id && (x._mediaType || 'movie') === mediaType);
      if (!item) return;
      const container = document.getElementById('to-watch-content');
      // Look up the row by item id (not DOM position or array index) — works
      // correctly regardless of search/sort order or concurrent list mutation.
      const row = container ? container.querySelector(`[data-id="${id}"][data-media-type="${mediaType}"]`) : null;
      if (!row) {
        // rare fallback: default to 4 to avoid jarring prompt
        addToWatched(item, 4);
        return;
      }
      const actionButtons = Array.from(row.querySelectorAll('button'));
      const contentDiv = row.querySelector('.lib-body') || row.querySelector('.flex-1') || row;
      openInlineRatingPrompt(contentDiv, item, r => {
        addToWatched(item, r);
        row.style.opacity = '0.4';
      }, { hideButtons: actionButtons });
    }
    function dislikeFromToWatch(id, mediaType = 'movie') {
      const item = toWatchList.find(x => x.id === id && (x._mediaType || 'movie') === mediaType);
      if (!item) return;
      addToDisliked(item);
    }

    function renderWatched() {
      const c = document.getElementById('watched-content');
      if (!c) return;
      if (!watchedList.length) { c.innerHTML = `<div class="empty-state"><span class="empty-state-icon">👁️</span><div class="text-sm font-medium text-zinc-400">No watched titles yet</div><div class="text-xs text-zinc-600 mt-1">Rate movies as you watch — this powers your personal recs.</div></div>`; return; }
      const view = applyLibraryView(watchedList);
      if (!view.length) {
        c.innerHTML = `<div class="empty-state col-span-full"><span class="empty-state-icon">🔍</span><div class="text-sm font-medium text-zinc-400">No matches in your watched library</div></div>`;
        return;
      }
      const shown = view.slice(0, LIBRARY_DISPLAY_CAP);
      let html = '';
      shown.forEach((item) => {
        const year = (item.release_date || '').slice(0,4);
        const wGenre = (item.genre_ids && item.genre_ids.length) ? (GENRES.find(g=>g.id===item.genre_ids[0])?.name || '') : '';
        const itemTitleSafe = escapeHtml(item.title || item.name || 'Untitled');
        const posterImg = item.poster_path
          ? `<img src="https://image.tmdb.org/t/p/w342${item.poster_path}" loading="lazy" alt="${itemTitleSafe} poster" style="width:100%;height:100%;object-fit:cover;display:block;">`
          : `🎬`;
        const stars = item.rating ? `<span class="library-rating text-[10px]">${'★'.repeat(item.rating)}${'☆'.repeat(5-item.rating)}</span>` : '';
        html += `<div class="library-item library-item-v2 library-card" data-id="${item.id}" data-media-type="${item._mediaType || 'movie'}">
          <div class="lib-poster">${posterImg}</div>
          <div class="lib-body flex-1">
            <div class="lib-title">${itemTitleSafe}</div>
            <div class="lib-meta">
              ${year ? `<span class="text-[10px] text-zinc-500">${year}</span>` : ''}
              ${wGenre ? `<span class="library-genre-tag">${wGenre}</span>` : ''}
              ${stars}
            </div>
            <div class="lib-actions">
              <button onclick="removeFromWatched(${item.id}, '${item._mediaType}')" class="text-red-400 border border-zinc-700" aria-label="Remove ${itemTitleSafe} from Watched" title="Remove from Watched">×</button>
            </div>
          </div>
        </div>`;
      });
      html += libraryMoreFooter(watchedList.length, shown.length);
      c.innerHTML = html;

      // Make poster area clickable to open detail modal
      const watchedRows = c.querySelectorAll('.library-item');
      shown.forEach((item, i) => {
        if (i >= watchedRows.length) return;
        const posterEl = watchedRows[i].querySelector('.lib-poster');
        if (posterEl && item) {
          posterEl.style.cursor = 'pointer';
          posterEl.title = 'View details';
          posterEl.onclick = (e) => { e.stopPropagation(); openModal(item).catch(()=>{}); };
        }
      });

      // Swipe gestures on mobile
      setupSwipeActions(c, 'watched');
    }

    function renderDisliked() {
      const c = document.getElementById('disliked-content');
      if (!c) return;
      if (!dislikedList.length) { c.innerHTML = `<div class="empty-state"><span class="empty-state-icon">👎</span><div class="text-sm font-medium text-zinc-400">Nothing disliked yet</div><div class="text-xs text-zinc-600 mt-1">Disliked titles are excluded from recommendations.</div></div>`; return; }
      const view = applyLibraryView(dislikedList);
      if (!view.length) {
        c.innerHTML = `<div class="empty-state col-span-full"><span class="empty-state-icon">🔍</span><div class="text-sm font-medium text-zinc-400">No matches in your disliked list</div></div>`;
        return;
      }
      const shown = view.slice(0, LIBRARY_DISPLAY_CAP);
      let html = '';
      shown.forEach((item) => {
        const displayTitle = escapeHtml(item.title || item.name || item.original_title || item.original_name || 'Unknown Title');
        const year = (item.release_date || item.first_air_date || '').slice(0,4);
        const topGenre = (item.genre_ids && item.genre_ids.length) ? (GENRES.find(g=>g.id===item.genre_ids[0])?.name || '') : '';
        const posterImg = item.poster_path
          ? `<img src="https://image.tmdb.org/t/p/w342${item.poster_path}" loading="lazy" alt="${displayTitle} poster" style="width:100%;height:100%;object-fit:cover;display:block;">`
          : `🎬`;
        html += `<div class="library-item library-item-v2 library-card" data-id="${item.id}" data-media-type="${item._mediaType || 'movie'}">
          <div class="lib-poster">${posterImg}</div>
          <div class="lib-body flex-1">
            <div class="lib-title">${displayTitle}</div>
            <div class="lib-meta">
              ${year ? `<span class="text-[10px] text-zinc-500">${year}</span>` : ''}
              ${topGenre ? `<span class="library-genre-tag">${topGenre}</span>` : ''}
            </div>
            <div class="lib-actions">
              <button onclick="removeFromDisliked(${item.id}, '${item._mediaType || 'movie'}')" class="text-red-400 border border-zinc-700" title="Remove from disliked" aria-label="Remove ${displayTitle} from Disliked">×</button>
            </div>
          </div>
        </div>`;
      });
      html += libraryMoreFooter(dislikedList.length, shown.length);
      c.innerHTML = html;

      // Make poster area clickable to open detail modal
      const dislikedRows = c.querySelectorAll('.library-item');
      shown.forEach((item, i) => {
        if (i >= dislikedRows.length) return;
        const posterEl = dislikedRows[i].querySelector('.lib-poster');
        if (posterEl && item) {
          posterEl.style.cursor = 'pointer';
          posterEl.title = 'View details';
          posterEl.onclick = (e) => { e.stopPropagation(); openModal(item).catch(()=>{}); };
        }
      });

      // Swipe gestures on mobile
      setupSwipeActions(c, 'disliked');
    }

    function renderNotInterested() {
      const c = document.getElementById('notinterested-content');
      if (!c) return;
      if (!notInterestedList.length) {
        c.innerHTML = `<div class="empty-state"><span class="empty-state-icon">🚫</span><div class="text-sm font-medium text-zinc-400">Nothing hidden yet</div><div class="text-xs text-zinc-600 mt-1">Movies you mark Not Interested are hidden and their genres are downranked in recs.</div></div>`;
        return;
      }
      const view = applyLibraryView(notInterestedList);
      if (!view.length) {
        c.innerHTML = `<div class="empty-state col-span-full"><span class="empty-state-icon">🔍</span><div class="text-sm font-medium text-zinc-400">No matches in your hidden list</div></div>`;
        return;
      }
      const shown = view.slice(0, LIBRARY_DISPLAY_CAP);
      let html = '';
      shown.forEach((item, idx) => {
        const displayTitle = escapeHtml(item.title || item.name || item.original_title || 'Unknown Title');
        const year = (item.release_date || item.first_air_date || '').slice(0, 4);
        const topGenre = (item.genre_ids && item.genre_ids.length) ? (GENRES.find(g => g.id === item.genre_ids[0])?.name || '') : '';
        const posterImg = item.poster_path
          ? `<img src="https://image.tmdb.org/t/p/w342${item.poster_path}" loading="lazy" alt="${displayTitle} poster" style="width:100%;height:100%;object-fit:cover;display:block;">`
          : `🎬`;
        html += `<div class="library-item library-item-v2 library-card" data-ni-idx="${idx}">
          <div class="lib-poster">${posterImg}</div>
          <div class="lib-body flex-1">
            <div class="lib-title">${displayTitle}</div>
            <div class="lib-meta">
              ${year ? `<span class="text-[10px] text-zinc-500">${year}</span>` : ''}
              ${topGenre ? `<span class="library-genre-tag">${topGenre}</span>` : ''}
            </div>
            <div class="lib-actions">
              <button onclick="removeFromNotInterested(${item.id}, '${item._mediaType || 'movie'}')" class="text-zinc-400 border border-zinc-700" title="Unhide">× Unhide</button>
            </div>
          </div>
        </div>`;
      });
      html += libraryMoreFooter(notInterestedList.length, shown.length);
      c.innerHTML = html;
    }

    // Migrate old disliked entries missing title/poster — re-fetch from TMDB silently
    async function migrateDislikedData() {
      const needsMigration = dislikedList.filter(d => !d.title && !d.name);
      if (!needsMigration.length) return;
      let changed = false;
      for (const item of needsMigration) {
        if (!item.id) continue;
        try {
          const mediaType = item._mediaType || 'movie';
          const data = await apiFetch(`/api/tmdb/3/${mediaType}/${item.id}?language=en-US`);
          if (data && (data.title || data.name)) {
            item.title = data.title || data.name;
            item.name = data.name || data.title;
            item.poster_path = item.poster_path || data.poster_path;
            item.release_date = item.release_date || data.release_date || data.first_air_date;
            item.vote_average = item.vote_average || data.vote_average;
            item.genre_ids = item.genre_ids && item.genre_ids.length ? item.genre_ids : (data.genre_ids || (data.genres || []).map(g=>g.id));
            changed = true;
          }
        } catch(e) { /* silent */ }
      }
      if (changed) {
        saveDisliked();
        renderDisliked();
      }
    }

    // Basic pull-to-refresh for personal lists area (mobile)
    function setupPullToRefresh() {
      const content = document.getElementById('personal-content');
      const bar = document.getElementById('personal-tabs-bar');
      if (!content || !bar) return;
      let startY = 0;
      let pulling = false;
      bar.addEventListener('touchstart', (e) => {
        if (content.scrollTop > 5) return;
        startY = e.touches[0].clientY;
        pulling = true;
      }, {passive: true});
      bar.addEventListener('touchmove', (e) => {
        if (!pulling) return;
        const dy = e.touches[0].clientY - startY;
        if (dy > 60) {
          content.style.transition = 'none';
          content.style.transform = `translateY(${Math.min(dy-60, 40)}px)`;
        }
      }, {passive: true});
      bar.addEventListener('touchend', () => {
        if (!pulling) return;
        pulling = false;
        const wasPulled = content.style.transform && parseFloat(content.style.transform) > 20;
        content.style.transition = 'transform 0.2s ease';
        content.style.transform = '';
        if (wasPulled) {
          updateAllLibraryRenders();
          showToast('Lists refreshed');
          recomputeRecommendations();
        }
      });
    }

    function pickRandomToWatch() {
      if (!toWatchList.length) { alert('To Watch is empty.'); return; }
      const pick = toWatchList[Math.floor(Math.random()*toWatchList.length)];
      // show in modal or just toast + detail if possible
      openModal(pick).catch(()=>{});
    }

    function updateAllLibraryRenders() {
      updateLibraryCounts();
      renderToWatch();
      renderWatched();
      renderDisliked();
      renderNotInterested();
      // Migrate any old disliked entries missing title/poster
      setTimeout(() => migrateDislikedData().catch(()=>{}), 1500);
      try { renderWatchlist(); } catch(e){}
      applyListsCollapse();
    }

    // Master collapse for all three personal list panes (To Watch / Watched / Disliked).
    // Persisted so it remembers across reloads. Single toggle for all at once.
    let listsCollapsed = Store.getItem('horror_roki_lists_collapsed') === 'true';

    function toggleAllLists() {
      listsCollapsed = !listsCollapsed;
      Store.setItem('horror_roki_lists_collapsed', listsCollapsed);
      applyListsCollapse();
    }

    function applyListsCollapse() {
      const wrapper = document.getElementById('personal-content');
      const btn = document.getElementById('lists-toggle');
      const bar = document.getElementById('personal-tabs-bar');
      if (wrapper) {
        wrapper.style.display = listsCollapsed ? 'none' : '';
      }
      if (btn) {
        btn.textContent = listsCollapsed ? '▸' : '▾';
        btn.title = listsCollapsed ? 'Show all lists' : 'Hide all lists';
      }
      if (bar) {
        if (listsCollapsed) bar.classList.add('rounded-b-2xl');
        else bar.classList.remove('rounded-b-2xl');
      }
    }

    // Simple tabs for top personal (To Watch etc moved to top)
    function switchPersonalTab(tab) {
      // Clear the search box when switching lists so each tab starts unfiltered.
      const searchEl = document.getElementById('library-search');
      if (searchEl && searchEl.value) { searchEl.value = ''; librarySearch = ''; }
      document.querySelectorAll('.personal-pane').forEach(p => p.classList.add('hidden'));
      document.querySelectorAll('.personal-tab').forEach(b => b.classList.remove('active'));
      const pane = document.getElementById('pane-' + tab);
      if (pane) {
        pane.classList.remove('hidden');
        pane.style.animation = 'none';
        pane.offsetHeight; // reflow
        pane.style.animation = '';
      }
      const btn = document.getElementById('tab-' + tab);
      if (btn) btn.classList.add('active');

      // Re-apply swipes for the newly visible pane
      setTimeout(() => {
        const activePane = document.querySelector('.personal-pane:not(.hidden)');
        if (activePane) {
          const content = activePane.querySelector('#to-watch-content, #watched-content, #disliked-content');
          if (content) {
            const type = activePane.id.includes('towatch') ? 'towatch' : activePane.id.includes('watched') ? 'watched' : 'disliked';
            setupSwipeActions(content, type);
          }
        }
      }, 50);
    }


