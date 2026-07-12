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
      const count = selectedGenres.size + (minRating > 0 ? 1 : 0) + (selectedDecade ? 1 : 0);
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

    function clearSelectedGenres() {
      selectedGenres.clear();
      minRating = 0;
      selectedDecade = null;
      renderGenreChips();
      renderRatingChips();
      renderDecadeChips();
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
      let url = `/api/tmdb/3/discover/${currentDiscoverType}?language=en-US&sort_by=${sortValue}&include_adult=false&with_original_language=en&with_origin_country=US&without_genres=16&primary_release_date.gte=1960-01-01&watch_region=US&page=${currentDiscoverPage}`;
      if (genreIds.length > 0) {
        url += `&with_genres=${genreIds.join(',')}`;
      }
      if (minRating > 0) {
        url += `&vote_average.gte=${minRating}&vote_count.gte=75`;
      }
      if (selectedDecade) {
        const dateField = currentDiscoverType === 'movie' ? 'primary_release_date' : 'first_air_date';
        url += `&${dateField}.gte=${selectedDecade.gte}&${dateField}.lte=${selectedDecade.lte}`;
      }

      try {
        const data = await apiFetch(url);

        if (!data.results?.length) {
          if (reset) {
            container.innerHTML = `<div class="text-center py-10 text-zinc-400">
              <p>No titles found for those filters.</p>
              <p class="text-xs mt-2 text-zinc-500">Try removing a genre or lowering the minimum rating.</p>
            </div>`;
          }
          document.getElementById('load-more-container').classList.add('hidden');
          return;
        }

        const enriched = await Promise.all(data.results.map(async item => {
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

