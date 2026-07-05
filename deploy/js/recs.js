    // ===================== HORROR ROKI RECS + TASTE =====================

    // Simple genre prefs used by the Curator for context (kept for compatibility)
    function getUserGenrePrefs() {
      const counts = {};
      watchedList.forEach(m => {
        const w = (m.rating === 5) ? 4 : (m.rating === 4) ? 2 : 1;
        (m.genre_ids || []).forEach(gid => { counts[gid] = (counts[gid] || 0) + w; });
      });
      const total = Object.values(counts).reduce((a,b)=>a+b, 0) || 1;
      const prefs = {};
      Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,6).forEach(([gid, c]) => {
        const g = GENRES.find(x => x.id == gid);
        if (g) prefs[g.name] = Math.round((c/total)*1000)/10;
      });
      return prefs;
    }

    // Rich taste profile used by the scoring engine
    function buildTasteProfile() {
      const genreScores = {};   // genre_id -> weighted affinity (positive or negative)
      const decadeCounts = {};  // decade (e.g. 1990) -> weighted count
      const genrePairScores = {}; // "gidA,gidB" (sorted) -> weighted affinity for that *combination*
      const genreDislikeCounts = {}; // genre_id -> count of disliked items carrying it (for scaled penalty)

      // Watched history — weight by rating + recency decay.
      // Decay prefers an actual watched timestamp (m._ts, ms since epoch) when present;
      // older stored entries lack it, so we fall back to list-index decay for those
      // (index 0 = most recently added) to stay backward compatible.
      const now = Date.now();
      const DAY = 86400000;
      watchedList.forEach((m, index) => {
        const r = m.rating || 3;
        const decay = m._ts
          ? Math.pow(0.97, Math.max(0, (now - m._ts) / DAY) / 1.4) // ~daily-equivalent decay using real elapsed time
          : Math.pow(0.97, index); // legacy fallback: full weight at 0; ~50% by index 23; ~5% by index 95
        const w = (r === 5 ? 4 : r === 4 ? 2 : r === 3 ? 0.3 : r === 2 ? -1 : -2) * decay;
        const gids = m.genre_ids || [];
        gids.forEach(gid => { genreScores[gid] = (genreScores[gid] || 0) + w; });
        // Pairwise co-occurrence: reward the *combination* of genres this title carries,
        // not just each genre independently. Only counted for positively-weighted titles
        // so co-occurrence doesn't end up rewarding pairs from films the user disliked.
        if (w > 0 && gids.length >= 2) {
          for (let i = 0; i < gids.length; i++) {
            for (let j = i + 1; j < gids.length; j++) {
              const key = gids[i] < gids[j] ? `${gids[i]},${gids[j]}` : `${gids[j]},${gids[i]}`;
              genrePairScores[key] = (genrePairScores[key] || 0) + w;
            }
          }
        }
        const year = parseInt((m.release_date || '').slice(0, 4));
        if (year >= 1920) {
          const decade = Math.floor(year / 10) * 10;
          decadeCounts[decade] = (decadeCounts[decade] || 0) + (r >= 4 ? 2 : 1) * decay;
        }
      });

      // Disliked — negative genre signal, scaled by how often each genre shows up in
      // dislikes rather than a flat penalty per item. One disliked horror movie nudges
      // the horror score down; ten disliked horror movies push it down hard.
      dislikedList.forEach(m => {
        (m.genre_ids || []).forEach(gid => { genreDislikeCounts[gid] = (genreDislikeCounts[gid] || 0) + 1; });
      });
      Object.entries(genreDislikeCounts).forEach(([gid, count]) => {
        // Diminishing per-item penalty (sqrt) so it scales with frequency but doesn't
        // run away to an unbounded negative for genres with many dislikes.
        genreScores[gid] = (genreScores[gid] || 0) - 1.6 * Math.sqrt(count);
      });

      // Normalise: total positive genre weight (for relative boost calculation)
      const totalPos = Object.values(genreScores).reduce((a, b) => a + Math.max(0, b), 0) || 1;
      const totalDecade = Object.values(decadeCounts).reduce((a, b) => a + b, 0) || 1;
      const totalPairPos = Object.values(genrePairScores).reduce((a, b) => a + Math.max(0, b), 0) || 1;

      return { genreScores, decadeCounts, totalPos, totalDecade, genrePairScores, totalPairPos };
    }

    // Bayesian-corrected rating — penalises films with few votes
    function bayesianRating(voteAvg, voteCount) {
      const C = 6.5;   // global mean prior
      const m = 800;   // minimum votes for full trust
      return (voteCount * voteAvg + m * C) / (voteCount + m);
    }

    // Percentile helper — value below which `p` fraction of a sorted numeric array falls.
    function percentile(sortedArr, p) {
      if (!sortedArr.length) return 0;
      const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.floor(p * (sortedArr.length - 1))));
      return sortedArr[idx];
    }

    // Pool-relative thresholds for the hidden-gem bonus and vote-count reliability
    // penalty in scoreItem(). Fixed constants (vote_average>=7.2, popularity<60, etc.)
    // don't adapt: a pool that's mostly obscure titles would almost never clear a fixed
    // popularity<60 bar in a meaningful way, while a blockbuster-heavy pool would clear
    // it too easily. Computing percentiles from the actual fetched pool keeps both bonus
    // and penalty calibrated to whatever was actually returned this refresh.
    function computePoolStats(pool) {
      if (!pool || !pool.length) {
        // Sane fallbacks matching the old fixed constants, for an empty/missing pool.
        return { gemVoteAvgMin: 7.2, gemPopularityMax: 60, gemVoteCountMin: 500, lowVoteCount: 150, midVoteCount: 400 };
      }
      const voteAvgs = pool.map(p => p.vote_average || 0).sort((a, b) => a - b);
      const popularities = pool.map(p => p.popularity || 0).sort((a, b) => a - b);
      const voteCounts = pool.map(p => p.vote_count || 0).sort((a, b) => a - b);
      return {
        gemVoteAvgMin: Math.max(6.5, percentile(voteAvgs, 0.75)),     // top quartile rating in this pool
        gemPopularityMax: Math.max(20, percentile(popularities, 0.5)), // below-median popularity = "didn't blow up"
        gemVoteCountMin: Math.max(200, percentile(voteCounts, 0.25)),  // still enough votes to trust the rating
        lowVoteCount: Math.max(50, percentile(voteCounts, 0.15)),
        midVoteCount: Math.max(150, percentile(voteCounts, 0.35))
      };
    }

    // ── Live-tunable ranking weights ────────────────────────────────────────────
    // These three numbers were hardcoded; they're now driven by the sliders in
    // Settings → Recommendation tuning and persisted to localStorage so the user can
    // adjust ranking behaviour without editing code.
    //   qualityBaseline : weight on the Bayesian "is this objectively well-rated" score
    //   genreAffinity   : weight on how well a title matches the user's genre taste
    //   exploration     : size of the random serendipity jitter (shuffle on refresh)
    // Defaults match the shipped tuning (0.78 / 4.0 / 0.6).
    const RECTUNE_DEFAULTS = { qualityBaseline: 0.78, genreAffinity: 4.0, exploration: 0.6 };
    let recTune = { ...RECTUNE_DEFAULTS };
    try {
      const saved = JSON.parse(Store.getItem('roki_rec_tune') || 'null');
      if (saved && typeof saved === 'object') recTune = { ...RECTUNE_DEFAULTS, ...saved };
    } catch (_) {}
    function saveRecTune() {
      try { Store.setItem('roki_rec_tune', JSON.stringify(recTune)); } catch (_) {}
    }

    function scoreItem(item, profile, poolStats) {
      const { genreScores, decadeCounts, totalPos, totalDecade, genrePairScores, totalPairPos } = profile;
      const stats = poolStats || computePoolStats(null);
      const voteCount = item.vote_count || 0;
      const voteAvg = item.vote_average || 6.0;

      // Start from a reliable quality baseline.
      // Tuned slightly DOWN (0.9 -> 0.78) so generically well-rated films no longer
      // out-muscle titles that actually match the user's taste — a gentle tilt toward
      // "more personal" without narrowing the (intentionally broad) candidate pool.
      let score = bayesianRating(voteAvg, voteCount) * recTune.qualityBaseline;

      // Genre affinity — normalised so top genres give a lift, anti-genres pull down.
      // Tuned slightly UP (3.5 -> 4.0) as the other half of the taste tilt above.
      const gids = item.genre_ids || [];
      gids.forEach(gid => {
        if (genreScores[gid] != null) {
          score += (genreScores[gid] / totalPos) * recTune.genreAffinity;
        }
      });

      // Genre co-occurrence bonus — rewards the *specific combination* of genres this
      // item carries when the user has consistently rated that exact combination well,
      // not just each genre in isolation (e.g. specifically Horror+Comedy, not just
      // "likes Horror" and "likes Comedy" as two separate unrelated facts).
      if (gids.length >= 2 && genrePairScores) {
        for (let i = 0; i < gids.length; i++) {
          for (let j = i + 1; j < gids.length; j++) {
            const key = gids[i] < gids[j] ? `${gids[i]},${gids[j]}` : `${gids[j]},${gids[i]}`;
            const pairScore = genrePairScores[key];
            if (pairScore > 0) score += (pairScore / totalPairPos) * 1.5;
          }
        }
      }

      // Decade affinity
      const year = parseInt((item.release_date || '').slice(0, 4));
      if (year && totalDecade > 0) {
        const decade = Math.floor(year / 10) * 10;
        if (decadeCounts[decade]) score += (decadeCounts[decade] / totalDecade) * 1.2;
      }

      // Hidden-gem bonus: quality film that didn't blow up mainstream — thresholds are
      // relative to this pool's own distribution (see computePoolStats), not fixed constants.
      if (voteAvg >= stats.gemVoteAvgMin && (item.popularity || 0) < stats.gemPopularityMax && voteCount >= stats.gemVoteCountMin) score += 0.8;

      // Vote-count reliability penalty — also pool-relative.
      if (voteCount < stats.lowVoteCount) score -= 0.8;
      else if (voteCount < stats.midVoteCount) score -= 0.3;

      // Director / actor / keyword / franchise affinity boost (tagged at pool-fetch time)
      if (item._affinityBoost) score += item._affinityBoost;

      // Serendipity / exploration jitter — a small random nudge so successive refreshes
      // and Recompute don't return an identical frozen ordering, and near-tied titles get
      // a fair shot at rotating into the visible top 40. recTune.exploration is small
      // relative to the genre-affinity lift so it reshuffles near-ties without ever
      // floating a poor match above a strong one. Controlled by the Serendipity slider
      // in Settings → Recommendation tuning.
      score += (Math.random() - 0.5) * 2 * recTune.exploration;

      return Math.max(0.01, score);
    }

    // Diversity interleave: round-robin across top genres so the top 40 isn't mono-genre
    function diversify(scored, limit) {
      if (scored.length <= limit) return scored;

      // Bucket by primary genre (first genre_id)
      const buckets = {};
      const ungrouped = [];
      scored.forEach(it => {
        const g = (it.genre_ids || [])[0];
        if (g) { (buckets[g] = buckets[g] || []).push(it); }
        else { ungrouped.push(it); }
      });

      // Sort bucket keys by the score of their top item (best genre first)
      const keys = Object.keys(buckets).sort((a, b) => buckets[b][0]._score - buckets[a][0]._score);

      // Round-robin across genre buckets first, *without* touching `ungrouped` — this
      // produces a clean genre-interleaved sequence with no arbitrary score-offset logic.
      const interleaved = [];
      let i = 0;
      while (true) {
        let added = false;
        for (const k of keys) {
          if (buckets[k].length > i) { interleaved.push(buckets[k][i]); added = true; }
        }
        if (!added) break;
        i++;
      }

      // Merge `ungrouped` into the interleaved sequence purely by score rank (both lists
      // are already sorted descending by _score, since `scored` was sorted before this
      // call) — a standard two-pointer merge, so an ungrouped item lands exactly where
      // its score places it rather than via a fixed "-1" fudge-factor comparison.
      const result = [];
      let a = 0, b = 0;
      while (result.length < limit && (a < interleaved.length || b < ungrouped.length)) {
        const left = interleaved[a];
        const right = ungrouped[b];
        if (left && (!right || left._score >= right._score)) { result.push(left); a++; }
        else { result.push(right); b++; }
      }
      return result;
    }

    // Mood chips UI removed per request. currentMood stays 'All' (no filtering).

    let recGenreFilter = null; // null = All, otherwise a genre id (number)
    let recMediaFilter = 'movie'; // 'all' | 'movie' | 'tv' — filters For You recs by media type; defaults to Movies

    // Keep the inline "Genre: X ▾" button label in sync with the dropdown's selection.
    function updateRecGenreLabel() {
      const el = document.getElementById('rec-genre-filter-label');
      if (!el) return;
      if (recGenreFilter === null) { el.textContent = 'Genre: All'; return; }
      const g = (typeof GENRES !== 'undefined') ? GENRES.find(x => x.id === recGenreFilter) : null;
      el.textContent = 'Genre: ' + (g ? g.name : '…');
    }

    function setRecMediaFilter(val) {
      recMediaFilter = val;
      // Update the toggle buttons' active styling
      ['all', 'movie', 'tv'].forEach(v => {
        const b = document.getElementById('rec-media-' + v);
        if (b) {
          const active = v === val;
          b.className = `text-xs px-3 py-1.5 rounded-full border transition-colors ${active ? 'bg-red-700 border-red-600 text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:border-zinc-500'}`;
        }
      });
      recomputeRecommendations();
    }

    function renderRecGenreChips() {
      const wrap = document.getElementById('recs-genre-chips');
      if (!wrap) return;
      // Derive which genres actually exist in the current pool
      const poolGenreIds = new Set();
      currentRecPool.forEach(m => (m.genre_ids || []).forEach(id => poolGenreIds.add(id)));
      const available = GENRES.filter(g => g.id !== 16 && poolGenreIds.has(g.id));

      const allBtn = document.createElement('button');
      allBtn.textContent = 'All';
      allBtn.className = `text-xs px-3 py-1.5 rounded-full border transition-colors ${recGenreFilter === null ? 'bg-red-700 border-red-600 text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:border-zinc-500'}`;
      allBtn.onclick = () => { recGenreFilter = null; collapseRecsGenreFilter(); renderRecGenreChips(); recomputeRecommendations(); };
      wrap.innerHTML = '';
      wrap.appendChild(allBtn);

      available.forEach(g => {
        const btn = document.createElement('button');
        btn.textContent = g.name;
        btn.className = `text-xs px-3 py-1.5 rounded-full border transition-colors ${recGenreFilter === g.id ? 'bg-red-700 border-red-600 text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:border-zinc-500'}`;
        btn.onclick = () => { recGenreFilter = recGenreFilter === g.id ? null : g.id; collapseRecsGenreFilter(); renderRecGenreChips(); recomputeRecommendations(); };
        wrap.appendChild(btn);
      });

      // Update the collapsed-header label to show the active genre
      const label = document.getElementById('recs-filter-current');
      if (label) {
        const active = GENRES.find(g => g.id === recGenreFilter);
        label.textContent = active ? active.name : 'All';
      }
      // Keep the inline "Genre: X ▾" button in sync as well
      updateRecGenreLabel();
    }

    function toggleRecsGenreFilter() {
      const wrap = document.getElementById('recs-filter-wrap');
      if (wrap) wrap.classList.toggle('recs-filter-collapsed');
    }

    // Collapse the recs genre list (used after a pick so the chosen genre shows compact on mobile)
    function collapseRecsGenreFilter() {
      const wrap = document.getElementById('recs-filter-wrap');
      if (wrap) wrap.classList.add('recs-filter-collapsed');
    }

    let _recPoolLoading = false;

    // Negative affinity signals derived from disliked films (directors / keywords the
    // user has repeatedly rejected). Mirrors the POSITIVE affinity phase: dislikes used
    // to only push down genres, so a director you disliked 3x could still be recommended.
    // Populated in refreshRecPool's disliked-affinity phase, consumed when tagging the pool.
    let _dislikedPersonScores = {};   // personId -> penalty weight (positive number = how disliked)
    let _dislikedKeywordScores = {};  // keywordId -> penalty weight
    let _dislikedPenaltyIds = new Set(); // "id:movie" keys from strongly-disliked directors' filmographies

    // "⋯" overflow menu for the less-common recs actions (Refresh Pool / Surprise Me /
    // Found Footage) — appended to body and positioned via getBoundingClientRect,
    // same pattern as the why-this-pop / wtw-popup elsewhere, so it can't get clipped
    // by the action row's own horizontal-scroll container.
    function toggleRecsActionsMenu(e) {
      e.stopPropagation();
      const existing = document.getElementById('recs-actions-menu');
      const btn = document.getElementById('recs-more-btn');
      if (existing) { closeRecsActionsMenu(); return; }
      const menu = document.createElement('div');
      menu.id = 'recs-actions-menu';
      menu.setAttribute('role', 'menu');
      menu.style.cssText = 'position:fixed;z-index:50;background:#18181b;border:1px solid #3f3f46;border-radius:14px;padding:4px;min-width:170px;box-shadow:0 12px 24px rgba(0,0,0,0.4);';
      menu.innerHTML = `
        <button onclick="refreshRecPool(); closeRecsActionsMenu();" class="w-full text-left text-sm px-3 py-2 rounded-xl text-zinc-300 hover:bg-zinc-800" role="menuitem">Refresh Pool</button>
        <button onclick="surpriseMe(); closeRecsActionsMenu();" class="w-full text-left text-sm px-3 py-2 rounded-xl text-amber-400 hover:bg-zinc-800" role="menuitem">🎲 Surprise Me</button>
        <button onclick="loadFoundFootage(); closeRecsActionsMenu();" class="w-full text-left text-sm px-3 py-2 rounded-xl text-zinc-300 hover:bg-zinc-800" role="menuitem">🎥 Found Footage</button>
      `;
      document.body.appendChild(menu);
      const rect = btn.getBoundingClientRect();
      const mw = 170;
      menu.style.left = Math.min(rect.left, window.innerWidth - mw - 8) + 'px';
      menu.style.top = (rect.bottom + 6) + 'px';
      btn.setAttribute('aria-expanded', 'true');
      setTimeout(() => document.addEventListener('click', closeRecsActionsMenu, { once: true }), 10);
    }
    function closeRecsActionsMenu() {
      const m = document.getElementById('recs-actions-menu');
      if (m) m.remove();
      const btn = document.getElementById('recs-more-btn');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }

    async function refreshRecPool(options = {}) {
      if (_recPoolLoading) return; // prevent double-fire / infinite loop
      _recPoolLoading = true;
      const append = !!options.append;

      const grid = document.getElementById('recs-grid');
      const empty = document.getElementById('recs-empty');
      if (grid) {
        if (!append) {
          grid.innerHTML = '';
          showSkeletons('recs-grid', 8);
        } else {
          const loading = document.createElement('div');
          loading.id = 'recs-loading-more';
          loading.className = 'text-center py-6 text-zinc-400 text-sm col-span-full';
          loading.textContent = 'Looking deeper...';
          grid.appendChild(loading);
        }
      }
      if (empty) empty.classList.add('hidden');

      try {
        const excluded = getExcludedKeys();
        let raw = [];

        // ── PHASE 1: Build affinity signals from watch history (fresh loads only) ──
        // Fetches credits, keywords, and movie details (for franchise) for the
        // user's top-rated films. Results are used to seed the pool with targeted
        // discover queries and to tag items for score boosting.
        const affinityTagged = []; // items pre-tagged with _affinityReason/_affinityBoost

        if (!append && watchedList.length) {
          const topRated = [...watchedList]
            .filter(m => (m.rating || 0) >= 4 && m.id)
            .sort((a, b) => (b.rating || 0) - (a.rating || 0))
            .slice(0, 8);
          // Affinity signals (credits/keywords/collection) only exist for the movie
          // endpoints below — TV uses a different credits shape (created_by, no belongs_to_collection),
          // so we scope this phase to movies but still let TV-watched items inform genre/decade
          // scoring in buildTasteProfile (that part is media-type agnostic already).
          const topRatedMovies = topRated.filter(m => (m._mediaType || 'movie') === 'movie');

          if (topRatedMovies.length) {
            try {
              const [credResults, kwResults, detResults] = await Promise.all([
                Promise.allSettled(topRatedMovies.map(m => apiFetch(`/api/tmdb/3/movie/${m.id}/credits`))),
                Promise.allSettled(topRatedMovies.slice(0, 5).map(m => apiFetch(`/api/tmdb/3/movie/${m.id}/keywords`))),
                Promise.allSettled(topRatedMovies.slice(0, 5).map(m => apiFetch(`/api/tmdb/3/movie/${m.id}?language=en-US`)))
              ]);

              // Build person scores (directors weighted higher than cast)
              const personScores = {};
              credResults.forEach((res, i) => {
                if (res.status !== 'fulfilled') return;
                const w = topRatedMovies[i].rating === 5 ? 4 : topRatedMovies[i].rating === 4 ? 2.5 : 1.5;
                (res.value.crew || []).filter(c => c.job === 'Director').forEach(c => {
                  if (!personScores[c.id]) personScores[c.id] = { name: c.name, score: 0, type: 'director' };
                  personScores[c.id].score += w;
                });
                (res.value.cast || []).slice(0, 3).forEach(c => {
                  if (!personScores[c.id]) personScores[c.id] = { name: c.name, score: 0, type: 'actor' };
                  personScores[c.id].score += w * 0.4;
                });
              });

              // Build keyword frequency map
              const kwCounts = {};
              kwResults.forEach((res, i) => {
                if (res.status !== 'fulfilled') return;
                const w = topRatedMovies[i].rating === 5 ? 3 : 2;
                (res.value.keywords || []).forEach(kw => { kwCounts[kw.id] = (kwCounts[kw.id] || 0) + w; });
              });
              const topKeywordIds = Object.entries(kwCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => id);

              // Franchise siblings from belongs_to_collection
              const colIds = new Set();
              detResults.forEach(res => {
                if (res.status === 'fulfilled' && res.value?.belongs_to_collection?.id)
                  colIds.add(res.value.belongs_to_collection.id);
              });
              if (colIds.size) {
                const colResults = await Promise.allSettled([...colIds].map(id => apiFetch(`/api/tmdb/3/collection/${id}?language=en-US`)));
                colResults.forEach(res => {
                  if (res.status !== 'fulfilled') return;
                  (res.value.parts || []).forEach(p => {
                    if (p.poster_path && p.original_language === 'en')
                      affinityTagged.push({ ...p, _mediaType: 'movie', _affinityReason: `Part of a series you love`, _affinityBoost: 2.5 });
                  });
                });
              }

              // Affinity discover URLs (director / actor / keyword) — fetched with tagging
              const affinityUrls = [];
              Object.entries(personScores)
                .filter(([, p]) => p.type === 'director' && p.score >= 3)
                .sort((a, b) => b[1].score - a[1].score).slice(0, 3)
                .forEach(([id, p]) => {
                  const base2 = `/api/tmdb/3/discover/movie?with_crew=${id}&sort_by=vote_average.desc&vote_count.gte=200`;
                  affinityUrls.push({ url: `${base2}&page=1`, reason: `Directed by ${p.name}`, boost: 2.0 });
                  affinityUrls.push({ url: `${base2}&page=2`, reason: `Directed by ${p.name}`, boost: 2.0 });
                });
              Object.entries(personScores)
                .filter(([, p]) => p.type === 'actor' && p.score >= 1.5)
                .sort((a, b) => b[1].score - a[1].score).slice(0, 3)
                .forEach(([id, p]) => {
                  affinityUrls.push({ url: `/api/tmdb/3/discover/movie?with_cast=${id}&sort_by=vote_average.desc&vote_count.gte=200&page=1`, reason: `Stars ${p.name}`, boost: 1.2 });
                });
              if (topKeywordIds.length) {
                const kwStr = topKeywordIds.slice(0, 5).join('|');
                affinityUrls.push({ url: `/api/tmdb/3/discover/movie?with_keywords=${kwStr}&sort_by=vote_average.desc&vote_count.gte=200&page=1`, reason: `Matches your themes`, boost: 0.8 });
                affinityUrls.push({ url: `/api/tmdb/3/discover/movie?with_keywords=${kwStr}&sort_by=vote_average.desc&vote_count.gte=200&page=2`, reason: `Matches your themes`, boost: 0.8 });
              }

              // Fetch affinity URLs sequentially (small set, need to tag results)
              for (const { url, reason, boost } of affinityUrls) {
                try {
                  const d = await apiFetch(url).catch(() => null);
                  (d?.results || []).forEach(r => affinityTagged.push({ ...r, _mediaType: 'movie', _affinityReason: reason, _affinityBoost: boost }));
                } catch (_) {}
              }
            } catch (e) {
              console.warn('[Recs] Affinity phase error (non-fatal):', e.message);
            }
          }

          // ── TV affinity pass — parallels the movie pass above using TV-shaped
          // endpoints (created_by instead of crew/Director; no belongs_to_collection). ──
          const topRatedTv = topRated.filter(m => m._mediaType === 'tv');
          if (topRatedTv.length) {
            try {
              const [tvCredResults, tvKwResults] = await Promise.all([
                Promise.allSettled(topRatedTv.map(m => apiFetch(`/api/tmdb/3/tv/${m.id}/credits`))),
                Promise.allSettled(topRatedTv.slice(0, 5).map(m => apiFetch(`/api/tmdb/3/tv/${m.id}/keywords`)))
              ]);

              const tvPersonScores = {};
              tvCredResults.forEach((res, i) => {
                if (res.status !== 'fulfilled') return;
                const w = topRatedTv[i].rating === 5 ? 4 : topRatedTv[i].rating === 4 ? 2.5 : 1.5;
                // TV credits don't reliably expose a "Director" job on /credits; cast carries the signal.
                (res.value.cast || []).slice(0, 3).forEach(c => {
                  if (!tvPersonScores[c.id]) tvPersonScores[c.id] = { name: c.name, score: 0, type: 'actor' };
                  tvPersonScores[c.id].score += w * 0.4;
                });
              });

              const tvKwCounts = {};
              tvKwResults.forEach((res, i) => {
                if (res.status !== 'fulfilled') return;
                const w = topRatedTv[i].rating === 5 ? 3 : 2;
                // /tv/{id}/keywords returns { results: [...] } rather than { keywords: [...] }
                (res.value.results || res.value.keywords || []).forEach(kw => { tvKwCounts[kw.id] = (tvKwCounts[kw.id] || 0) + w; });
              });
              const topTvKeywordIds = Object.entries(tvKwCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => id);

              const tvAffinityUrls = [];
              Object.entries(tvPersonScores)
                .filter(([, p]) => p.type === 'actor' && p.score >= 1.5)
                .sort((a, b) => b[1].score - a[1].score).slice(0, 3)
                .forEach(([id, p]) => {
                  tvAffinityUrls.push({ url: `/api/tmdb/3/discover/tv?with_cast=${id}&sort_by=vote_average.desc&vote_count.gte=100&page=1`, reason: `Stars ${p.name}`, boost: 1.2 });
                });
              if (topTvKeywordIds.length) {
                const kwStr = topTvKeywordIds.slice(0, 5).join('|');
                tvAffinityUrls.push({ url: `/api/tmdb/3/discover/tv?with_keywords=${kwStr}&sort_by=vote_average.desc&vote_count.gte=100&page=1`, reason: `Matches your themes`, boost: 0.8 });
              }

              for (const { url, reason, boost } of tvAffinityUrls) {
                try {
                  const d = await apiFetch(url).catch(() => null);
                  (d?.results || []).forEach(r => affinityTagged.push({ ...r, _mediaType: 'tv', _affinityReason: reason, _affinityBoost: boost }));
                } catch (_) {}
              }
            } catch (e) {
              console.warn('[Recs] TV affinity phase error (non-fatal):', e.message);
            }
          }
        }

        // ── PHASE 1b: Disliked-affinity (negative) signals ──
        // Symmetric to the positive affinity phase: learn which directors and keywords
        // the user has repeatedly disliked so the pool tagging can push those titles
        // DOWN, not just penalise their genres. Scoped to movies (TV credits differ),
        // best-effort, and capped to the most recent dislikes to bound API calls.
        if (!append && dislikedList.length) {
          _dislikedPersonScores = {};
          _dislikedKeywordScores = {};
          const dislikedMovies = dislikedList
            .filter(m => m.id && (m._mediaType || 'movie') === 'movie')
            .slice(0, 12); // most-recent dislikes (list is unshift-ordered)
          if (dislikedMovies.length) {
            try {
              const [dCred, dKw] = await Promise.all([
                Promise.allSettled(dislikedMovies.map(m => apiFetch(`/api/tmdb/3/movie/${m.id}/credits`))),
                Promise.allSettled(dislikedMovies.slice(0, 8).map(m => apiFetch(`/api/tmdb/3/movie/${m.id}/keywords`)))
              ]);
              dCred.forEach(res => {
                if (res.status !== 'fulfilled') return;
                (res.value.crew || []).filter(c => c.job === 'Director').forEach(c => {
                  _dislikedPersonScores[c.id] = (_dislikedPersonScores[c.id] || 0) + 1;
                });
              });
              dKw.forEach(res => {
                if (res.status !== 'fulfilled') return;
                (res.value.keywords || []).forEach(kw => {
                  _dislikedKeywordScores[kw.id] = (_dislikedKeywordScores[kw.id] || 0) + 1;
                });
              });

              // Discover results only carry genre_ids — not credits — so we can't match a
              // disliked director against an arbitrary pool item cheaply. Instead, for the
              // most strongly-disliked directors (rejected >=2 times), pull their filmography
              // and mark those specific movie IDs for a score penalty when they appear in
              // the pool. Bounded to the top few directors to keep API calls small.
              _dislikedPenaltyIds = new Set();
              const strongDislikedDirectors = Object.entries(_dislikedPersonScores)
                .filter(([, n]) => n >= 2)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([id]) => id);
              if (strongDislikedDirectors.length) {
                const dirFilms = await Promise.allSettled(
                  strongDislikedDirectors.map(id =>
                    apiFetch(`/api/tmdb/3/discover/movie?with_crew=${id}&sort_by=popularity.desc&page=1`))
                );
                dirFilms.forEach(res => {
                  if (res.status !== 'fulfilled') return;
                  (res.value.results || []).forEach(r => _dislikedPenaltyIds.add(`${r.id}:movie`));
                });
              }
            } catch (e) {
              console.warn('[Recs] Disliked-affinity phase error (non-fatal):', e.message);
            }
          }
        }

        // ── PHASE 2: Broad pool URLs ──
        // Each entry carries its own media type so every fetched item can be tagged
        // correctly at the source — movie and TV ids can collide, so dedupe/scoring
        // downstream needs `${id}:${mediaType}` keys rather than id alone.
        const base = `/api/tmdb/3/discover/movie?language=en-US&include_adult=false&with_original_language=en&without_genres=16&primary_release_date.gte=1960-01-01&vote_count.gte=100&vote_average.gte=5.5`;
        const tvBase = `/api/tmdb/3/discover/tv?language=en-US&include_adult=false&with_original_language=en&without_genres=16&first_air_date.gte=1960-01-01&vote_count.gte=100&vote_average.gte=5.5`;
        const pageCount = 10;
        const startPage = append ? recPageCursor : (1 + Math.floor(Math.random() * 20));
        const urls = []; // { url, type }
        for (let i = 0; i < pageCount; i++) {
          const page = Math.min(startPage + i, 480);
          urls.push({ url: `${base}&sort_by=popularity.desc&page=${page}`, type: 'movie' });
          urls.push({ url: `${base}&sort_by=vote_average.desc&page=${page}`, type: 'movie' });
        }
        // TV gets a lighter share of the broad pool (fewer pages) since affinity/similar
        // signals carry more of the TV weight, keeping movie:TV roughly balanced overall.
        for (let i = 0; i < Math.ceil(pageCount / 2); i++) {
          const page = Math.min(startPage + i, 480);
          urls.push({ url: `${tvBase}&sort_by=popularity.desc&page=${page}`, type: 'tv' });
          urls.push({ url: `${tvBase}&sort_by=vote_average.desc&page=${page}`, type: 'tv' });
        }
        urls.push({ url: `/api/tmdb/3/trending/movie/week`, type: 'movie' });
        urls.push({ url: `/api/tmdb/3/trending/tv/week`, type: 'tv' });
        for (let i = 0; i < 5; i++) {
          const page = Math.min(startPage + i, 480);
          urls.push({ url: `/api/tmdb/3/movie/popular?language=en-US&page=${page}`, type: 'movie' });
          urls.push({ url: `/api/tmdb/3/movie/top_rated?language=en-US&page=${page}`, type: 'movie' });
        }
        for (let i = 0; i < 3; i++) {
          const page = Math.min(startPage + i, 480);
          urls.push({ url: `/api/tmdb/3/tv/popular?language=en-US&page=${page}`, type: 'tv' });
          urls.push({ url: `/api/tmdb/3/tv/top_rated?language=en-US&page=${page}`, type: 'tv' });
        }
        // Similar/recommendations from top-rated watches (movie + TV, each via its own endpoint)
        if (!append && watchedList.length) {
          const topRatedAll = [...watchedList].filter(m => (m.rating || 0) >= 4 && m.id)
            .sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, 5);
          topRatedAll.forEach(m => {
            const mt = m._mediaType === 'tv' ? 'tv' : 'movie';
            urls.push({ url: `/api/tmdb/3/${mt}/${m.id}/similar?language=en-US&page=1`, type: mt });
            urls.push({ url: `/api/tmdb/3/${mt}/${m.id}/recommendations?language=en-US&page=1`, type: mt });
          });
        }

        // Concurrency-limited fetch
        const CONCURRENCY = 5;
        let urlIndex = 0;
        async function worker() {
          while (urlIndex < urls.length) {
            const { url: u, type } = urls[urlIndex++];
            try {
              const d = await apiFetch(u);
              raw = raw.concat((d.results || []).map(r => ({ ...r, _mediaType: type })));
            } catch (_) {
              try { await new Promise(r => setTimeout(r, 500)); const d = await apiFetch(u); raw = raw.concat((d.results || []).map(r => ({ ...r, _mediaType: type }))); } catch (_) {}
            }
          }
        }
        await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

        // Merge affinity-tagged items into raw (they may duplicate broad results — deduping handles it)
        raw = raw.concat(affinityTagged);

        // ── PHASE 3: Dedupe, filter, sort ──
        // Dedupe key is `${id}:${mediaType}` everywhere below — a movie and a TV show
        // can share a numeric id, so id alone is not a safe key once TV is included.
        // Affinity-tagged items win the dedupe race: process them first so their tags survive.
        const seen = new Set();
        let results = [];
        if (append) currentRecPool.forEach(r => seen.add(`${r.id}:${r._mediaType || 'movie'}`));

        // Affinity items first (preserve tags)
        for (const r of affinityTagged) {
          const k = `${r.id}:${r._mediaType || 'movie'}`;
          if (!seen.has(k)) { seen.add(k); results.push(r); }
        }
        // Then broad pool (sorted by quality)
        const sorted = [...raw.filter(r => !seen.has(`${r.id}:${r._mediaType || 'movie'}`))].sort((a, b) => {
          const s = x => (x.vote_average || 0) * 10 + (x.vote_count || 0) * 0.015 + (x.popularity || 0) * 0.08;
          return s(b) - s(a);
        });
        for (const r of sorted) {
          const k = `${r.id}:${r._mediaType || 'movie'}`;
          if (!seen.has(k)) { seen.add(k); results.push(r); }
        }

        results = results.filter(r => {
          const mt = r._mediaType || 'movie';
          const key = `${r.id}:${mt}`;
          // TV uses first_air_date / name; movies use release_date / title.
          const dateStr = mt === 'tv' ? (r.first_air_date || '') : (r.release_date || '');
          const year = parseInt(dateStr.slice(0, 4));
          return !excluded.has(key) && (r.vote_average || 0) >= 4.8 && r.poster_path
            && r.original_language === 'en' && !r.adult && !(r.genre_ids || []).includes(16)
            && (!year || year >= 1960);
        });

        const mapped = results.slice(0, append ? 200 : 350).map(r => {
          const mt = r._mediaType || 'movie';
          // Negative affinity: titles from directors the user has repeatedly disliked get
          // their boost pulled down. Subtracts from any positive boost they may also carry.
          let boost = r._affinityBoost || 0;
          let reason = r._affinityReason || null;
          if (_dislikedPenaltyIds.has(`${r.id}:${mt}`)) {
            boost -= 3.0;
            if (!reason) reason = null; // don't surface a "reason" for a penalised item
          }
          return {
            id: r.id, title: mt === 'tv' ? (r.name || r.title) : (r.title || r.name), _mediaType: mt,
            poster_path: r.poster_path, release_date: mt === 'tv' ? (r.first_air_date || r.release_date) : (r.release_date || r.first_air_date),
            vote_average: r.vote_average, vote_count: r.vote_count || 0,
            genre_ids: r.genre_ids || [], overview: r.overview || '', popularity: r.popularity || 0,
            _affinityReason: reason, _affinityBoost: boost
          };
        });
        currentRecPool = append ? currentRecPool.concat(mapped) : mapped;
        recPageCursor = startPage + pageCount;
        _recPoolLastRefreshed = new Date();
        if (typeof updateHomeSnapshot === 'function') updateHomeSnapshot();

        console.log('[Recs] Pool size:', currentRecPool.length);
        if (!currentRecPool.length) {
          if (grid) grid.innerHTML = `<div class="text-center py-8 text-zinc-400 text-sm col-span-full">No results loaded. Check your Worker password (\uD83D\uDD10 Pass) or connection.</div>`;
        } else {
          recomputeRecommendations();
        }
      } catch (e) {
        console.error('[Recs] Refresh pool failed:', e);
        let poolMsg = 'Failed to load recommendations. Check \uD83D\uDD10 Pass button or connection.';
        if (e.status === 401) poolMsg = 'Wrong password. Tap \uD83D\uDD10 Pass to reset it.';
        if (grid) grid.innerHTML = `<div class="text-center py-8 text-red-400 text-sm col-span-full">${poolMsg}</div>`;
      } finally {
        const loading = document.getElementById('recs-loading-more');
        if (loading) loading.remove();
        _recPoolLoading = false;
      }
    }

    async function loadMoreRecommendations() {
      await refreshRecPool({ append: true });
    }

    // Load a dedicated Found Footage pool. Found footage is a TMDB *keyword*, not a genre,
    // so the existing genre chips can't surface it — items in the normal pool don't carry
    // the tag. Instead we fetch films tagged with the found-footage keywords directly,
    // replace the rec pool with them, and reuse recomputeRecommendations() so they get
    // scored by the user's taste and rendered with all the normal card wiring.
    //
    // Keyword set verified against TMDB's actual keyword search (search/keyword?query=...):
    // 163053 found footage · 342857 found footage horror · 340385 found footage story ·
    // 345179 found footage mystery · 365923 found footage adjacent · 357207 foundfootage ·
    // 322394 horror mockumentary · 272745 screenlife · 376138 screenlife horror ·
    // 272686 screen life · 11665 handheld camera · 365784 faux documentary ·
    // 160517 fake documentary. Deliberately excludes plain "mockumentary"/"point of view" —
    // checked those too, but they're dominated by non-horror comedy/wildlife content that
    // would dilute this pool rather than expand it.
    //
    // The vote_count floor was the real limiter, not the keyword list: querying TMDB
    // directly showed this keyword set has ~4,000 movies total, but the old
    // vote_count.gte=50 floor cut that down to under 300 — found-footage is dominated by
    // low-budget/indie titles that naturally have few ratings. Lowered to vote_count.gte=8
    // (still filters out zero-vote noise) for the main pull, while keeping a separate
    // stricter vote_count.gte=200 pass so well-known, highly-rated titles still surface.
    let _foundFootageLoading = false;
    async function loadFoundFootage() {
      if (_foundFootageLoading) return;
      _foundFootageLoading = true;
      const grid = document.getElementById('recs-grid');
      const empty = document.getElementById('recs-empty');
      if (empty) empty.classList.add('hidden');
      if (grid) { grid.innerHTML = ''; showSkeletons('recs-grid', 8); }
      try {
        const kw = '163053|342857|340385|345179|365923|357207|322394|272745|376138|272686|11665|365784|160517';
        const base = `/api/tmdb/3/discover/movie?language=en-US&include_adult=false&with_keywords=${kw}&vote_count.gte=8&sort_by=popularity.desc`;
        const tvBase = `/api/tmdb/3/discover/tv?language=en-US&include_adult=false&with_keywords=${kw}&vote_count.gte=3&sort_by=popularity.desc`;
        const urls = [
          { url: `${base}&page=1`, type: 'movie' },
          { url: `${base}&page=2`, type: 'movie' },
          { url: `${base}&page=3`, type: 'movie' },
          { url: `${base}&page=4`, type: 'movie' },
          { url: `${base}&page=5`, type: 'movie' },
          { url: `${base}&sort_by=vote_average.desc&vote_count.gte=200&page=1`, type: 'movie' },
          { url: `${tvBase}&page=1`, type: 'tv' },
          { url: `${tvBase}&page=2`, type: 'tv' },
        ];
        // Fetch all pages in parallel instead of one-at-a-time — these are independent
        // requests, and awaiting them sequentially just adds up their latencies for no
        // reason (this alone used to make the button noticeably slower as page count grew).
        const results = await Promise.allSettled(urls.map(({ url }) => apiFetch(url)));
        let raw = [];
        results.forEach((res, i) => {
          if (res.status !== 'fulfilled') return;
          const { type } = urls[i];
          raw = raw.concat((res.value.results || []).map(r => ({ ...r, _mediaType: type })));
        });
        // Dedupe by id:mediaType, tag with a reason, drop animation + excluded items.
        const excluded = getExcludedKeys();
        const seen = new Set();
        const mapped = [];
        for (const r of raw) {
          const mt = r._mediaType || 'movie';
          const key = `${r.id}:${mt}`;
          if (seen.has(key) || excluded.has(key)) continue;
          if (!r.poster_path || (r.genre_ids || []).includes(16)) continue;
          seen.add(key);
          mapped.push({
            id: r.id, title: mt === 'tv' ? (r.name || r.title) : (r.title || r.name), _mediaType: mt,
            poster_path: r.poster_path, release_date: mt === 'tv' ? (r.first_air_date || '') : (r.release_date || ''),
            vote_average: r.vote_average, vote_count: r.vote_count || 0,
            genre_ids: r.genre_ids || [], overview: r.overview || '', popularity: r.popularity || 0,
            _affinityReason: '🎥 Found footage', _affinityBoost: 0
          });
        }
        if (!mapped.length) {
          if (grid) grid.innerHTML = `<div class="empty-state col-span-full"><span class="empty-state-icon">🎥</span><div class="text-zinc-300 font-medium">No found-footage titles loaded</div><div class="text-zinc-500 text-xs mt-1">Check the 🔐 Pass button or your connection.</div></div>`;
          return;
        }
        currentRecPool = mapped;
        _recPoolLastRefreshed = new Date();
        if (typeof updateHomeSnapshot === 'function') updateHomeSnapshot();
        recGenreFilter = null;      // found-footage pool spans many genres; don't pre-filter
        recMediaFilter = 'all';
        setRecMediaFilter('all');   // resets toggle styling + triggers recompute/render
        showToast(`Found footage: ${mapped.length} titles`);
      } catch (e) {
        if (grid) grid.innerHTML = `<div class="empty-state col-span-full"><span class="empty-state-icon">⚠️</span><div class="text-zinc-300 font-medium">Couldn't load found footage</div></div>`;
      } finally {
        _foundFootageLoading = false;
      }
    }

    function surpriseMe() {
      if (!currentRecPool.length) { showToast('Load a pool first'); return; }
      const profile = buildTasteProfile();
      const excluded = getExcludedKeys();
      // Find the user's top 3 genre IDs by positive score
      const topGenreIds = new Set(
        Object.entries(profile.genreScores)
          .filter(([, s]) => s > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([id]) => Number(id))
      );
      // Pick from movies/TV that don't share those top genres
      let outside = currentRecPool.filter(it => {
        if (excluded.has(`${it.id}:${it._mediaType || 'movie'}`)) return false;
        const gids = it.genre_ids || [];
        return !gids.some(g => topGenreIds.has(g));
      });
      if (outside.length < 5) {
        // Fallback: broaden to anything not in top genre
        outside = currentRecPool.filter(it => !excluded.has(`${it.id}:${it._mediaType || 'movie'}`));
      }
      // Shuffle and pick 20
      for (let i = outside.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [outside[i], outside[j]] = [outside[j], outside[i]];
      }
      const picks = outside.slice(0, 20).map(it => ({ ...it, _affinityReason: 'Outside your usual taste', _affinityBoost: 0 }));

      const grid = document.getElementById('recs-grid');
      if (!grid) return;
      const { genreScores, decadeCounts } = profile;
      function matchLabel(item) { return `🎲 Outside your usual taste`; }
      grid.innerHTML = '';
      picks.forEach(item => {
        const card = document.createElement('div');
        card.className = 'movie-card rec-card bg-zinc-900 border border-zinc-700 rounded-3xl flex flex-col';
        const poster = item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27120%27 height=%27180%27%3E%3Crect fill=%27%2327272a%27 width=%27120%27 height=%27180%27/%3E%3C/svg%27';
        const year = (item.release_date || '').slice(0,4);
        const tmdbRating = item.vote_average ? item.vote_average.toFixed(1) : null;
        const ratingBadgeClass = item.vote_average >= 7.5 ? 'high' : item.vote_average >= 6 ? '' : 'low';
        const rtSearchUrl = rtUrl(item.title || item.name, item._mediaType);
        const imdbSearchUrl = `https://www.imdb.com/find/?q=${encodeURIComponent(item.title + (year ? ' ' + year : ''))}&s=tt&ttype=ft`;
        const itemTitleSafe = escapeHtml(item.title || item.name || 'Untitled'); // for innerHTML string contexts only
        card.innerHTML = `
<div class="relative overflow-hidden rounded-2xl">
  <div class="swipe-overlay absolute inset-0 rounded-2xl flex items-center justify-center text-white font-bold text-lg opacity-0 pointer-events-none z-10" style="transition:opacity 0.12s;"></div>
  <img src="${poster}" class="w-full aspect-[2/3] object-cover" loading="lazy" alt="${itemTitleSafe} poster">
</div>
<div class="mt-2 px-0.5">
  <div class="font-semibold text-sm leading-tight line-clamp-2">${itemTitleSafe}</div>
  <div class="flex items-center gap-1 flex-wrap mt-1">
    ${year ? `<span class="text-[11px] text-zinc-500">${year}</span>` : ''}
    ${tmdbRating ? `<span class="rating-badge ${ratingBadgeClass}" style="font-size:10px;padding:2px 5px;"><i class="fa-solid fa-star" style="font-size:7px"></i> ${tmdbRating}</span>` : ''}
    <a id="imdb-si-${item.id}" href="${imdbSearchUrl}" target="_blank" rel="noopener" class="inline-flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded bg-[#f5c518] text-black font-bold no-underline"><i class="fa-brands fa-imdb" style="font-size:9px"></i></a>
    <a href="${rtSearchUrl}" target="_blank" rel="noopener" class="inline-flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded bg-[#fa320a] text-white font-bold no-underline">RT</a>
  </div>
  <button class="why-this-btn text-[10px] text-amber-400/80 mt-1.5 text-left w-full truncate hover:text-amber-300 transition-colors" title="Why this recommendation?">🎲 Outside your usual taste</button>
  <div id="wtw-si-${item.id}" class="mt-1"></div>
</div>
<div class="mt-2 flex gap-1 items-center" style="position:relative;">
  <button class="flex-1 min-w-0 text-[11px] px-2 py-1.5 rounded-2xl bg-emerald-700 hover:bg-emerald-600 text-white font-medium" data-act="towatch" aria-label="Add ${itemTitleSafe} to To Watch">+ Watch</button>
  <button class="text-[11px] px-2 py-1.5 rounded-2xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 font-medium" data-act="watched" aria-label="Mark ${itemTitleSafe} as watched">✓</button>
  <button class="text-sm px-2 py-1.5 rounded-2xl border border-zinc-700 text-zinc-400" data-act="more" title="More actions" aria-label="More actions for ${itemTitleSafe}" aria-haspopup="true" aria-expanded="false">⋯</button>
  <button id="trailer-si-${item.id}" class="text-[11px] px-2 py-1.5 rounded-2xl border border-zinc-700 text-zinc-500 hidden" data-act="trailer" title="Watch Trailer" aria-label="Play trailer for ${itemTitleSafe}">▶</button>
  <div class="hidden" data-act-menu role="menu" style="position:absolute;bottom:calc(100% + 6px);right:0;z-index:5;background:var(--card-bg,#18181b);border:1px solid var(--border,#3f3f46);border-radius:14px;padding:4px;min-width:160px;box-shadow:0 12px 24px rgba(0,0,0,0.35);">
    <button class="w-full text-left text-sm px-3 py-2 rounded-xl text-red-400 hover:bg-zinc-800" data-act="dislike" role="menuitem" aria-label="Dislike ${itemTitleSafe}">👎 Dislike</button>
    <button class="w-full text-left text-xs px-3 py-2 rounded-xl text-zinc-400 hover:bg-zinc-800" data-act="notinterested" role="menuitem" aria-label="Hide ${itemTitleSafe} — not interested">✕ Not Interested</button>
  </div>
</div>`;
        card.querySelector('[data-act="towatch"]').onclick = () => { addToToWatch(item); card.remove(); };
        card.querySelector('[data-act="watched"]').onclick = () => {
          openInlineRatingPrompt(card, item, r => { addToWatched(item, r); card.remove(); },
            { hideButtons: Array.from(card.querySelectorAll('[data-act]')) });
        };
        card.querySelector('[data-act="dislike"]').onclick = () => { addToDisliked(item); card.remove(); };
        card.querySelector('[data-act="notinterested"]').onclick = () => { addToNotInterested(item); card.remove(); };
        wireMoreMenu(card);
        const _mt = item._mediaType === 'tv' ? 'tv' : 'movie';
        card.querySelector('[data-act="trailer"]').onclick = async () => {
          const vdata = await apiFetch(`/api/tmdb/3/${_mt}/${item.id}/videos`).catch(() => null);
          const t = (vdata?.results || []).find(v => v.site === 'YouTube' && v.type === 'Trailer') || (vdata?.results || []).find(v => v.site === 'YouTube');
          if (t) window.open(`https://www.youtube.com/watch?v=${t.key}`, '_blank', 'noopener');
        };
        apiFetch(`/api/tmdb/3/${_mt}/${item.id}/videos`).then(vdata => {
          const t = (vdata?.results || []).find(v => v.site === 'YouTube' && v.type === 'Trailer') || (vdata?.results || []).find(v => v.site === 'YouTube');
          if (t) { const b = card.querySelector('[data-act="trailer"]'); if (b) { b.classList.remove('hidden', 'text-zinc-500'); b.classList.add('text-red-400'); } }
        }).catch(() => {});
        // wire why-this-btn
        const whyBtn = card.querySelector('.why-this-btn');
        if (whyBtn) {
          whyBtn.addEventListener('click', e => {
            e.stopPropagation();
            document.querySelectorAll('.why-this-pop').forEach(p => p.remove());
            const gNames = (item.genre_ids || []).map(id => GENRES.find(g => g.id === id)?.name).filter(Boolean);
            const pop = document.createElement('div');
            pop.className = 'why-this-pop';
            pop.innerHTML = `
              <div style="color:#e4e4e7;font-weight:600;margin-bottom:6px;">${escapeHtml(item._affinityReason || '🎲 Outside your usual taste')}</div>
              ${gNames.length ? `<div style="color:#71717a;font-size:11px;">Genres: ${escapeHtml(gNames.join(', '))}</div>` : ''}
              ${item.vote_average ? `<div style="color:#71717a;font-size:11px;margin-top:3px;">TMDB ${item.vote_average.toFixed(1)} / 10</div>` : ''}
              ${item.vote_count ? `<div style="color:#52525b;font-size:10px;margin-top:2px;">${item.vote_count.toLocaleString()} votes</div>` : ''}
            `;
            document.body.appendChild(pop);
            const rect = e.target.getBoundingClientRect();
            const pw = 230;
            pop.style.left = Math.min(rect.left, window.innerWidth - pw - 8) + 'px';
            pop.style.top = (rect.bottom + 6) + 'px';
            setTimeout(() => document.addEventListener('click', () => { document.querySelectorAll('.why-this-pop').forEach(p => p.remove()); }, { once: true }), 10);
          });
        }
        // swipe gesture
        addSwipeGesture(card, item);
        enhanceCard(card, item);
        grid.appendChild(card);
      });
      showToast('🎲 Surprise picks — outside your usual genres');
    }

    function recomputeRecommendations() {
      const grid = document.getElementById('recs-grid');
      const empty = document.getElementById('recs-empty');
      if (!grid) return;

      if (!currentRecPool.length) {
        grid.innerHTML = '';
        if (empty) {
          empty.classList.remove('hidden');
          // Only auto-trigger once — the _recPoolLoading guard prevents loops
          if (!_recPoolLoading) {
            empty.innerHTML = `<span class="empty-state-icon">🎬</span><div class="text-zinc-300 font-medium">Loading recommendations...</div><div class="text-zinc-500 text-xs mt-1">Fetching a wider dark cinema pool.</div>`;
            refreshRecPool();
          }
        }
        return;
      }
      if (empty) empty.classList.add('hidden');

      renderRecGenreChips();

      const profile = buildTasteProfile();
      const excluded = getExcludedKeys();
      // Pool-relative thresholds (hidden-gem / vote-count reliability), computed once
      // per recompute rather than per item, then reused for every score in this pass.
      const poolStats = computePoolStats(currentRecPool);
      // Score every item in the pool
      let scored = currentRecPool.map(it => ({...it, _score: scoreItem(it, profile, poolStats)}));
      // Filter out already seen/queued/hidden
      scored = scored.filter(it => !excluded.has(`${it.id}:${it._mediaType || 'movie'}`));
      // Genre filter
      if (recGenreFilter !== null) {
        scored = scored.filter(it => (it.genre_ids || []).includes(recGenreFilter));
      }
      // Media-type filter (All / Movies / TV) using each item's _mediaType tag
      if (recMediaFilter !== 'all') {
        scored = scored.filter(it => (it._mediaType || 'movie') === recMediaFilter);
      }
      if (!scored.length) {
        const mediaHint = recMediaFilter === 'tv' ? 'No TV shows in the current pool. ' : recMediaFilter === 'movie' ? 'No movies in the current pool. ' : '';
        grid.innerHTML = `<div class="empty-state col-span-full">
          <span class="empty-state-icon">🎬</span>
          <div class="text-zinc-300 font-medium">This pool is tapped out</div>
          <div class="text-zinc-500 text-xs mt-1">${mediaHint}Use More Recs to search deeper pages and less obvious titles.</div>
        </div>`;
        return;
      }
      scored.sort((a, b) => b._score - a._score);
      // Diversity pass: interleave genres so the top 40 isn't all one genre
      const display = recGenreFilter !== null ? scored.slice(0, 40) : diversify(scored, 40);

      // Build a label explaining why each card matched
      const { genreScores, decadeCounts, totalPos, totalDecade, genrePairScores, totalPairPos } = profile;
      // Mirrors scoreItem's genre-combo bonus exactly: only surfaces a pairing when
      // that SPECIFIC combination (not just each genre alone) has a positive score
      // in the user's taste profile — same genrePairScores lookup scoreItem uses.
      function bestGenrePair(gids) {
        if (!gids || gids.length < 2 || !genrePairScores || !totalPairPos) return null;
        let best = null, bestScore = 0;
        for (let i = 0; i < gids.length; i++) {
          for (let j = i + 1; j < gids.length; j++) {
            const key = gids[i] < gids[j] ? `${gids[i]},${gids[j]}` : `${gids[j]},${gids[i]}`;
            const pairScore = genrePairScores[key];
            if (pairScore > 0 && pairScore > bestScore) { bestScore = pairScore; best = [gids[i], gids[j]]; }
          }
        }
        if (!best) return null;
        const n1 = GENRES.find(g => g.id === best[0])?.name;
        const n2 = GENRES.find(g => g.id === best[1])?.name;
        return (n1 && n2) ? `${n1} + ${n2}` : null;
      }
      function matchLabel(item) {
        const gids = item.genre_ids || [];
        const topGenreId = gids.find(g => (genreScores[g] || 0) > 0);
        const topGenreName = topGenreId ? GENRES.find(g => g.id === topGenreId)?.name : null;
        const year = parseInt((item.release_date || '').slice(0, 4));
        const decade = year ? Math.floor(year / 10) * 10 : null;
        const decadeFits = decade && decadeCounts[decade] > 0;
        const comboNames = bestGenrePair(gids);
        const isHiddenGem = (item.vote_average || 0) >= poolStats.gemVoteAvgMin && (item.popularity || 0) < poolStats.gemPopularityMax && (item.vote_count || 0) >= poolStats.gemVoteCountMin;
        // Affinity labels take priority — they're the most specific signal
        if (item._affinityReason) {
          return isHiddenGem ? `💎 ${item._affinityReason}` : `🎬 ${item._affinityReason}`;
        }
        if (isHiddenGem && topGenreName) return `💎 Hidden gem · ${topGenreName}`;
        if (isHiddenGem) return `💎 Quality hidden gem`;
        if (comboNames) return `✨ ${comboNames} combo you love`;
        if (topGenreName && decadeFits) return `✨ ${topGenreName} · ${decade}s`;
        if (topGenreName) return `✨ Matches your ${topGenreName} taste`;
        if (decadeFits) return `✨ Fits your ${decade}s preference`;
        return `✨ Picked for your taste profile`;
      }

      grid.innerHTML = '';
      display.forEach(item => {
        const card = document.createElement('div');
        card.className = 'movie-card rec-card bg-zinc-900 border border-zinc-700 rounded-3xl flex flex-col';
        const poster = item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27120%27 height=%27180%27%3E%3Crect fill=%27%2327272a%27 width=%27120%27 height=%27180%27/%3E%3C/svg%27';
        const year = (item.release_date || '').slice(0,4);
        const tmdbRating = item.vote_average ? item.vote_average.toFixed(1) : null;
        const ratingBadgeClass = item.vote_average >= 7.5 ? 'high' : item.vote_average >= 6 ? '' : 'low';
        const rtSearchUrl = rtUrl(item.title || item.name, item._mediaType);
        const imdbSearchUrl = `https://www.imdb.com/find/?q=${encodeURIComponent(item.title + (year ? ' ' + year : ''))}&s=tt&ttype=ft`;
        const itemTitleSafe = escapeHtml(item.title || item.name || 'Untitled'); // for innerHTML string contexts only
        card.innerHTML = `
<div class="relative overflow-hidden rounded-2xl">
  <div class="swipe-overlay absolute inset-0 rounded-2xl flex items-center justify-center text-white font-bold text-lg opacity-0 pointer-events-none z-10" style="transition:opacity 0.12s;"></div>
  <img src="${poster}" class="w-full aspect-[2/3] object-cover" loading="lazy" alt="${itemTitleSafe} poster">
</div>
<div class="mt-2 px-0.5">
  <div class="font-semibold text-sm leading-tight line-clamp-2">${itemTitleSafe}</div>
  <div class="flex items-center gap-1 flex-wrap mt-1">
    ${year ? `<span class="text-[11px] text-zinc-500">${year}</span>` : ''}
    ${tmdbRating ? `<span class="rating-badge ${ratingBadgeClass}" style="font-size:10px;padding:2px 5px;"><i class="fa-solid fa-star" style="font-size:7px"></i> ${tmdbRating}</span>` : ''}
    <a id="imdb-link-${item.id}" href="${imdbSearchUrl}" target="_blank" rel="noopener" class="inline-flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded bg-[#f5c518] text-black font-bold no-underline"><i class="fa-brands fa-imdb" style="font-size:9px"></i></a>
    <a href="${rtSearchUrl}" target="_blank" rel="noopener" class="inline-flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded bg-[#fa320a] text-white font-bold no-underline">RT</a>
  </div>
  <button class="why-this-btn text-[10px] text-emerald-400/80 mt-1.5 text-left w-full truncate hover:text-emerald-300 transition-colors" title="Why this recommendation?">${escapeHtml(matchLabel(item))}</button>
  <div id="wtw-rec-${item.id}" class="mt-1"></div>
</div>
<div class="mt-2 flex gap-1 items-center" style="position:relative;">
  <button class="flex-1 min-w-0 text-[11px] px-2 py-1.5 rounded-2xl bg-emerald-700 hover:bg-emerald-600 text-white font-medium" data-act="towatch" aria-label="Add ${itemTitleSafe} to To Watch">+ Watch</button>
  <button class="text-[11px] px-2 py-1.5 rounded-2xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 font-medium" data-act="watched" aria-label="Mark ${itemTitleSafe} as watched">✓</button>
  <button class="text-sm px-2 py-1.5 rounded-2xl border border-zinc-700 text-zinc-400" data-act="more" title="More actions" aria-label="More actions for ${itemTitleSafe}" aria-haspopup="true" aria-expanded="false">⋯</button>
  <button id="trailer-btn-${item.id}" class="text-[11px] px-2 py-1.5 rounded-2xl border border-zinc-700 text-zinc-500 hidden" data-act="trailer" title="Watch Trailer" aria-label="Play trailer for ${itemTitleSafe}">▶</button>
  <div class="hidden" data-act-menu role="menu" style="position:absolute;bottom:calc(100% + 6px);right:0;z-index:5;background:var(--card-bg,#18181b);border:1px solid var(--border,#3f3f46);border-radius:14px;padding:4px;min-width:160px;box-shadow:0 12px 24px rgba(0,0,0,0.35);">
    <button class="w-full text-left text-sm px-3 py-2 rounded-xl text-red-400 hover:bg-zinc-800" data-act="dislike" role="menuitem" aria-label="Dislike ${itemTitleSafe}">👎 Dislike</button>
    <button class="w-full text-left text-xs px-3 py-2 rounded-xl text-zinc-400 hover:bg-zinc-800" data-act="notinterested" role="menuitem" aria-label="Hide ${itemTitleSafe} — not interested">✕ Not Interested</button>
  </div>
</div>
        `;
        // Async: upgrade IMDB link + fetch trailer
        const _mt2 = item._mediaType === 'tv' ? 'tv' : 'movie';
        apiFetch(`/api/tmdb/3/${_mt2}/${item.id}/external_ids`).then(ext => {
          if (ext && ext.imdb_id) {
            const lnk = card.querySelector(`#imdb-link-${item.id}`);
            if (lnk) {
              lnk.href = `https://www.imdb.com/title/${ext.imdb_id}/`;
              lnk.title = ext.imdb_id;
            }
          }
        }).catch(() => {});
        apiFetch(`/api/tmdb/3/${_mt2}/${item.id}/videos`).then(vdata => {
          const trailer = (vdata?.results || []).find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
                          (vdata?.results || []).find(v => v.site === 'YouTube');
          if (trailer) {
            const btn = card.querySelector(`#trailer-btn-${item.id}`);
            if (btn) {
              btn.classList.remove('hidden');
              btn.classList.add('text-red-400');
              btn.classList.remove('text-zinc-500');
            }
          }
        }).catch(() => {});
        // wire actions
        card.querySelector('[data-act="towatch"]').onclick = () => { addToToWatch(item); card.remove(); };
        card.querySelector('[data-act="watched"]').onclick = () => {
          const actions = card.querySelector('.mt-2') || card.querySelector('[data-act="watched"]').parentElement;
          openInlineRatingPrompt(card, item, r => {
            addToWatched(item, r);
            card.remove();
          }, { hideButtons: actions ? Array.from(actions.querySelectorAll('button')) : [] });
        };
        card.querySelector('[data-act="dislike"]').onclick = () => { addToDisliked(item); card.remove(); };
        card.querySelector('[data-act="notinterested"]').onclick = () => { addToNotInterested(item); card.remove(); };
        wireMoreMenu(card);
        card.querySelector('[data-act="trailer"]').onclick = async () => {
          const vdata = await apiFetch(`/api/tmdb/3/${_mt2}/${item.id}/videos`).catch(() => null);
          const trailer = (vdata?.results || []).find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
                          (vdata?.results || []).find(v => v.site === 'YouTube');
          if (trailer) window.open(`https://www.youtube.com/watch?v=${trailer.key}`, '_blank', 'noopener');
        };
        // wire why-this-btn
        const whyBtn = card.querySelector('.why-this-btn');
        if (whyBtn) {
          whyBtn.addEventListener('click', e => {
            e.stopPropagation();
            document.querySelectorAll('.why-this-pop').forEach(p => p.remove());
            const gNames = (item.genre_ids || []).map(id => GENRES.find(g => g.id === id)?.name).filter(Boolean);
            // Same decade/combo facts matchLabel uses for the button text, shown here
            // as their own detail lines — previously this popover just repeated
            // _affinityReason (or a generic fallback) and never surfaced the
            // decade-fit or genre-combo reasoning scoreItem actually used to rank it.
            const year = parseInt((item.release_date || '').slice(0, 4));
            const decade = year ? Math.floor(year / 10) * 10 : null;
            const decadeFits = decade && decadeCounts[decade] > 0;
            const comboNames = bestGenrePair(item.genre_ids || []);
            const pop = document.createElement('div');
            pop.className = 'why-this-pop';
            pop.innerHTML = `
              <div style="color:#e4e4e7;font-weight:600;margin-bottom:6px;">${escapeHtml(matchLabel(item))}</div>
              ${gNames.length ? `<div style="color:#71717a;font-size:11px;">Genres: ${escapeHtml(gNames.join(', '))}</div>` : ''}
              ${comboNames ? `<div style="color:#a78bfa;font-size:11px;margin-top:2px;">Combo match: ${escapeHtml(comboNames)}</div>` : ''}
              ${decadeFits ? `<div style="color:#71717a;font-size:11px;margin-top:2px;">Fits your ${decade}s taste</div>` : ''}
              ${item.vote_average ? `<div style="color:#71717a;font-size:11px;margin-top:3px;">TMDB ${item.vote_average.toFixed(1)} / 10</div>` : ''}
              ${item.vote_count ? `<div style="color:#52525b;font-size:10px;margin-top:2px;">${item.vote_count.toLocaleString()} votes</div>` : ''}
            `;
            document.body.appendChild(pop);
            const rect = e.target.getBoundingClientRect();
            const pw = 230;
            pop.style.left = Math.min(rect.left, window.innerWidth - pw - 8) + 'px';
            pop.style.top = (rect.bottom + 6) + 'px';
            setTimeout(() => document.addEventListener('click', () => { document.querySelectorAll('.why-this-pop').forEach(p => p.remove()); }, { once: true }), 10);
          });
        }
        // swipe gesture
        addSwipeGesture(card, item);

        // Make the whole rec card (including thumbnail) clickable for the rich detail bio modal,
        // just like search/discover results. Buttons are protected by the guard inside enhanceCard.
        enhanceCard(card, item);

        grid.appendChild(card);
      });
    }

