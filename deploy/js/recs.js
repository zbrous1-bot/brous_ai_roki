    // ===================== HORROR ROKI RECS + TASTE =====================

    // Shared placeholder for missing/failed poster art (also used as the onerror
    // fallback below, so a broken TMDB image URL doesn't show as a broken-image icon).
    const FALLBACK_POSTER = 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27120%27 height=%27180%27%3E%3Crect fill=%27%2327272a%27 width=%27120%27 height=%27180%27/%3E%3C/svg%27';

    // Taste math is relative to this library. A universal 5★ weight assumes a 5 is rare.
    // On a library whose average sits near 4.4, another 5 is ordinary and a 3 is the signal.
    let _meanCache = undefined;      // null = computed, too small to personalize
    let _dominantCache = null;       // Set of genre ids on >=45% of above-average titles

    function invalidateTasteCache() {
      _meanCache = undefined;
      _dominantCache = null;
      _likedSubTaste = null;
    }

    function libraryRatingMean(list) {
      const src = list || [];
      if (typeof watchedList !== 'undefined' && src === watchedList && _meanCache !== undefined) return _meanCache;
      const rated = src.filter(m => (m.rating || 0) >= 1);
      let mean = null;
      if (rated.length >= 8) {
        mean = rated.reduce((s, m) => s + m.rating, 0) / rated.length;
      }
      if (typeof watchedList !== 'undefined' && src === watchedList) _meanCache = mean;
      return mean;
    }

    // A 5 is a small yes. A 4 is ordinary and does not train the genre.
    // A 3 or below is the miss, and one miss outweighs another 5.
    // Libraries with fewer than 8 ratings keep the old fixed weights so cold start still moves.
    function ratingAffinityWeight(rating, mean) {
      const r = Number(rating) || 0;
      if (r < 1) return 0;
      if (mean == null || !isFinite(mean)) {
        return r === 5 ? 4 : r === 4 ? 2 : r === 3 ? 0.3 : r === 2 ? -1 : -2;
      }
      if (r >= 5) return Math.max(0.55, (r - mean) * 1.15);
      if (r >= 4) return 0.05;
      if (r === 3) return -1.7;
      if (r === 2) return -3.4;
      return -5.1;
    }

    // Genres on almost every above-average title (Horror, often Thriller) are not a personal link.
    function dominantGenreIds(list) {
      const src = list || [];
      if (typeof watchedList !== 'undefined' && src === watchedList && _dominantCache) return _dominantCache;
      const mean = libraryRatingMean(src);
      const counts = {};
      let n = 0;
      src.forEach(m => {
        const r = m.rating || 0;
        const keep = mean == null ? r >= 4 : r + 0.05 >= mean;
        if (!keep) return;
        const gids = m.genre_ids || [];
        if (!gids.length) return;
        n++;
        gids.forEach(g => { counts[g] = (counts[g] || 0) + 1; });
      });
      const ids = new Set();
      if (n >= 12) {
        Object.entries(counts).forEach(([id, c]) => {
          if (c / n >= 0.22) ids.add(Number(id));
        });
      }
      if (typeof watchedList !== 'undefined' && src === watchedList) _dominantCache = ids;
      return ids;
    }

    // Seeds for the pool: above-average titles whose genres are less common in the library,
    // plus a bump when the user rated a modestly scored film highly. Falls back to the
    // above-average band when nothing clears the mean (everyone is a 5).
    function pickDistinctiveSeeds(list, limit) {
      const src = list || [];
      const mean = libraryRatingMean(src);
      const floor = mean == null ? 4 : mean;
      const band = src.filter(m => m && m.id && (m.rating || 0) + 0.001 >= floor);
      const above = band.filter(m => mean == null ? (m.rating || 0) >= 5 : (m.rating || 0) > floor + 0.05);
      const pool = above.length >= 3 ? above : band;
      const freq = {};
      let n = 0;
      pool.forEach(m => {
        n++;
        (m.genre_ids || []).forEach(g => { freq[g] = (freq[g] || 0) + 1; });
      });
      const now = Date.now();
      const ranked = pool.map(m => {
        const gids = m.genre_ids || [];
        let rarity = 0;
        if (gids.length && n) {
          rarity = gids.reduce((s, g) => s + (1 - (freq[g] || 0) / n), 0) / gids.length;
        }
        const beatCrowd = Math.max(0, ((m.rating || 0) * 1.35) - (m.vote_average || 6.5)) * 0.18;
        const ageDays = m._ts ? Math.max(0, (now - m._ts) / 86400000) : 400;
        const recency = Math.exp(-ageDays / 140) * 0.4;
        const aboveMean = (m.rating || 0) - (mean == null ? 4 : mean);
        return { m, score: aboveMean * 1.1 + rarity * 2.4 + beatCrowd + recency };
      });
      ranked.sort((a, b) => b.score - a.score);
      return ranked.slice(0, limit).map(x => x.m);
    }

    // Together mode explains a pick from both libraries. A solo session uses the active list.
    function tasteSourceList() {
      const mine = (typeof watchedList !== 'undefined' && watchedList) ? watchedList : [];
      if (typeof togetherMode === 'undefined' || !togetherMode) return mine;
      if (typeof otherProfileId !== 'function' || typeof readProfileLists !== 'function') return mine;
      const otherId = otherProfileId();
      if (!otherId) return mine;
      const other = readProfileLists(otherId);
      return mine.concat((other && other.watched) || []);
    }

    // A named title is only a reason when the shared genres are not the ones on everything.
    function recSimilarWatched(item, list) {
      const src = (typeof togetherMode !== 'undefined' && togetherMode)
        ? tasteSourceList()
        : (list || (typeof watchedList !== 'undefined' ? watchedList : []));
      const gids = item.genre_ids || [];
      if (!gids.length || !src.length) return null;
      const dominant = dominantGenreIds(src);
      const specific = new Set(gids.map(Number).filter(g => !dominant.has(g)));
      if (!specific.size) return null;
      const mean = libraryRatingMean(src);
      let best = null;
      let bestScore = 0;
      src.forEach(w => {
        const r = w.rating || 0;
        const liked = mean == null ? r >= 4 : r > mean + 0.05;
        if (!liked) return;
        let overlap = 0;
        (w.genre_ids || []).forEach(g => { if (specific.has(Number(g))) overlap++; });
        if (overlap < 1) return;
        const score = overlap * 20 + r * 2 + (w._ts ? Math.min(4, (Date.now() - (Date.now() - w._ts)) / 1e15) : 0);
        if (score > bestScore) { bestScore = score; best = w; }
      });
      return best;
    }

    function specificAffinityText(item) {
      const aff = String(item && item._affinityReason || '').replace(/^[^\w(]+/, '').trim();
      if (!aff) return null;
      if (/^Directed by /i.test(aff) || /^Stars /i.test(aff) || /series you/i.test(aff) || /^Like /i.test(aff)) return aff;
      return null;
    }

    function recMatchLabel(item, profile, poolStats) {
      if (!item) return 'Picked for your taste';
      if (item._togetherLabel) return item._togetherLabel;
      if (item._outside) return 'Outside your usual taste';
      const specific = specificAffinityText(item);
      if (specific) return specific;
      const similar = recSimilarWatched(item);
      if (similar) {
        const raw = (similar.title || similar.name || '').trim();
        const st = raw.length > 22 ? raw.slice(0, 21) + '…' : raw;
        return `Because you rated ${st} ${similar.rating}★`;
      }
      const gids = item.genre_ids || [];
      const scores = (profile && profile.genreScores) || {};
      const topGenreId = gids.find(g => (scores[g] || 0) > 0);
      const topGenreName = topGenreId && typeof GENRES !== 'undefined'
        ? (GENRES.find(g => g.id === topGenreId)?.name)
        : null;
      if (topGenreName) return `Matches your ${topGenreName} taste`;
      return 'Picked for your taste';
    }

    // Simple genre prefs used by the Curator for context (kept for compatibility)
    function getUserGenrePrefs() {
      const counts = {};
      const mean = libraryRatingMean(watchedList);
      watchedList.forEach(m => {
        const w = ratingAffinityWeight(m.rating, mean);
        if (w <= 0) return;
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
      if (!lists) invalidateTasteCache();
      const { watched, disliked, notInterested } = lists || {
        watched: watchedList,
        disliked: dislikedList,
        notInterested: typeof notInterestedList !== 'undefined' ? notInterestedList : [],
      };
      const watchedSource = watched || [];
      const dislikedSource = disliked || [];
      const notInterestedSource = notInterested || [];
      const genreScores = {};   // genre_id -> weighted affinity (positive or negative)
      const decadeCounts = {};  // decade (e.g. 1990) -> weighted count
      const genrePairScores = {}; // "gidA,gidB" (sorted) -> weighted affinity for that *combination*
      const genreDislikeCounts = {}; // genre_id -> count of disliked items carrying it
      const genreHideCounts = {}; // genre_id -> count from Not Interested
      const loveGenreCounts = {};
      let loveN = 0;

      // Watched history — weight by distance from this library's own average, then recency.
      // A 5 is a small yes when the average is already ~4.4. A 3 or below is the vote that moves.
      // Decay prefers an actual watched timestamp (m._ts, ms since epoch) when present;
      // older stored entries lack it, so we fall back to list-index decay for those
      // (index 0 = most recently added) to stay backward compatible.
      const mean = libraryRatingMean(watchedSource);
      const now = Date.now();
      const DAY = 86400000;
      watchedSource.forEach((m, index) => {
        const r = m.rating || 0;
        if (!r) return;
        const decay = m._ts
          ? Math.pow(0.5, Math.max(0, (now - m._ts) / DAY) / 90) // half-life ~90 days; a season still counts
          : Math.pow(0.97, index); // legacy fallback: full weight at 0; ~50% by index 23; ~5% by index 95
        const w = ratingAffinityWeight(r, mean) * decay;
        const gids = m.genre_ids || [];
        // A miss on a film should not erase a genre that is already the library's background
        // (Horror, Thriller). The neighborhood of that film is learned separately.
        const dominant = dominantGenreIds(watchedSource);
        gids.forEach(gid => {
          const gw = (w < 0 && dominant.has(Number(gid))) ? w * 0.25 : w;
          genreScores[gid] = (genreScores[gid] || 0) + gw;
        });
        const above = mean == null ? r >= 4 : r > mean + 0.05;
        if (above && gids.length) {
          loveN++;
          gids.forEach(gid => { loveGenreCounts[gid] = (loveGenreCounts[gid] || 0) + 1; });
        }
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
        if (year >= 1920 && w > 0) {
          const decade = Math.floor(year / 10) * 10;
          decadeCounts[decade] = (decadeCounts[decade] || 0) + w;
        }
      });

      // Passes and dislikes do not downrank a genre the user also loves.
      // Horror is on most of both lists here, so a flat penalty just fights the 5s and loses.
      // A genre is penalized only when its share of passes exceeds its share of above-average watches.
      // The title itself is still hard-excluded. Neighborhood (director, keywords, similar titles)
      // is learned separately in the pool refresh.
      const passGenreCounts = {};
      let passN = 0;
      dislikedSource.forEach(m => {
        const gids = m.genre_ids || [];
        if (!gids.length) return;
        passN++;
        gids.forEach(gid => {
          genreDislikeCounts[gid] = (genreDislikeCounts[gid] || 0) + 1;
          passGenreCounts[gid] = (passGenreCounts[gid] || 0) + 1;
        });
      });
      notInterestedSource.forEach(m => {
        const gids = m.genre_ids || [];
        if (!gids.length) return;
        passN++;
        gids.forEach(gid => {
          genreHideCounts[gid] = (genreHideCounts[gid] || 0) + 1;
          passGenreCounts[gid] = (passGenreCounts[gid] || 0) + 1;
        });
      });
      if (passN >= 12 && loveN >= 12) {
        Object.keys(passGenreCounts).forEach(gid => {
          const current = genreScores[gid] || 0;
          if (current <= 0) return;
          const passShare = passGenreCounts[gid] / passN;
          const loveShare = (loveGenreCounts[gid] || 0) / loveN;
          const excess = passShare - loveShare;
          // A genre they also love (Horror, on both lists) only loses a fraction of its score.
          if (excess > 0.06) genreScores[gid] = current - Math.min(excess * 28, current * 0.4);
        });
      }

      // Normalise: total positive genre weight (for relative boost calculation)
      const totalPos = Object.values(genreScores).reduce((a, b) => a + Math.max(0, b), 0) || 1;
      const totalDecade = Object.values(decadeCounts).reduce((a, b) => a + b, 0) || 1;
      const totalPairPos = Object.values(genrePairScores).reduce((a, b) => a + Math.max(0, b), 0) || 1;

      return { genreScores, decadeCounts, totalPos, totalDecade, genrePairScores, totalPairPos, genreHideCounts };
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
        profile: buildTasteProfile({
          watched: lists.watched,
          disliked: lists.disliked,
          notInterested: lists.notInterested,
        }),
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

    // Runtime cache filled during pool affinity detail fetches (and optional item.runtime).
    let _runtimeByKey = Object.create(null);

    // Prefer contemporary titles in For You. Discover used to open at 1960, which flooded
    // the pool with classics; hard floor + recency scoring push the feed toward recent.
    const REC_MIN_YEAR = 2000;
    const REC_RECENT_YEAR = 2015; // extra discover weight for mid-recent
    const REC_FRESH_YEAR = 2020;  // extra discover weight for very recent

    /** Soft rank signal: newer titles climb; pre-floor leftovers (similar API etc.) get demoted. */
    function recencyScore(year) {
      if (!year || !Number.isFinite(year)) return { boost: -0.25, note: null };
      const nowY = new Date().getFullYear();
      const age = nowY - year;
      if (age <= 3) return { boost: 1.25, note: 'Very recent' };
      if (age <= 6) return { boost: 0.95, note: 'Recent' };
      if (age <= 10) return { boost: 0.65, note: null };
      if (age <= 15) return { boost: 0.35, note: null };
      if (age <= 20) return { boost: 0.1, note: null };
      if (age <= 25) return { boost: -0.35, note: null };
      if (year < REC_MIN_YEAR) return { boost: -1.5, note: 'Older title' };
      return { boost: -0.75, note: null };
    }

    // A3: as the library grows, lean less on generic quality and more on personal taste.
    // t≈0 with a cold library; t→1 around ~25+ watched titles.
    function personalizationCurve() {
      const n = (typeof watchedList !== 'undefined' && watchedList)
        ? watchedList.filter(w => w && w.id != null).length
        : 0;
      const t = Math.min(1, Math.max(0, (n - 4) / 22));
      return {
        n,
        t,
        qualityMult: 1.18 - 0.28 * t, // 1.18 → 0.90
        genreMult: 0.65 + 0.50 * t,   // 0.65 → 1.15
        similarMult: 0.55 + 0.55 * t, // similar-title signal strengthens with history
      };
    }

    // A1: concrete overlap with highly rated watched titles (genres + decade).
    function similarTitleSignal(item) {
      const gids = item.genre_ids || [];
      const src = tasteSourceList();
      if (!gids.length || !src.length) {
        return { boost: 0, title: null, rating: null, overlap: 0 };
      }
      // Sharing Horror with a 5 is not a personal signal when Horror is on most of the library.
      const dominant = dominantGenreIds(src);
      const gset = new Set(gids.map(Number).filter(g => !dominant.has(g)));
      if (!gset.size) return { boost: 0, title: null, rating: null, overlap: 0 };
      const mean = libraryRatingMean(src);
      const yearA = parseInt((item.release_date || item.first_air_date || '').slice(0, 4)) || 0;
      let best = 0, bestW = null, bestOverlap = 0;
      src.forEach(w => {
        const r = w.rating || 0;
        const liked = mean == null ? r >= 4 : r > mean + 0.05;
        if (!liked) return;
        let overlap = 0;
        (w.genre_ids || []).forEach(g => { if (gset.has(Number(g))) overlap++; });
        if (overlap < 1) return;
        const yearB = parseInt((w.release_date || w.first_air_date || '').slice(0, 4)) || 0;
        const decadeMatch = yearA && yearB && Math.floor(yearA / 10) === Math.floor(yearB / 10) ? 0.12 : 0;
        const s = overlap * 0.5 + decadeMatch + (overlap >= 2 ? 0.3 : 0);
        if (s > best) { best = s; bestW = w; bestOverlap = overlap; }
      });
      if (!bestW) return { boost: 0, title: null, rating: null, overlap: 0 };
      return {
        boost: Math.min(1.4, best),
        title: bestW.title || bestW.name || null,
        rating: bestW.rating || null,
        overlap: bestOverlap,
      };
    }

    // B7: recent queue = intent signal (genres the user is actively planning to watch).
    function recentQueueIntentSignal(item) {
      if (typeof toWatchList === 'undefined' || !toWatchList.length) {
        return { boost: 0, note: null };
      }
      const gids = new Set(item.genre_ids || []);
      if (!gids.size) return { boost: 0, note: null };
      const cutoff = Date.now() - 14 * 86400000;
      let weight = 0;
      // Newest-first list: first 10 are the live queue; prefer timestamped recent adds.
      toWatchList.slice(0, 10).forEach((w, idx) => {
        const t = w._queuedAt || w._ts || 0;
        if (t && t < cutoff) return;
        const recency = t ? 1 : Math.max(0.35, 1 - idx * 0.08);
        let hit = 0;
        (w.genre_ids || []).forEach(g => { if (gids.has(g)) hit += 1; });
        if (hit) weight += recency * Math.min(2, hit) * 0.14;
      });
      if (weight <= 0) return { boost: 0, note: null };
      return {
        boost: Math.min(0.75, weight),
        note: 'Matches genres on your recent queue',
      };
    }

    // A2: soft services signal from in-memory / localStorage provider cache (no hard filter).
    function softServicesSignal(item) {
      if (typeof myServices === 'undefined' || !myServices || !myServices.size) {
        return { boost: 0, note: null };
      }
      const mt = item._mediaType === 'tv' ? 'tv' : 'movie';
      let data = null;
      if (typeof _availabilityByKey !== 'undefined' && _availabilityByKey.has(`${item.id}:${mt}`)) {
        data = _availabilityByKey.get(`${item.id}:${mt}`);
      } else if (typeof loadProviderCache === 'function') {
        try {
          const cache = loadProviderCache();
          const hit = cache[`${mt}:${item.id}`];
          if (hit && hit.d) data = hit.d;
        } catch (_) {}
      }
      if (!data) return { boost: 0, note: null };
      if (typeof streamsOnMyServices === 'function' && streamsOnMyServices(data)) {
        return { boost: 0.9, note: 'Streaming on your services' };
      }
      if (data.rentable) return { boost: -0.12, note: 'Rent/buy only on your region' };
      if (Array.isArray(data.stream) && data.stream.length === 0) {
        return { boost: -0.22, note: 'Not currently streaming' };
      }
      return { boost: 0, note: null };
    }

    // B5: prefer watchable-tonight runtimes when we know length.
    function tonightFitSignal(item) {
      const mt = item._mediaType === 'tv' ? 'tv' : 'movie';
      const rt = item.runtime || item._runtime || _runtimeByKey[`${item.id}:${mt}`] || null;
      if (rt == null || !Number.isFinite(Number(rt))) {
        return { boost: 0, note: null, runtime: null };
      }
      const n = Number(rt);
      if (mt === 'tv') {
        // episode minutes when present
        if (n >= 35 && n <= 55) return { boost: 0.25, note: `~${n} min episodes`, runtime: n };
        if (n > 70) return { boost: -0.15, note: `~${n} min episodes`, runtime: n };
        return { boost: 0, note: `~${n} min episodes`, runtime: n };
      }
      if (n >= 85 && n <= 130) return { boost: 0.42, note: `${n} min — solid tonight length`, runtime: n };
      if (n >= 70 && n <= 150) return { boost: 0.12, note: `${n} min`, runtime: n };
      if (n > 180) return { boost: -0.45, note: `${n} min — long sit`, runtime: n };
      if (n < 65) return { boost: -0.15, note: `${n} min`, runtime: n };
      return { boost: 0, note: `${n} min`, runtime: n };
    }

    // Full score with component breakdown (B6). scoreItem() returns the total only.
    function scoreItemDetailed(item, profile, poolStats) {
      const { genreScores, decadeCounts, totalPos, totalDecade, genrePairScores, totalPairPos } = profile;
      const stats = poolStats || computePoolStats(null);
      const curve = personalizationCurve();
      const voteCount = item.vote_count || 0;
      const voteAvg = item.vote_average || 6.0;
      const parts = {
        quality: 0,
        taste: 0,
        pairs: 0,
        decade: 0,
        gem: 0,
        reliability: 0,
        affinity: 0,
        similar: 0,
        queueIntent: 0,
        services: 0,
        runtime: 0,
        explore: 0,
        penalties: 0,
      };
      const notes = [];

      // Quality baseline × personalization curve × user slider
      const bayes = bayesianRating(voteAvg, voteCount, item.imdb_rating, item.imdb_votes, stats.qualityPrior);
      parts.quality = bayes * recTune.qualityBaseline * curve.qualityMult;

      // Genre affinity
      const gids = item.genre_ids || [];
      gids.forEach(gid => {
        if (genreScores[gid] != null) {
          parts.taste += (genreScores[gid] / totalPos) * recTune.genreAffinity * curve.genreMult;
        }
      });

      // Genre co-occurrence
      if (gids.length >= 2 && genrePairScores) {
        for (let i = 0; i < gids.length; i++) {
          for (let j = i + 1; j < gids.length; j++) {
            const key = gids[i] < gids[j] ? `${gids[i]},${gids[j]}` : `${gids[j]},${gids[i]}`;
            const pairScore = genrePairScores[key];
            if (pairScore > 0) parts.pairs += (pairScore / totalPairPos) * 1.5;
          }
        }
      }

      // Decade affinity from taste + global recency bias (prefer newer titles in the feed)
      const year = parseInt((item.release_date || item.first_air_date || '').slice(0, 4));
      if (year && totalDecade > 0) {
        const decade = Math.floor(year / 10) * 10;
        if (decadeCounts[decade]) parts.decade += (decadeCounts[decade] / totalDecade) * 1.2;
      }
      const recency = recencyScore(year);
      parts.decade += recency.boost;
      if (recency.note) notes.push(recency.note);

      // Hidden gem
      if (voteAvg >= stats.gemVoteAvgMin && (item.popularity || 0) < stats.gemPopularityMax && voteCount >= stats.gemVoteCountMin) {
        parts.gem = 0.8;
        notes.push('Hidden gem quality');
      }

      // Reliability
      if (voteCount < stats.lowVoteCount) parts.reliability = -0.8;
      else if (voteCount < stats.midVoteCount) parts.reliability = -0.3;

      // Affinity tags (director / cast / keyword / franchise / similar API)
      if (item._affinityBoost) {
        parts.affinity += item._affinityBoost;
        if (item._affinityReason) notes.push(String(item._affinityReason));
      }
      if (item._source === 'similar' && !item._affinityBoost) {
        parts.affinity += 1.35;
        notes.push('Similar to something you loved');
      } else if (item._source === 'recommendations' && !item._affinityBoost) {
        parts.affinity += 1.5;
        notes.push('From TMDB recommendations on your ratings');
      }

      // Keyword dislike soft penalty
      if (item._affinityKeywordIds && item._affinityKeywordIds.length
          && typeof _dislikedKeywordScores === 'object' && _dislikedKeywordScores) {
        let kwPen = 0;
        item._affinityKeywordIds.forEach(id => { kwPen += _dislikedKeywordScores[id] || 0; });
        if (kwPen > 0) parts.penalties -= Math.min(2.0, 0.4 * Math.sqrt(kwPen));
      }

      // Neighbors of a pass, a dislike, or a below-average rating. This is the
      // signal a genre penalty cannot carry: the next film like the one you skipped,
      // not "fewer horror movies."
      if (typeof _missNeighborWeights !== 'undefined' && _missNeighborWeights) {
        const missW = _missNeighborWeights.get(`${item.id}:${item._mediaType || 'movie'}`) || 0;
        if (missW > 0) {
          parts.penalties -= Math.min(2.2, missW);
          notes.push('Near a film you passed on');
        }
      }

      // Disliked-director soft penalty
      if (typeof _dislikedPenaltyIds !== 'undefined' && _dislikedPenaltyIds
          && _dislikedPenaltyIds.has(`${item.id}:${item._mediaType || 'movie'}`)) {
        parts.penalties -= 1.2;
        notes.push('Director you often dislike');
      }

      // A1 similar-title
      const sim = similarTitleSignal(item);
      if (sim.boost > 0) {
        parts.similar = sim.boost * curve.similarMult;
        if (sim.title) notes.push(`Like ${sim.title}${sim.rating ? ` (${sim.rating}★)` : ''}`);
      }

      // B7 queue intent
      const qi = recentQueueIntentSignal(item);
      parts.queueIntent = qi.boost;
      if (qi.note) notes.push(qi.note);

      // A2 services
      const svc = softServicesSignal(item);
      parts.services = svc.boost;
      if (svc.note) notes.push(svc.note);

      // B5 runtime / tonight fit
      const fit = tonightFitSignal(item);
      parts.runtime = fit.boost;
      if (fit.note) notes.push(fit.note);

      // Sub-taste keyword clusters (horror-adjacent) learned from 4–5★ watches
      const sub = subTasteSignal(item);
      if (sub.boost) {
        parts.taste += sub.boost;
        if (sub.note) notes.push(sub.note);
      }

      // Stale queue near-neighbor soft penalty
      const stale = staleQueueSignal(item);
      if (stale.boost) {
        parts.penalties += stale.boost;
        if (stale.note) notes.push(stale.note);
      }

      // TV-native: finished/short-run soft preference when status known
      const tv = tvNativeSignal(item);
      if (tv.boost) {
        parts.taste += tv.boost;
        if (tv.note) notes.push(tv.note);
      }

      // Watch Tonight mode extras
      if (typeof watchTonightExtra === 'function') {
        const wt = watchTonightExtra(item);
        if (wt.boost) {
          parts.services += wt.boost * 0.55;
          parts.runtime += wt.boost * 0.45;
          if (wt.note) notes.push(wt.note);
        }
      }

      // Exploration jitter (stronger when exploration slider high — anti-echo uses diversify)
      const seed = ((item.id || 0) * 2654435761) >>> 0;
      const unit = ((seed % 1000) / 1000) - 0.5;
      parts.explore = unit * 2 * recTune.exploration;

      const total = Math.max(0.01,
        parts.quality + parts.taste + parts.pairs + parts.decade + parts.gem
        + parts.reliability + parts.affinity + parts.similar + parts.queueIntent
        + parts.services + parts.runtime + parts.explore + parts.penalties
      );

      return { total, parts, notes, similar: sim, services: svc, runtime: fit, curve };
    }

    // Keyword sub-taste clusters. Found Footage and Cosmic Horror ids are the same
    // sets the dedicated pools search with, but those constants are pipe-joined
    // strings for discover URLs. Scoring needs a real array — calling .some on the
    // string throws and aborts the whole rec load.
    function keywordIdList(value) {
      if (Array.isArray(value)) return value.map(Number).filter(n => Number.isFinite(n) && n > 0);
      if (typeof value === 'string') return value.split('|').map(s => Number(String(s).trim())).filter(n => Number.isFinite(n) && n > 0);
      return [];
    }
    const SUB_TASTE_CLUSTERS = {
      found_footage: { label: 'Found footage', ids: keywordIdList(typeof FF_KEYWORD_IDS !== 'undefined' ? FF_KEYWORD_IDS : [12377, 33737, 224636]) },
      cosmic: { label: 'Cosmic horror', ids: keywordIdList(typeof COSMIC_KEYWORD_IDS !== 'undefined' ? COSMIC_KEYWORD_IDS : [186915, 12564]) },
      slasher: { label: 'Slasher', ids: keywordIdList([12339, 6152]) },
      folk: { label: 'Folk horror', ids: keywordIdList([191228, 222243]) },
    };
    let _likedSubTaste = null; // clusterKey -> weight

    function rebuildLikedSubTastes() {
      _likedSubTaste = Object.create(null);
      if (typeof watchedList === 'undefined') return;
      watchedList.forEach(w => {
        const r = w.rating || 0;
        if (r < 4) return;
        const kws = w._keywordIds || w.keyword_ids || [];
        if (!kws.length) return;
        const set = new Set(kws.map(Number));
        Object.entries(SUB_TASTE_CLUSTERS).forEach(([key, cl]) => {
          const hit = keywordIdList(cl.ids).some(id => set.has(id));
          if (hit) _likedSubTaste[key] = (_likedSubTaste[key] || 0) + (r === 5 ? 1.2 : 0.8);
        });
      });
    }

    function subTasteSignal(item) {
      if (!_likedSubTaste) rebuildLikedSubTastes();
      const kws = item._affinityKeywordIds || item._keywordIds || [];
      if (!kws.length || !Object.keys(_likedSubTaste).length) return { boost: 0, note: null };
      const set = new Set(kws.map(Number));
      let best = 0, bestLabel = null;
      Object.entries(SUB_TASTE_CLUSTERS).forEach(([key, cl]) => {
        if (!_likedSubTaste[key]) return;
        if (keywordIdList(cl.ids).some(id => set.has(id))) {
          const b = Math.min(0.85, _likedSubTaste[key] * 0.35);
          if (b > best) { best = b; bestLabel = cl.label; }
        }
      });
      return best ? { boost: best, note: `Sub-taste: ${bestLabel}` } : { boost: 0, note: null };
    }

    function staleQueueSignal(item) {
      if (typeof toWatchList === 'undefined' || !toWatchList.length) return { boost: 0, note: null };
      const cutoff = Date.now() - 30 * 86400000;
      const gids = new Set(item.genre_ids || []);
      if (!gids.size) return { boost: 0, note: null };
      let hits = 0;
      toWatchList.forEach(w => {
        const t = w._queuedAt || w._ts || 0;
        if (!t || t > cutoff) return; // only stale
        let o = 0;
        (w.genre_ids || []).forEach(g => { if (gids.has(g)) o++; });
        if (o >= 2) hits++;
      });
      if (hits < 1) return { boost: 0, note: null };
      return { boost: -Math.min(0.55, 0.18 * hits), note: 'Similar to long-queued titles' };
    }

    function tvNativeSignal(item) {
      if ((item._mediaType || 'movie') !== 'tv') return { boost: 0, note: null };
      let boost = 0.05; // slight TV presence in mixed pools
      const st = item.status || item._tvStatus || null;
      if (st === 'Ended' || st === 'Canceled') { boost += 0.25; return { boost, note: 'Finished series' }; }
      if (st === 'Returning Series') boost -= 0.08;
      const seasons = item.number_of_seasons || item._seasons;
      if (seasons && seasons <= 2) boost += 0.15;
      if (seasons && seasons >= 6) boost -= 0.12;
      return { boost, note: boost > 0.1 ? 'TV fit' : null };
    }

    function scoreItem(item, profile, poolStats) {
      return scoreItemDetailed(item, profile, poolStats).total;
    }

    // A4: one title per franchise / obvious sequel chain in the visible top-N.
    function franchiseKey(item) {
      if (item && item._collectionId) return 'col:' + item._collectionId;
      const raw = (item && (item.title || item.name) || '').toLowerCase();
      if (!raw) return null;
      let t = raw
        .replace(/\(.*?\)/g, ' ')
        .replace(/:.*$/, '')
        .replace(/\s+part\s+\d+.*/i, '')
        .replace(/\s+chapter\s+\d+.*/i, '')
        .replace(/\s+\d{1,2}$/, '')
        .replace(/\s+(i{1,3}|iv|v|vi{0,3}|vii|viii|ix|x)$/i, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (t.length < 8) return null;
      return 'title:' + t;
    }

    function takeWithFranchiseDedupe(scored, limit) {
      const out = [];
      const seen = new Set();
      const used = new Set();
      for (const it of scored) {
        const idk = `${it.id}:${it._mediaType || 'movie'}`;
        if (used.has(idk)) continue;
        const fk = franchiseKey(it);
        if (fk && seen.has(fk)) continue;
        if (fk) seen.add(fk);
        used.add(idk);
        out.push(it);
        if (out.length >= limit) break;
      }
      // Fill remaining slots if franchise caps left holes (prefer unique franchises first, then allow repeats)
      if (out.length < limit) {
        for (const it of scored) {
          const idk = `${it.id}:${it._mediaType || 'movie'}`;
          if (used.has(idk)) continue;
          used.add(idk);
          out.push(it);
          if (out.length >= limit) break;
        }
      }
      return out;
    }

    function diversifyWithFranchiseCap(scored, limit) {
      // Over-fetch diversified list, then franchise-cap down to limit.
      const diversified = diversify(scored, Math.min(scored.length, Math.max(limit * 3, limit + 20)));
      return takeWithFranchiseDedupe(diversified, limit);
    }

    // ---- Stable Tonight's pick ----
    // Pin the hero until the user acts (queue / watched / hide / dislike) or it leaves
    // the eligible set. Recompute and pool refreshes keep the same pick when possible.
    const TONIGHT_PIN_KEY = 'brous_tonight_pin';

    function readTonightPin() {
      try {
        const raw = Store.getItem(TONIGHT_PIN_KEY);
        if (!raw) return null;
        const p = JSON.parse(raw);
        if (!p || p.id == null) return null;
        return { id: p.id, mediaType: p.mediaType || 'movie' };
      } catch (_) { return null; }
    }

    function writeTonightPin(item) {
      if (!item || item.id == null) return;
      try {
        Store.setItem(TONIGHT_PIN_KEY, JSON.stringify({
          id: item.id,
          mediaType: item._mediaType || 'movie',
        }));
      } catch (_) {}
    }

    function clearTonightPin(id, mediaType) {
      const pin = readTonightPin();
      if (!pin) return;
      if (id == null || (pin.id === id && pin.mediaType === (mediaType || 'movie'))) {
        try { Store.removeItem(TONIGHT_PIN_KEY); } catch (_) {}
      }
    }

    // Place pinned title as hero when still eligible; otherwise adopt a new pin.
    function applyTonightPin(display, scored) {
      const pin = readTonightPin();
      const keyOf = (it) => `${it.id}:${it._mediaType || 'movie'}`;
      if (!display.length) {
        try { Store.removeItem(TONIGHT_PIN_KEY); } catch (_) {}
        return display;
      }
      if (pin) {
        const inDisplay = display.find(it => keyOf(it) === `${pin.id}:${pin.mediaType}`);
        if (inDisplay) {
          return [inDisplay, ...display.filter(it => it !== inDisplay)];
        }
        const inScored = (scored || []).find(it => keyOf(it) === `${pin.id}:${pin.mediaType}`);
        if (inScored) {
          return [inScored, ...display.filter(it => keyOf(it) !== keyOf(inScored))].slice(0, Math.max(display.length, 1));
        }
        // Pin no longer eligible — fall through to new pin
      }
      writeTonightPin(display[0]);
      return display;
    }

    // Diversity interleave: round-robin across top genres so the top 40 isn't mono-genre.
    // Anti-echo: when serendipity is mid/high, cap how many from the same primary genre
    // enter the first half of the list.
    function diversify(scored, limit) {
      if (scored.length <= limit) return scored;

      const explore = (typeof recTune !== 'undefined' && recTune.exploration) || 0.6;
      // Higher exploration → stricter per-genre cap in the visible window
      const maxPerGenre = explore >= 0.9 ? 3 : explore >= 0.55 ? 5 : 8;

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

      // Cap each bucket for anti-echo before interleave
      keys.forEach(k => {
        if (buckets[k].length > maxPerGenre + 4) {
          buckets[k] = buckets[k].slice(0, maxPerGenre + 4);
        }
      });

      // Round-robin across genre buckets
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

      const result = [];
      const genreCounts = Object.create(null);
      let a = 0, b = 0;
      while (result.length < limit && (a < interleaved.length || b < ungrouped.length)) {
        const left = interleaved[a];
        const right = ungrouped[b];
        let pick;
        if (left && (!right || left._score >= right._score)) { pick = left; a++; }
        else { pick = right; b++; }
        if (!pick) break;
        const pg = (pick.genre_ids || [])[0] || 'x';
        genreCounts[pg] = (genreCounts[pg] || 0) + 1;
        // Soft skip if this genre already dominates the first half
        if (result.length < limit * 0.55 && genreCounts[pg] > maxPerGenre) continue;
        result.push(pick);
      }
      // Fill if anti-echo left holes
      if (result.length < limit) {
        const used = new Set(result.map(it => `${it.id}:${it._mediaType || 'movie'}`));
        for (const it of scored) {
          const k = `${it.id}:${it._mediaType || 'movie'}`;
          if (used.has(k)) continue;
          result.push(it);
          used.add(k);
          if (result.length >= limit) break;
        }
      }
      return result;
    }

    // Mood chips UI removed per request. currentMood stays 'All' (no filtering).

    let recGenreFilter = null; // null = All, otherwise a genre id (number)
    let recMediaFilter = 'movie'; // 'all' | 'movie' | 'tv' — filters For You recs by media type; defaults to Movies
    // For You: only show titles streaming on services the user picked in Settings.
    // Persisted so the dashboard "product" default sticks across sessions.
    let recServicesOnly = false;
    try { recServicesOnly = Store.getItem('brous_rec_services_only') === '1'; } catch (_) {}
    let _recomputeGen = 0;

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

    function syncRecServicesToggleUI() {
      const btn = document.getElementById('rec-services-toggle');
      if (!btn) return;
      const on = !!recServicesOnly;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.className = `text-xs px-3 py-1.5 rounded-full border transition-all ${on ? 'type-toggle-active' : 'filter-chip'}`;
      if (!myServices.size) {
        btn.title = 'Pick streaming services in Settings first';
      } else {
        btn.title = on
          ? 'Showing only titles on your services — tap to show all ranked picks'
          : 'Only show titles streaming on services you selected in Settings';
      }
    }

    function toggleRecServicesOnly() {
      if (!myServices.size) {
        try { showToast('Pick your streaming services in Settings first'); } catch (_) {}
        if (typeof showSettings === 'function') showSettings();
        return;
      }
      recServicesOnly = !recServicesOnly;
      try { Store.setItem('brous_rec_services_only', recServicesOnly ? '1' : '0'); } catch (_) {}
      syncRecServicesToggleUI();
      recomputeRecommendations();
    }

    function streamsOnMyServices(data) {
      if (!data || !myServices || !myServices.size) return false;
      return (data.stream || []).some(n => {
        const label = PROVIDER_NAME_TO_SERVICE[n];
        return label && myServices.has(label);
      });
    }

    // Walk scored candidates (already ranked) and keep those on the user's services.
    // Stops once we have enough for the hero + diversified grid, so we don't fetch
    // providers for the entire pool on every recompute.
    async function filterScoredToMyServices(scored, wantCount = 48) {
      const cache = loadProviderCache();
      const out = [];
      for (const it of scored) {
        if (out.length >= wantCount) break;
        const mt = it._mediaType === 'tv' ? 'tv' : 'movie';
        const data = await fetchWatchProviders(it.id, mt, cache);
        if (!data) continue;
        _availabilityByKey.set(`${it.id}:${mt}`, data);
        if (streamsOnMyServices(data)) out.push(it);
      }
      saveProviderCache(cache);
      return out;
    }

    function genreChoicesFromPool() {
      const counts = Object.create(null);
      const pool = (typeof currentRecPool !== 'undefined' && currentRecPool) || [];
      pool.forEach(m => {
        (m.genre_ids || []).forEach(id => { counts[id] = (counts[id] || 0) + 1; });
      });
      const list = (typeof GENRES !== 'undefined' ? GENRES : [])
        .filter(g => g.id !== 16 && counts[g.id])
        .sort((a, b) => counts[b.id] - counts[a.id]);
      return { counts, list, total: pool.length };
    }

    function applyRecGenre(id) {
      if (typeof exitKeywordPoolMode === 'function') exitKeywordPoolMode();
      recGenreFilter = id;
      renderRecGenreChips();
      if (typeof recomputeRecommendations === 'function') recomputeRecommendations();
    }

    function renderRecGenreChips() {
      const wrap = document.getElementById('recs-genre-chips');
      if (!wrap) return;
      const { counts: genreCounts, list: available, total } = genreChoicesFromPool();
      const allBtn = document.createElement('button');
      allBtn.textContent = `All · ${total}`;
      allBtn.className = `text-xs px-3 py-1.5 rounded-full border transition-colors ${(!keywordPoolActive && recGenreFilter === null) ? 'bg-red-700 border-red-600 text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:border-zinc-500'}`;
      allBtn.onclick = () => applyRecGenre(null);
      wrap.innerHTML = '';
      wrap.appendChild(allBtn);

      available.forEach(g => {
        const btn = document.createElement('button');
        const n = genreCounts[g.id] || 0;
        btn.textContent = n ? `${g.name} · ${n}` : g.name;
        btn.className = `text-xs px-3 py-1.5 rounded-full border transition-colors ${(!keywordPoolActive && recGenreFilter === g.id) ? 'bg-red-700 border-red-600 text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:border-zinc-500'}`;
        btn.onclick = () => applyRecGenre(recGenreFilter === g.id ? null : g.id);
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
    // The pool holds a few hundred scored titles. The grid only paints the
    // first page until Show more raises this, otherwise a deeper fetch
    // recomputes back down to the same cards.
    const REC_VISIBLE_START = 40;
    const REC_VISIBLE_STEP = 24;
    let recVisibleLimit = REC_VISIBLE_START;

    // Negative affinity signals derived from disliked films (directors / keywords the
    // user has repeatedly rejected). Mirrors the POSITIVE affinity phase: dislikes used
    // to only push down genres, so a director you disliked 3x could still be recommended.
    // Populated in refreshRecPool's disliked-affinity phase, consumed when tagging the pool.
    let _dislikedPersonScores = {};   // personId -> penalty weight (positive number = how disliked)
    let _dislikedKeywordScores = {};  // keywordId -> penalty weight
    let _dislikedPenaltyIds = new Set(); // "id:movie" keys from strongly-disliked directors' filmographies
    let _missNeighborWeights = new Map(); // "id:mediaType" -> penalty from similar-to-a-miss

    // A pass, a dislike, or a low rating should sink the films TMDB calls similar,
    // and remember the director, without waiting for the next full pool refresh.
    async function learnPassNeighborhood(item, weight) {
      if (!item || !item.id) return;
      const mt = item._mediaType === 'tv' ? 'tv' : 'movie';
      const w = weight || 1.1;
      try {
        await stampTitleFacts(item, w);
        const d = await apiFetch(`/api/tmdb/3/${mt}/${item.id}/similar?language=en-US&page=1`);
        (d && d.results || []).slice(0, 12).forEach(r => {
          const k = `${r.id}:${mt}`;
          const prev = _missNeighborWeights.get(k) || 0;
          _missNeighborWeights.set(k, Math.max(prev, w));
        });
        if (typeof recomputeRecommendationsDebounced === 'function') recomputeRecommendationsDebounced(60);
      } catch (_) {}
    }

    // One credits + keywords fetch. A positive rating stores the facts on the row.
    // A negative weight also sinks that director's other films.
    async function stampTitleFacts(item, weight) {
      if (!item || item.id == null) return;
      const mt = item._mediaType === 'tv' ? 'tv' : 'movie';
      const w = Number(weight) || 0;
      try {
        const [cred, kw] = await Promise.all([
          apiFetch(`/api/tmdb/3/${mt}/${item.id}/credits`).catch(() => null),
          apiFetch(`/api/tmdb/3/${mt}/${item.id}/keywords`).catch(() => null),
        ]);
        const director = ((cred && cred.crew) || []).find(c => c.job === 'Director')
          || ((cred && cred.crew) || []).find(c => c.known_for_department === 'Directing');
        const keywordIds = (((kw && (kw.keywords || kw.results)) || []).map(k => k.id).filter(Boolean)).slice(0, 12);
        const patch = {};
        if (keywordIds.length) patch._keywordIds = keywordIds;
        if (director && director.id) {
          patch._directorId = director.id;
          patch._directorName = director.name || '';
        }
        if (Object.keys(patch).length && typeof patchLibraryItem === 'function') {
          patchLibraryItem(item.id, mt, patch);
          _likedSubTaste = null;
        }
        if (w > 0 && director && director.id) {
          _dislikedPersonScores[director.id] = (_dislikedPersonScores[director.id] || 0) + w;
          if (_dislikedPersonScores[director.id] >= 2) {
            const films = await apiFetch(`/api/tmdb/3/discover/movie?with_crew=${director.id}&sort_by=popularity.desc&page=1`).catch(() => null);
            (films && films.results || []).forEach(r => _dislikedPenaltyIds.add(`${r.id}:movie`));
          }
        }
        if (w > 0) {
          keywordIds.forEach(id => {
            _dislikedKeywordScores[id] = (_dislikedKeywordScores[id] || 0) + w * 0.35;
          });
        }
      } catch (_) {}
    }

    const REC_PAINT_KEY = 'brous_rec_paint_v1';

    function libraryStamp() {
      const w = (typeof watchedList !== 'undefined' ? watchedList : []);
      const q = (typeof toWatchList !== 'undefined' ? toWatchList : []);
      const d = (typeof dislikedList !== 'undefined' ? dislikedList : []);
      const n = (typeof notInterestedList !== 'undefined' ? notInterestedList : []);
      const head = (arr) => (arr[0] && arr[0].id) || 0;
      return [w.length, q.length, d.length, n.length, head(w), head(n), head(d)].join('.');
    }

    function slimRecItem(it) {
      if (!it || it.id == null) return null;
      return {
        id: it.id,
        title: it.title || it.name,
        _mediaType: it._mediaType || 'movie',
        poster_path: it.poster_path || null,
        release_date: it.release_date || it.first_air_date || '',
        vote_average: it.vote_average || 0,
        vote_count: it.vote_count || 0,
        genre_ids: it.genre_ids || [],
        overview: (it.overview || '').slice(0, 280),
        _score: it._score || 0,
        _affinityReason: it._affinityReason || null,
        _source: it._source || null,
        _seriesGap: !!it._seriesGap,
        _outside: !!it._outside,
        _togetherLabel: it._togetherLabel || null,
        imdb_rating: it.imdb_rating || null,
        imdb_votes: it.imdb_votes || 0,
        runtime: it.runtime || null,
      };
    }

    function saveRecPaint(items) {
      try {
        const slim = (items || []).map(slimRecItem).filter(Boolean).slice(0, 40);
        if (!slim.length) return;
        Store.setItem(REC_PAINT_KEY, JSON.stringify({ stamp: libraryStamp(), savedAt: Date.now(), items: slim }));
      } catch (_) {}
    }

    function loadRecPaint() {
      try {
        const raw = Store.getItem(REC_PAINT_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.items) || !data.items.length) return null;
        return data;
      } catch (_) { return null; }
    }

    function paintCachedRecommendations() {
      if (typeof currentRecPool !== 'undefined' && currentRecPool.length) return false;
      const data = loadRecPaint();
      if (!data) return false;
      currentRecPool = data.items.map(it => Object.assign({}, it));
      const same = data.stamp === libraryStamp();
      if (typeof setPoolProgress === 'function') {
        setPoolProgress(same ? 'Last picks · updating…' : 'Library changed · updating picks…');
      }
      if (typeof recomputeRecommendations === 'function') recomputeRecommendations();
      return true;
    }

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
      menu.style.cssText = 'position:fixed;z-index:80;background:#18181b;border:1px solid #3f3f46;border-radius:14px;padding:6px;min-width:200px;max-width:calc(100vw - 16px);max-height:70vh;overflow:auto;box-shadow:0 12px 24px rgba(0,0,0,0.4);';
      const mark = (on) => on ? '✓ ' : '';
      menu.innerHTML = `
        <div class="recs-menu-label">Show</div>
        <button type="button" class="recs-menu-item" onclick="setRecMediaFilter('all'); closeRecsActionsMenu();">${mark(recMediaFilter === 'all')}All</button>
        <button type="button" class="recs-menu-item" onclick="setRecMediaFilter('movie'); closeRecsActionsMenu();">${mark(recMediaFilter === 'movie')}Movies</button>
        <button type="button" class="recs-menu-item" onclick="setRecMediaFilter('tv'); closeRecsActionsMenu();">${mark(recMediaFilter === 'tv')}TV</button>
        <button type="button" class="recs-menu-item" onclick="toggleRecServicesOnly(); closeRecsActionsMenu();">${mark(!!recServicesOnly)}On my services</button>
        <div class="recs-menu-label">Genre</div>
        <div class="recs-menu-genres"></div>
        <div class="recs-menu-label">Posters</div>
        <button type="button" class="recs-menu-item" onclick="setRecDensity(3); closeRecsActionsMenu();">${mark(typeof recDensity !== 'undefined' && recDensity === 3)}Larger posters</button>
        <button type="button" class="recs-menu-item" onclick="setRecDensity(4); closeRecsActionsMenu();">${mark(!(typeof recDensity !== 'undefined') || recDensity !== 3)}More posters</button>
        <div class="recs-menu-label">Pool</div>
        <button type="button" class="recs-menu-item" onclick="refreshRecPool(); closeRecsActionsMenu();">Refresh picks</button>
        <button type="button" class="recs-menu-item" onclick="surpriseMe(); closeRecsActionsMenu();">Surprise me</button>
      `;
      const genreHost = menu.querySelector('.recs-menu-genres');
      if (genreHost) {
        const { list } = genreChoicesFromPool();
        const addGenreChip = (label, on, fn) => {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = on ? 'is-on' : '';
          chip.textContent = label;
          chip.onclick = (ev) => {
            ev.stopPropagation();
            fn();
            closeRecsActionsMenu();
          };
          genreHost.appendChild(chip);
        };
        addGenreChip('All', !keywordPoolActive && recGenreFilter == null, () => applyRecGenre(null));
        list.forEach(g => {
          addGenreChip(g.name, !keywordPoolActive && recGenreFilter === g.id, () => {
            applyRecGenre(recGenreFilter === g.id ? null : g.id);
          });
        });
        Object.entries(KEYWORD_POOLS).forEach(([key, pool]) => {
          addGenreChip(pool.label, keywordPoolActive === key, () => toggleKeywordPool(key));
        });
      }
      document.body.appendChild(menu);
      const rect = btn.getBoundingClientRect();
      const mw = Math.min(320, window.innerWidth - 16);
      menu.style.width = mw + 'px';
      menu.style.left = Math.max(8, Math.min(rect.right - mw, window.innerWidth - mw - 8)) + 'px';
      const top = rect.bottom + 6;
      const menuH = menu.offsetHeight || 280;
      menu.style.top = (top + menuH > window.innerHeight - 8 ? Math.max(8, rect.top - menuH - 6) : top) + 'px';
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
      if (!append) recVisibleLimit = REC_VISIBLE_START;
      // A throw here used to leave _recPoolLoading stuck, so every later
      // refresh and Show more returned immediately and the grid stayed empty.
      try { rebuildLikedSubTastes(); }
      catch (e) {
        console.warn('[Recs] Sub-taste rebuild failed:', e && e.message);
        _likedSubTaste = Object.create(null);
      }

      // A full rebuild replaces currentRecPool outright, so a stale keyword-pool snapshot
      // (see toggleKeywordPool) would no longer have anything sensible to restore later —
      // drop it rather than let the chip lie about being active.
      if (keywordPoolActive) { keywordPoolActive = null; _keywordPoolSnapshot = null; }

      const grid = document.getElementById('recs-grid');
      const empty = document.getElementById('recs-empty');
      const heroEl = document.getElementById('tonight-hero');
      const hasPaint = (grid && grid.querySelector('.rec-card')) || (heroEl && !heroEl.classList.contains('hidden'));
      if (typeof setPoolProgress === 'function') {
        setPoolProgress(append ? 'Looking deeper…' : (hasPaint ? 'Updating picks…' : 'Building affinity…'));
      }
      if (grid) {
        if (!append && !hasPaint) {
          grid.innerHTML = '';
          showSkeletons('recs-grid', 8);
        } else if (append) {
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
          const seeded = pickDistinctiveSeeds(watchedList, 8);
          const topRated = seeded.length ? seeded : [...watchedList]
            .filter(m => (m.rating || 0) >= 4 && m.id)
            .slice(0, 8);
          const seedMean = libraryRatingMean(watchedList);
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
                const w = Math.max(0.45, ratingAffinityWeight(topRatedMovies[i].rating, seedMean));
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
                const w = Math.max(0.4, ratingAffinityWeight(topRatedMovies[i].rating, seedMean));
                (res.value.keywords || []).forEach(kw => { kwCounts[kw.id] = (kwCounts[kw.id] || 0) + w; });
              });
              const topKeywordIds = Object.entries(kwCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => id);

              // Franchise siblings from belongs_to_collection + runtime for tonight-fit
              const colIds = new Set();
              detResults.forEach((res, i) => {
                if (res.status !== 'fulfilled' || !res.value) return;
                const m = topRatedMovies[i];
                if (m && res.value.runtime) {
                  _runtimeByKey[`${m.id}:movie`] = res.value.runtime;
                }
                if (res.value.belongs_to_collection?.id) {
                  colIds.add(res.value.belongs_to_collection.id);
                }
              });
              if (colIds.size) {
                const colResults = await Promise.allSettled([...colIds].map(id => apiFetch(`/api/tmdb/3/collection/${id}?language=en-US`)));
                colResults.forEach(res => {
                  if (res.status !== 'fulfilled') return;
                  const colId = res.value && res.value.id;
                  (res.value.parts || []).forEach(p => {
                    const py = parseInt((p.release_date || '').slice(0, 4));
                    if (p.poster_path && p.original_language === 'en' && py && py >= REC_MIN_YEAR)
                      affinityTagged.push({
                        ...p,
                        _mediaType: 'movie',
                        _affinityReason: `Next in a series you rated`,
                        _affinityBoost: 1.15,
                        _collectionId: colId || null,
                        _source: 'collection',
                        _seriesGap: true,
                      });
                  });
                });
              }

              // Affinity discover URLs (director / actor / keyword) — fetched with tagging
              const affinityUrls = [];
              Object.entries(personScores)
                .filter(([, p]) => p.type === 'director' && p.score >= 1)
                .sort((a, b) => b[1].score - a[1].score).slice(0, 3)
                .forEach(([id, p]) => {
                  const base2 = `/api/tmdb/3/discover/movie?with_crew=${id}&with_origin_country=US&primary_release_date.gte=${REC_MIN_YEAR}-01-01&sort_by=vote_average.desc&vote_count.gte=150`;
                  affinityUrls.push({ url: `${base2}&page=1`, reason: `Directed by ${p.name}`, boost: 2.0 });
                  affinityUrls.push({ url: `${base2}&page=2`, reason: `Directed by ${p.name}`, boost: 2.0 });
                  affinityUrls.push({ url: `/api/tmdb/3/discover/movie?with_crew=${id}&with_origin_country=US&primary_release_date.gte=${REC_RECENT_YEAR}-01-01&sort_by=popularity.desc&page=1`, reason: `Directed by ${p.name}`, boost: 2.1 });
                });
              Object.entries(personScores)
                .filter(([, p]) => p.type === 'actor' && p.score >= 0.7)
                .sort((a, b) => b[1].score - a[1].score).slice(0, 3)
                .forEach(([id, p]) => {
                  affinityUrls.push({ url: `/api/tmdb/3/discover/movie?with_cast=${id}&with_origin_country=US&primary_release_date.gte=${REC_MIN_YEAR}-01-01&sort_by=vote_average.desc&vote_count.gte=150&page=1`, reason: `Stars ${p.name}`, boost: 1.2 });
                  affinityUrls.push({ url: `/api/tmdb/3/discover/movie?with_cast=${id}&with_origin_country=US&primary_release_date.gte=${REC_RECENT_YEAR}-01-01&sort_by=popularity.desc&page=1`, reason: `Stars ${p.name}`, boost: 1.25 });
                });
              if (topKeywordIds.length) {
                const kwStr = topKeywordIds.slice(0, 5).join('|');
                const kwIds = topKeywordIds.slice(0, 5).map(Number);
                affinityUrls.push({ url: `/api/tmdb/3/discover/movie?with_keywords=${kwStr}&with_origin_country=US&primary_release_date.gte=${REC_MIN_YEAR}-01-01&sort_by=vote_average.desc&vote_count.gte=150&page=1`, reason: `Matches your themes`, boost: 0.8, keywordIds: kwIds });
                affinityUrls.push({ url: `/api/tmdb/3/discover/movie?with_keywords=${kwStr}&with_origin_country=US&primary_release_date.gte=${REC_RECENT_YEAR}-01-01&sort_by=popularity.desc&page=1`, reason: `Matches your themes`, boost: 0.9, keywordIds: kwIds });
              }

              // Fetch affinity URLs sequentially (small set, need to tag results)
              for (const { url, reason, boost, keywordIds } of affinityUrls) {
                try {
                  const d = await apiFetch(url).catch(() => null);
                  (d?.results || []).forEach(r => {
                    let adjBoost = boost;
                    // If this row came from a keyword discover, soft-cut boost when those
                    // themes overlap keywords the user has repeatedly disliked.
                    if (keywordIds && keywordIds.length && _dislikedKeywordScores) {
                      let pen = 0;
                      keywordIds.forEach(id => { pen += _dislikedKeywordScores[id] || 0; });
                      if (pen > 0) adjBoost -= Math.min(boost, 0.35 * Math.sqrt(pen));
                    }
                    affinityTagged.push({
                      ...r,
                      _mediaType: 'movie',
                      _affinityReason: reason,
                      _affinityBoost: adjBoost,
                      _affinityKeywordIds: keywordIds || null,
                    });
                  });
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
                const w = Math.max(0.45, ratingAffinityWeight(topRatedTv[i].rating, seedMean));
                // TV credits don't reliably expose a "Director" job on /credits; cast carries the signal.
                (res.value.cast || []).slice(0, 3).forEach(c => {
                  if (!tvPersonScores[c.id]) tvPersonScores[c.id] = { name: c.name, score: 0, type: 'actor' };
                  tvPersonScores[c.id].score += w * 0.4;
                });
              });

              const tvKwCounts = {};
              tvKwResults.forEach((res, i) => {
                if (res.status !== 'fulfilled') return;
                const w = Math.max(0.4, ratingAffinityWeight(topRatedTv[i].rating, seedMean));
                // /tv/{id}/keywords returns { results: [...] } rather than { keywords: [...] }
                (res.value.results || res.value.keywords || []).forEach(kw => { tvKwCounts[kw.id] = (tvKwCounts[kw.id] || 0) + w; });
              });
              const topTvKeywordIds = Object.entries(tvKwCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => id);

              const tvAffinityUrls = [];
              Object.entries(tvPersonScores)
                .filter(([, p]) => p.type === 'actor' && p.score >= 0.7)
                .sort((a, b) => b[1].score - a[1].score).slice(0, 3)
                .forEach(([id, p]) => {
                  tvAffinityUrls.push({ url: `/api/tmdb/3/discover/tv?with_cast=${id}&with_origin_country=US&first_air_date.gte=${REC_MIN_YEAR}-01-01&sort_by=vote_average.desc&vote_count.gte=80&page=1`, reason: `Stars ${p.name}`, boost: 1.2 });
                });
              if (topTvKeywordIds.length) {
                const kwStr = topTvKeywordIds.slice(0, 5).join('|');
                tvAffinityUrls.push({ url: `/api/tmdb/3/discover/tv?with_keywords=${kwStr}&with_origin_country=US&first_air_date.gte=${REC_MIN_YEAR}-01-01&sort_by=popularity.desc&page=1`, reason: `Matches your themes`, boost: 0.8 });
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

        // ── PHASE 1b: Neighborhood of misses ──
        // A pass, a dislike, or a 1–3 does not downrank the genre Horror. It downranks
        // the director, the keywords, and the films TMDB lists as similar.
        // Weight >= 2 on a director (one 2★, or two dislikes) pulls that filmography down.
        if (!append) {
          _dislikedPersonScores = {};
          _dislikedKeywordScores = {};
          _dislikedPenaltyIds = new Set();
          _missNeighborWeights = new Map();
          const misses = [];
          const pushMiss = (m, weight) => {
            if (!m || !m.id) return;
            const mt = m._mediaType === 'tv' ? 'tv' : 'movie';
            const key = `${m.id}:${mt}`;
            if (misses.some(x => x.key === key)) return;
            misses.push({ m, weight, key, mt });
          };
          (watchedList || []).filter(m => (m.rating || 0) >= 1 && (m.rating || 0) <= 2).slice(0, 8)
            .forEach(m => pushMiss(m, 2.2));
          (watchedList || []).filter(m => m.rating === 3).slice(0, 6)
            .forEach(m => pushMiss(m, 1.5));
          (dislikedList || []).slice(0, 8).forEach(m => pushMiss(m, 1.8));
          (typeof notInterestedList !== 'undefined' ? notInterestedList : []).slice(0, 8)
            .forEach(m => pushMiss(m, 1.1));
          const movieMisses = misses.filter(x => x.mt === 'movie').slice(0, 14);
          if (movieMisses.length) {
            try {
              movieMisses.forEach(x => {
                if (x.m._directorId) {
                  _dislikedPersonScores[x.m._directorId] = (_dislikedPersonScores[x.m._directorId] || 0) + x.weight;
                }
                (x.m._keywordIds || []).forEach(id => {
                  _dislikedKeywordScores[id] = (_dislikedKeywordScores[id] || 0) + x.weight;
                });
              });
              const credN = movieMisses.filter(x => !x.m._directorId).slice(0, 10);
              const kwN = movieMisses.filter(x => !(x.m._keywordIds && x.m._keywordIds.length)).slice(0, 8);
              const simN = movieMisses.slice(0, 8);
              const [dCred, dKw, dSim] = await Promise.all([
                Promise.allSettled(credN.map(x => apiFetch(`/api/tmdb/3/movie/${x.m.id}/credits`))),
                Promise.allSettled(kwN.map(x => apiFetch(`/api/tmdb/3/movie/${x.m.id}/keywords`))),
                Promise.allSettled(simN.map(x => apiFetch(`/api/tmdb/3/movie/${x.m.id}/similar?language=en-US&page=1`))),
              ]);
              dCred.forEach((res, i) => {
                if (res.status !== 'fulfilled') return;
                const w = credN[i].weight;
                (res.value.crew || []).filter(c => c.job === 'Director').forEach(c => {
                  _dislikedPersonScores[c.id] = (_dislikedPersonScores[c.id] || 0) + w;
                });
              });
              dKw.forEach((res, i) => {
                if (res.status !== 'fulfilled') return;
                const w = kwN[i].weight;
                (res.value.keywords || []).forEach(kw => {
                  _dislikedKeywordScores[kw.id] = (_dislikedKeywordScores[kw.id] || 0) + w;
                });
              });
              dSim.forEach((res, i) => {
                if (res.status !== 'fulfilled') return;
                const w = simN[i].weight;
                (res.value.results || []).slice(0, 12).forEach(r => {
                  const k = `${r.id}:movie`;
                  const prev = _missNeighborWeights.get(k) || 0;
                  _missNeighborWeights.set(k, Math.max(prev, w));
                });
              });
              const strongDislikedDirectors = Object.entries(_dislikedPersonScores)
                .filter(([, n]) => n >= 2)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 4)
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
              console.warn('[Recs] Miss-neighborhood phase error (non-fatal):', e.message);
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
        const minDate = `${REC_MIN_YEAR}-01-01`;
        const recentDate = `${REC_RECENT_YEAR}-01-01`;
        const freshDate = `${REC_FRESH_YEAR}-01-01`;
        // Main discover: 2000+ only (was 1960 — that pulled decades of classics into every pool).
        const genreQ = (append && recGenreFilter) ? `&with_genres=${recGenreFilter}` : '';
        const base = `/api/tmdb/3/discover/movie?language=en-US&include_adult=false&with_original_language=en&with_origin_country=US&without_genres=${MOVIE_EXCL}${genreQ}&primary_release_date.gte=${minDate}&vote_count.gte=80&vote_average.gte=5.5`;
        const tvBase = `/api/tmdb/3/discover/tv?language=en-US&include_adult=false&with_original_language=en&with_origin_country=US&without_genres=${TV_EXCL}${genreQ}&first_air_date.gte=${minDate}&vote_count.gte=80&vote_average.gte=5.5`;
        // Extra weight on recent / fresh windows so the pool isn't all 2000s mid-tier.
        const recentBase = `${base}&primary_release_date.gte=${recentDate}`;
        const freshBase = `${base}&primary_release_date.gte=${freshDate}`;
        const tvRecentBase = `${tvBase}&first_air_date.gte=${recentDate}`;
        const pageCount = 8;
        const startPage = append ? recPageCursor : (1 + Math.floor(Math.random() * 12));
        const urls = []; // { url, type }
        for (let i = 0; i < pageCount; i++) {
          const page = Math.min(startPage + i, 200);
          urls.push({ url: `${base}&sort_by=popularity.desc&page=${page}`, type: 'movie' });
          urls.push({ url: `${base}&sort_by=primary_release_date.desc&page=${page}`, type: 'movie' });
        }
        // Heavy recent / fresh passes
        for (let i = 0; i < 6; i++) {
          const page = Math.min(1 + i, 40);
          urls.push({ url: `${recentBase}&sort_by=popularity.desc&page=${page}`, type: 'movie' });
          urls.push({ url: `${freshBase}&sort_by=popularity.desc&page=${page}`, type: 'movie' });
          urls.push({ url: `${recentBase}&sort_by=vote_average.desc&page=${page}`, type: 'movie' });
        }
        // TV — lighter share, still recent-biased
        for (let i = 0; i < Math.ceil(pageCount / 2); i++) {
          const page = Math.min(startPage + i, 120);
          urls.push({ url: `${tvBase}&sort_by=popularity.desc&page=${page}`, type: 'tv' });
          urls.push({ url: `${tvBase}&sort_by=first_air_date.desc&page=${page}`, type: 'tv' });
        }
        for (let i = 0; i < 4; i++) {
          urls.push({ url: `${tvRecentBase}&sort_by=popularity.desc&page=${1 + i}`, type: 'tv' });
        }
        // Outside the usual genre. Kept in the pool so it can be scored, and pulled
        // into its own row so it does not have to beat a horror-heavy grid to be seen.
        if (!append) {
          const outsideBase = `/api/tmdb/3/discover/movie?language=en-US&include_adult=false&with_original_language=en&with_origin_country=US&without_genres=27,${MOVIE_EXCL}&primary_release_date.gte=${minDate}&vote_count.gte=400&vote_average.gte=6.2`;
          urls.push({ url: `${outsideBase}&sort_by=popularity.desc&page=1`, type: 'movie', outside: true });
          urls.push({ url: `${outsideBase}&sort_by=popularity.desc&page=2`, type: 'movie', outside: true });
          urls.push({ url: `${outsideBase}&with_genres=878&sort_by=vote_average.desc&vote_count.gte=200&page=1`, type: 'movie', outside: true });
          urls.push({ url: `${outsideBase}&with_genres=80&sort_by=popularity.desc&page=1`, type: 'movie', outside: true });
        }
        urls.push({ url: `/api/tmdb/3/trending/movie/week`, type: 'movie' });
        urls.push({ url: `/api/tmdb/3/trending/tv/week`, type: 'tv' });
        // Popular only (skip top_rated — it is heavily classic-biased)
        for (let i = 0; i < 4; i++) {
          const page = Math.min(startPage + i, 80);
          urls.push({ url: `/api/tmdb/3/movie/popular?language=en-US&page=${page}`, type: 'movie' });
        }
        for (let i = 0; i < 2; i++) {
          const page = Math.min(startPage + i, 40);
          urls.push({ url: `/api/tmdb/3/tv/popular?language=en-US&page=${page}`, type: 'tv' });
        }
        // Dedicated horror pass — also recent-biased
        const horrorBase = `/api/tmdb/3/discover/movie?language=en-US&include_adult=false&with_original_language=en&with_origin_country=US&with_genres=27&without_genres=${MOVIE_EXCL}&primary_release_date.gte=${minDate}&vote_count.gte=25&vote_average.gte=4.3`;
        const horrorRecent = `${horrorBase}&primary_release_date.gte=${recentDate}`;
        for (let i = 0; i < 6; i++) {
          const page = Math.min(startPage + i, 120);
          urls.push({ url: `${horrorBase}&sort_by=popularity.desc&page=${page}`, type: 'movie' });
          urls.push({ url: `${horrorRecent}&sort_by=popularity.desc&page=${page}`, type: 'movie' });
        }
        for (let i = 0; i < 3; i++) {
          urls.push({ url: `${horrorRecent}&sort_by=primary_release_date.desc&page=${1 + i}`, type: 'movie' });
        }
        // Similar/recommendations from top-rated watches (movie + TV, each via its own endpoint)
        // Tagged with _source so scoreItem can boost them as concrete item-to-item signals (A1).
        if (!append && watchedList.length) {
          const neighborSeeds = pickDistinctiveSeeds(watchedList, 5);
          const topRatedAll = neighborSeeds.length ? neighborSeeds : [...watchedList].filter(m => (m.rating || 0) >= 4 && m.id).slice(0, 5);
          topRatedAll.forEach(m => {
            const mt = m._mediaType === 'tv' ? 'tv' : 'movie';
            const who = String(m.title || m.name || 'a film you rated').trim().slice(0, 42);
            urls.push({ url: `/api/tmdb/3/${mt}/${m.id}/similar?language=en-US&page=1`, type: mt, source: 'similar', reason: `Like ${who}` });
            urls.push({ url: `/api/tmdb/3/${mt}/${m.id}/recommendations?language=en-US&page=1`, type: mt, source: 'recommendations', reason: `Like ${who}` });
          });
        }

        // Concurrency-limited fetch
        const CONCURRENCY = 5;
        let urlIndex = 0;
        async function worker() {
          while (urlIndex < urls.length) {
            const { url: u, type, source, outside, reason } = urls[urlIndex++];
            const tagResults = (results) => (results || []).map(r => {
              const row = { ...r, _mediaType: type };
              if (source === 'similar' || source === 'recommendations') {
                row._source = source;
                row._affinityReason = reason || row._affinityReason || null;
                row._affinityBoost = Math.max(row._affinityBoost || 0, source === 'similar' ? 1.15 : 1.25);
              }
              if (outside) {
                row._outside = true;
                if (!row._affinityReason) row._affinityReason = 'Outside your usual taste';
              }
              return row;
            });
            try {
              const d = await apiFetch(u);
              raw = raw.concat(tagResults(d.results));
            } catch (_) {
              try {
                await new Promise(r => setTimeout(r, 500));
                const d = await apiFetch(u);
                raw = raw.concat(tagResults(d.results));
              } catch (_) {}
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
          // Series gaps keep a non-English sequel the user has not logged ([REC]³).
          // The rest of the pool stays English and American.
          const seriesGap = !!r._seriesGap;
          return !excluded.has(key) && ((seriesGap && r.poster_path) || (r.vote_average || 0) >= ratingFloor) && r.poster_path
            && (seriesGap || r.original_language === 'en') && (seriesGap || isAmerican) && !r.adult && isRecPoolEligible(mt, r.genre_ids)
            && year && year >= (seriesGap ? 1970 : REC_MIN_YEAR);
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
          const rt = r.runtime || r._runtime || _runtimeByKey[`${r.id}:${mt}`] || null;
          return {
            id: r.id, title: mt === 'tv' ? (r.name || r.title) : (r.title || r.name), _mediaType: mt,
            poster_path: r.poster_path, release_date: mt === 'tv' ? (r.first_air_date || r.release_date) : (r.release_date || r.first_air_date),
            vote_average: r.vote_average, vote_count: r.vote_count || 0,
            genre_ids: r.genre_ids || [], overview: r.overview || '', popularity: r.popularity || 0,
            runtime: rt,
            _affinityReason: reason, _affinityBoost: boost,
            _affinityKeywordIds: r._affinityKeywordIds || null,
            _collectionId: r._collectionId || null,
            _source: r._source || null,
            _seriesGap: !!r._seriesGap,
            _outside: !!r._outside,
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
        if (typeof setPoolProgress === 'function') setPoolProgress(currentRecPool.length ? `Scoring ${currentRecPool.length} titles…` : '');
        if (!currentRecPool.length) {
          if (grid && !grid.querySelector('.rec-card')) {
            grid.innerHTML = `<div class="text-center py-8 text-zinc-400 text-sm col-span-full">No results loaded. Set the password in Settings → Advanced, then refresh.</div>`;
          }
        } else {
          recomputeRecommendations();
        }
      } catch (e) {
        console.error('[Recs] Refresh pool failed:', e);
        let poolMsg = 'Failed to load recommendations. Check Settings → Advanced, then your connection.';
        if (e.status === 401) poolMsg = 'Wrong password. Set it in Settings → Advanced.';
        if (grid && !grid.querySelector('.rec-card')) {
          grid.innerHTML = `<div class="text-center py-8 text-red-400 text-sm col-span-full">${poolMsg}</div>`;
        } else if (typeof setPoolProgress === 'function') {
          setPoolProgress(poolMsg);
        }
      } finally {
        const loading = document.getElementById('recs-loading-more');
        if (loading) loading.remove();
        _recPoolLoading = false;
        if (typeof setPoolProgress === 'function') setTimeout(() => setPoolProgress(''), 600);
      }
    }

    async function loadMoreRecommendations() {
      if (_recPoolLoading) return;
      if (!currentRecPool.length) {
        await refreshRecPool();
        return;
      }
      const before = document.querySelectorAll('#recs-grid .rec-card').length;
      recVisibleLimit += REC_VISIBLE_STEP;
      await recomputeRecommendations();
      const after = document.querySelectorAll('#recs-grid .rec-card').length;
      const reveal = () => {
        const cards = document.querySelectorAll('#recs-grid .rec-card');
        const firstNew = cards[before];
        if (firstNew && cards.length > before) firstNew.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      };
      if (after > before) {
        reveal();
        return;
      }
      // The ranked list is already on screen. Pull a deeper page, still
      // inside the raised window so the new titles can actually paint.
      await refreshRecPool({ append: true });
      reveal();
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
          if (grid) grid.innerHTML = `<div class="empty-state col-span-full"><span class="empty-state-icon">🎥</span><div class="text-zinc-300 font-medium">No found-footage titles loaded</div><div class="text-zinc-500 text-xs mt-1">Check Settings → Advanced, or your connection.</div></div>`;
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
          if (grid) grid.innerHTML = `<div class="empty-state col-span-full"><span class="empty-state-icon">🐙</span><div class="text-zinc-300 font-medium">No cosmic-horror titles loaded</div><div class="text-zinc-500 text-xs mt-1">Check Settings → Advanced, or your connection.</div></div>`;
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
      picks.forEach((item, idx) => {
        const card = document.createElement('div');
        card.className = 'movie-card rec-card bg-zinc-900 border border-zinc-700 rounded-3xl flex flex-col';
        if (typeof applyCardStagger === 'function') applyCardStagger(card, idx);
        const poster = item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : FALLBACK_POSTER;
        const year = (item.release_date || '').slice(0,4);
        const imdbRating = typeof imdbScoreText === 'function' ? imdbScoreText(item) : null;
        const ratingBadgeClass = (item.imdb_rating || 0) >= 7.5 ? 'high' : (item.imdb_rating || 0) >= 6 ? '' : 'low';
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
    ${imdbRating ? `<span class="rating-badge ${ratingBadgeClass}" style="font-size:10px;padding:2px 5px;" title="IMDb ${imdbRating}/10">IMDb ${imdbRating}</span>` : ''}
    ${imdbBadgeHtml(item, `imdb-si-${item.id}`)}
    <a href="${rtSearchUrl}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-[11px] px-1.5 py-1 rounded bg-[#fa320a] text-white font-bold no-underline">RT</a>
  </div>
  <button class="why-this-btn text-[10px] text-amber-400/80 mt-1.5 text-left w-full truncate hover:text-emerald-300 transition-colors" title="Why this recommendation?">🎲 Outside your usual taste</button>
  ${typeof wtwBlockHtml === 'function' ? wtwBlockHtml(item.id, item._mediaType || 'movie', { compact: true }) : `<div id="wtw-rec-${item.id}-${item._mediaType || 'movie'}" class="wtw-rec-slot mt-1"></div>`}
</div>
<div class="mt-2 flex gap-1 items-center" style="position:relative;">
  <button class="flex-1 min-w-0 text-[11px] px-2 py-1.5 rounded-2xl bg-emerald-700 hover:bg-emerald-600 text-white font-medium" data-act="towatch" aria-label="Add ${itemTitleSafe} to To Watch">+ Queue</button>
  <button class="text-[11px] px-2 py-1.5 rounded-2xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 font-medium" data-act="watched" aria-label="Mark ${itemTitleSafe} as watched">✓</button>
  <button class="text-[11px] px-2 py-1.5 rounded-2xl border border-zinc-700 text-zinc-300" data-act="pass" aria-label="Pass on ${itemTitleSafe}">Pass</button>
  <button id="trailer-si-${item.id}" class="text-[11px] px-2 py-1.5 rounded-2xl border border-zinc-700 text-zinc-500 hidden" data-act="trailer" title="Watch Trailer" aria-label="Play trailer for ${itemTitleSafe}">▶</button>
</div>`;
        card.querySelector('[data-act="towatch"]').onclick = () => { addToToWatch(item); card.remove(); };
        card.querySelector('[data-act="watched"]').onclick = () => {
          openInlineRatingPrompt(card, item, r => {
            const finish = () => { addToWatched(item, r); };
            if (typeof animateCardExit === 'function') animateCardExit(card, 'watched').then(finish);
            else finish();
          }, { hideButtons: Array.from(card.querySelectorAll('[data-act]')), sheet: true });
        };
        const surprisePass = card.querySelector('[data-act="pass"]');
        if (surprisePass) surprisePass.onclick = () => {
          const go = () => { addToNotInterested(item); };
          if (typeof animateCardExit === 'function') animateCardExit(card, 'hide').then(go);
          else go();
        };
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

    /**
     * Soft-remove one title from For You UI without rebuilding the whole grid.
     * Remaining cards stay put and “move up” in layout as the gap closes.
     */
    function softRemoveRecFromUI(id, mediaType) {
      const mt = mediaType === 'tv' ? 'tv' : 'movie';
      const key = `${id}:${mt}`;
      const reduced = typeof prefersReducedMotion === 'function' && prefersReducedMotion();

      // Grid card
      const grid = document.getElementById('recs-grid');
      if (grid) {
        let card = null;
        const slot = document.getElementById(`wtw-rec-${id}-${mt}`);
        if (slot) card = slot.closest('.rec-card, .movie-card');
        if (!card) {
          grid.querySelectorAll('.rec-card, .movie-card').forEach(c => {
            if (card) return;
            const w = c.querySelector(`[id^="wtw-rec-${id}-"]`);
            if (w) card = c;
          });
        }
        if (card && card.isConnected) {
          if (reduced) {
            card.remove();
          } else if (!card.classList.contains('card-exit-watched') && !card.classList.contains('card-exit-hide')) {
            card.style.pointerEvents = 'none';
            card.classList.add('card-exit-watched');
            setTimeout(() => { try { card.remove(); } catch (_) {} }, 300);
          } else {
            setTimeout(() => { try { card.remove(); } catch (_) {} }, 280);
          }
        }
      }

      // Tonight hero: if this was the pick, promote the next remaining grid card or re-score lightly
      const hero = document.getElementById('tonight-hero');
      if (hero && !hero.classList.contains('hidden') && hero.dataset.tonightKey === key) {
        // Prefer the first remaining rec-card as the new visual hero candidate from pool
        const nextFromPool = (typeof currentRecPool !== 'undefined' && currentRecPool.length)
          ? currentRecPool[0]
          : null;
        if (nextFromPool && typeof writeTonightPin === 'function') {
          writeTonightPin(nextFromPool);
        } else if (typeof clearTonightPin === 'function') {
          clearTonightPin(id, mt);
        }
        // Rebuild hero only (full recompute would reshuffle the grid)
        try {
          softRefreshTonightHeroOnly();
        } catch (_) {
          if (typeof recomputeRecommendationsDebounced === 'function') recomputeRecommendationsDebounced(500);
        }
      }

      if (typeof updateHomeSnapshot === 'function') {
        try { updateHomeSnapshot(); } catch (_) {}
      }
      if (typeof renderTasteStats === 'function') {
        try { renderTasteStats(); } catch (_) {}
      }
    }

    /** Re-pick Tonight’s hero from the current pool without wiping #recs-grid. */
    function softRefreshTonightHeroOnly() {
      if (typeof buildTasteProfile !== 'function' || typeof scoreItem !== 'function') return;
      const profile = buildTasteProfile();
      const poolStats = typeof computePoolStats === 'function' ? computePoolStats(currentRecPool) : null;
      const excluded = typeof getExcludedKeys === 'function' ? getExcludedKeys() : new Set();
      let scored = (currentRecPool || [])
        .filter(it => !excluded.has(`${it.id}:${it._mediaType || 'movie'}`))
        .map(it => ({ ...it, _score: scoreItem(it, profile, poolStats) }))
        .sort((a, b) => b._score - a._score);
      if (typeof recMediaFilter !== 'undefined' && recMediaFilter !== 'all') {
        scored = scored.filter(it => (it._mediaType || 'movie') === recMediaFilter);
      }
      if (typeof recGenreFilter !== 'undefined' && recGenreFilter !== null) {
        scored = scored.filter(it => (it.genre_ids || []).includes(recGenreFilter));
      }
      let display = scored.slice(0, 12);
      if (typeof applyTonightPin === 'function') display = applyTonightPin(display, scored);
      const heroItem = display.find(it => !it._outside && !it._seriesGap && it._source !== 'collection') || display[0] || null;
      const matchLabel = (item) => recMatchLabel(item, profile, poolStats);
      if (typeof renderTonightHero === 'function') {
        renderTonightHero(heroItem, matchLabel, null, profile.decadeCounts, null, null);
      }
      // Drop the new hero from the grid if it was double-featured there
      if (heroItem) {
        const mt = heroItem._mediaType === 'tv' ? 'tv' : 'movie';
        const slot = document.getElementById(`wtw-rec-${heroItem.id}-${mt}`);
        const card = slot && slot.closest('.rec-card, .movie-card');
        if (card) card.remove();
      }
    }

    function renderTasteLanes(gapItems, outsideItems, matchLabel) {
      const paint = (id, title, sub, items) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (!items || !items.length) {
          el.classList.add('hidden');
          el.innerHTML = '';
          return;
        }
        el.classList.remove('hidden');
        const cards = items.map(item => {
          const mt = item._mediaType === 'tv' ? 'tv' : 'movie';
          const name = item.title || item.name || 'Untitled';
          const year = (item.release_date || item.first_air_date || '').slice(0, 4);
          const poster = item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : FALLBACK_POSTER;
          const why = typeof matchLabel === 'function' ? matchLabel(item) : '';
          return `<article class="rec-lane-card" data-lane-id="${item.id}" data-lane-mt="${mt}">
            <img src="${poster}" alt="${escapeHtml(name)} poster" loading="lazy" onerror="this.onerror=null;this.src='${FALLBACK_POSTER}'">
            <div class="rec-lane-title-line">${escapeHtml(name)}</div>
            <div class="rec-lane-meta">${year ? escapeHtml(year) : ''}${why ? ` · ${escapeHtml(why)}` : ''}</div>
            <div class="rec-lane-actions">
              <button type="button" data-lane="queue">Queue</button>
              <button type="button" data-lane="pass">Pass</button>
            </div>
          </article>`;
        }).join('');
        el.innerHTML = `<div class="rec-lane-head"><div><div class="rec-lane-kicker">${escapeHtml(title)}</div><div class="rec-lane-sub">${escapeHtml(sub)}</div></div></div><div class="rec-lane-scroller">${cards}</div>`;
        el.querySelectorAll('.rec-lane-card').forEach(card => {
          const id = Number(card.dataset.laneId);
          const mt = card.dataset.laneMt === 'tv' ? 'tv' : 'movie';
          const item = items.find(it => it.id === id && (it._mediaType === 'tv' ? 'tv' : 'movie') === mt);
          if (!item) return;
          card.querySelector('[data-lane="queue"]').onclick = (e) => {
            e.stopPropagation();
            addToToWatch(item);
            card.remove();
          };
          card.querySelector('[data-lane="pass"]').onclick = (e) => {
            e.stopPropagation();
            addToNotInterested(item);
            card.remove();
          };
          card.addEventListener('click', () => {
            if (typeof openModal === 'function') openModal(item, { sourceEl: card.querySelector('img') || card });
          });
        });
      };
      paint('series-gap-row', 'Finish the series', 'Unseen films from a series you already rated', gapItems);
      paint('outside-taste-row', 'Outside the usual', 'Not another pass through the same genres', outsideItems);
    }

    async function recomputeRecommendations() {
      const grid = document.getElementById('recs-grid');
      const empty = document.getElementById('recs-empty');
      const heroEl = document.getElementById('tonight-hero');
      if (!grid) return;
      const gen = ++_recomputeGen;
      syncRecServicesToggleUI();

      if (!currentRecPool.length) {
        grid.innerHTML = '';
        if (heroEl) { heroEl.classList.add('hidden'); heroEl.innerHTML = ''; }
        renderTasteLanes([], [], null);
        if (empty) {
          empty.classList.remove('hidden');
          // Only auto-trigger once — the _recPoolLoading guard prevents loops
          if (!_recPoolLoading) {
            empty.innerHTML = `<span class="empty-state-icon">🎬</span><div class="text-zinc-300 font-medium">Loading recommendations...</div><div class="text-zinc-500 text-xs mt-1">Building your ranked pool.</div>`;
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

      scored.sort((a, b) => b._score - a._score);

      // Optional: only titles streaming on the user's subscribed services.
      // Don't clear the rows before this await. A newer recompute can start while
      // providers load, and wiping here would erase the rows that newer pass just painted.
      if (recServicesOnly && myServices.size) {
        if (typeof showSkeletons === 'function') showSkeletons('recs-grid', 8);
        else grid.innerHTML = `<div class="col-span-full text-center py-8 text-sm text-zinc-500">Checking what’s on your services…</div>`;
        if (heroEl) { heroEl.classList.add('hidden'); heroEl.innerHTML = ''; }
        scored = await filterScoredToMyServices(scored, 56);
        if (gen !== _recomputeGen) return;
      }

      if (!scored.length) {
        if (gen !== _recomputeGen) return;
        if (heroEl) { heroEl.classList.add('hidden'); heroEl.innerHTML = ''; }
        renderTasteLanes([], [], null);
        const mediaHint = recMediaFilter === 'tv' ? 'No TV shows in the current pool. ' : recMediaFilter === 'movie' ? 'No movies in the current pool. ' : '';
        const svcHint = recServicesOnly
          ? 'Nothing ranked is currently streaming on your services. Turn off “On my services” or refresh picks.'
          : `${mediaHint}Use Show more for deeper pages and less obvious titles.`;
        grid.innerHTML = `<div class="empty-state col-span-full">
          <span class="empty-state-icon">🎬</span>
          <div class="text-zinc-300 font-medium">${recServicesOnly ? 'No matches on your services' : 'This pool is tapped out'}</div>
          <div class="text-zinc-500 text-xs mt-1">${svcHint}</div>
          <div class="flex items-center justify-center gap-2 mt-4 flex-wrap">
            ${recServicesOnly ? `<button onclick="toggleRecServicesOnly()" class="text-xs px-4 py-2 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-200 hover:bg-zinc-700 transition-colors">Show all picks</button>` : ''}
            <button onclick="loadMoreRecommendations()" class="text-xs px-4 py-2 rounded-full bg-red-700 hover:bg-red-600 active:bg-red-500 text-white font-semibold transition-colors">Show more</button>
            <button onclick="switchMainTab('browse')" class="text-xs px-4 py-2 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-200 hover:bg-zinc-700 transition-colors">Browse instead</button>
          </div>
        </div>`;
        return;
      }
      // Diversity + franchise de-dupe so the top 40 isn't one genre or one sequel chain (A4)
      let display = recGenreFilter !== null
        ? takeWithFranchiseDedupe(scored, recVisibleLimit)
        : diversifyWithFranchiseCap(scored, recVisibleLimit);
      // Keep Tonight's pick stable across recomputes until the user acts on it.
      display = applyTonightPin(display, scored);

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
      // Named titles require a director, a series, a keyword neighbor, or a genre
      // that is not on most of the library. Horror-only overlap stays a genre line.
      function bestSimilarWatched(item) {
        return recSimilarWatched(item, watchedList);
      }
      function matchLabel(item) {
        return recMatchLabel(item, profile, poolStats);
      }
      function whyDetailHtml(item) {
        const gNames = (item.genre_ids || []).map(id => GENRES.find(g => g.id === id)?.name).filter(Boolean);
        const year = parseInt((item.release_date || '').slice(0, 4));
        const decade = year ? Math.floor(year / 10) * 10 : null;
        const decadeFits = decade && decadeCounts[decade] > 0;
        const comboNames = bestGenrePair(item.genre_ids || []);
        const similar = bestSimilarWatched(item);
        const detail = scoreItemDetailed(item, profile, poolStats);
        const p = detail.parts;
        const lines = [];
        lines.push(`<div class="why-pop-title">${escapeHtml(matchLabel(item))}</div>`);
        if (similar) {
          lines.push(`<div class="why-pop-line">Similar to <strong>${escapeHtml(similar.title || similar.name || '')}</strong> (${similar.rating}★)</div>`);
        }
        if (comboNames) lines.push(`<div class="why-pop-line why-pop-accent">Genre combo: ${escapeHtml(comboNames)}</div>`);
        if (gNames.length) lines.push(`<div class="why-pop-line">Genres: ${escapeHtml(gNames.join(', '))}</div>`);
        if (decadeFits) lines.push(`<div class="why-pop-line">Fits your ${decade}s preference</div>`);
        if (item._affinityReason) lines.push(`<div class="why-pop-line">${escapeHtml(String(item._affinityReason))}</div>`);
        // B6: score breakdown — what actually moved the rank
        const fmt = (n) => (n >= 0 ? '+' : '') + n.toFixed(2);
        const breakdown = [
          ['Quality', p.quality],
          ['Taste', p.taste + p.pairs + p.decade],
          ['Similar', p.similar],
          ['Affinity', p.affinity],
          ['Services', p.services],
          ['Tonight fit', p.runtime],
          ['Queue intent', p.queueIntent],
        ].filter(([, v]) => Math.abs(v) >= 0.08);
        if (breakdown.length) {
          lines.push(`<div class="why-pop-meta" style="margin-top:6px;">Score drivers</div>`);
          breakdown
            .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
            .slice(0, 5)
            .forEach(([label, v]) => {
              lines.push(`<div class="why-pop-line" style="color:#a1a1aa;font-size:11px;">${escapeHtml(label)} <strong style="color:#e4e4e7">${fmt(v)}</strong></div>`);
            });
        }
        if (detail.runtime && detail.runtime.runtime) {
          lines.push(`<div class="why-pop-line">Runtime: ${detail.runtime.runtime} min</div>`);
        }
        if (detail.services && detail.services.note) {
          lines.push(`<div class="why-pop-line">${escapeHtml(detail.services.note)}</div>`);
        }
        if (detail.curve && detail.curve.n < 12) {
          lines.push(`<div class="why-pop-meta">Learning your taste (${detail.curve.n} watched) — rate more for sharper picks</div>`);
        }
        if (item.vote_average) {
          lines.push(`<div class="why-pop-meta">TMDB ${item.vote_average.toFixed(1)}/10${item.vote_count ? ` · ${item.vote_count.toLocaleString()} votes` : ''}${item.imdb_rating && item.imdb_votes ? ` · IMDb ${Number(item.imdb_rating).toFixed(1)}` : ''}</div>`);
        }
        return lines.join('');
      }

      // Hero = top pick from the main lane. Series gaps and outside-taste titles
      // stay in their own rows instead of being swallowed by the hero slot.
      const heroItem = (display.find(it => !it._outside && !it._seriesGap && it._source !== 'collection') || display[0] || null);
      const heroKey = heroItem ? `${heroItem.id}:${heroItem._mediaType || 'movie'}` : '';
      const laneSkip = new Set();
      const gapItems = [];
      const outsideItems = [];
      scored.forEach(it => {
        const k = `${it.id}:${it._mediaType || 'movie'}`;
        if (k === heroKey) return;
        if ((it._seriesGap || it._source === 'collection') && gapItems.length < 12 && !laneSkip.has(k)) {
          gapItems.push(it);
          laneSkip.add(k);
        }
      });
      scored.forEach(it => {
        const k = `${it.id}:${it._mediaType || 'movie'}`;
        if (k === heroKey || laneSkip.has(k)) return;
        if (it._outside && outsideItems.length < 8) {
          outsideItems.push(it);
          laneSkip.add(k);
        }
      });
      const gridItems = [];
      const seenGrid = new Set();
      const pushGrid = (it) => {
        const k = `${it.id}:${it._mediaType || 'movie'}`;
        if (k === heroKey || laneSkip.has(k) || seenGrid.has(k)) return;
        seenGrid.add(k);
        gridItems.push(it);
      };
      display.forEach(pushGrid);
      const gridFloor = Math.min(24, recVisibleLimit);
      if (gridItems.length < gridFloor) {
        scored.forEach(it => { if (gridItems.length < recVisibleLimit) pushGrid(it); });
      }
      renderTasteLanes(gapItems, outsideItems, matchLabel);
      renderTonightHero(heroItem, matchLabel, bestGenrePair, decadeCounts, gen, whyDetailHtml);

      grid.innerHTML = '';
      gridItems.forEach((item, idx) => {
        const card = document.createElement('div');
        card.className = 'movie-card rec-card bg-zinc-900 border border-zinc-700 rounded-3xl flex flex-col';
        if (typeof applyCardStagger === 'function') applyCardStagger(card, idx);
        const poster = item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : FALLBACK_POSTER;
        const year = (item.release_date || '').slice(0,4);
        const rtSearchUrl = rtUrl(item.title || item.name, item._mediaType);
        const itemTitleSafe = escapeHtml(item.title || item.name || 'Untitled'); // for innerHTML string contexts only
        card.innerHTML = `
<div class="poster-wrap loading relative overflow-hidden rounded-2xl">
  <div class="swipe-overlay absolute inset-0 rounded-2xl flex items-center justify-center text-white font-bold text-lg opacity-0 pointer-events-none z-10" style="transition:opacity 0.12s;"></div>
  <img src="${poster}" class="w-full aspect-[2/3] object-cover" loading="lazy" alt="${itemTitleSafe} poster" onload="this.parentNode.classList.remove('loading')" onerror="this.onerror=null;this.src='${FALLBACK_POSTER}';this.parentNode.classList.remove('loading')">
  <div class="rec-poster-actions">
    <button type="button" class="rec-poster-btn rec-poster-watched" data-act="watched" title="Mark watched" aria-label="Mark ${itemTitleSafe} as watched">✓</button>
    <button type="button" class="rec-poster-btn rec-poster-trailer" id="trailer-btn-${item.id}" data-act="trailer" title="Watch trailer" aria-label="Play trailer for ${itemTitleSafe}">▶</button>
  </div>
</div>
<div class="rec-card-meta">
  <div class="rec-card-title">${itemTitleSafe}</div>
  <div class="rec-card-sub">
    ${year ? `<span>${year}</span>` : ''}
    <span class="rec-ext-tiles">
      ${typeof imdbBadgeHtml === 'function' ? imdbBadgeHtml(item, `imdb-link-${item.id}`) : ''}
      <a href="${rtSearchUrl}" target="_blank" rel="noopener" class="rec-rt-tile" title="Rotten Tomatoes" aria-label="Open ${itemTitleSafe} on Rotten Tomatoes">RT</a>
    </span>
  </div>
  ${typeof wtwBlockHtml === 'function' ? wtwBlockHtml(item.id, item._mediaType || 'movie', { compact: true }) : `<div id="wtw-rec-${item.id}-${item._mediaType || 'movie'}" class="wtw-rec-slot"></div>`}
</div>
<div class="rec-card-actions" style="position:relative;">
  <button class="rec-q-btn" data-act="towatch" aria-label="Add ${itemTitleSafe} to To Watch">+ Queue</button>
  <button class="rec-pass-btn" data-act="pass" aria-label="Pass on ${itemTitleSafe}">Pass</button>
</div>
        `;
        card.title = matchLabel(item);
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
        const passBtn = card.querySelector('[data-act="pass"]');
        if (passBtn) passBtn.onclick = () => {
          const go = () => { addToNotInterested(item); };
          if (typeof animateCardExit === 'function') animateCardExit(card, 'hide').then(go);
          else go();
        };
        card.querySelector('[data-act="watched"]').onclick = () => {
          openInlineRatingPrompt(card, item, r => {
            const finish = () => { addToWatched(item, r); };
            if (typeof animateCardExit === 'function') animateCardExit(card, 'watched').then(finish);
            else finish();
          }, { sheet: true });
        };
        wireMoreMenu(card);
        const playTrailer = async (e) => {
          if (e) e.stopPropagation();
          const vdata = await apiFetch(`/api/tmdb/3/${_mt2}/${item.id}/videos`).catch(() => null);
          const trailer = (vdata?.results || []).find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
                          (vdata?.results || []).find(v => v.site === 'YouTube');
          if (trailer) window.open(`https://www.youtube.com/watch?v=${trailer.key}`, '_blank', 'noopener');
          else try { showToast('No trailer found'); } catch (_) {}
        };
        const trailerBtn = card.querySelector('[data-act="trailer"]');
        if (trailerBtn) trailerBtn.onclick = playTrailer;
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
      // Include the hero so its where-to-watch slot fills in with the same pipeline.
      const painted = [heroItem, ...gapItems, ...outsideItems, ...gridItems].filter(Boolean);
      saveRecPaint(painted);
      renderRecAvailability(heroItem ? [heroItem, ...gridItems] : gridItems);
    }

    // Tonight hero: the highest-ranked pick as a single decisive card above the grid.
    function renderTonightHero(item, matchLabel, bestGenrePair, decadeCounts, gen, whyDetailHtml) {
      const el = document.getElementById('tonight-hero');
      if (!el) return;
      if (!item) {
        el.classList.add('hidden');
        el.innerHTML = '';
        return;
      }
      if (gen != null && gen !== _recomputeGen) return;

      const title = item.title || item.name || 'Untitled';
      const year = (item.release_date || item.first_air_date || '').slice(0, 4);
      const poster = item.poster_path
        ? `https://image.tmdb.org/t/p/w342${item.poster_path}`
        : FALLBACK_POSTER;
      const tmdbRating = item.vote_average ? item.vote_average.toFixed(1) : null;
      const why = typeof matchLabel === 'function' ? matchLabel(item) : 'Picked for your taste';
      const mt = item._mediaType === 'tv' ? 'tv' : 'movie';
      const titleSafe = escapeHtml(title);
      const overviewRaw = (item.overview || '').trim();
      const overview = overviewRaw
        ? (overviewRaw.length > 220 ? overviewRaw.slice(0, 210).replace(/\s+\S*$/, '') + '…' : overviewRaw)
        : '';
      const genreNames = (item.genre_ids || [])
        .map(id => (typeof GENRES !== 'undefined' ? GENRES.find(g => g.id === id) : null)?.name)
        .filter(Boolean)
        .slice(0, 4);
      const genreChips = genreNames.length
        ? `<div class="tonight-hero-genres">${genreNames.map(n =>
            `<span class="tonight-hero-genre-chip">${escapeHtml(n)}</span>`
          ).join('')}</div>`
        : '';
      // Both ratings, each with its own vote count, mirroring what the cards below show.
      // The hero previously displayed a bare "★ 8.1" that was TMDB's, which had become
      // misleading: ranking is driven mostly by IMDb's far larger vote counts, so the one
      // number on screen didn't explain the pick. Titles diverge enough for this to matter
      // (Iron Lung is 6.9 on TMDB against 5.8 on IMDb; FROM is 8.5 against 7.8).
      //
      // Counts sit next to their own rating rather than in a single unlabelled "N votes"
      // span, because once two ratings are shown an unattributed count is ambiguous — and
      // the disparity between them is the entire reason IMDb was worth adding.
      const imdbRating = imdbScoreText(item);
      const tmdbVotes = item.vote_count ? ` <span class="tonight-hero-meta-dim">(${Number(item.vote_count).toLocaleString()})</span>` : '';
      const imdbVotes = (item.imdb_votes || 0) > 0 ? ` <span class="tonight-hero-meta-dim">(${Number(item.imdb_votes).toLocaleString()})</span>` : '';
      const overviewBlock = overview
        ? `<p class="tonight-hero-overview">${escapeHtml(overview)}</p>`
        : `<p class="tonight-hero-overview tonight-hero-overview-empty">No synopsis on file — open details for more, or trust the pick and queue it.</p>`;

      const pinKey = `${item.id}:${mt}`;
      const prevKey = el.dataset.tonightKey || '';
      const isNewPick = prevKey !== pinKey;
      el.dataset.tonightKey = pinKey;
      el.classList.remove('hidden');
      el.innerHTML = `
        <div class="tonight-hero-inner">
          <img class="tonight-hero-poster" src="${poster}" alt="${titleSafe} poster"
               loading="eager" onerror="this.onerror=null;this.src='${FALLBACK_POSTER}'">
          <div class="tonight-hero-body">
            <div class="tonight-hero-kicker">Tonight’s pick</div>
            <div class="tonight-hero-title">${titleSafe}</div>
            <div class="tonight-hero-meta">
              ${year ? `<span>${year}</span>` : ''}
              ${tmdbRating ? `<span>· <span class="tonight-hero-meta-dim">TMDB</span> ★ ${tmdbRating}${tmdbVotes}</span>` : ''}
              ${imdbRating ? `<span>· <span class="tonight-hero-meta-dim">IMDb</span> ${imdbRating}${imdbVotes}</span>` : ''}
              <span>· ${mt === 'tv' ? 'TV series' : 'Movie'}</span>
            </div>
            ${genreChips}
            ${overviewBlock}
            <div class="tonight-hero-why-block">
              <div class="tonight-hero-why-label">Why this for you</div>
              <button type="button" class="tonight-hero-why why-this-btn" title="Why this recommendation?">${escapeHtml(why)}</button>
              <div class="tonight-hero-why-strip" data-th="why-strip">${escapeHtml(why)}</div>
            </div>
            ${(() => {
              const tmdb = item.vote_average;
              const imdb = item.imdb_rating;
              if (typeof tmdb === 'number' && typeof imdb === 'number' && Math.abs(tmdb - imdb) >= 1.0) {
                return `<div class="tonight-rating-diverge">TMDB ${tmdb.toFixed(1)} vs IMDb ${Number(imdb).toFixed(1)} — critics diverge</div>`;
              }
              return '';
            })()}
            ${typeof wtwBlockHtml === 'function'
              ? wtwBlockHtml(item.id, mt, { compact: false })
              : `<div class="tonight-hero-wtw-row"><span class="tonight-hero-wtw-label">Where to watch</span><div id="wtw-rec-${item.id}-${mt}" class="wtw-rec-slot tonight-hero-wtw"></div></div>`}
            <div class="tonight-active-filters" id="tonight-active-filters"></div>
            <div class="tonight-hero-actions">
              <button type="button" class="th-primary roku-play-btn" data-th="play">Play</button>
              <button type="button" class="th-primary" data-th="towatch">+ Queue</button>
              <button type="button" class="th-secondary" data-th="watched">Watched</button>
              <button type="button" class="th-ghost" data-th="pass">Pass</button>
              <button type="button" class="th-ghost" data-th="more">⋯</button>
            </div>
            <div class="tonight-more-menu hidden" data-th-menu>
              <button type="button" data-th="details">Details</button>
              <button type="button" data-th="trailer">Trailer</button>
              <button type="button" data-th="share">Share</button>
            </div>
          </div>
        </div>`;

      const whyBtn = el.querySelector('.tonight-hero-why');
      if (whyBtn && typeof whyDetailHtml === 'function') {
        whyBtn.onclick = (e) => {
          e.stopPropagation();
          document.querySelectorAll('.why-this-pop').forEach(p => p.remove());
          const pop = document.createElement('div');
          pop.className = 'why-this-pop';
          pop.innerHTML = whyDetailHtml(item);
          document.body.appendChild(pop);
          const rect = whyBtn.getBoundingClientRect();
          const pw = 260;
          pop.style.left = Math.min(rect.left, window.innerWidth - pw - 8) + 'px';
          pop.style.top = (rect.bottom + 6) + 'px';
          setTimeout(() => document.addEventListener('click', () => {
            document.querySelectorAll('.why-this-pop').forEach(p => p.remove());
          }, { once: true }), 10);
        };
      }

      const openDetails = () => {
        const src = el.querySelector('.tonight-hero-poster') || el;
        if (typeof openModal === 'function') openModal(item, { sourceEl: src });
        else if (typeof showMovieModal === 'function') showMovieModal(item);
      };

      const playHero = el.querySelector('[data-th="play"]');
      if (playHero) playHero.onclick = (e) => {
        e.stopPropagation();
        if (typeof playOnRoku === "function") playOnRoku(item, playHero);
      };
      el.querySelector('[data-th="towatch"]').onclick = () => {
        addToToWatch(item);
      };
      const passHero = el.querySelector('[data-th="pass"]');
      if (passHero) passHero.onclick = () => { addToNotInterested(item); };
      el.querySelector('[data-th="watched"]').onclick = () => {
        openInlineRatingPrompt(el, item, r => {
          addToWatched(item, r);
        }, { sheet: true });
      };
      const moreBtn = el.querySelector('[data-th="more"]');
      const moreMenu = el.querySelector('[data-th-menu]');
      if (moreBtn && moreMenu) {
        moreBtn.onclick = (e) => {
          e.stopPropagation();
          moreMenu.classList.toggle('hidden');
        };
        document.addEventListener('click', () => moreMenu.classList.add('hidden'), { once: true });
      }
      const shareBtn = el.querySelector('[data-th="share"]');
      if (shareBtn) shareBtn.onclick = () => {
        if (typeof shareTonightPick === 'function') shareTonightPick();
      };
      const detailsBtn = el.querySelector('[data-th="details"]');
      if (detailsBtn) detailsBtn.onclick = openDetails;
      if (typeof paintTonightFilterChips === 'function') paintTonightFilterChips();
      el.querySelector('[data-th="trailer"]').onclick = async () => {
        const vdata = await apiFetch(`/api/tmdb/3/${mt}/${item.id}/videos`).catch(() => null);
        const trailer = (vdata?.results || []).find(v => v.site === 'YouTube' && v.type === 'Trailer')
          || (vdata?.results || []).find(v => v.site === 'YouTube');
        if (trailer) window.open(`https://www.youtube.com/watch?v=${trailer.key}`, '_blank', 'noopener');
        else try { showToast('No trailer found'); } catch (_) {}
      };

      // Poster / overview open detail modal.
      const posterEl = el.querySelector('.tonight-hero-poster');
      if (posterEl) {
        posterEl.style.cursor = 'pointer';
        posterEl.onclick = openDetails;
      }
      const overviewEl = el.querySelector('.tonight-hero-overview');
      if (overviewEl) {
        overviewEl.style.cursor = 'pointer';
        overviewEl.title = 'Open full details';
        overviewEl.onclick = openDetails;
      }

      // Paint availability if we already fetched it (services-only path).
      paintAvailabilitySlot(item.id, mt);

      // Cinematic reveal when the hero title changes (respects reduced motion via CSS).
      if (isNewPick) {
        el.classList.remove('tonight-reveal');
        void el.offsetWidth;
        el.classList.add('tonight-reveal');
        setTimeout(() => el.classList.remove('tonight-reveal'), 700);
      }

      // Async: enrich synopsis / genres if the pool item is thin (common for some discover rows).
      if (!overviewRaw || genreNames.length < 2) {
        apiFetch(`/api/tmdb/3/${mt}/${item.id}`).then(details => {
          if (!details || gen != null && gen !== _recomputeGen) return;
          // Only refresh this hero if it's still the same title.
          if (!document.getElementById(`wtw-rec-${item.id}-${mt}`)) return;
          const body = el.querySelector('.tonight-hero-body');
          if (!body) return;
          if (!overviewRaw && details.overview) {
            const ov = details.overview.length > 220
              ? details.overview.slice(0, 210).replace(/\s+\S*$/, '') + '…'
              : details.overview;
            const ovEl = body.querySelector('.tonight-hero-overview');
            if (ovEl) {
              ovEl.classList.remove('tonight-hero-overview-empty');
              ovEl.textContent = ov;
            }
          }
          if (genreNames.length < 2 && Array.isArray(details.genres) && details.genres.length) {
            let genreWrap = body.querySelector('.tonight-hero-genres');
            if (!genreWrap) {
              genreWrap = document.createElement('div');
              genreWrap.className = 'tonight-hero-genres';
              const meta = body.querySelector('.tonight-hero-meta');
              if (meta && meta.nextSibling) body.insertBefore(genreWrap, meta.nextSibling);
              else body.appendChild(genreWrap);
            }
            genreWrap.innerHTML = details.genres.slice(0, 4)
              .map(g => `<span class="tonight-hero-genre-chip">${escapeHtml(g.name)}</span>`)
              .join('');
          }
        }).catch(() => {});
      }
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

    // Watch-provider data reaches us through TMDB's partnership with JustWatch, and TMDB
    // requires that JustWatch be credited on each media item showing it — not once in a
    // footer — with API access revocable for non-compliance. So this rides on every
    // availability row rather than being hoisted out of the grid.
    //
    // flex-shrink:0 is load-bearing: the row is overflow:hidden, and without it the credit
    // would be the first thing clipped on a two-service card, which is precisely the case
    // where it has to stay visible.
    const JW_CREDIT = '<span style="font-size:8px;color:#52525b;white-space:nowrap;flex-shrink:0;margin-left:1px;"'
      + ' title="Streaming availability data by JustWatch">JustWatch</span>';

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
        // Show pending state immediately on every reserved slot
        paintAvailabilitySlot(item.id, mt);
        const data = await fetchWatchProviders(item.id, mt, cache);
        if (run !== _availabilityRun) return;
        _availabilityByKey.set(`${item.id}:${mt}`, data);
        paintAvailabilitySlot(item.id, mt);
      }
      saveProviderCache(cache);
      // After WTW loads, soft re-promote a streamable Tonight pick when Watch Tonight is on
      // (or when hero is not on services but a close runner-up is).
      if (run === _availabilityRun) {
        try { maybeRerankTonightFromAvailability(items); } catch (_) {}
      }
    }

    let _tonightAvailRerankKey = '';
    function maybeRerankTonightFromAvailability(items) {
      if (!(typeof myServices !== 'undefined' && myServices && myServices.size)) return;
      const heroEl = document.getElementById('tonight-hero');
      if (!heroEl || heroEl.classList.contains('hidden')) return;
      const pinKey = heroEl.dataset.tonightKey || '';
      const list = Array.isArray(items) ? items : [];
      if (list.length < 2) return;

      const streamable = list.filter(it => {
        const mt = it._mediaType === 'tv' ? 'tv' : 'movie';
        if (it._outside || it._seriesGap || it._source === 'collection') return false;
        const data = _availabilityByKey.get(`${it.id}:${mt}`);
        return data && typeof streamsOnMyServices === 'function' && streamsOnMyServices(data);
      }).sort((a, b) => {
        const movieA = (a._mediaType || 'movie') === 'movie' ? 1 : 0;
        const movieB = (b._mediaType || 'movie') === 'movie' ? 1 : 0;
        if (movieA !== movieB) return movieB - movieA;
        const fitA = typeof tonightFitSignal === 'function' ? (tonightFitSignal(a).boost || 0) : 0;
        const fitB = typeof tonightFitSignal === 'function' ? (tonightFitSignal(b).boost || 0) : 0;
        return fitB - fitA;
      });
      if (!streamable.length) return;
      const heroOk = streamable.some(it => `${it.id}:${it._mediaType || 'movie'}` === pinKey);
      if (heroOk) return;
      const next = streamable[0];
      if (!next) return;
      const nextKey = `${next.id}:${next._mediaType || 'movie'}`;
      if (nextKey === pinKey || nextKey === _tonightAvailRerankKey) return;
      _tonightAvailRerankKey = nextKey;
      if (typeof writeTonightPin === 'function') writeTonightPin(next);
      if (typeof recomputeRecommendationsDebounced === 'function') recomputeRecommendationsDebounced(200);
    }

    function paintAvailabilitySlot(id, mediaType) {
      const mt = mediaType === 'tv' ? 'tv' : 'movie';
      const data = _availabilityByKey.has(`${id}:${mt}`)
        ? _availabilityByKey.get(`${id}:${mt}`)
        : undefined;
      // Always paint a status (pending → services / rent / not listed). Never leave blank.
      if (typeof paintAllWtwFor === 'function') {
        paintAllWtwFor(id, mt, data === undefined ? undefined : (data || null), { compact: true });
        return;
      }
      const slot = document.getElementById(`wtw-rec-${id}-${mt}`);
      if (!slot) return;
      if (typeof paintWtwBody === 'function') {
        paintWtwBody(slot, data === undefined ? undefined : (data || null), { compact: true });
      }
    }

    // Repaint from already-fetched data — no network. Called when the Settings service
    // picker changes, so toggling a service updates the visible grid immediately.
    function refreshVisibleAvailability() {
      if (typeof refreshAllWtwSlots === 'function') {
        refreshAllWtwSlots();
        return;
      }
      document.querySelectorAll('.wtw-rec-slot').forEach(el => {
        const m = el.id.match(/^wtw-rec-(\d+)-(movie|tv)$/);
        if (m) paintAvailabilitySlot(m[1], m[2]);
      });
    }

