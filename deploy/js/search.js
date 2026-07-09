    // ===================== SEARCH =====================
    // The Browse tab's title search: direct TMDB title matches, a "similar titles"
    // broadening pass, and the director/writer/actor name fallback (which resolves
    // a query like "Stephen King" to a person and pulls their credits when a plain
    // title search comes up empty). renderResults() below is shared with Discover.

    // Search by director/writer/actor name: TMDB's title search only matches
    // movie/show titles, never person names, so a query like "Ari Aster" returns
    // nothing from it. This resolves the query to a person via /search/person, then
    // pulls their directing/writing/acting credits from BOTH movie_credits and
    // tv_credits (a person search should surface their whole body of work — e.g.
    // Stephen King's "The Langoliers" is a TV miniseries and would otherwise never
    // appear while the Movies toggle is active), merges same-title credits into one
    // entry, and sorts writing/directing credits (their primary, defining
    // contribution) ahead of pure-acting credits, popularity descending within each
    // group. Capped generously at 40 — a prolific person can have 400+ credits, and
    // even after this sorting, a straight top-20 cut still missed well-known films
    // (verified live: Stephen King's "The Mist", "Misery", "Carrie", and "Doctor
    // Sleep" all sit between rank 20-40, behind higher-popularity-but-more-tangential
    // credits like a talk-show appearance's host show).
    //
    // person.name must match the query fairly closely (see isCloseNameMatch) before
    // any of this is used: TMDB's person search is fuzzy and will happily return an
    // unrelated adult-content title for a query like "The Mist" (matching on "mist"
    // as a substring) — without this gate, that false match would hijack a search
    // for an actual movie titled "The Mist" and hide the real, correct title match.
    function isCloseNameMatch(query, name) {
      const norm = s => s.toLowerCase().trim().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ');
      return norm(query) === norm(name);
    }

    // TMDB cast credits include talk-show/game-show/news guest appearances (playing
    // "Self"), which can have a very high popularity score from the HOST SHOW's fame
    // (e.g. The Daily Show, Jeopardy!) even though the appearance itself says nothing
    // about the person's actual body of work — these otherwise crowd out their real
    // acting/writing/directing credits when sorting by popularity.
    function isSelfCameo(credit, personName) {
      const character = (credit.character || '').toLowerCase().trim();
      if (!character) return true; // no character name at all — almost always an interview/clip appearance, not a real role
      if (character.startsWith('self')) return true;
      const stripped = character.split('(')[0].trim();
      return stripped === personName.toLowerCase().trim();
    }

    async function searchPersonCredits(query) {
      try {
        const personData = await apiFetch(`/api/tmdb/3/search/person?query=${encodeURIComponent(query)}`);
        const person = (personData.results || []).find(p => isCloseNameMatch(query, p.name));
        if (!person) return null;

        const [movieCredits, tvCredits] = await Promise.all([
          apiFetch(`/api/tmdb/3/person/${person.id}/movie_credits`),
          apiFetch(`/api/tmdb/3/person/${person.id}/tv_credits`),
        ]);
        const directorJobs = new Set(['Director', 'Creator']);
        const writerJobs = new Set(['Writer', 'Screenplay', 'Novel', 'Story']);

        const roleById = new Map(); // "id:mediaType" -> { item, isDirector, isWriter, isActor }
        const addCrew = (list, itemMediaType) => (list || []).forEach(c => {
          if (!directorJobs.has(c.job) && !writerJobs.has(c.job)) return;
          if (!c.id || !(c.title || c.name)) return;
          const key = `${c.id}:${itemMediaType}`;
          const r = roleById.get(key) || { item: c, mediaType: itemMediaType, isDirector: false, isWriter: false, isActor: false };
          if (directorJobs.has(c.job)) r.isDirector = true;
          if (writerJobs.has(c.job)) r.isWriter = true;
          roleById.set(key, r);
        });
        const addCast = (list, itemMediaType) => (list || []).forEach(c => {
          if (!c.id || !(c.title || c.name)) return;
          if (isSelfCameo(c, person.name)) return;
          const key = `${c.id}:${itemMediaType}`;
          const r = roleById.get(key) || { item: c, mediaType: itemMediaType, isDirector: false, isWriter: false, isActor: false };
          r.isActor = true;
          roleById.set(key, r);
        });
        addCrew(movieCredits.crew, 'movie');
        addCrew(tvCredits.crew, 'tv');
        addCast(movieCredits.cast, 'movie');
        addCast(tvCredits.cast, 'tv');

        const items = [...roleById.values()].map(r => {
          const roleParts = [];
          if (r.isDirector) roleParts.push('Directed');
          if (r.isWriter) roleParts.push('Written');
          if (r.isActor) roleParts.push(roleParts.length ? 'Acted in' : 'Starring');
          return {
            ...r.item,
            _mediaType: r.mediaType,
            _isWriterOrDirector: r.isDirector || r.isWriter,
            _personRole: `${roleParts.join(' & ')} by ${person.name}`.replace('Starring by', 'Starring'),
          };
        }).sort((a, b) => {
          // Writing/directing credits first (the person's primary contribution),
          // then popularity within each group — see comment above for why.
          const tierDiff = (b._isWriterOrDirector ? 1 : 0) - (a._isWriterOrDirector ? 1 : 0);
          if (tierDiff !== 0) return tierDiff;
          return (b.popularity || 0) - (a.popularity || 0);
        }).map(({ _isWriterOrDirector, ...item }) => item); // internal sort key only, not needed downstream

        return { person, items };
      } catch (e) {
        return null;
      }
    }

    // TMDB
    async function performSearch() {
      const container = document.getElementById('results');
      const initial = document.getElementById('initial-state');
      const query = document.getElementById('search-input').value.trim();
      if (!query) return;

      // Search-as-you-type means several of these can be in flight at once (each
      // doing multiple TMDB round-trips) — tag this call and bail out at each
      // display point if a newer call has since started, so a slow older response
      // can't land after and clobber what the user's now typing/seeing.
      const myGen = ++_searchGen;

      if (initial) initial.style.display = 'none';
      showSkeletons('results', 8);

      const isMovie = currentSearchType === 'movie';
      const searchEndpoint = isMovie ? 'movie' : 'tv';
      const mediaPath = isMovie ? 'movie' : 'tv';

      try {
        // Run the title search and a person lookup in parallel — a query like
        // "Stephen King" or "Ridley Scott" often DOES return a few title matches
        // from TMDB (making-of documentaries, "X: A Life in Film" specials that
        // literally contain the name), so gating the person lookup on "title
        // search came back empty" doesn't catch those cases: the results list
        // ends up with a handful of irrelevant docs instead of the person's actual
        // filmography. Preferring the person's credits whenever a match exists
        // fixes that.
        const [searchData, personResult] = await Promise.all([
          apiFetch(`/api/tmdb/3/search/${searchEndpoint}?query=${encodeURIComponent(query)}`),
          searchPersonCredits(query),
        ]);
        if (myGen !== _searchGen) return;

        if (searchData.success === false) {
          container.innerHTML = `<div class="text-center py-6 text-red-400">TMDB error: ${searchData.status_message}</div>`;
          return;
        }

        let top = [];

        if (personResult && personResult.items.length) {
          // Capped more generously than a title search's 20 — a prolific person's
          // well-known work is easily spread across ranks 20-40 by popularity (see
          // searchPersonCredits' comment), so 20 alone still missed real titles.
          top = personResult.items.slice(0, 40);
        } else if (searchData.results?.length) {
          const directMatches = searchData.results
            .filter(item => item && (item.title || item.name))
            .slice(0, 10);

          // Broaden the search: pull titles similar to the best match so the user
          // sees related films in the same vein, not just exact-name results.
          let similar = [];
          const best = directMatches[0];
          if (best && best.id) {
            try {
              const sim = await apiFetch(`/api/tmdb/3/${mediaPath}/${best.id}/similar?page=1`);
              similar = (sim.results || []).filter(i => i && (i.title || i.name) && i.poster_path);
            } catch (e) { /* similar is best-effort */ }
          }

          // Merge direct matches (first, most relevant) + similar, dedupe by id
          const seenIds = new Set();
          for (const it of [...directMatches, ...similar]) {
            if (it && it.id && !seenIds.has(it.id)) { seenIds.add(it.id); top.push(it); }
            if (top.length >= 20) break;
          }
        } else {
          container.innerHTML = `
            <div class="text-center py-10 text-zinc-400">
              <i class="fa-solid fa-search text-3xl mb-3 opacity-50"></i>
              <p>No results found for that search.</p>
              <p class="text-xs mt-1">Try a different title, or a director/writer/actor's full name.</p>
            </div>`;
          return;
        }
        const enriched = await Promise.all(top.map(async item => {
          // Person-credit results can mix movie and TV items regardless of the
          // active toggle (see searchPersonCredits) — use each item's own type if
          // it has one, instead of forcing every item to match the toggle, which
          // would fetch the wrong provider/external-id endpoint for half of them.
          const itemMediaType = item._mediaType || currentSearchType;
          const itemMediaPath = itemMediaType === 'tv' ? 'tv' : 'movie';
          try {
            const [provData, extData] = await Promise.all([
              apiFetch(`/api/tmdb/3/${itemMediaPath}/${item.id}/watch/providers`),
              apiFetch(`/api/tmdb/3/${itemMediaPath}/${item.id}/external_ids`)
            ]);
            const providers = provData.results?.US || null;
            const external = extData;
            return {
              ...item,
              providers,
              imdb_id: external.imdb_id || null,
              _mediaType: itemMediaType
            };
          } catch {
            return { ...item, providers: null, imdb_id: null, _mediaType: itemMediaType };
          }
        }));
        if (myGen !== _searchGen) return;

        renderResults(enriched, { keepLibraryItems: true });
        const activeFilters = document.getElementById('active-filters');
        if (activeFilters) activeFilters.classList.add('hidden');
      } catch (e) {
        if (myGen !== _searchGen) return;
        console.error('[Horror Roki] Search failed:', e);
        let displayMsg;
        if (e.status === 401 || e.message.includes('Unauthorized') || e.message.includes('password')) {
          displayMsg = 'Password required or incorrect. Click the 🔐 Pass button above to set it (or use ⚙︎ Settings to set API Endpoint Base if running locally).';
        } else if (e.details && e.details.error) {
          displayMsg = e.details.error;
          if (e.details.availableSecrets) {
            displayMsg += ' | Available matching secrets: ' + JSON.stringify(e.details.availableSecrets);
          }
        } else if (e.message) {
          displayMsg = e.message;
        } else {
          displayMsg = 'Error fetching data. Check password (🔐 Pass button) or connection. (If using local server: open ⚙︎ Settings and set "API Endpoint Base" to your Worker URL like https://your-worker.workers.dev , then set password. See browser Console for details.)';
        }
        container.innerHTML = `<div class="text-center py-6 text-red-400">${displayMsg}</div>`;
      }
    }

    function quickSearch(q) {
      document.getElementById('search-input').value = q;
      performSearch();
    }

function setCuratorPrompt(q) {
      const input = document.getElementById('curator-input');
      if (!input) return;
      input.value = q;
      sendToCurator();
    }

    function addSwipeGesture(card, item) {
      let startX = 0, startY = 0, tracking = false;
      const overlay = card.querySelector('.swipe-overlay');
      card.addEventListener('touchstart', e => {
        startX = e.touches[0].clientX; startY = e.touches[0].clientY; tracking = false;
        card.style.transition = 'none';
      }, { passive: true });
      card.addEventListener('touchmove', e => {
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        if (!tracking && Math.abs(dy) > Math.abs(dx) + 5) return;
        tracking = true;
        card.style.transform = `translateX(${dx}px) rotate(${dx * 0.025}deg)`;
        if (overlay) {
          overlay.style.opacity = Math.min(Math.abs(dx) / 90, 0.85);
          overlay.style.background = dx > 0 ? 'rgba(16,185,129,0.5)' : 'rgba(239,68,68,0.5)';
          overlay.textContent = dx > 0 ? '+ Watch' : '✕ Hide';
        }
      }, { passive: true });
      card.addEventListener('touchend', e => {
        if (!tracking) return;
        const dx = e.changedTouches[0].clientX - startX;
        card.style.transition = 'transform 0.25s ease, opacity 0.2s ease';
        if (dx > 80) {
          card.style.transform = 'translateX(150%) rotate(20deg)'; card.style.opacity = '0';
          setTimeout(() => { addToToWatch(item); card.remove(); }, 230);
        } else if (dx < -80) {
          card.style.transform = 'translateX(-150%) rotate(-20deg)'; card.style.opacity = '0';
          setTimeout(() => { addToNotInterested(item); card.remove(); }, 230);
        } else {
          card.style.transform = ''; card.style.opacity = '';
          if (overlay) { overlay.style.opacity = '0'; overlay.textContent = ''; }
        }
      });
    }

    function getProviderName(p) {
      const map = { 8: 'Netflix', 9: 'Prime Video', 15: 'Hulu', 1899: 'Max', 337: 'Disney+', 386: 'Peacock', 350: 'Apple TV', 531: 'Paramount+', 2575: 'Tubi', 207: 'Pluto TV' };
      return map[p.provider_id] || p.provider_name;
    }

    function showWatchPopup(anchorEl, providers) {
      document.querySelectorAll('.wtw-popup').forEach(p => p.remove());
      const popup = document.createElement('div');
      popup.className = 'wtw-popup';
      const groups = [
        { label: 'Stream', items: providers?.flatrate || [] },
        { label: 'Rent',   items: providers?.rent    || [] },
        { label: 'Buy',    items: providers?.buy     || [] },
      ].filter(g => g.items.length);
      if (!groups.length) {
        popup.innerHTML = `<div style="font-size:12px;color:#71717a;">No streaming data available</div>`;
      } else {
        popup.innerHTML = groups.map(g => `
          <div class="wtw-section-label">${g.label}</div>
          <div>${g.items.map(p => {
            const name = getProviderName(p);
            const cc = PROVIDER_COLORS[name] || 'bg-zinc-700 text-zinc-200';
            return `<span class="wtw-provider-pill ${cc}">${escapeHtml(name)}</span>`;
          }).join('')}</div>
        `).join('');
      }
      document.body.appendChild(popup);
      const rect = anchorEl.getBoundingClientRect();
      const pw = popup.offsetWidth || 220;
      let left = rect.left;
      let top = rect.bottom + 6;
      if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
      if (top + popup.offsetHeight > window.innerHeight - 8) top = rect.top - popup.offsetHeight - 6;
      popup.style.left = left + 'px';
      popup.style.top = top + 'px';
      const close = (e) => { if (!popup.contains(e.target) && e.target !== anchorEl) { popup.remove(); document.removeEventListener('pointerdown', close, true); } };
      setTimeout(() => document.addEventListener('pointerdown', close, true), 10);
    }

    function renderResults(items, opts = {}) {
      const container = document.getElementById('results');
      const initial = document.getElementById('initial-state');
      if (initial) initial.style.display = 'none';
      container.innerHTML = '';
      const services = getUserServices();

      lastRenderedItems = items;
      lastRenderedOpts = opts;

      // Filter out watched / to-watch / disliked using full exclusion (carries the "disappear" fix)
      // — except when keepLibraryItems is set (direct title search), where a title
      // already in the library should still show up, just badged as such, rather
      // than silently vanishing from the results the user explicitly searched for.
      const excluded = getExcludedKeys();
      items = items.filter(m => {
        const key = `${m.id}:${m._mediaType || 'movie'}`;
        const year = parseInt((m.release_date || m.first_air_date || '').slice(0, 4));
        const passesContentFilters = m.original_language === 'en' && !m.adult
          && !(m.genre_ids || []).includes(16) && (!year || year >= 1960);
        if (!passesContentFilters) return false;
        return opts.keepLibraryItems || !excluded.has(key);
      });

      if (!items.length) {
        container.innerHTML = `
          <div class="empty-state col-span-full">
            <span class="empty-state-icon">🎞️</span>
            <div class="text-zinc-300 font-medium">Everything here is already sorted</div>
            <div class="text-zinc-500 text-xs mt-1">Those titles are already watched, queued, or disliked. Try another search or loosen Discover.</div>
          </div>`;
        return;
      }

      items.forEach(m => {
        const title = m.title || m.name || 'Untitled';
        const titleSafe = escapeHtml(title); // for innerHTML string contexts only; DOM-API uses (textContent/aria-label) use `title` directly and are already safe
        const year = (m.release_date || m.first_air_date || '').slice(0, 4);
        const poster = m.poster_path ? `https://image.tmdb.org/t/p/w342${m.poster_path}` : null;

        const streamProviders = (m.providers?.flatrate || []);
        const hasAnyProvider = m.providers && (
          (m.providers.flatrate||[]).length || (m.providers.rent||[]).length || (m.providers.buy||[]).length
        );
        const html = (() => {
          if (streamProviders.length) {
            const pills = streamProviders.slice(0, 4).map(p => {
              const cc = PROVIDER_COLORS[p.provider_name] || 'bg-zinc-700 text-zinc-200';
              return `<span class="wtw-provider-pill ${cc}" style="font-size:10px;padding:2px 7px;border-radius:9999px;">${escapeHtml(p.provider_name)}</span>`;
            }).join('');
            return `<div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;"><span style="font-size:10px;color:#71717a;">Stream:</span>${pills}</div>`;
          }
          if (hasAnyProvider) {
            return `<button class="wtw-trigger" data-wtw-id="${m.id}">📍 Where to watch</button>`;
          }
          return '';
        })();

        const mediaLabel = (m._mediaType || 'movie') === 'tv' ? 'TV' : 'Movie';
        const mediaColor = (m._mediaType || 'movie') === 'tv' ? 'bg-sky-900 text-sky-400' : 'bg-violet-900 text-violet-400';
        const libraryBadge = getLibraryStatusBadge(m.id, m._mediaType);
        const libraryBadgeOverlay = libraryBadge
          ? `<span class="absolute top-1.5 left-1.5 text-[10px] font-bold px-2 py-1 rounded-full shadow ${libraryBadge.cls}">${libraryBadge.label}</span>`
          : '';
        // No poster to overlay onto — show the same badge as a plain inline pill instead.
        const libraryBadgeInline = libraryBadge
          ? `<span class="inline-block text-[10px] font-bold px-2 py-1 rounded-full mb-2 ${libraryBadge.cls}">${libraryBadge.label}</span>`
          : '';

        const card = document.createElement('div');
        card.className = 'movie-card movie-card-v2 bg-zinc-900 border border-zinc-700 rounded-3xl p-5 sm:p-6';
        card.innerHTML = `
          <div class="flex flex-col sm:flex-row gap-4 sm:gap-5">
            ${poster
              ? `<div class="search-card-poster poster-wrap loading relative flex-shrink-0 w-full sm:w-36"><img src="${poster}" class="w-full h-56 sm:h-[216px] rounded-2xl object-cover ring-1 ring-zinc-800 shadow" alt="${titleSafe} poster" onload="this.parentNode.classList.remove('loading')" onerror="this.onerror=null;this.src='${FALLBACK_POSTER}';this.parentNode.classList.remove('loading')">${libraryBadgeOverlay}</div>`
              : ''}
            <div class="flex-1 min-w-0 pt-1">
              <div>
                ${!poster ? libraryBadgeInline : ''}
                <div class="font-semibold text-base sm:text-lg leading-tight tracking-[-0.2px] min-w-0 line-clamp-3">${titleSafe}</div>
                ${m._personRole ? `<div class="text-xs text-indigo-400 mt-0.5">🎬 ${escapeHtml(m._personRole)}</div>` : ''}
                <div class="flex items-center gap-2 mt-2 flex-wrap">
                  <span class="text-[9px] sm:text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${mediaColor}">${mediaLabel}</span>
                  ${year ? `<span class="text-zinc-400 text-sm">${year}</span>` : ''}
                  ${m.vote_average ? `<span class="rating-badge ${m.vote_average >= 7.5 ? 'high' : ''}"><i class="fa-solid fa-star" style="font-size:8px"></i> ${m.vote_average.toFixed(1)}</span>` : ''}
                  ${m.imdb_id ? `
                    <a href="https://www.imdb.com/title/${m.imdb_id}/" target="_blank" rel="noopener"
                       class="inline-flex items-center gap-1 text-xs sm:text-sm px-1.5 py-px rounded bg-[#f5c518] text-black font-bold no-underline hover:brightness-95">
                      <i class="fa-brands fa-imdb text-sm"></i>
                      <span>IMDb</span>
                    </a>
                  ` : ''}
                  <a href="${rtUrl(title, m._mediaType || currentSearchType)}"
                     target="_blank" rel="noopener"
                     class="inline-flex items-center gap-1 text-xs sm:text-sm px-1.5 py-px rounded bg-[#fa320a] text-white font-bold no-underline hover:brightness-95">
                    <span>RT</span>
                  </a>
                </div>
              </div>
              <div class="mt-3">${html}</div>

            </div>
          </div>`;
        enhanceCard(card, m);

        // Wire up "Where to watch" popup trigger
        const wtwBtn = card.querySelector('.wtw-trigger');
        if (wtwBtn) wtwBtn.addEventListener('click', (e) => { e.stopPropagation(); showWatchPopup(wtwBtn, m.providers); });

        // Rich list actions: +Watch / Watched stay primary and visible; Dislike + Hide
        // move into a single overflow (⋯) menu so the row doesn't compete for attention
        // with 5 buttons of equal visual weight.
        const addBtnContainer = document.createElement('div');
        addBtnContainer.className = 'mt-2 flex gap-1.5 flex-wrap';
        addBtnContainer.style.position = 'relative';
        const b1 = document.createElement('button');
        b1.className = 'flex-shrink-0 text-sm px-3 py-1.5 rounded-2xl bg-emerald-700 text-white';
        b1.textContent = '+ Watch';
        b1.setAttribute('aria-label', `Add ${title} to To Watch`);
        b1.onclick = (e) => { e.stopImmediatePropagation(); addToToWatch(m); b1.textContent = '✓'; setTimeout(()=>b1.textContent='+ Watch',900); };
        const b2 = document.createElement('button');
        b2.className = 'flex-shrink-0 text-sm px-3 py-1.5 rounded-2xl bg-zinc-800 border border-zinc-700';
        b2.textContent = 'Watched';
        b2.setAttribute('aria-label', `Mark ${title} as watched`);
        b2.onclick = (e) => {
          e.stopImmediatePropagation();
          openInlineRatingPrompt(addBtnContainer, m, r => {
            addToWatched(m, r);
            b2.textContent='✓';
          }, { hideButtons: [b1, b2, moreBtn, b4] });
        };

        // Overflow menu: Dislike + Hide
        const moreBtn = document.createElement('button');
        moreBtn.className = 'flex-shrink-0 text-sm px-2.5 py-1.5 rounded-2xl border border-zinc-700 text-zinc-400';
        moreBtn.textContent = '⋯';
        moreBtn.title = 'More actions';
        moreBtn.setAttribute('aria-label', `More actions for ${title}`);
        moreBtn.setAttribute('aria-haspopup', 'true');
        moreBtn.setAttribute('aria-expanded', 'false');

        const moreMenu = document.createElement('div');
        moreMenu.className = 'hidden';
        moreMenu.setAttribute('role', 'menu');
        moreMenu.style.cssText = 'position:absolute;bottom:calc(100% + 6px);left:0;z-index:5;background:var(--card-bg,#18181b);border:1px solid var(--border,#3f3f46);border-radius:14px;padding:4px;min-width:160px;box-shadow:0 12px 24px rgba(0,0,0,0.35);';

        const b3 = document.createElement('button');
        b3.className = 'w-full text-left text-sm px-3 py-2 rounded-xl text-red-400 hover:bg-zinc-800';
        b3.textContent = '👎 Dislike';
        b3.setAttribute('role', 'menuitem');
        b3.setAttribute('aria-label', `Dislike ${title}`);
        b3.onclick = (e) => { e.stopImmediatePropagation(); addToDisliked(m); closeMoreMenu(); moreBtn.textContent = '✓'; };

        const bni = document.createElement('button');
        bni.className = 'w-full text-left text-xs px-3 py-2 rounded-xl text-zinc-400 hover:bg-zinc-800';
        bni.textContent = '✕ Hide';
        bni.title = 'Not Interested — hide from results';
        bni.setAttribute('role', 'menuitem');
        bni.setAttribute('aria-label', `Hide ${title} — not interested`);
        bni.onclick = (e) => { e.stopImmediatePropagation(); addToNotInterested(m); closeMoreMenu(); };

        moreMenu.appendChild(b3); moreMenu.appendChild(bni);

        function closeMoreMenu() {
          moreMenu.classList.add('hidden');
          moreBtn.setAttribute('aria-expanded', 'false');
          document.removeEventListener('click', onDocClick);
        }
        function onDocClick(ev) {
          if (!moreMenu.contains(ev.target) && ev.target !== moreBtn) closeMoreMenu();
        }
        moreBtn.onclick = (e) => {
          e.stopImmediatePropagation();
          const isHidden = moreMenu.classList.contains('hidden');
          if (isHidden) {
            moreMenu.classList.remove('hidden');
            moreBtn.setAttribute('aria-expanded', 'true');
            document.addEventListener('click', onDocClick);
          } else {
            closeMoreMenu();
          }
        };

        const b4 = document.createElement('button');
        b4.className = 'flex-shrink-0 text-xs px-2.5 py-1.5 rounded-2xl border border-zinc-700 text-zinc-500 hidden';
        b4.textContent = '▶ Trailer';
        b4.setAttribute('aria-label', `Play trailer for ${title}`);
        b4.onclick = async (e) => {
          e.stopImmediatePropagation();
          const mediaPath = (m._mediaType || 'movie') === 'tv' ? 'tv' : 'movie';
          const vdata = await apiFetch(`/api/tmdb/3/${mediaPath}/${m.id}/videos`).catch(() => null);
          const trailer = (vdata?.results || []).find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
                          (vdata?.results || []).find(v => v.site === 'YouTube');
          if (trailer) window.open(`https://www.youtube.com/watch?v=${trailer.key}`, '_blank', 'noopener');
        };
        addBtnContainer.appendChild(b1); addBtnContainer.appendChild(b2); addBtnContainer.appendChild(moreBtn); addBtnContainer.appendChild(moreMenu); addBtnContainer.appendChild(b4);
        // Append inside content div so buttons stay beside the poster on mobile
        const contentDiv = card.querySelector('.flex-1.min-w-0');
        (contentDiv || card).appendChild(addBtnContainer);

        // Async: show trailer button if a YouTube video exists
        const mediaPath = (m._mediaType || 'movie') === 'tv' ? 'tv' : 'movie';
        apiFetch(`/api/tmdb/3/${mediaPath}/${m.id}/videos`).then(vdata => {
          const trailer = (vdata?.results || []).find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
                          (vdata?.results || []).find(v => v.site === 'YouTube');
          if (trailer) { b4.classList.remove('hidden', 'text-zinc-500'); b4.classList.add('text-red-400'); }
        }).catch(() => {});

        container.appendChild(card);
      });
    }

