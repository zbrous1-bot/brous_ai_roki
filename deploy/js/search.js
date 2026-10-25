    // ===================== SEARCH =====================
    // The Browse tab's title search: direct TMDB title matches, a "similar titles"
    // broadening pass, and the director/writer/actor name fallback. renderResults()
    // is shared with Discover.

    // Browse: only show titles streaming on the user's selected services (mirrors For You).
    let browseServicesOnly = false;
    try { browseServicesOnly = Store.getItem('brous_browse_services_only') === '1'; } catch (_) {}

    function syncBrowseServicesToggleUI() {
      const btn = document.getElementById('browse-services-toggle');
      if (!btn) return;
      const on = !!browseServicesOnly;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.className = `text-xs px-3 py-1.5 rounded-full border transition-all filter-chip ${on ? 'type-toggle-active' : ''}`;
      btn.title = !myServices.size
        ? 'Pick streaming services in Settings first'
        : on
          ? 'Showing only titles on your services — tap to show all'
          : 'Only show titles streaming on services you selected in Settings';
    }

    function toggleBrowseServicesOnly() {
      if (!myServices.size) {
        try { showToast('Pick your streaming services in Settings first'); } catch (_) {}
        if (typeof showSettings === 'function') showSettings('streaming');
        return;
      }
      browseServicesOnly = !browseServicesOnly;
      try { Store.setItem('brous_browse_services_only', browseServicesOnly ? '1' : '0'); } catch (_) {}
      syncBrowseServicesToggleUI();
      if (typeof updateFilterCount === 'function') updateFilterCount();
      if (lastRenderedItems && lastRenderedItems.length) {
        renderResults(lastRenderedItems, lastRenderedOpts || {});
      }
    }

    function itemOnMyServices(m) {
      if (!myServices || !myServices.size) return false;
      const stream = (m.providers && m.providers.flatrate) || [];
      return stream.some(p => {
        const name = p.provider_name || p;
        const label = PROVIDER_NAME_TO_SERVICE[name];
        return label && myServices.has(label);
      });
    }

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
      const searchBoth = currentSearchType === 'all';
      const searchEndpoint = isMovie ? 'movie' : (currentSearchType === 'tv' ? 'tv' : 'movie');
      const otherEndpoint = searchEndpoint === 'movie' ? 'tv' : 'movie';
      const mediaPath = searchEndpoint;

      try {
        // Always search both movie + TV when All is selected (Browse default).
        // Still run a person lookup in parallel for director/actor names.
        const titleSearches = searchBoth
          ? [
              apiFetch(`/api/tmdb/3/search/movie?query=${encodeURIComponent(query)}`),
              apiFetch(`/api/tmdb/3/search/tv?query=${encodeURIComponent(query)}`),
            ]
          : [apiFetch(`/api/tmdb/3/search/${searchEndpoint}?query=${encodeURIComponent(query)}`)];
        const [personResult, ...titleResults] = await Promise.all([
          searchPersonCredits(query),
          ...titleSearches,
        ]);
        const searchData = searchBoth
          ? {
              results: [
                ...((titleResults[0] && titleResults[0].results) || []).map(r => ({ ...r, _mediaType: 'movie' })),
                ...((titleResults[1] && titleResults[1].results) || []).map(r => ({ ...r, _mediaType: 'tv' })),
              ],
              success: (titleResults[0] && titleResults[0].success === false && titleResults[1] && titleResults[1].success === false)
                ? false : undefined,
              status_message: (titleResults[0] && titleResults[0].status_message) || '',
            }
          : titleResults[0];
        if (myGen !== _searchGen) return;

        if (searchData.success === false) {
          container.innerHTML = `<div class="text-center py-6 text-red-400">TMDB error: ${searchData.status_message}</div>`;
          return;
        }

        let top = [];
        let usedOtherType = false;

        function tagMedia(list, type) {
          return (list || [])
            .filter(item => item && (item.title || item.name))
            .map(item => ({ ...item, _mediaType: item._mediaType || type }));
        }

        if (personResult && personResult.items.length) {
          // Capped more generously than a title search's 20 — a prolific person's
          // well-known work is easily spread across ranks 20-40 by popularity (see
          // searchPersonCredits' comment), so 20 alone still missed real titles.
          top = personResult.items.slice(0, 40);
        } else if (searchData.results?.length) {
          const directMatches = tagMedia(searchData.results, searchEndpoint).slice(0, 10);

          // Broaden the search: pull titles similar to the best match so the user
          // sees related films in the same vein, not just exact-name results.
          let similar = [];
          const best = directMatches[0];
          if (best && best.id) {
            try {
              const simType = best._mediaType === 'tv' ? 'tv' : 'movie';
              const sim = await apiFetch(`/api/tmdb/3/${simType}/${best.id}/similar?page=1`);
              similar = tagMedia(
                (sim.results || []).filter(i => i && (i.title || i.name) && i.poster_path),
                simType
              );
            } catch (e) { /* similar is best-effort */ }
          }

          // Merge direct matches (first, most relevant) + similar, dedupe by id
          const seenIds = new Set();
          for (const it of [...directMatches, ...similar]) {
            if (it && it.id && !seenIds.has(it.id)) { seenIds.add(it.id); top.push(it); }
            if (top.length >= 20) break;
          }
        }

        // Cross-type fallback: Browse defaults to Movies, so a TV-only hit like
        // "Widow's Bay" used to return nothing. If the active type is empty, try the other.
        if (!top.length) {
          try {
            const otherData = await apiFetch(`/api/tmdb/3/search/${otherEndpoint}?query=${encodeURIComponent(query)}`);
            if (myGen !== _searchGen) return;
            if (otherData && otherData.results && otherData.results.length) {
              usedOtherType = true;
              const directMatches = tagMedia(otherData.results, otherEndpoint).slice(0, 12);
              const seenIds = new Set();
              for (const it of directMatches) {
                if (it && it.id && !seenIds.has(it.id)) { seenIds.add(it.id); top.push(it); }
              }
            }
          } catch (_) { /* other-type search is best-effort */ }
        }

        if (!top.length) {
          container.innerHTML = `
            <div class="text-center py-10 text-zinc-400">
              <div class="text-3xl mb-3 opacity-50" aria-hidden="true">⌕</div>
              <p>No results found for that search.</p>
              <p class="text-xs mt-1">Try a different title, switch Movies/TV, or a director/writer/actor's full name.</p>
            </div>`;
          return;
        }
        if (usedOtherType) {
          try {
            showToast(`Found under ${otherEndpoint === 'tv' ? 'TV' : 'Movies'} (toggle was ${isMovie ? 'Movies' : 'TV'})`, 'info');
          } catch (_) {}
        }
        const enriched = await Promise.all(top.map(async item => {
          // Person-credit results can mix movie and TV items regardless of the
          // active toggle (see searchPersonCredits) — use each item's own type if
          // it has one, instead of forcing every item to match the toggle, which
          // would fetch the wrong provider/external-id endpoint for half of them.
          const itemMediaType = item._mediaType || currentSearchType;
          const itemMediaPath = itemMediaType === 'tv' ? 'tv' : 'movie';
          try {
            // Combined into one details call (append_to_response) instead of two
            // separate watch/providers + external_ids requests — also gets us
            // origin_country for free (movie list results don't carry it, only
            // movie *details* do; TV list results already have it but details
            // repeats it harmlessly) for the American-titles content filter below.
            const details = await apiFetch(`/api/tmdb/3/${itemMediaPath}/${item.id}?append_to_response=watch/providers,external_ids`);
            const providers = details['watch/providers']?.results?.US || null;
            const imdbId = details.imdb_id || details.external_ids?.imdb_id || null;
            return {
              ...item,
              providers,
              imdb_id: imdbId,
              origin_country: details.origin_country || item.origin_country || [],
              _mediaType: itemMediaType
            };
          } catch {
            return { ...item, providers: null, imdb_id: null, origin_country: item.origin_country || null, _mediaType: itemMediaType };
          }
        }));
        if (myGen !== _searchGen) return;

        // Same as Browse: imdb_id already came back with the per-item details above, so
        // this is one batched /api/ratings call rather than a lookup per title.
        await attachImdbRatings(enriched);
        // Re-check the generation guard — attachImdbRatings awaits, so a newer search may
        // have been issued while it was in flight, and rendering here would clobber it.
        if (myGen !== _searchGen) return;

        renderResults(enriched, { keepLibraryItems: true });
        const activeFilters = document.getElementById('active-filters');
        if (activeFilters) activeFilters.classList.add('hidden');
      } catch (e) {
        if (myGen !== _searchGen) return;
        console.error('[Horror Roki] Search failed:', e);
        let displayMsg;
        if (e.status === 401 || e.message.includes('Unauthorized') || e.message.includes('password')) {
          displayMsg = 'Password required or incorrect. Set it in Settings → Advanced.';
        } else if (e.details && e.details.error) {
          displayMsg = e.details.error;
          if (e.details.availableSecrets) {
            displayMsg += ' | Available matching secrets: ' + JSON.stringify(e.details.availableSecrets);
          }
        } else if (e.message) {
          displayMsg = e.message;
        } else {
          displayMsg = 'Error fetching data. Check the password in Settings → Advanced, or your connection.';
        }
        container.innerHTML = `<div class="text-center py-6 text-red-400">${displayMsg}</div>`;
      }
    }

    function quickSearch(q, el) {
      const input = document.getElementById('search-input');
      if (input) input.value = q;
      document.querySelectorAll('.search-chip').forEach(c => c.classList.remove('active'));
      if (el) el.classList.add('active');
      const clearBtn = document.getElementById('search-clear-btn');
      if (clearBtn) clearBtn.classList.toggle('hidden', !(input && input.value.trim()));
      performSearch();
    }

function setCuratorPrompt(q) {
      const input = document.getElementById('curator-input');
      if (!input) return;
      input.value = q;
      sendToCurator();
    }

    // Rec / Browse poster cards: swipe right = Queue, left = Hide.
    // Delegates to shared attachCardSwipe so library + recs feel the same.
    function addSwipeGesture(card, item) {
      if (typeof attachCardSwipe === 'function') {
        attachCardSwipe(card, {
          rightLabel: '+ Queue',
          leftLabel: 'Pass',
          onRight: () => { addToToWatch(item); },
          onLeft: () => { addToNotInterested(item); },
          removeOnCommit: true,
        });
        return;
      }
      // Fallback if helpers not loaded yet (shouldn't happen in normal boot order)
      let startX = 0, startY = 0, tracking = false;
      const overlay = card.querySelector('.swipe-overlay');
      card.addEventListener('touchstart', e => {
        startX = e.touches[0].clientX; startY = e.touches[0].clientY; tracking = false;
        card.style.transition = 'none';
      }, { passive: true });
      card.addEventListener('touchmove', e => {
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        if (!tracking && Math.abs(dy) > Math.abs(dx) + 8) return;
        tracking = true;
        card.style.transform = `translateX(${dx * 0.92}px) rotate(${dx * 0.02}deg)`;
        if (overlay) {
          overlay.style.opacity = Math.min(Math.abs(dx) / 72, 0.9);
          overlay.style.background = dx > 0 ? 'rgba(16,185,129,0.55)' : 'rgba(239,68,68,0.55)';
          overlay.textContent = dx > 0 ? '+ Queue' : 'Pass';
        }
      }, { passive: true });
      card.addEventListener('touchend', e => {
        if (!tracking) return;
        const dx = e.changedTouches[0].clientX - startX;
        card.style.transition = 'transform 0.18s cubic-bezier(0.2,0.8,0.2,1), opacity 0.16s ease';
        if (dx > 72) {
          card.style.transform = 'translateX(110%) rotate(8deg)'; card.style.opacity = '0';
          setTimeout(() => { addToToWatch(item); card.remove(); }, 160);
        } else if (dx < -72) {
          card.style.transform = 'translateX(-110%) rotate(-8deg)'; card.style.opacity = '0';
          setTimeout(() => { addToNotInterested(item); card.remove(); }, 160);
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
        `).join('') + `<div style="margin-top:6px;padding-top:5px;border-top:1px solid #3f3f46;font-size:9px;color:#52525b;">Availability data by <a href="https://www.justwatch.com" target="_blank" rel="noopener" style="color:#71717a;">JustWatch</a></div>`;
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
      const meta = document.getElementById('browse-results-meta');
      const countEl = document.getElementById('browse-results-count');
      if (initial) initial.style.display = 'none';
      if (!container) return;
      container.innerHTML = '';
      container.className = 'browse-results';

      lastRenderedItems = items;
      lastRenderedOpts = opts;

      const excluded = getExcludedKeys();
      items = items.filter(function(m) {
        const key = m.id + ':' + (m._mediaType || 'movie');
        const year = parseInt((m.release_date || m.first_air_date || '').slice(0, 4));
        const isAmerican = m.origin_country == null || m.origin_country.includes('US');
        const passesContentFilters = m.original_language === 'en' && isAmerican && !m.adult
          && !(m.genre_ids || []).includes(16) && (!year || year >= 1960);
        if (!passesContentFilters) return false;
        return opts.keepLibraryItems || !excluded.has(key);
      });

      if (browseServicesOnly && myServices && myServices.size) {
        items = items.filter(itemOnMyServices);
      }

      if (meta && countEl) {
        if (items.length) {
          meta.classList.remove('hidden');
          countEl.textContent = items.length + ' title' + (items.length === 1 ? '' : 's');
        } else {
          meta.classList.add('hidden');
          countEl.textContent = '';
        }
      }

      if (!items.length) {
        const svcEmpty = browseServicesOnly && myServices && myServices.size;
        container.innerHTML = '<div class="browse-empty">'
          + '<div class="browse-empty-title">' + (svcEmpty ? 'Nothing on your services here' : 'No matching titles') + '</div>'
          + '<div class="browse-empty-sub">' + (svcEmpty
            ? 'Turn off “On my services” or try different filters.'
            : 'Those titles may already be in your library, or filters are too tight.') + '</div>'
          + (svcEmpty ? '<button type="button" onclick="toggleBrowseServicesOnly()" class="browse-empty-btn">Show all results</button>' : '')
          + '</div>';
        return;
      }

      items.forEach(function(m, idx) {
        const title = m.title || m.name || 'Untitled';
        const titleSafe = escapeHtml(title);
        const year = (m.release_date || m.first_air_date || '').slice(0, 4);
        const poster = m.poster_path ? ('https://image.tmdb.org/t/p/w342' + m.poster_path) : null;
        const mediaLabel = (m._mediaType || 'movie') === 'tv' ? 'TV' : 'Movie';
        const libraryBadge = getLibraryStatusBadge(m.id, m._mediaType);
        const badgeHtml = libraryBadge
          ? ('<span class="browse-card-badge ' + libraryBadge.cls + '">' + libraryBadge.label + '</span>')
          : '';
        const overviewRaw = (m.overview || '').trim();
        let overview = '';
        if (overviewRaw) {
          overview = escapeHtml(overviewRaw.length > 160
            ? overviewRaw.slice(0, 150).replace(/\s+\S*$/, '') + '…'
            : overviewRaw);
        }
        const tmdb = m.vote_average ? Number(m.vote_average).toFixed(1) : null;
        const ratingClass = m.vote_average >= 7.5 ? 'high' : (m.vote_average >= 6 ? '' : 'low');
        const mt = (m._mediaType || 'movie') === 'tv' ? 'tv' : 'movie';
        const wtwHtml = (typeof wtwBlockHtml === 'function')
          ? wtwBlockHtml(m.id, mt, { compact: false })
          : '<div class="browse-card-stream"></div>';
        const posterBlock = poster
          ? ('<img src="' + poster + '" class="browse-card-poster" alt="' + titleSafe + ' poster" loading="lazy"'
            + ' onload="this.parentNode.classList.remove(\'loading\')"'
            + ' onerror="this.onerror=null;this.src=\'' + FALLBACK_POSTER + '\';this.parentNode.classList.remove(\'loading\')">')
          : '<div class="browse-card-poster browse-card-poster-fallback">🎬</div>';

        const card = document.createElement('div');
        card.className = 'movie-card movie-card-v2 browse-card';
        if (typeof applyCardStagger === 'function') applyCardStagger(card, idx);
        card.innerHTML = ''
          + '<div class="browse-card-inner">'
          +   '<div class="browse-card-poster-wrap poster-wrap loading">'
          +     posterBlock + badgeHtml
          +   '</div>'
          +   '<div class="browse-card-body">'
          +     '<div class="browse-card-title">' + titleSafe + '</div>'
          +     (m._personRole ? ('<div class="browse-card-role">' + escapeHtml(m._personRole) + '</div>') : '')
          +     '<div class="browse-card-meta">'
          +       '<span class="browse-card-type">' + mediaLabel + '</span>'
          +       (year ? ('<span>' + year + '</span>') : '')
          +       (tmdb ? ('<span class="rating-badge ' + ratingClass + '">★ ' + tmdb + '</span>') : '')
          +     '</div>'
          +     (overview ? ('<p class="browse-card-overview">' + overview + '</p>') : '')
          +     wtwHtml
          +     '<div class="browse-card-actions"></div>'
          +   '</div>'
          + '</div>';
        enhanceCard(card, m);

        // Paint WTW from providers already on the item when present
        if (m.providers && typeof paintWtwBody === 'function') {
          const body = document.getElementById(typeof wtwSlotId === 'function' ? wtwSlotId(m.id, mt) : ('wtw-rec-' + m.id + '-' + mt));
          if (body) paintWtwBody(body, normalizeProvidersData(m.providers), { compact: false });
        }

        const addBtnContainer = card.querySelector('.browse-card-actions');
        addBtnContainer.style.position = 'relative';

        const b1 = document.createElement('button');
        b1.type = 'button';
        b1.className = 'browse-act browse-act-primary';
        b1.textContent = '+ Queue';
        b1.setAttribute('aria-label', 'Add ' + title + ' to To Watch');
        b1.onclick = function(e) {
          e.stopImmediatePropagation();
          addToToWatch(m);
          b1.textContent = 'Queued';
          b1.classList.add('browse-act-done');
        };

        const b2 = document.createElement('button');
        b2.type = 'button';
        b2.className = 'browse-act browse-act-secondary';
        b2.textContent = 'Watched';
        b2.setAttribute('aria-label', 'Mark ' + title + ' as watched');
        b2.onclick = function(e) {
          e.stopImmediatePropagation();
          openInlineRatingPrompt(card, m, function(r) {
            addToWatched(m, r);
            b2.textContent = 'Rated';
            b2.classList.add('browse-act-done');
            if (typeof flashCardWatched === 'function') flashCardWatched(card);
          }, { sheet: true });
        };

        const moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'browse-act browse-act-ghost';
        moreBtn.textContent = '⋯';
        moreBtn.title = 'More actions';
        moreBtn.setAttribute('aria-label', 'More actions for ' + title);
        moreBtn.setAttribute('aria-haspopup', 'true');
        moreBtn.setAttribute('aria-expanded', 'false');

        const moreMenu = document.createElement('div');
        moreMenu.className = 'browse-more-menu hidden';
        moreMenu.setAttribute('role', 'menu');

        const b3 = document.createElement('button');
        b3.type = 'button';
        b3.className = 'browse-more-item browse-more-danger';
        b3.textContent = 'Dislike';
        b3.setAttribute('role', 'menuitem');
        b3.onclick = function(e) { e.stopImmediatePropagation(); addToDisliked(m); closeMoreMenu(); };

        const bni = document.createElement('button');
        bni.type = 'button';
        bni.className = 'browse-more-item';
        bni.textContent = 'Hide';
        bni.setAttribute('role', 'menuitem');
        bni.onclick = function(e) { e.stopImmediatePropagation(); addToNotInterested(m); closeMoreMenu(); };

        moreMenu.appendChild(b3);
        moreMenu.appendChild(bni);

        function closeMoreMenu() {
          moreMenu.classList.add('hidden');
          moreBtn.setAttribute('aria-expanded', 'false');
          document.removeEventListener('click', onDocClick);
        }
        function onDocClick(ev) {
          if (!moreMenu.contains(ev.target) && ev.target !== moreBtn) closeMoreMenu();
        }
        moreBtn.onclick = function(e) {
          e.stopImmediatePropagation();
          const isHidden = moreMenu.classList.contains('hidden');
          if (isHidden) {
            moreMenu.classList.remove('hidden');
            moreBtn.setAttribute('aria-expanded', 'true');
            document.addEventListener('click', onDocClick);
          } else closeMoreMenu();
        };

        addBtnContainer.appendChild(b1);
        addBtnContainer.appendChild(b2);
        addBtnContainer.appendChild(moreBtn);
        addBtnContainer.appendChild(moreMenu);
        container.appendChild(card);
      });

      // Fill any WTW slots still pending (missing providers on the item)
      if (typeof fillWtwForItems === 'function') {
        fillWtwForItems(items, { compact: false });
      }
    }

    function formatBrowseStreamLine(m) {
      const stream = (m.providers && m.providers.flatrate) || [];
      const hasAny = m.providers && (
        stream.length || (m.providers.rent || []).length || (m.providers.buy || []).length
      );
      if (!stream.length) {
        if (hasAny) {
          return '<button type="button" class="wtw-trigger browse-wtw-btn">Where to watch</button>'
            + '<span class="browse-jw" title="Streaming availability data by JustWatch">JustWatch</span>';
        }
        return '';
      }
      const mine = [];
      const other = [];
      const seen = new Set();
      stream.forEach(function(p) {
        const raw = p.provider_name || p;
        const label = PROVIDER_NAME_TO_SERVICE[raw] || raw;
        const key = String(label).toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        if (myServices && myServices.size && myServices.has(label)) mine.push(label);
        else other.push(label);
      });
      const pills = [];
      mine.slice(0, 3).forEach(function(label) {
        pills.push('<span class="browse-svc browse-svc-mine">' + escapeHtml(label) + '</span>');
      });
      other.slice(0, mine.length ? 2 : 3).forEach(function(label) {
        pills.push('<span class="browse-svc browse-svc-other">' + escapeHtml(label) + '</span>');
      });
      if (!pills.length) return '';
      return '<div class="browse-svc-row">' + pills.join('')
        + '<span class="browse-jw" title="Streaming availability data by JustWatch">JustWatch</span></div>';
    }

    function clearBrowseSearch() {
      const input = document.getElementById('search-input');
      if (input) input.value = '';
      const clearBtn = document.getElementById('search-clear-btn');
      if (clearBtn) clearBtn.classList.add('hidden');
      document.querySelectorAll('.search-chip.active').forEach(function(c) { c.classList.remove('active'); });
      clearTimeout(_liveSearchTimer);
      const container = document.getElementById('results');
      if (container) { container.innerHTML = ''; container.className = 'browse-results'; }
      const initial = document.getElementById('initial-state');
      if (initial) initial.style.display = '';
      const meta = document.getElementById('browse-results-meta');
      if (meta) meta.classList.add('hidden');
    }
