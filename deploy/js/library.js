    // ===================== FULL LIBRARY (To Watch / Watched / Disliked) =====================
    // Mirrors Streamlit lists + the title-based removal fix (items disappear reliably).
    // Also syncs a bit with legacy watchlist for the old My List accordion.

    function saveToWatch() {
      Store.setItem('horror_roki_towatch', JSON.stringify(toWatchList));
      updateLibraryCounts();
      renderToWatch();
      // also refresh legacy quick list if desired
      try { renderWatchlist(); } catch(e){}
      pushToServer(); // server sync (debounced)
    }
    function saveWatched() {
      Store.setItem('horror_roki_watched', JSON.stringify(watchedList));
      updateLibraryCounts();
      renderWatched();
      // Recompute recs when library changes (taste changed)
      if (currentRecPool.length) recomputeRecommendations();
      pushToServer();
    }
    function saveDisliked() {
      Store.setItem('horror_roki_disliked', JSON.stringify(dislikedList));
      updateLibraryCounts();
      renderDisliked();
      if (currentRecPool.length) recomputeRecommendations();
      pushToServer();
    }

    function updateLibraryCounts() {
      // update top tabs counts (personal tabs at top)
      const ttw = document.getElementById('tab-towatch-count');
      if (ttw) ttw.textContent = `(${toWatchList.length})`;
      const twa = document.getElementById('tab-watched-count');
      if (twa) twa.textContent = `(${watchedList.length})`;
      const td = document.getElementById('tab-disliked-count');
      if (td) td.textContent = `(${dislikedList.length})`;
      const tni = document.getElementById('tab-notinterested-count');
      if (tni) tni.textContent = notInterestedList.length ? `(${notInterestedList.length})` : '';

      // Mini stats row
      renderPersonalStats();
      updateHomeSnapshot();
    }

    function renderPersonalStats() {
      const el = document.getElementById('personal-stats');
      if (!el) return;
      const total = watchedList.length + toWatchList.length + dislikedList.length;
      if (total === 0) {
        el.innerHTML = `<span style="color:#52525b;font-style:italic">No titles yet — search or Discover below to build your library.</span>`;
        return;
      }
      // Simple top genre from watched (rough)
      const genreCounts = {};
      watchedList.forEach(it => (it.genre_ids || []).forEach(g => { genreCounts[g] = (genreCounts[g]||0) + 1; }));
      const topGenreId = Object.keys(genreCounts).sort((a,b)=>genreCounts[b]-genreCounts[a])[0];
      const topGenre = topGenreId ? (GENRES.find(g=>g.id==topGenreId)?.name || '') : '';
      const parts = [];
      if (watchedList.length) parts.push(`<span style="display:inline-flex;align-items:center;gap:4px"><span style="color:#f87171">●</span><strong style="color:#e4e4e7">${watchedList.length}</strong><span style="color:#71717a">watched</span></span>`);
      if (toWatchList.length) parts.push(`<span style="display:inline-flex;align-items:center;gap:4px"><span style="color:#818cf8">●</span><strong style="color:#e4e4e7">${toWatchList.length}</strong><span style="color:#71717a">queued</span></span>`);
      if (dislikedList.length) parts.push(`<span style="display:inline-flex;align-items:center;gap:4px"><span style="color:#52525b">●</span><strong style="color:#e4e4e7">${dislikedList.length}</strong><span style="color:#71717a">disliked</span></span>`);
      if (topGenre) parts.push(`<span style="color:#52525b">—</span><span style="color:rgba(248,113,113,0.7)">★ ${topGenre}</span>`);
      el.innerHTML = parts.join('');
    }

    function renderTasteStats() {
      const el = document.getElementById('taste-stats-panel');
      if (!el) return;
      if (!watchedList.length) { el.innerHTML = ''; return; }

      const rated = watchedList.filter(m => m.rating);
      const avgRating = rated.length ? (rated.reduce((s, m) => s + m.rating, 0) / rated.length).toFixed(1) : null;

      const genreScores = {};
      watchedList.forEach(m => {
        const w = m.rating >= 4 ? 2 : m.rating === 3 ? 1 : 0.5;
        (m.genre_ids || []).forEach(g => { genreScores[g] = (genreScores[g] || 0) + w; });
      });
      const topGenres = Object.entries(genreScores)
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([id, score]) => ({ name: GENRES.find(g => g.id == id)?.name || 'Unknown', score }));
      const maxScore = topGenres[0]?.score || 1;

      const decadeCounts = {};
      watchedList.forEach(m => {
        const y = parseInt((m.release_date || '').slice(0, 4));
        if (y >= 1920) { const d = Math.floor(y / 10) * 10; decadeCounts[d] = (decadeCounts[d] || 0) + 1; }
      });
      const topDecade = Object.entries(decadeCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

      const GENRE_COLORS = ['bg-red-600','bg-orange-500','bg-violet-600','bg-sky-600','bg-emerald-600'];

      const isCollapsed = Store.getItem('tasteProfileCollapsed') === 'true';
      el.innerHTML = `
        <div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-4">
          <button onclick="toggleTasteProfile()" class="flex items-center justify-between w-full" style="background:none;border:none;cursor:pointer;padding:0;text-align:left;">
            <span class="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest">Your Taste Profile</span>
            <div class="flex items-center gap-3">
              <div class="flex gap-3 text-sm" id="taste-stats-summary">
                <span><strong class="text-zinc-100">${watchedList.length}</strong> <span class="text-zinc-500 text-xs">watched</span></span>
                ${avgRating ? `<span><strong class="text-zinc-100">★ ${avgRating}</strong> <span class="text-zinc-500 text-xs">avg</span></span>` : ''}
                <span><strong class="text-zinc-100">${toWatchList.length}</strong> <span class="text-zinc-500 text-xs">queued</span></span>
                ${topDecade ? `<span><strong class="text-zinc-100">${topDecade}s</strong> <span class="text-zinc-500 text-xs">era</span></span>` : ''}
              </div>
              <svg id="taste-profile-chevron" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color:#71717a;flex-shrink:0;transition:transform 0.2s;transform:rotate(${isCollapsed ? '-90deg' : '0deg'})"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </div>
          </button>
          <div id="taste-profile-body" style="overflow:hidden;transition:max-height 0.25s ease,opacity 0.2s ease;max-height:${isCollapsed ? '0' : '200px'};opacity:${isCollapsed ? '0' : '1'};">
            <div class="mt-3">
              ${topGenres.length ? `<div class="space-y-2">${topGenres.map((g, i) => `
                <div class="flex items-center gap-2">
                  <span class="text-[11px] text-zinc-400 w-20 text-right shrink-0 truncate">${g.name}</span>
                  <div class="flex-1 bg-zinc-800 rounded-full h-1.5 overflow-hidden">
                    <div class="h-full ${GENRE_COLORS[i] || 'bg-zinc-600'} rounded-full" style="width:${Math.round(g.score / maxScore * 100)}%"></div>
                  </div>
                </div>`).join('')}</div>` : ''}
            </div>
          </div>
        </div>`;
    }

    function toggleTasteProfile() {
      const body = document.getElementById('taste-profile-body');
      const chevron = document.getElementById('taste-profile-chevron');
      if (!body) return;
      const collapsed = body.style.maxHeight === '0px' || body.style.maxHeight === '0';
      if (collapsed) {
        body.style.maxHeight = '200px';
        body.style.opacity = '1';
        if (chevron) chevron.style.transform = 'rotate(0deg)';
        Store.setItem('tasteProfileCollapsed', 'false');
      } else {
        body.style.maxHeight = '0';
        body.style.opacity = '0';
        if (chevron) chevron.style.transform = 'rotate(-90deg)';
        Store.setItem('tasteProfileCollapsed', 'true');
      }
    }

    // Short relative-time label for dashboard snapshots (e.g. "2h ago", "just now").
    function timeAgo(date) {
      if (!date) return '';
      const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
      if (seconds < 60) return 'just now';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ago`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      return `${days}d ago`;
    }

    function updateHomeSnapshot() {
      const queueEl = document.getElementById('home-queue-count');
      const watchedEl = document.getElementById('home-watched-count');
      const nextEl = document.getElementById('home-next-title');
      const tasteEl = document.getElementById('home-taste-label');
      const queueCard = document.getElementById('home-queue-card');
      const queueThumb = document.getElementById('home-queue-thumb');
      if (queueEl) queueEl.textContent = `${toWatchList.length} waiting`;
      if (watchedEl) watchedEl.textContent = `${watchedList.length} rated`;
      const next = toWatchList[0];
      if (nextEl) {
        const nextTitle = next?.title || next?.name;
        nextEl.textContent = nextTitle ? `Next up: ${nextTitle}` : 'Add titles from search or Curator.';
      }
      if (queueCard && queueThumb) {
        if (next && next.poster_path) {
          queueThumb.style.display = ''; // clear any display:none an earlier onerror set, so a fresh poster can show
          queueThumb.src = `https://image.tmdb.org/t/p/w92${next.poster_path}`;
          queueThumb.alt = `${next.title || next.name || ''} poster`;
          queueCard.classList.add('has-thumb');
        } else {
          queueThumb.src = '';
          queueCard.classList.remove('has-thumb');
        }
      }
      if (tasteEl) {
        const genreCounts = {};
        watchedList.forEach(it => (it.genre_ids || []).forEach(g => { genreCounts[g] = (genreCounts[g] || 0) + 1; }));
        const topGenreId = Object.keys(genreCounts).sort((a,b) => genreCounts[b] - genreCounts[a])[0];
        const topGenre = topGenreId ? (GENRES.find(g => g.id == topGenreId)?.name || '') : '';
        const rated = watchedList.filter(it => typeof it.rating === 'number' && it.rating > 0);
        const avgRating = rated.length ? (rated.reduce((sum, it) => sum + it.rating, 0) / rated.length) : null;
        const avgText = avgRating !== null ? `${avgRating.toFixed(1)}★ avg` : '';
        const genreText = topGenre ? `Leaning ${topGenre.toLowerCase()}` : '';
        const labelText = [avgText, genreText].filter(Boolean).join(' · ') || 'Taste profile is warming up.';
        tasteEl.innerHTML = `${labelText}<span class="taste-chevron">▼</span>`;
      }

      const recCountEl = document.getElementById('home-rec-pool-count');
      const recNoteEl = document.getElementById('home-rec-pool-note');
      if (recCountEl && recNoteEl) {
        if (currentRecPool.length) {
          recCountEl.textContent = `${currentRecPool.length} picks`;
          recNoteEl.textContent = _recPoolLastRefreshed ? `Refreshed ${timeAgo(_recPoolLastRefreshed)}` : 'Tap to pull fresh picks.';
        } else {
          recCountEl.textContent = 'Fresh pool';
          recNoteEl.textContent = 'Pull a wider set of dark cinema picks.';
        }
      }

      const curatorValueEl = document.getElementById('home-curator-value');
      const curatorNoteEl = document.getElementById('home-curator-note');
      if (curatorValueEl && curatorNoteEl) {
        if (curatorPicks.length) {
          curatorValueEl.textContent = `${curatorPicks.length} pick${curatorPicks.length === 1 ? '' : 's'} ready`;
          curatorNoteEl.textContent = `Top pick: ${curatorPicks[0].title}`;
        } else if (chatHistory.some(m => m.role === 'assistant')) {
          curatorValueEl.textContent = 'In conversation';
          curatorNoteEl.textContent = 'Pick up where you left off.';
        } else {
          curatorValueEl.textContent = 'Ask next';
          curatorNoteEl.textContent = 'Use your library to pick tonight.';
        }
      }
    }

    function toggleTasteDropdown(e) {
      if (e) e.stopPropagation();
      const panel = document.getElementById('taste-dropdown');
      const card = document.getElementById('taste-profile-card');
      if (!panel) return;
      const isOpen = !panel.classList.contains('hidden');
      if (isOpen) {
        panel.classList.add('hidden');
        if (card) card.classList.remove('taste-open');
      } else {
        renderTasteDropdownGenres();
        panel.classList.remove('hidden');
        if (card) card.classList.add('taste-open');
      }
    }

    function closeTasteDropdown() {
      const panel = document.getElementById('taste-dropdown');
      const card = document.getElementById('taste-profile-card');
      if (panel) panel.classList.add('hidden');
      if (card) card.classList.remove('taste-open');
    }

    function renderTasteDropdownGenres() {
      const container = document.getElementById('taste-dropdown-genres');
      if (!container) return;

      const profile = buildTasteProfile();
      const { genreScores } = profile;

      const genreList = GENRES.filter(g => g.id !== 16 && (genreScores[g.id] || 0) > 0)
        .sort((a, b) => (genreScores[b.id] || 0) - (genreScores[a.id] || 0))
        .slice(0, 9);

      const maxScore = genreList.length ? (genreScores[genreList[0].id] || 1) : 1;

      function dotsHtml(score) {
        const filled = Math.max(1, Math.round((score / maxScore) * 5));
        let html = '<span class="taste-strength-dots">';
        for (let i = 0; i < 5; i++) {
          html += `<span class="taste-dot${i < filled ? ' filled' : ''}"></span>`;
        }
        return html + '</span>';
      }

      container.innerHTML = '';

      const allBtn = document.createElement('button');
      allBtn.className = `taste-genre-chip${recGenreFilter === null ? ' active' : ''}`;
      allBtn.innerHTML = 'All genres';
      allBtn.onclick = () => {
        recGenreFilter = null;
        renderRecGenreChips();
        updateRecGenreLabel();
        recomputeRecommendations();
        switchMainTab('foryou');
        closeTasteDropdown();
      };
      container.appendChild(allBtn);

      genreList.forEach(g => {
        const score = genreScores[g.id] || 0;
        const btn = document.createElement('button');
        btn.className = `taste-genre-chip${recGenreFilter === g.id ? ' active' : ''}`;
        btn.innerHTML = `${g.name} ${dotsHtml(score)}`;
        btn.onclick = () => {
          recGenreFilter = recGenreFilter === g.id ? null : g.id;
          renderRecGenreChips();
          updateRecGenreLabel();
          recomputeRecommendations();
          switchMainTab('foryou');
          closeTasteDropdown();
        };
        container.appendChild(btn);
      });

      if (!genreList.length) {
        container.innerHTML = '<span style="font-size:12px;color:var(--text4)">Rate some movies to unlock genre filters.</span>';
      }
    }

    // Build a best-effort DIRECT Rotten Tomatoes movie/TV URL instead of a search page.
    // RT has no public API or stable ID in TMDB data, but its pages follow a predictable
    // slug pattern: rottentomatoes.com/m/<title-slugified> (movies) and /tv/<slug> (TV).
    // Slugify = lowercase, strip punctuation, spaces→underscores. This lands directly on
    // the title page for the large majority of films; for the misses (year-suffixed slugs,
    // remakes) RT's own 404 page redirects to a search for the slug, so it degrades
    // gracefully rather than dead-ending.
    function rtSlug(title) {
      return (title || '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/['’.]/g, '')            // drop apostrophes / periods (don't → dont)
        .replace(/[^a-z0-9]+/g, '_')      // any other run of non-alphanumerics → underscore
        .replace(/^_+|_+$/g, '');         // trim leading/trailing underscores
    }
    function rtUrl(title, mediaType = 'movie') {
      const slug = rtSlug(title);
      if (!slug) return 'https://www.rottentomatoes.com/';
      const path = mediaType === 'tv' ? 'tv' : 'm';
      return `https://www.rottentomatoes.com/${path}/${slug}`;
    }

    function posterHtml(item, size = 'w92') {
      if (!item || !item.poster_path) {
        return `<div class="w-20 h-[120px] bg-zinc-800 rounded-lg flex-shrink-0 flex items-center justify-center text-zinc-600 text-2xl">🎬</div>`;
      }
      return `<div class="poster-wrap w-20 h-[120px] flex-shrink-0 loading"><img src="https://image.tmdb.org/t/p/${size}${item.poster_path}" class="w-full h-full object-cover rounded-lg shadow-lg" loading="lazy" alt="${(item.title || item.name || 'Untitled')} poster" onload="this.parentNode.classList.remove('loading')"></div>`;
    }

    function addToToWatch(item) {
      const key = `${item.id}:${item._mediaType || 'movie'}`;
      const exists = toWatchList.some(w => `${w.id}:${w._mediaType||'movie'}` === key);
      if (exists) return;
      const rec = {
        id: item.id,
        title: item.title || item.name,
        _mediaType: item._mediaType || 'movie',
        poster_path: item.poster_path,
        release_date: item.release_date || item.first_air_date,
        vote_average: item.vote_average,
        genre_ids: item.genre_ids || [],
        overview: item.overview || ''
      };
      toWatchList.unshift(rec); // newest first
      // also add to legacy quick list for compatibility
      const legacyExists = watchlist.some(w => w.id === rec.id && w._mediaType === rec._mediaType);
      if (!legacyExists) {
        watchlist.unshift({...rec});
        Store.setItem('brous_watchlist', JSON.stringify(watchlist));
        watchedIds.add(key);
      }
      saveToWatch();
      showToast('Added to To Watch');
      // remove from current visible recs/search (like the Streamlit title filter + roki removal)
      removeFromCurrentResults(item.id, item._mediaType || 'movie');
    }

    function addToWatched(item, rating = null) {
      const key = `${item.id}:${item._mediaType || 'movie'}`;
      // remove from to watch / quick list first (the "disappear" fix)
      toWatchList = toWatchList.filter(w => `${w.id}:${w._mediaType||'movie'}` !== key);
      watchlist = watchlist.filter(w => !(w.id === item.id && (w._mediaType||'movie') === (item._mediaType||'movie')));
      Store.setItem('brous_watchlist', JSON.stringify(watchlist));
      watchedIds.delete(key);

      const existsIdx = watchedList.findIndex(w => `${w.id}:${w._mediaType||'movie'}` === key);
      const rec = {
        id: item.id, title: item.title || item.name, _mediaType: item._mediaType || 'movie',
        poster_path: item.poster_path, release_date: item.release_date || item.first_air_date,
        vote_average: item.vote_average, genre_ids: item.genre_ids || [],
        overview: item.overview || '', rating: rating || null,
        _ts: Date.now() // real timestamp for recency-decay scoring (buildTasteProfile); falls back to list-index decay for older entries without it
      };
      if (existsIdx >= 0) watchedList[existsIdx] = rec; else watchedList.unshift(rec);
      saveWatched();
      renderTasteStats();
      saveToWatch(); // counts + renders
      showToast('Marked watched ★' + (rating ? rating : ''));
      removeFromCurrentResults(item.id, item._mediaType || 'movie');
    }

    function addToDisliked(item) {
      const key = `${item.id}:${item._mediaType || 'movie'}`;
      toWatchList = toWatchList.filter(w => `${w.id}:${w._mediaType||'movie'}` !== key);
      watchlist = watchlist.filter(w => !(w.id === item.id && (w._mediaType||'movie') === (item._mediaType||'movie')));
      Store.setItem('brous_watchlist', JSON.stringify(watchlist));
      watchedIds.delete(key);

      const exists = dislikedList.some(d => `${d.id}:${d._mediaType||'movie'}` === key);
      if (!exists) {
        dislikedList.unshift({
          id: item.id, title: item.title || item.name, _mediaType: item._mediaType || 'movie',
          poster_path: item.poster_path, release_date: item.release_date || item.first_air_date,
          vote_average: item.vote_average, genre_ids: item.genre_ids || []
        });
      }
      saveDisliked();
      saveToWatch();
      showToast('Added to Disliked');
      removeFromCurrentResults(item.id, item._mediaType || 'movie');
    }

    function removeFromToWatch(id, mediaType = 'movie') {
      const key = `${id}:${mediaType}`;
      toWatchList = toWatchList.filter(w => `${w.id}:${w._mediaType||'movie'}` !== key);
      watchlist = watchlist.filter(w => !(w.id === id && (w._mediaType||'movie') === mediaType));
      Store.setItem('brous_watchlist', JSON.stringify(watchlist));
      watchedIds.delete(key);
      saveToWatch();
    }

    function removeFromWatched(id, mediaType = 'movie') {
      const key = `${id}:${mediaType}`;
      watchedList = watchedList.filter(w => `${w.id}:${w._mediaType||'movie'}` !== key);
      saveWatched();
    }

    function removeFromDisliked(id, mediaType = 'movie') {
      const key = `${id}:${mediaType}`;
      dislikedList = dislikedList.filter(d => `${d.id}:${d._mediaType||'movie'}` !== key);
      saveDisliked();
    }

    function addToNotInterested(item) {
      const key = `${item.id}:${item._mediaType || 'movie'}`;
      const exists = notInterestedList.some(d => `${d.id}:${d._mediaType||'movie'}` === key);
      if (!exists) {
        notInterestedList.unshift({
          id: item.id, title: item.title || item.name, _mediaType: item._mediaType || 'movie',
          poster_path: item.poster_path, release_date: item.release_date || item.first_air_date,
          vote_average: item.vote_average, genre_ids: item.genre_ids || []
        });
      }
      saveNotInterested();
      showToast('Hidden — won\'t appear in results');
      removeFromCurrentResults(item.id, item._mediaType || 'movie');
    }

    function saveNotInterested() {
      Store.setItem('horror_roki_not_interested', JSON.stringify(notInterestedList));
      updateLibraryCounts();
      renderNotInterested();
      if (currentRecPool.length) recomputeRecommendations();
      pushToServer();
    }

    function removeFromNotInterested(id, mediaType = 'movie') {
      const key = `${id}:${mediaType}`;
      notInterestedList = notInterestedList.filter(d => `${d.id}:${d._mediaType||'movie'}` !== key);
      saveNotInterested();
    }

