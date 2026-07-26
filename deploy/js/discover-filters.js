    // ===================== DISCOVER + FILTERS =====================
    // The "Browse" tab's genre/rating/decade filter chips and the Discover feed
    // itself (TMDB /discover/movie or /tv, driven by whichever chips are active).

    const RATING_OPTIONS = [0, 6, 7, 7.5, 8];
    const DECADES = [
      {label: '2020s', gte: '2020-01-01', lte: '2029-12-31'},
      {label: '2010s', gte: '2010-01-01', lte: '2019-12-31'},
      {label: '2000s', gte: '2000-01-01', lte: '2009-12-31'},
      {label: '1990s', gte: '1990-01-01', lte: '1999-12-31'},
      {label: '1980s', gte: '1980-01-01', lte: '1989-12-31'},
      {label: '1970s', gte: '1970-01-01', lte: '1979-12-31'},
    ];

    function toggleMobileFilters() {
      const section = document.getElementById('section-discover');
      if (section) section.classList.toggle('filters-collapsed');
    }

    function updateFilterCount() {
      const badge = document.getElementById('filter-active-count');
      if (!badge) return;
      const count = selectedGenres.size + (minRating > 0 ? 1 : 0) + (selectedDecade ? 1 : 0)
        + (foundFootageOnly ? 1 : 0) + (cosmicHorrorOnly ? 1 : 0);
      if (count > 0) {
        badge.textContent = count;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }

    function renderGenreChips() {
      const container = document.getElementById('genre-chips');
      if (!container) return;
      container.innerHTML = '';
      GENRES.forEach(g => {
        const isSelected = selectedGenres.has(g.id);
        const btn = document.createElement('button');
        btn.textContent = g.name;
        btn.className = `px-3 py-1 text-xs rounded-2xl border transition-all active:scale-[0.985] ${isSelected 
          ? 'filter-chip-active' 
          : 'filter-chip'}`;
        btn.onclick = () => {
          if (selectedGenres.has(g.id)) selectedGenres.delete(g.id);
          else selectedGenres.add(g.id);
          renderGenreChips();
        };
        container.appendChild(btn);
      });
      updateFilterCount();
    }

    // Style toggles for the Browse filter panel. Unlike the For You versions
    // (toggleKeywordPool in recs.js, which swaps the whole rec pool in and out), these are
    // just another filter dimension: each adds `with_keywords` to the Discover query, so
    // they compose with the genre / rating / decade / sort chips as-is.
    //
    // They're mutually exclusive with each other, though. TMDB can express the combination
    // (comma = AND between pipe-delimited OR groups), but the actual intersection is 10
    // titles and 9 of them have zero votes — turning on the second chip would always read
    // as a broken filter rather than a narrower one, so picking one clears the other.
    // Each entry also carries the query tweaks its pool needs, so performDiscover below can
    // read them off the active filter instead of growing a ternary per knob per filter.
    const STYLE_FILTERS = [
      {
        key: 'ff',
        label: '🎥 Found Footage',
        get: () => foundFootageOnly,
        set: v => { foundFootageOnly = v; },
        keywords: () => FF_KEYWORD_IDS,
        // The broad "faux/fake documentary" keywords drag in real docs, so Documentary
        // joins Animation in without_genres here.
        withoutGenres: '16,99',
        // Found footage is dominated by low-budget indies with naturally few ratings — the
        // usual 75-vote floor cuts the pool to almost nothing (this floor, not the keyword
        // list, was the real limiter when the For You pool was first built).
        voteFloor: 10,
        usOnly: true,
        gate: isPlausibleFoundFootage,
        emptyHint: 'Found Footage is a narrow pool — try clearing the genre chips, lowering the minimum rating, or switching to Movies.',
      },
      {
        key: 'cosmic',
        label: '🐙 Cosmic Horror',
        get: () => cosmicHorrorOnly,
        set: v => { cosmicHorrorOnly = v; },
        keywords: () => COSMIC_KEYWORD_IDS,
        withoutGenres: '16,99',
        voteFloor: 10,
        // The only filter that drops `with_origin_country=US`. The whole cosmic-horror pool
        // is ~70 titles, and that one parameter removes five of the most canonical entries
        // in it — Hellraiser (1987), Dark City, The Void, Dagon and Dark Waters are all
        // English-language but non-US productions. `with_original_language=en` still applies,
        // so this widens the pool to UK/Canadian/Irish cosmic horror without opening it up
        // to subtitled titles the rest of the app doesn't surface.
        usOnly: false,
        gate: isPlausibleCosmicHorror,
        emptyHint: 'Cosmic Horror is a narrow pool (~70 titles) — try clearing the genre chips, lowering the minimum rating, or switching to Movies.',
      },
    ];

    function activeStyleFilter() {
      return STYLE_FILTERS.find(f => f.get()) || null;
    }

    function renderStyleChips() {
      const container = document.getElementById('style-chips');
      if (!container) return;
      container.innerHTML = '';

      STYLE_FILTERS.forEach(f => {
        const on = f.get();
        const btn = document.createElement('button');
        btn.textContent = f.label;
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.className = `px-3 py-1 text-xs rounded-2xl border transition-all active:scale-[0.985] ${on
          ? 'filter-chip-active'
          : 'filter-chip'}`;
        btn.onclick = () => {
          const next = !on;
          STYLE_FILTERS.forEach(o => o.set(false)); // one at a time — see comment above
          f.set(next);
          renderStyleChips();
        };
        container.appendChild(btn);
      });
      updateFilterCount();
    }

    function clearSelectedGenres() {
      selectedGenres.clear();
      minRating = 0;
      selectedDecade = null;
      foundFootageOnly = false;
      cosmicHorrorOnly = false;
      renderGenreChips();
      renderRatingChips();
      renderDecadeChips();
      renderStyleChips();
      const activeFilters = document.getElementById('active-filters');
      if (activeFilters) activeFilters.classList.add('hidden');
      // Also clear the search box text and cancel any pending search-as-you-type,
      // so "Clear all" fully resets the page instead of leaving a stale query typed in.
      clearTimeout(_liveSearchTimer);
      const searchInput = document.getElementById('search-input');
      if (searchInput) searchInput.value = '';
      // Clear results and restore the empty state
      const results = document.getElementById('results');
      if (results) results.innerHTML = '';
      const initial = document.getElementById('initial-state');
      if (initial) initial.style.display = '';
    }

    function renderRatingChips() {
      const container = document.getElementById('rating-chips');
      if (!container) return;
      container.innerHTML = '';

      RATING_OPTIONS.forEach(val => {
        const isSelected = minRating === val;
        const label = val === 0 ? 'Any' : `${val}+`;
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.className = `px-3 py-1 text-xs rounded-2xl border transition-all active:scale-[0.985] ${isSelected 
          ? 'filter-chip-active' 
          : 'filter-chip'}`;
        btn.onclick = () => {
          minRating = val;
          renderRatingChips();
        };
        container.appendChild(btn);
      });
      updateFilterCount();
    }

    function renderDecadeChips() {
      const container = document.getElementById('decade-chips');
      if (!container) return;
      container.innerHTML = '';

      // Any chip
      const anyBtn = document.createElement('button');
      anyBtn.textContent = 'Any';
      anyBtn.className = `px-3 py-1 text-xs rounded-2xl border transition-all active:scale-[0.985] ${!selectedDecade 
        ? 'filter-chip-active' 
        : 'filter-chip'}`;
      anyBtn.onclick = () => {
        selectedDecade = null;
        renderDecadeChips();
      };
      container.appendChild(anyBtn);

      DECADES.forEach(d => {
        const isSelected = selectedDecade && selectedDecade.label === d.label;
        const btn = document.createElement('button');
        btn.textContent = d.label;
        btn.className = `px-3 py-1 text-xs rounded-2xl border transition-all active:scale-[0.985] ${isSelected 
          ? 'filter-chip-active' 
          : 'filter-chip'}`;
        btn.onclick = () => {
          selectedDecade = d;
          renderDecadeChips();
        };
        container.appendChild(btn);
      });
      updateFilterCount();
    }

    function setDiscoverType(type) {
      currentDiscoverType = type;
      const movieBtn = document.getElementById('type-movie');
      const tvBtn = document.getElementById('type-tv');
      if (movieBtn && tvBtn) {
        if (type === 'movie') {
          movieBtn.classList.add('type-toggle-active');
          movieBtn.classList.remove('text-zinc-300');
          tvBtn.classList.remove('type-toggle-active');
          tvBtn.classList.add('text-zinc-300');
        } else {
          tvBtn.classList.add('type-toggle-active');
          tvBtn.classList.remove('text-zinc-300');
          movieBtn.classList.remove('type-toggle-active');
          movieBtn.classList.add('text-zinc-300');
        }
      }
    }

    function setSearchType(type) {
      currentSearchType = type;
      const movieBtn = document.getElementById('search-type-movie');
      const tvBtn = document.getElementById('search-type-tv');
      if (movieBtn && tvBtn) {
        if (type === 'movie') {
          movieBtn.classList.add('bg-white', 'text-black');
          movieBtn.classList.remove('text-zinc-300');
          tvBtn.classList.remove('bg-white', 'text-black');
          tvBtn.classList.add('text-zinc-300');
        } else {
          tvBtn.classList.add('bg-white', 'text-black');
          tvBtn.classList.remove('text-zinc-300');
          movieBtn.classList.remove('bg-white', 'text-black');
          movieBtn.classList.add('text-zinc-300');
        }
      }
    }

    async function performDiscover(reset = true) {
      const container = document.getElementById('results');
      const initial = document.getElementById('initial-state');
      if (initial) initial.style.display = 'none';

      if (reset) {
        currentDiscoverPage = 1;
        currentDiscoverResults = [];
        showSkeletons('results', 6);
      }

      const genreIds = Array.from(selectedGenres);

      const sortValue = document.getElementById('discover-sort')?.value || 'popularity.desc';
      const style = activeStyleFilter();
      // Animation is always excluded; the style filters widen that (see withoutGenres in
      // STYLE_FILTERS) because their keyword sets pull in documentaries.
      const withoutGenres = style ? style.withoutGenres : '16';
      const originCountry = (!style || style.usOnly) ? '&with_origin_country=US' : '';
      let url = `/api/tmdb/3/discover/${currentDiscoverType}?language=en-US&sort_by=${sortValue}&include_adult=false&with_original_language=en${originCountry}&without_genres=${withoutGenres}&primary_release_date.gte=1960-01-01&watch_region=US&page=${currentDiscoverPage}`;
      if (style) {
        url += `&with_keywords=${style.keywords()}`;
      }
      if (genreIds.length > 0) {
        url += `&with_genres=${genreIds.join(',')}`;
      }
      if (minRating > 0) {
        // Style pools are small and indie-heavy, so they lower the usual 75-vote floor
        // (see voteFloor in STYLE_FILTERS for why).
        url += `&vote_average.gte=${minRating}&vote_count.gte=${style ? style.voteFloor : 75}`;
      }
      if (selectedDecade) {
        const dateField = currentDiscoverType === 'movie' ? 'primary_release_date' : 'first_air_date';
        url += `&${dateField}.gte=${selectedDecade.gte}&${dateField}.lte=${selectedDecade.lte}`;
      }

      try {
        const data = await apiFetch(url);

        const noResultsHint = style ? style.emptyHint : 'Try removing a genre or lowering the minimum rating.';

        if (!data.results?.length) {
          if (reset) {
            container.innerHTML = `<div class="text-center py-10 text-zinc-400">
              <p>No titles found for those filters.</p>
              <p class="text-xs mt-2 text-zinc-500">${noResultsHint}</p>
            </div>`;
          }
          document.getElementById('load-more-container').classList.add('hidden');
          return;
        }

        // Keyword false-positive gate, applied before the per-item details fetch below so
        // we don't spend a request enriching titles we're about to discard. `without_genres`
        // already dropped documentaries server-side; this also catches the titles that carry
        // a plausible genre but aren't really the style (see the *_DENYLIST sets and the
        // genre gates in ui-helpers.js).
        const pageResults = style
          ? data.results.filter(item => style.gate(item.id, currentDiscoverType, item.genre_ids))
          : data.results;

        const enriched = await Promise.all(pageResults.map(async item => {
          const mediaPath = currentDiscoverType === 'movie' ? 'movie' : 'tv';
          try {
            // Combined into one details call (append_to_response) instead of two
            // separate watch/providers + external_ids requests — also gets us
            // origin_country for free (movie list results don't carry it, only
            // movie *details* do; TV list results already have it but details
            // repeats it harmlessly) for the American-titles content filter below.
            const details = await apiFetch(`/api/tmdb/3/${mediaPath}/${item.id}?append_to_response=watch/providers,external_ids`);
            const providers = details['watch/providers']?.results?.US || null;
            const imdbId = details.imdb_id || details.external_ids?.imdb_id || null;
            return {
              ...item,
              providers,
              imdb_id: imdbId,
              origin_country: details.origin_country || item.origin_country || [],
              _mediaType: currentDiscoverType
            };
          } catch {
            return { ...item, providers: null, imdb_id: null, origin_country: item.origin_country || null, _mediaType: currentDiscoverType };
          }
        }));

        currentDiscoverResults = currentDiscoverResults.concat(enriched);

        renderActiveFilters();
        renderResults(currentDiscoverResults);

        // Keep fetching more pages silently until we have enough visible results
        const excluded = getExcludedKeys();
        const visibleCount = currentDiscoverResults.filter(m => !excluded.has(`${m.id}:${m._mediaType || 'movie'}`)).length;
        const maxPage = Math.min(data.total_pages || 20, 20);
        const hasMorePages = data.results.length >= 20 && currentDiscoverPage < maxPage;

        if (visibleCount < 10 && hasMorePages) {
          currentDiscoverPage++;
          performDiscover(false);
          return;
        }

        // TMDB returned rows but the style gate above discarded every one of them, and there
        // are no further pages to try — without this the grid would just sit blank with no
        // explanation. (The early `!data.results?.length` return can't catch this case: the
        // API response itself was non-empty.)
        if (currentDiscoverResults.length === 0 && !hasMorePages) {
          container.innerHTML = `<div class="text-center py-10 text-zinc-400">
            <p>No titles found for those filters.</p>
            <p class="text-xs mt-2 text-zinc-500">${noResultsHint}</p>
          </div>`;
          document.getElementById('load-more-container').classList.add('hidden');
          return;
        }

        // Show/hide load more button
        const loadMoreContainer = document.getElementById('load-more-container');
        if (hasMorePages) {
          loadMoreContainer.classList.remove('hidden');
        } else {
          loadMoreContainer.classList.add('hidden');
        }

      } catch (e) {
        if (reset) {
          console.error('[Horror Roki] Discover failed:', e, 'URL attempted:', url);
          let hint = 'Check password (🔐 Pass button) or connection.';
          if (apiBase) hint += ` (Using custom base: ${apiBase})`;
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
            displayMsg = `Error loading results. ${hint} (If using local server: open ⚙︎ Settings and set "API Endpoint Base" to your Worker URL like https://your-worker.workers.dev , then set password. See browser Console for details.)`;
          }
          container.innerHTML = `<div class="text-center py-6 text-red-400">${displayMsg}</div>`;
        }
        document.getElementById('load-more-container').classList.add('hidden');
      }
    }

    function loadMoreDiscover() {
      currentDiscoverPage++;
      performDiscover(false);
    }

    function renderActiveFilters() {
      const container = document.getElementById('active-filters');
      if (!container) return;

      const filters = [];

      if (selectedGenres.size > 0) {
        const genreNames = Array.from(selectedGenres).map(id => {
          const g = GENRES.find(x => x.id === id);
          return g ? g.name : '';
        }).filter(Boolean);
        filters.push(`Genres: ${genreNames.join(', ')}`);
      }
      const activeStyle = activeStyleFilter();
      if (activeStyle) filters.push(`Style: ${activeStyle.label}`);
      if (minRating > 0) filters.push(`Rating: ${minRating}+`);
      if (selectedDecade) filters.push(`Decade: ${selectedDecade.label}`);

      if (filters.length === 0) {
        container.classList.add('hidden');
        container.innerHTML = '';
        return;
      }

      container.classList.remove('hidden');
      container.innerHTML = filters.map(f => 
        `<span class="text-[11px] px-2.5 py-1 bg-zinc-800 border border-zinc-700 rounded-2xl text-zinc-300">${f}</span>`
      ).join('');
    }

