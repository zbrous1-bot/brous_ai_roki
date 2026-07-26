    // ===================== HORROR ROKI RECS + TASTE =====================

    // Shared placeholder for missing/failed poster art (also used as the onerror
    // fallback below, so a broken TMDB image URL doesn't show as a broken-image icon).
    const FALLBACK_POSTER = 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27120%27 height=%27180%27%3E%3Crect fill=%27%2327272a%27 width=%27120%27 height=%27180%27/%3E%3C/svg%27';

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

    // Rich taste profile used by the scoring engine.
    //
    // `lists` defaults to the active profile's in-memory library, which is every caller
    // except Together mode — that one passes the OTHER person's lists (read out of their
    // local namespace by readProfileLists in profiles.js) to build a second, independent
    // profile so candidates can be scored against both at once. Nothing here reads
    // anything but the two lists, which is what makes that possible.
    function buildTasteProfile(lists) {
      const { watched, disliked } = lists || { watched: watchedList, disliked: dislikedList };
      const watchedSource = watched || [];
      const dislikedSource = disliked || [];
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
      watchedSource.forEach((m, index) => {
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
      dislikedSource.forEach(m => {
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

    // ---- Together mode scoring ----
    // Assemble everything needed to score against the other person: their taste profile,
    // built from the read-only mirror of their library, and the set of titles they've
    // already seen or rejected. Returns null if there's no other profile or no data for
    // them, so the caller silently falls back to normal single-profile recs.
    function buildTogetherContext() {
      if (typeof otherProfileId !== 'function') return null;
      const otherId = otherProfileId();
      if (!otherId) return null;
      const lists = readProfileLists(otherId);
      if (!lists.watched.length && !lists.disliked.length) return null;
      const excluded = new Set();
      [...lists.watched, ...lists.toWatch, ...lists.disliked, ...lists.notInterested]
        .forEach(it => excluded.add(`${it.id}:${it._mediaType || 'movie'}`));
      return {
        name: getProfile(otherId).name,
        profile: buildTasteProfile({ watched: lists.watched, disliked: lists.disliked }),
        excluded,
      };
    }

    // Combine two individual scores into one joint score.
    //
    // Weighted toward the MINIMUM rather than the average on purpose. Averaging optimises
    // for "one of you will love this", which is how you end up with a queue full of films
    // one person tolerates — the failure mode of picking something for two people is a
    // veto, not a lack of enthusiasm. Leaning on the min favours titles neither of you
    // would turn down, while the smaller mean term still breaks ties toward the pick you
    // are both actually excited about rather than the blandest mutually-acceptable one.
    function jointScore(a, b) {
      return 0.65 * Math.min(a, b) + 0.35 * ((a + b) / 2);
    }

    // Explain a joint pick in the card's match label. The gap between the two scores is
    // the interesting part: a small gap means genuine common ground, a large one means
    // it's really one person's pick that the other can live with — worth saying plainly
    // rather than presenting both cases as an equally good joint recommendation.
    function togetherLabel(mine, theirs, otherName) {
      const gap = Math.abs(mine - theirs);
      const low = Math.min(mine, theirs);
      if (gap <= 1.5 && low > 0) return `👥 Solid common ground`;
      if (gap <= 1.5) return `👥 Equally new territory for you both`;
      return mine > theirs ? `👥 Your pick — ${otherName} should be fine with it`
                           : `👥 ${otherName}'s pick — you should be fine with it`;
    }

    // Bayesian-corrected rating — penalises titles with few votes.
    //
    // Pools TMDB and IMDb votes as one body of evidence rather than averaging two separate
    // scores. IMDb carries 40-60x more votes per title (measured on the live pools: median
    // 4,326 TMDB against 274,742 IMDb on the main pool, 205 against 9,730 on Cosmic Horror),
    // so it naturally dominates wherever it has data, which is the point — TMDB alone can't
    // tell an obscure title from one it simply has no data on. Where IMDb is missing
    // (imdbVotes 0) this degrades exactly to the old TMDB-only behaviour.
    //
    // `prior` is the pool's own 25th-percentile rating, not a fixed constant, and that
    // detail is the whole ballgame. A Bayesian prior is a magnet, not a penalty: it pulls
    // thin-evidence titles toward itself. A prior ABOVE the pool's centre therefore
    // promotes junk instead of demoting it. Fixed priors were tested against both pools
    // and fail in opposite directions — the pools' means are 7.69 (main) and 5.99 (Cosmic
    // Horror), so any constant sits above one of them. p25 is below the centre of whatever
    // pool it's computed from, so it always acts as a penalty. See computePoolStats.
    //
    // m=1000 rather than the old 800: with IMDb's vote counts in play, 400 was low enough
    // to let a 11,580-vote stand-up special into the main pool's top 20. Verified at 1000
    // the least-evidenced title in the top 20 is 49,282 votes (main) and 9,730 (Cosmic).
    function bayesianRating(voteAvg, voteCount, imdbRating, imdbVotes, prior) {
      const C = (typeof prior === 'number' && isFinite(prior)) ? prior : 6.5;
      const m = 1000;
      const iv = imdbVotes || 0;
      const ia = iv > 0 ? (imdbRating || 0) : 0;
      return (voteCount * voteAvg + iv * ia + m * C) / (voteCount + iv + m);
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
        // qualityPrior falls back to the 6.5 global mean bayesianRating used before this
        // was pool-relative — with no pool there's no distribution to derive it from.
        return { gemVoteAvgMin: 7.2, gemPopularityMax: 60, gemVoteCountMin: 500, lowVoteCount: 150, midVoteCount: 400, qualityPrior: 6.5 };
      }
      const voteAvgs = pool.map(p => p.vote_average || 0).sort((a, b) => a - b);
      const popularities = pool.map(p => p.popularity || 0).sort((a, b) => a - b);
      const voteCounts = pool.map(p => p.vote_count || 0).sort((a, b) => a - b);
      return {
        gemVoteAvgMin: Math.max(6.5, percentile(voteAvgs, 0.75)),     // top quartile rating in this pool
        gemPopularityMax: Math.max(20, percentile(popularities, 0.5)), // below-median popularity = "didn't blow up"
        gemVoteCountMin: Math.max(200, percentile(voteCounts, 0.25)),  // still enough votes to trust the rating
        lowVoteCount: Math.max(50, percentile(voteCounts, 0.15)),
        midVoteCount: Math.max(150, percentile(voteCounts, 0.35)),
        // Prior for bayesianRating. Must sit BELOW this pool's centre or it promotes
        // thin-evidence titles instead of demoting them (see the comment there). Measured
        // p25 is 7.31 on the main pool and 5.21 on Cosmic Horror — no constant could serve
        // both, which is why this is derived per pool like the thresholds above.
        qualityPrior: percentile(voteAvgs, 0.25)
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
      let score = bayesianRating(voteAvg, voteCount, item.imdb_rating, item.imdb_votes, stats.qualityPrior) * recTune.qualityBaseline;

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

    // Found Footage and Cosmic Horror are keyword searches (TMDB has no such genres), not
    // real genre ids, so they can't be filtered client-side out of the normal pool the way
    // a genre chip filters currentRecPool by genre_ids — each needs its own fetched pool
    // (see loadFoundFootage / loadCosmicHorror below). They're presented as genre-style
    // chips (see renderTasteDropdownGenres in library.js) that swap the whole pool in/out
    // instead of filtering the existing one. _keywordPoolSnapshot remembers what was
    // showing before one was turned on, so turning it back off restores it instantly.
    //
    // Only one can be active at a time: each replaces currentRecPool outright, so there's
    // no state in which both are meaningfully "on".
    const KEYWORD_POOLS = {
      ff:     { label: 'Found Footage', chip: '🎥 Found Footage', load: () => loadFoundFootage() },
      cosmic: { label: 'Cosmic Horror', chip: '🐙 Cosmic Horror', load: () => loadCosmicHorror() },
    };

    let keywordPoolActive = null;   // null | 'ff' | 'cosmic'
    let _keywordPoolSnapshot = null; // { pool, mediaFilter } or null

    // Toggle a keyword pool on/off — mirrors clicking a genre chip, but swaps in/out a
    // dedicated keyword-fetched pool instead of filtering the current one.
    function toggleKeywordPool(key) {
      if (keywordPoolActive === key) { exitKeywordPoolMode(); return; }
      // Only snapshot when coming from the normal recs. Switching straight from one keyword
      // pool to the other must keep the original snapshot, or turning the second one off
      // would "restore" the first keyword pool instead of the user's actual recommendations.
      if (!keywordPoolActive) _keywordPoolSnapshot = { pool: currentRecPool, mediaFilter: recMediaFilter };
      keywordPoolActive = key;
      recGenreFilter = null;
      KEYWORD_POOLS[key].load();
    }

    // Restore whatever pool/media-filter was active before a keyword pool was turned on.
    // Called both when a keyword chip is toggled off directly and when a real genre chip is
    // picked while one is active (see library.js).
    function exitKeywordPoolMode() {
      if (!keywordPoolActive) return;
      keywordPoolActive = null;
      if (_keywordPoolSnapshot) {
        currentRecPool = _keywordPoolSnapshot.pool;
        const restoreMediaFilter = _keywordPoolSnapshot.mediaFilter;
        _keywordPoolSnapshot = null;
        setRecMediaFilter(restoreMediaFilter); // restores toggle styling + recomputes
      }
    }

    // Keep the inline "Genre: X ▾" button label in sync with the dropdown's selection.
    function updateRecGenreLabel() {
      const el = document.getElementById('rec-genre-filter-label');
      if (!el) return;
      if (keywordPoolActive) { el.textContent = 'Genre: ' + KEYWORD_POOLS[keywordPoolActive].label; return; }
      if (recGenreFilter === null) { el.textContent = 'Genre: All'; return; }
      const g = (typeof GENRES !== 'undefined') ? GENRES.find(x => x.id === recGenreFilter) : null;
      el.textContent = 'Genre: ' + (g ? g.name : '…');
    }

    function setRecMediaFilter(val) {
      recMediaFilter = val;
      // Update the toggle buttons' active styling — shares the same filter-chip /
      // type-toggle-active classes as the Browse tab's Movies/TV toggle so both
      // read as the same control instead of two different-looking widgets.
      ['all', 'movie', 'tv'].forEach(v => {
        const b = document.getElementById('rec-media-' + v);
        if (b) {
          const active = v === val;
          b.className = `text-xs px-3 py-1.5 rounded-full border transition-all ${active ? 'type-toggle-active' : 'filter-chip'}`;
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
      allBtn.className = `text-xs px-3 py-1.5 rounded-full border transition-colors ${(!keywordPoolActive && recGenreFilter === null) ? 'bg-red-700 border-red-600 text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:border-zinc-500'}`;
      allBtn.onclick = () => { exitKeywordPoolMode(); recGenreFilter = null; collapseRecsGenreFilter(); renderRecGenreChips(); recomputeRecommendations(); };
      wrap.innerHTML = '';
      wrap.appendChild(allBtn);

      available.forEach(g => {
        const btn = document.createElement('button');
        btn.textContent = g.name;
        btn.className = `text-xs px-3 py-1.5 rounded-full border transition-colors ${(!keywordPoolActive && recGenreFilter === g.id) ? 'bg-red-700 border-red-600 text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:border-zinc-500'}`;
        btn.onclick = () => { exitKeywordPoolMode(); recGenreFilter = recGenreFilter === g.id ? null : g.id; collapseRecsGenreFilter(); renderRecGenreChips(); recomputeRecommendations(); };
        wrap.appendChild(btn);
      });

      // Keyword pools (see toggleKeywordPool) — presented as genre-style chips alongside the
      // real genres above. Unlike those, they're always offered: they're fetched on demand
      // rather than derived from what happens to be in the current pool.
      Object.entries(KEYWORD_POOLS).forEach(([key, pool]) => {
        const btn = document.createElement('button');
        btn.textContent = pool.chip;
        btn.className = `text-xs px-3 py-1.5 rounded-full border transition-colors ${keywordPoolActive === key ? 'bg-red-700 border-red-600 text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:border-zinc-500'}`;
        btn.onclick = () => { collapseRecsGenreFilter(); toggleKeywordPool(key); };
        wrap.appendChild(btn);
      });

      // Update the collapsed-header label to show the active genre
      const label = document.getElementById('recs-filter-current');
      if (label) {
        const active = GENRES.find(g => g.id === recGenreFilter);
        label.textContent = keywordPoolActive ? KEYWORD_POOLS[keywordPoolActive].label : (active ? active.name : 'All');
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

      // A full rebuild replaces currentRecPool outright, so a stale keyword-pool snapshot
      // (see toggleKeywordPool) would no longer have anything sensible to restore later —
      // drop it rather than let the chip lie about being active.
      if (keywordPoolActive) { keywordPoolActive = null; _keywordPoolSnapshot = null; }

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
                  const base2 = `/api/tmdb/3/discover/movie?with_crew=${id}&with_origin_country=US&sort_by=vote_average.desc&vote_count.gte=200`;
                  affinityUrls.push({ url: `${base2}&page=1`, reason: `Directed by ${p.name}`, boost: 2.0 });
                  affinityUrls.push({ url: `${base2}&page=2`, reason: `Directed by ${p.name}`, boost: 2.0 });
                });
              Object.entries(personScores)
                .filter(([, p]) => p.type === 'actor' && p.score >= 1.5)
                .sort((a, b) => b[1].score - a[1].score).slice(0, 3)
                .forEach(([id, p]) => {
                  affinityUrls.push({ url: `/api/tmdb/3/discover/movie?with_cast=${id}&with_origin_country=US&sort_by=vote_average.desc&vote_count.gte=200&page=1`, reason: `Stars ${p.name}`, boost: 1.2 });
                });
              if (topKeywordIds.length) {
                const kwStr = topKeywordIds.slice(0, 5).join('|');
                affinityUrls.push({ url: `/api/tmdb/3/discover/movie?with_keywords=${kwStr}&with_origin_country=US&sort_by=vote_average.desc&vote_count.gte=200&page=1`, reason: `Matches your themes`, boost: 0.8 });
                affinityUrls.push({ url: `/api/tmdb/3/discover/movie?with_keywords=${kwStr}&with_origin_country=US&sort_by=vote_average.desc&vote_count.gte=200&page=2`, reason: `Matches your themes`, boost: 0.8 });
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
                  tvAffinityUrls.push({ url: `/api/tmdb/3/discover/tv?with_cast=${id}&with_origin_country=US&sort_by=vote_average.desc&vote_count.gte=100&page=1`, reason: `Stars ${p.name}`, boost: 1.2 });
                });
              if (topTvKeywordIds.length) {
                const kwStr = topTvKeywordIds.slice(0, 5).join('|');
                tvAffinityUrls.push({ url: `/api/tmdb/3/discover/tv?with_keywords=${kwStr}&with_origin_country=US&sort_by=vote_average.desc&vote_count.gte=100&page=1`, reason: `Matches your themes`, boost: 0.8 });
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
        // without_genres carries the same exclusions as REC_POOL_EXCLUDED_GENRES
        // (js/ui-helpers.js) so the non-narrative titles never get fetched in the first
        // place. The client-side gate below still has to exist — /movie/popular,
        // /movie/top_rated and /trending take no genre filter — but filtering here means
        // the Discover pages spend their 20 slots on titles that can actually be used.
        const MOVIE_EXCL = [...REC_POOL_EXCLUDED_GENRES.movie].join(',');
        const TV_EXCL = [...REC_POOL_EXCLUDED_GENRES.tv].join(',');
        const base = `/api/tmdb/3/discover/movie?language=en-US&include_adult=false&with_original_language=en&with_origin_country=US&without_genres=${MOVIE_EXCL}&primary_release_date.gte=1960-01-01&vote_count.gte=100&vote_average.gte=5.5`;
        const tvBase = `/api/tmdb/3/discover/tv?language=en-US&include_adult=false&with_original_language=en&with_origin_country=US&without_genres=${TV_EXCL}&first_air_date.gte=1960-01-01&vote_count.gte=100&vote_average.gte=5.5`;
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
        // Dedicated horror pass. The broad pool above skews toward whatever's popular
        // across ALL genres, so horror is naturally a thin slice of it — once a user's
        // watched/excluded list grows, filtering the feed down to Horror runs dry fast.
        // Pull a much deeper, lower-vote-floor horror-specific slice (indie/lesser-known
        // horror carries far fewer votes than mainstream genres, same reasoning as the
        // Found Footage pool's quality pass below) so Horror always has a real pool to
        // draw from instead of whatever scraps survive the generic discover queries.
        const horrorBase = `/api/tmdb/3/discover/movie?language=en-US&include_adult=false&with_original_language=en&with_origin_country=US&with_genres=27&without_genres=${MOVIE_EXCL}&vote_count.gte=25&vote_average.gte=4.3`;
        for (let i = 0; i < 8; i++) {
          const page = Math.min(startPage + i, 480);
          urls.push({ url: `${horrorBase}&sort_by=popularity.desc&page=${page}`, type: 'movie' });
          urls.push({ url: `${horrorBase}&sort_by=vote_average.desc&page=${page}`, type: 'movie' });
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
          // Horror carries a lower vote-average floor than the rest of the pool — the
          // dedicated horror pass above already gates on vote_count.gte=25, and indie
          // horror naturally scores lower than mainstream genres, so holding it to the
          // generic 4.8 floor would throw away most of what that pass just pulled in.
          const isHorror = (r.genre_ids || []).includes(27);
          const ratingFloor = isHorror ? 4.0 : 4.8;
          // TV list objects always carry origin_country, so it's checked directly here;
          // movie list objects don't (confirmed against the live API — only movie
          // *details* responses include it), so movies rely on with_origin_country=US
          // already applied at each discover URL above instead of a client-side check.
          const isAmerican = mt !== 'tv' || (r.origin_country || []).includes('US');
          // isRecPoolEligible (js/ui-helpers.js) replaces the old inline `includes(16)`
          // check and widens it to the other non-narrative genres. It has to run here and
          // not only via without_genres above because /movie/popular, /movie/top_rated,
          // /trending and the similar/recommendations calls aren't Discover endpoints and
          // accept no genre filter — those were the route most of the concert films and
          // documentaries were taking into the pool.
          return !excluded.has(key) && (r.vote_average || 0) >= ratingFloor && r.poster_path
            && r.original_language === 'en' && isAmerican && !r.adult && isRecPoolEligible(mt, r.genre_ids)
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
        // Attach IMDb ratings before the pool is scored. bayesianRating pools these votes
        // with TMDB's, so scoring without them would silently fall back to TMDB-only and
        // rank a 350-title pool off vote counts a fraction the size.
        await attachImdbRatings(mapped);
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
    // The keyword set itself lives in FF_KEYWORD_IDS (js/ui-helpers.js) so this pool and the
    // Browse tab's Found Footage filter stay in agreement about what counts; see the comment
    // there for how each keyword id was verified.
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
        const kw = FF_KEYWORD_IDS;
        // vote_count floor dropped further (8 → 5) and page depth roughly doubled across
        // every tier below — the keyword set already covers ~4,000 titles (see comment
        // above), the old page counts were only skimming the front of that, and found
        // footage's naturally low vote counts mean deeper pages still hold real titles
        // rather than trailing off into junk the way a mainstream-genre pool would.
        const base = `/api/tmdb/3/discover/movie?language=en-US&include_adult=false&with_original_language=en&with_origin_country=US&with_keywords=${kw}&vote_count.gte=5&sort_by=popularity.desc`;
        const tvBase = `/api/tmdb/3/discover/tv?language=en-US&include_adult=false&with_original_language=en&with_origin_country=US&with_keywords=${kw}&vote_count.gte=3&sort_by=popularity.desc`;
        const urls = [
          { url: `${base}&page=1`, type: 'movie' },
          { url: `${base}&page=2`, type: 'movie' },
          { url: `${base}&page=3`, type: 'movie' },
          { url: `${base}&page=4`, type: 'movie' },
          { url: `${base}&page=5`, type: 'movie' },
          { url: `${base}&page=6`, type: 'movie' },
          { url: `${base}&page=7`, type: 'movie' },
          { url: `${base}&page=8`, type: 'movie' },
          // Top-tier quality pass: the well-known, heavily-voted found-footage titles.
          { url: `${base}&sort_by=vote_average.desc&vote_count.gte=200&page=1`, type: 'movie' },
          { url: `${base}&sort_by=vote_average.desc&vote_count.gte=200&page=2`, type: 'movie' },
          // Mid-tier quality pass: acclaimed indie found-footage lives in the 50–200
          // vote range (Lake Mungo, Noroi, Grave Encounters territory) — too few votes for
          // the gte=200 pass, and buried by flashier junk in the popularity pass. Pulling it
          // by rating at a gte=50 floor is where most of the genuinely good, lesser-seen
          // found footage surfaces. Client-side weighted scoring below keeps the handful of
          // near-zero-vote 10.0-average flukes this sort can return from floating to the top.
          { url: `${base}&sort_by=vote_average.desc&vote_count.gte=50&page=1`, type: 'movie' },
          { url: `${base}&sort_by=vote_average.desc&vote_count.gte=50&page=2`, type: 'movie' },
          { url: `${base}&sort_by=vote_average.desc&vote_count.gte=50&page=3`, type: 'movie' },
          { url: `${base}&sort_by=vote_average.desc&vote_count.gte=50&page=4`, type: 'movie' },
          // Low-tier quality pass (NEW): the true deep cuts — barely-voted found footage
          // that a popularity sort would bury for pages. Rating-sorted at the same floor
          // as the main pull so genuinely well-regarded obscurities surface instead of
          // only ever showing up if someone happens to page far enough by popularity.
          { url: `${base}&sort_by=vote_average.desc&vote_count.gte=5&page=1`, type: 'movie' },
          { url: `${base}&sort_by=vote_average.desc&vote_count.gte=5&page=2`, type: 'movie' },
          { url: `${tvBase}&page=1`, type: 'tv' },
          { url: `${tvBase}&page=2`, type: 'tv' },
          { url: `${tvBase}&page=3`, type: 'tv' },
          { url: `${tvBase}&page=4`, type: 'tv' },
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
        // This pool used to carry a hand-tuned quality boost (m=60, C=6.0) because the
        // old bayesianRating flattened it — with a fixed m=800 against found footage's
        // tiny TMDB vote counts, everything collapsed onto the prior and ordering came
        // down to genre affinity plus jitter. bayesianRating now pools IMDb's vote counts
        // and takes its prior from the pool's own distribution, which addresses that at
        // the source, so the boost is gone rather than stacked on top of it.
        // Dedupe by id:mediaType, tag with a reason, drop excluded items and keyword
        // false-positives. The gate (documentary/animation exclusion, narrative-genre
        // requirement, curated denylist) is isPlausibleFoundFootage in js/ui-helpers.js —
        // shared with the Browse tab's Found Footage filter so both agree on what qualifies.
        const excluded = getExcludedKeys();
        const seen = new Set();
        const mapped = [];
        for (const r of raw) {
          const mt = r._mediaType || 'movie';
          const key = `${r.id}:${mt}`;
          if (seen.has(key) || excluded.has(key)) continue;
          if (!r.poster_path) continue;
          if (!isPlausibleFoundFootage(r.id, mt, r.genre_ids)) continue;
          seen.add(key);
          mapped.push({
            id: r.id, title: mt === 'tv' ? (r.name || r.title) : (r.title || r.name), _mediaType: mt,
            poster_path: r.poster_path, release_date: mt === 'tv' ? (r.first_air_date || '') : (r.release_date || ''),
            vote_average: r.vote_average, vote_count: r.vote_count || 0,
            genre_ids: r.genre_ids || [], overview: r.overview || '', popularity: r.popularity || 0,
            _affinityReason: '🎥 Found footage'
          });
        }
        if (!mapped.length) {
          if (grid) grid.innerHTML = `<div class="empty-state col-span-full"><span class="empty-state-icon">🎥</span><div class="text-zinc-300 font-medium">No found-footage titles loaded</div><div class="text-zinc-500 text-xs mt-1">Check the 🔐 Pass button or your connection.</div></div>`;
          return;
        }
        await attachImdbRatings(mapped);
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

    // Load a dedicated Cosmic Horror pool. Same mechanism as loadFoundFootage above — a
    // TMDB keyword search that replaces the rec pool and gets scored by the user's taste —
    // but the pool is two orders of magnitude smaller (~70 titles against found footage's
    // ~4,000, see COSMIC_KEYWORD_IDS in js/ui-helpers.js), and that changes how it's fetched:
    //
    // - No multi-tier sampling. Found footage needs popularity/rating passes at several
    //   vote floors because no single sort can surface 4,000 titles' worth of good material.
    //   Cosmic horror's entire pool is four pages, so paging straight through popularity.desc
    //   already returns all of it — a rating pass would just refetch the same rows.
    // - `with_origin_country=US` is dropped (with_original_language=en stays). Five of the
    //   most canonical entries — Hellraiser (1987), Dark City, The Void, Dagon, Dark Waters —
    //   are English-language but non-US, and losing five titles out of ~70 is a real dent.
    // - vote_count.gte=3 rather than found footage's 5. Below 3 the pool is almost entirely
    //   zero-rating shorts and unreleased entries; above it the tail still holds real films.
    //
    // Verified against production: 72 rows fetched, gate keeps 69, and the three it discards
    // are correct (The Spine of Night and Howard Lovecraft & the Undersea Kingdom are
    // animated; Spectral Shadows is tagged Documentary/Reality).
    let _cosmicHorrorLoading = false;
    async function loadCosmicHorror() {
      if (_cosmicHorrorLoading) return;
      _cosmicHorrorLoading = true;
      const grid = document.getElementById('recs-grid');
      const empty = document.getElementById('recs-empty');
      if (empty) empty.classList.add('hidden');
      if (grid) { grid.innerHTML = ''; showSkeletons('recs-grid', 8); }
      try {
        const kw = COSMIC_KEYWORD_IDS;
        const base = `/api/tmdb/3/discover/movie?language=en-US&include_adult=false&with_original_language=en&with_keywords=${kw}&vote_count.gte=3&sort_by=popularity.desc`;
        // TV contributes almost nothing here (FROM and Lovecraft Country, essentially), so
        // it's one page with no vote floor rather than found footage's four — the floor
        // would only cost recall on a list this short.
        const tvBase = `/api/tmdb/3/discover/tv?language=en-US&include_adult=false&with_original_language=en&with_keywords=${kw}&sort_by=popularity.desc`;
        const urls = [
          { url: `${base}&page=1`, type: 'movie' },
          { url: `${base}&page=2`, type: 'movie' },
          { url: `${base}&page=3`, type: 'movie' },
          { url: `${base}&page=4`, type: 'movie' },
          { url: `${tvBase}&page=1`, type: 'tv' },
        ];
        const results = await Promise.allSettled(urls.map(({ url }) => apiFetch(url)));
        let raw = [];
        results.forEach((res, i) => {
          if (res.status !== 'fulfilled') return;
          const { type } = urls[i];
          raw = raw.concat((res.value.results || []).map(r => ({ ...r, _mediaType: type })));
        });
        // Hand-tuned quality boost removed here for the same reason as the found-footage
        // pool above — bayesianRating's pooled IMDb evidence and pool-relative prior now
        // do this job properly. Verified on this pool specifically: without the boost, the
        // head is still canonical (The Thing, Evil Dead II, Dark City, The Lighthouse) and
        // Iron Lung correctly falls out of the top 12 — TMDB has it at 6.9 from 353 votes,
        // IMDb at 5.8 from 30,159.
        // Same shape as the found-footage mapping: dedupe by id:mediaType, drop excluded
        // items and keyword false-positives (isPlausibleCosmicHorror in js/ui-helpers.js,
        // shared with the Browse tab's Cosmic Horror filter), tag with a reason.
        const excluded = getExcludedKeys();
        const seen = new Set();
        const mapped = [];
        for (const r of raw) {
          const mt = r._mediaType || 'movie';
          const key = `${r.id}:${mt}`;
          if (seen.has(key) || excluded.has(key)) continue;
          if (!r.poster_path) continue;
          if (!isPlausibleCosmicHorror(r.id, mt, r.genre_ids)) continue;
          seen.add(key);
          mapped.push({
            id: r.id, title: mt === 'tv' ? (r.name || r.title) : (r.title || r.name), _mediaType: mt,
            poster_path: r.poster_path, release_date: mt === 'tv' ? (r.first_air_date || '') : (r.release_date || ''),
            vote_average: r.vote_average, vote_count: r.vote_count || 0,
            genre_ids: r.genre_ids || [], overview: r.overview || '', popularity: r.popularity || 0,
            _affinityReason: '🐙 Cosmic horror'
          });
        }
        if (!mapped.length) {
          if (grid) grid.innerHTML = `<div class="empty-state col-span-full"><span class="empty-state-icon">🐙</span><div class="text-zinc-300 font-medium">No cosmic-horror titles loaded</div><div class="text-zinc-500 text-xs mt-1">Check the 🔐 Pass button or your connection.</div></div>`;
          return;
        }
        await attachImdbRatings(mapped);
        currentRecPool = mapped;
        _recPoolLastRefreshed = new Date();
        if (typeof updateHomeSnapshot === 'function') updateHomeSnapshot();
        recGenreFilter = null;      // cosmic-horror pool spans many genres; don't pre-filter
        recMediaFilter = 'all';
        setRecMediaFilter('all');   // resets toggle styling + triggers recompute/render
        showToast(`Cosmic horror: ${mapped.length} titles`);
      } catch (e) {
        if (grid) grid.innerHTML = `<div class="empty-state col-span-full"><span class="empty-state-icon">⚠️</span><div class="text-zinc-300 font-medium">Couldn't load cosmic horror</div></div>`;
      } finally {
        _cosmicHorrorLoading = false;
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
        const poster = item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : FALLBACK_POSTER;
        const year = (item.release_date || '').slice(0,4);
        const tmdbRating = item.vote_average ? item.vote_average.toFixed(1) : null;
        const ratingBadgeClass = item.vote_average >= 7.5 ? 'high' : item.vote_average >= 6 ? '' : 'low';
        const rtSearchUrl = rtUrl(item.title || item.name, item._mediaType);
        const itemTitleSafe = escapeHtml(item.title || item.name || 'Untitled'); // for innerHTML string contexts only
        card.innerHTML = `
<div class="poster-wrap loading relative overflow-hidden rounded-2xl">
  <div class="swipe-overlay absolute inset-0 rounded-2xl flex items-center justify-center text-white font-bold text-lg opacity-0 pointer-events-none z-10" style="transition:opacity 0.12s;"></div>
  <img src="${poster}" class="w-full aspect-[2/3] object-cover" loading="lazy" alt="${itemTitleSafe} poster" onload="this.parentNode.classList.remove('loading')" onerror="this.onerror=null;this.src='${FALLBACK_POSTER}';this.parentNode.classList.remove('loading')">
</div>
<div class="mt-2 px-0.5">
  <div class="font-semibold text-sm leading-tight line-clamp-2">${itemTitleSafe}</div>
  <div class="flex items-center gap-1 flex-wrap mt-1">
    ${year ? `<span class="text-[11px] text-zinc-500">${year}</span>` : ''}
    ${tmdbRating ? `<span class="rating-badge ${ratingBadgeClass}" style="font-size:10px;padding:2px 5px;"><i class="fa-solid fa-star" style="font-size:7px"></i> ${tmdbRating}</span>` : ''}
    ${imdbBadgeHtml(item, `imdb-si-${item.id}`)}
    <a href="${rtSearchUrl}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-[11px] px-1.5 py-1 rounded bg-[#fa320a] text-white font-bold no-underline">RT</a>
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
      // Surprise picks render the same card markup, so they get the same availability line.
      renderRecAvailability(picks);
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

      // Together mode: build the other person's taste profile from their locally mirrored
      // library and score every candidate against both. `joint` is null in normal mode,
      // which leaves the single-profile path below completely untouched.
      const joint = (typeof togetherMode !== 'undefined' && togetherMode) ? buildTogetherContext() : null;

      let scored;
      if (joint) {
        scored = currentRecPool.map(it => {
          const mine = scoreItem(it, profile, poolStats);
          const theirs = scoreItem(it, joint.profile, poolStats);
          return { ...it, _score: jointScore(mine, theirs), _togetherLabel: togetherLabel(mine, theirs, joint.name) };
        });
      } else {
        // Score every item in the pool
        scored = currentRecPool.map(it => ({...it, _score: scoreItem(it, profile, poolStats)}));
      }
      // Filter out already seen/queued/hidden. In Together mode the other person's
      // library is excluded too — a joint pick that one of you has already seen or
      // explicitly passed on isn't something to watch together tonight.
      scored = scored.filter(it => {
        const key = `${it.id}:${it._mediaType || 'movie'}`;
        if (excluded.has(key)) return false;
        return !(joint && joint.excluded.has(key));
      });
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
          <div class="flex items-center justify-center gap-2 mt-4 flex-wrap">
            <button onclick="loadMoreRecommendations()" class="text-xs px-4 py-2 rounded-full bg-red-700 hover:bg-red-600 active:bg-red-500 text-white font-semibold transition-colors">More Recs</button>
            <button onclick="switchMainTab('browse')" class="text-xs px-4 py-2 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-200 hover:bg-zinc-700 transition-colors">🔍 Browse instead</button>
          </div>
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
        // In Together mode, why it suits BOTH of you is the whole point of the view —
        // it outranks the single-profile affinity explanation below.
        if (item._togetherLabel) return item._togetherLabel;
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
        const poster = item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : FALLBACK_POSTER;
        const year = (item.release_date || '').slice(0,4);
        const tmdbRating = item.vote_average ? item.vote_average.toFixed(1) : null;
        const ratingBadgeClass = item.vote_average >= 7.5 ? 'high' : item.vote_average >= 6 ? '' : 'low';
        const rtSearchUrl = rtUrl(item.title || item.name, item._mediaType);
        const itemTitleSafe = escapeHtml(item.title || item.name || 'Untitled'); // for innerHTML string contexts only
        card.innerHTML = `
<div class="poster-wrap loading relative overflow-hidden rounded-2xl">
  <div class="swipe-overlay absolute inset-0 rounded-2xl flex items-center justify-center text-white font-bold text-lg opacity-0 pointer-events-none z-10" style="transition:opacity 0.12s;"></div>
  <img src="${poster}" class="w-full aspect-[2/3] object-cover" loading="lazy" alt="${itemTitleSafe} poster" onload="this.parentNode.classList.remove('loading')" onerror="this.onerror=null;this.src='${FALLBACK_POSTER}';this.parentNode.classList.remove('loading')">
</div>
<div class="mt-2 px-0.5">
  <div class="font-semibold text-sm leading-tight line-clamp-2">${itemTitleSafe}</div>
  <div class="flex items-center gap-1 flex-wrap mt-1">
    ${year ? `<span class="text-[11px] text-zinc-500">${year}</span>` : ''}
    ${tmdbRating ? `<span class="rating-badge ${ratingBadgeClass}" style="font-size:10px;padding:2px 5px;"><i class="fa-solid fa-star" style="font-size:7px"></i> ${tmdbRating}</span>` : ''}
    ${imdbBadgeHtml(item, `imdb-link-${item.id}`)}
    <a href="${rtSearchUrl}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-[11px] px-1.5 py-1 rounded bg-[#fa320a] text-white font-bold no-underline">RT</a>
  </div>
  <button class="why-this-btn text-[10px] text-emerald-400/80 mt-1.5 text-left w-full truncate hover:text-emerald-300 transition-colors" title="Why this recommendation?">${escapeHtml(matchLabel(item))}</button>
  <div id="wtw-rec-${item.id}-${item._mediaType || 'movie'}" class="wtw-rec-slot mt-1"></div>
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

      // Availability runs after the grid is in the DOM, not during the render loop: it needs
      // a network round trip per title and blocking the render on ~40 of them would trade a
      // fast grid for a slow one. Cards paint immediately with an empty slot that fills in.
      renderRecAvailability(display);
    }

    // Fills each card's reserved availability slot with one compact line:
    //   streaming on a service you have -> pills for those services
    //   otherwise rentable              -> a single muted "Rent" marker
    //   neither / unknown               -> nothing
    //
    // The slot (see the card markup above) is a pre-existing empty div, so this adds no new
    // element to the layout and a card whose line stays empty is exactly as tall as before.
    // Only ever shows services from myServices — the whole point is "can I watch this
    // tonight without paying again", so listing services the user doesn't have would be
    // noise. With nothing configured in Settings, every available title reads as Rent.
    // Availability is held here rather than on the item, because the array passed in is a
    // scored/sliced COPY of currentRecPool — writing to those objects wouldn't reach the
    // pool, and the Settings repaint (which reads the pool) would find nothing.
    // One style string for both the service pill and the Rent marker, so the two states
    // occupy an identical box and a row of cards can't end up at different heights.
    // Deliberately NOT reusing the .wtw-provider-pill class from styles.css: that's sized
    // for the roomier Browse/Search rows (11px text, 3px/9px padding, 2px vertical margin)
    // and its margin in particular survives inline overrides, which is what made these
    // slots render 13px taller than the Rent ones.
    const AVAIL_CHIP_STYLE = 'display:inline-flex;align-items:center;font-size:9px;font-weight:600;'
      + 'line-height:14px;padding:1px 6px;margin:0;border:1px solid transparent;border-radius:9999px;white-space:nowrap;';

    // Both states go through this same wrapper. A bare inline chip and a chip inside a flex
    // row don't measure the same — the inline one picks up line-box leading and renders ~5px
    // taller — so streaming and Rent cards would sit at different heights despite the chips
    // themselves being identical.
    const availRow = inner => `<div style="display:flex;flex-wrap:nowrap;gap:3px;align-items:center;overflow:hidden;">${inner}</div>`;

    const _availabilityByKey = new Map(); // `${id}:${mediaType}` -> { stream, rentable }
    let _availabilityRun = 0;

    async function renderRecAvailability(items) {
      if (!Array.isArray(items) || !items.length) return;
      const run = ++_availabilityRun; // a newer render supersedes this one mid-flight
      const cache = loadProviderCache();
      // Sequential rather than Promise.all: this is a background nicety competing with the
      // poster loads the user actually cares about, and firing 40 requests at once would
      // contend with them for the browser's per-host connection budget.
      for (const item of items) {
        if (run !== _availabilityRun) return;
        const mt = item._mediaType === 'tv' ? 'tv' : 'movie';
        const data = await fetchWatchProviders(item.id, mt, cache);
        if (run !== _availabilityRun) return;
        if (!data) continue;
        _availabilityByKey.set(`${item.id}:${mt}`, data);
        paintAvailabilitySlot(item.id, mt);
      }
      saveProviderCache(cache);
    }

    function paintAvailabilitySlot(id, mediaType) {
      const mt = mediaType === 'tv' ? 'tv' : 'movie';
      const slot = document.getElementById(`wtw-rec-${id}-${mt}`);
      if (!slot) return;
      const data = _availabilityByKey.get(`${id}:${mt}`);
      if (!data) { slot.innerHTML = ''; return; }

      // Map TMDB's provider names onto the service labels the user picked (see
      // PROVIDER_NAME_TO_SERVICE) — "Shudder Amazon Channel" is still Shudder. Deduped
      // because a title can list the same service under two billing routes.
      const mine = [...new Set(
        (data.stream || []).map(n => PROVIDER_NAME_TO_SERVICE[n]).filter(l => l && myServices.has(l))
      )];

      if (mine.length) {
        // Capped at 2 and nowrap so the line can't grow to a second row and make this card
        // taller than its neighbours — the grid alignment was the stated concern.
        const pills = mine.slice(0, 2)
          .map(label => `<span class="${PROVIDER_COLORS[label] || 'bg-zinc-700 text-zinc-200'}" style="${AVAIL_CHIP_STYLE}">${escapeHtml(label)}</span>`)
          .join('');
        slot.innerHTML = availRow(pills);
        return;
      }
      if (data.rentable) {
        slot.innerHTML = availRow(`<span style="${AVAIL_CHIP_STYLE}color:#71717a;border-color:#3f3f46;">Rent</span>`);
        return;
      }
      slot.innerHTML = '';
    }

    // Repaint from already-fetched data — no network. Called when the Settings service
    // picker changes, so toggling a service updates the visible grid immediately.
    function refreshVisibleAvailability() {
      document.querySelectorAll('.wtw-rec-slot').forEach(el => {
        const m = el.id.match(/^wtw-rec-(\d+)-(movie|tv)$/);
        if (m) paintAvailabilitySlot(m[1], m[2]); else el.innerHTML = '';
      });
    }

