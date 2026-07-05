    // ===================== WATCHLIST =====================

    function saveWatchlist() {
      Store.setItem('brous_watchlist', JSON.stringify(watchlist));
      // keep top counts in sync if legacy path used
      try { updateLibraryCounts(); } catch(e){}
    }

    function addToWatchlist(item) {
      const exists = watchlist.some(w => w.id === item.id && w._mediaType === item._mediaType);
      if (!exists) {
        const rec = {
          id: item.id,
          title: item.title || item.name,
          _mediaType: item._mediaType || 'movie',
          poster_path: item.poster_path,
          release_date: item.release_date || item.first_air_date,
          vote_average: item.vote_average,
          genre_ids: item.genre_ids || []
        };
        watchlist.push(rec);
        const key = `${item.id}:${item._mediaType || 'movie'}`;
        watchedIds.add(key);
        saveWatchlist();
        renderWatchlist();

        // Also feed the full To Watch list
        addToToWatch(item);

        // Explicit removal from current discover/search results to prevent duplicates
        removeFromCurrentResults(item.id, item._mediaType || 'movie');
      }
    }

    // Dedicated removal function for items that should disappear from discover/search
    // after being selected as watched. This prevents duplication in the current results view.
    // Call this (or wire it into your "mark as watched" / add to library flow) whenever a title
    // is added to the watched library. It cleans both the in-memory cache and the DOM view.
    function removeFromCurrentResults(id, mediaType = 'movie') {
      const key = `${id}:${mediaType}`;
      currentDiscoverResults = currentDiscoverResults.filter(m => {
        const mKey = `${m.id}:${m._mediaType || 'movie'}`;
        return mKey !== key;
      });
      lastRenderedItems = lastRenderedItems.filter(m => {
        const mKey = `${m.id}:${m._mediaType || 'movie'}`;
        return mKey !== key;
      });
      currentRecPool = currentRecPool.filter(m => {
        const mKey = `${m.id}:${m._mediaType || 'movie'}`;
        return mKey !== key;
      });

      // Re-render whatever is actually on screen now (search OR discover).
      // lastRenderedItems always reflects the current view, so use it — preferring
      // currentDiscoverResults here was switching a search view back to stale discover.
      // Reuse lastRenderedOpts too, so a search's keepLibraryItems mode survives this
      // refresh instead of reverting to Discover's default (hide anything in the
      // library), which made other, unrelated search results vanish after one click.
      if (lastRenderedItems.length > 0) {
        renderResults(lastRenderedItems, lastRenderedOpts);
      }
      // keep recs grid fresh
      if (document.getElementById('recs-grid')) {
        recomputeRecommendations();
      }
    }

    function removeFromWatchlist(id, mediaType) {
      watchlist = watchlist.filter(w => !(w.id === id && w._mediaType === mediaType));
      const keyToDelete = `${id}:${mediaType || 'movie'}`;
      watchedIds.delete(keyToDelete);
      // also clean full lists
      toWatchList = toWatchList.filter(w => !(w.id === id && (w._mediaType||'movie') === (mediaType||'movie')));
      saveToWatch();
      saveWatchlist();
      renderWatchlist();
    }

    function renderWatchlist() {
      const container = document.getElementById('my-list-content');
      if (!container) return;

      if (watchlist.length === 0) {
        container.innerHTML = `<div class="text-sm text-zinc-400">Your list is empty. Add titles from search or Discover results.</div>`;
        return;
      }

      let html = '';
      watchlist.forEach(item => {
        const year = (item.release_date || '').slice(0, 4);
        const itemTitleSafe = escapeHtml(item.title || 'Untitled');
        html += `
          <div class="flex items-center justify-between bg-zinc-950 border border-zinc-800 rounded-2xl p-3">
            <div class="flex items-center gap-3">
              ${item.poster_path ? `<img src="https://image.tmdb.org/t/p/w92${item.poster_path}" class="w-10 h-14 rounded-lg object-cover" alt="${itemTitleSafe} poster">` : ''}
              <div>
                <div class="font-medium">${itemTitleSafe}</div>
                <div class="text-xs text-zinc-400">${year} · ${item._mediaType === 'tv' ? 'TV' : 'Movie'}</div>
              </div>
            </div>
            <button onclick="removeFromWatchlist(${item.id}, '${item._mediaType}')" 
                    class="text-red-400 hover:text-red-300 text-sm px-3 py-1">Remove</button>
          </div>`;
      });
      container.innerHTML = html;
    }

