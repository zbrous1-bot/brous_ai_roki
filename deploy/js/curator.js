    // ===================== THE CURATOR (full port: history, context, grounding, streaming /api/llm, SUGGESTED + BATCH_RATE) =====================

    function saveChat() {
      Store.setItem('horror_roki_chat', JSON.stringify(chatHistory.slice(-20)));
      // Light push for chat (debounced)
      pushToServer();
    }

    function renderCuratorMessages() {
      const box = document.getElementById('curator-messages');
      if (!box) return;
      box.innerHTML = '';
      const recent = chatHistory.slice(-8);
      if (recent.length === 0) {
        const welcome = document.createElement('div');
        welcome.className = 'curator-msg text-xs text-zinc-400';
        welcome.innerHTML = `<span class="curator-avatar">👻</span> <span>The reels are waiting. Ask about slow burns, gory classics, or what to queue next.</span>`;
        box.appendChild(welcome);
        box.scrollTop = box.scrollHeight;
        return;
      }
      recent.forEach(turn => {
        const div = document.createElement('div');
        div.className = `curator-msg ${turn.role === 'user' ? 'user' : ''}`;
        if (turn.role === 'user') {
          div.innerHTML = `<div class="whitespace-pre-wrap">${escapeHtml(turn.content || '')}</div>`;
        } else {
          // Curator replies always get the red ghost avatar inside the bubble
          div.innerHTML = `<span class="curator-avatar">👻</span><div class="whitespace-pre-wrap">${escapeHtml(turn.content || '')}</div>`;
        }
        box.appendChild(div);
      });
      box.scrollTop = box.scrollHeight;
    }

    // escapeHtml is now defined once, canonically, in store.js (first script
    // loaded) and attached to window so every module shares one implementation.
    // The local definition that used to live here was removed to avoid two
    // copies drifting apart.

    async function sendToCurator() {
      const input = document.getElementById('curator-input');
      if (!input) return;
      const text = input.value.trim();
      if (!text) return;

      // push user turn
      chatHistory.push({role: 'user', content: text});
      saveChat();
      renderCuratorMessages();
      input.value = '';

      const status = document.getElementById('curator-status');
      if (status) status.textContent = 'Consulting the reels...';

      // Cool horror-themed typing indicator
      const box = document.getElementById('curator-messages');
      const typingDiv = document.createElement('div');
      typingDiv.className = 'curator-msg';
      typingDiv.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 14px;';
      typingDiv.innerHTML = `<span class="curator-avatar">👻</span><div class="curator-typing-dots"><span></span><span></span><span></span></div>`;
      if (box) {
        box.appendChild(typingDiv);
        box.scrollTop = box.scrollHeight;
      }

      // ── Build rich Curator context ──────────────────────────────────────────
      const prefs = getUserGenrePrefs();

      const titleOf = x => (x && (x.title || x.name) || '').trim();
      const yearOf = x => (x.release_date || x.first_air_date || '').slice(0, 4);
      const genreNamesOf = x => (x.genre_ids || []).map(id => GENRES.find(g => g.id === id)?.name).filter(Boolean);

      // To Watch queue — short, this is intent
      const twDetail = toWatchList.slice(0, 30).map(x => ({
        title: titleOf(x),
        year: yearOf(x),
        genres: genreNamesOf(x),
        type: x._mediaType || 'movie'
      }));

      // Distinctive likes, not the newest 5s. A 5 is ordinary on this library.
      const seedSource = typeof pickDistinctiveSeeds === 'function'
        ? pickDistinctiveSeeds(watchedList, 12)
        : watchedList.filter(x => x.rating >= 5).slice(0, 12);
      const loved = seedSource.map(x => `${titleOf(x)} (${x.rating}★${genreNamesOf(x).length ? ', ' + genreNamesOf(x).slice(0, 2).join('/') : ''})`);

      // Sharp misses: the ratings and passes that actually describe taste.
      const sharp = [];
      const pushSharp = (x, tag) => {
        const t = titleOf(x);
        if (!t || sharp.some(s => s.toLowerCase() === `${t} (${tag})`.toLowerCase())) return;
        sharp.push(`${t} (${tag})`);
      };
      watchedList.filter(x => (x.rating || 0) >= 1 && (x.rating || 0) <= 2).slice(0, 12).forEach(x => pushSharp(x, `${x.rating}★`));
      watchedList.filter(x => x.rating === 3).slice(0, 12).forEach(x => pushSharp(x, '3★'));
      dislikedList.slice(0, 15).forEach(x => pushSharp(x, 'disliked'));
      (typeof notInterestedList !== 'undefined' ? notInterestedList : []).slice(0, 12).forEach(x => pushSharp(x, 'passed'));
      const mean = typeof libraryRatingMean === 'function' ? libraryRatingMean(watchedList) : null;
      const meanText = mean == null ? 'not enough ratings' : mean.toFixed(2);

      // Current rec pool — what the engine already surfaced
      const poolSample = currentRecPool.slice(0, 15).map(x => ({
        title: x.title || x.name,
        year: (x.release_date || '').slice(0, 4),
        score: x.vote_average,
        genres: (x.genre_ids || []).map(id => GENRES.find(g => g.id === id)?.name).filter(Boolean)
      }));

      // Grounding: extract any titles the user mentioned that we know about
      const knownTitles = [...toWatchList, ...watchedList, ...dislikedList, ...(typeof notInterestedList !== 'undefined' ? notInterestedList : []), ...currentRecPool].map(x => x.title || x.name).filter(Boolean);
      const mentioned = knownTitles.filter(t => t && text.toLowerCase().includes((t.toLowerCase()).slice(0, Math.min(14, t.length))));
      const grounding = {};
      mentioned.slice(0, 6).forEach(t => {
        const m = [...toWatchList, ...watchedList, ...currentRecPool].find(x => (x.title || x.name) === t);
        if (m) grounding[t] = {
          year: (m.release_date || m.first_air_date || '').slice(0, 4),
          overview: (m.overview || '').slice(0, 220),
          genres: (m.genre_ids || []).map(id => GENRES.find(g => g.id === id)?.name).filter(Boolean),
          rating: m.vote_average,
          user_rating: m.rating || null,
          id: m.id
        };
      });
      lastGrounding = grounding;

      // ── System prompt ────────────────────────────────────────────────────────
      const sys = `You are The Curator, an encyclopedic film curator with vast personal knowledge of cinema and television history. You draw from your OWN expertise — not from any provided list — to make recommendations.

YOUR EXPERTISE covers thousands of films and series: horror (found-footage, slow-burn, supernatural, psychological, body horror, cosmic horror, slasher, folk horror, giallo, J-horror, Korean thriller), thriller, sci-fi, mystery, crime, drama, and beyond. You know obscure cult classics, foreign gems, directorial filmographies, decade aesthetics, streaming originals, and deep cuts.

PERSONALITY: Dry dark wit, slightly theatrical. Brief but substantive. Never sycophantic. Reference the user's taste when relevant.

HOW TO USE THE PROVIDED CONTEXT:
- The app drops any suggestion whose title or TMDB id is already watched, queued, disliked, or passed, before a card is shown. Still avoid naming films you would expect in a library this large.
- SHARP_MISSES is the taste signal. A 3, a 1–2, a dislike, or a pass matters more than another 5.
- DISTINCTIVE_LIKES are the above-average titles whose genres are less common in the library. Do not treat "most of the 5s are horror" as a request for more generic horror.
- Their personal average is in the profile. A 5 at an average near 4.4 is ordinary enthusiasm, not a rare love.
- GROUNDING: optional metadata for titles mentioned in the query. If empty, use your own knowledge.
- Suggest from your own knowledge. The app is the exclusion list.

RULES:
1. Do not recommend a title from SHARP_MISSES or one you were shown as already logged. If your ideas are all too familiar, say so and offer a different lane.
2. For ANY query where you name films/shows to watch, you MUST end with a line in EXACTLY this format (this is what renders the clickable movie cards — without it the user only sees text): SUGGESTED: ["Title One", "Title Two", ...] (3-6 titles). Use the exact word SUGGESTED:, a real JSON array of plain double-quoted title strings, and put every title you recommend in it.
3. Match the specific tone asked for precisely — found-footage dread, slow-burn, brutal, cozy, etc.
4. For similar-to queries: match what is distinctive about the reference, and stay away from the neighborhood of SHARP_MISSES.
5. For director/actor queries: include deep cuts alongside highlights, still excluding logged titles.
6. For decade queries: respect that era's aesthetic
7. Non-recommendation questions: answer fully without forcing SUGGESTED
8. Flag TV with [TV Series] or [Mini-Series] after the title
9. Do not explain a pick as "because you like horror" when horror is on most of the library. Name a director, a series, or a specific film from DISTINCTIVE_LIKES or explain why it is unlike a SHARP_MISS.`;

      const userCtxBlock = `=== USER PROFILE ===
Personal average rating: ${meanText} (a 5 is ordinary when this is near 4.4; a 3 or below is the informative vote)
Genre weights from above-average ratings only: ${JSON.stringify(prefs)}
DISTINCTIVE_LIKES: ${loved.join(' | ') || 'none yet'}
SHARP_MISSES: ${sharp.join(' | ') || 'none yet'}
Total watched: ${watchedList.length} | Queued: ${toWatchList.length} | Disliked: ${dislikedList.length} | Passed: ${(typeof notInterestedList !== 'undefined' ? notInterestedList.length : 0)}
The app rejects logged titles before showing a card. Do not spend the reply listing them.

=== TO WATCH QUEUE ===
${JSON.stringify(twDetail)}

=== CURRENT REC POOL (engine's top picks — avoid duplicating unless asked) ===
${JSON.stringify(poolSample, null, 0)}

${Object.keys(grounding).length ? `=== GROUNDING (supplementary metadata) ===\n` + JSON.stringify(grounding, null, 2) : '=== GROUNDING: (empty — use your own encyclopedic knowledge)'}` ;

      const fullUser = `${userCtxBlock}\n\n=== USER MESSAGE ===\n${text}`;

      const payload = {
        model: llmConfig.model || 'grok-3-mini',
        messages: [
          {role: 'system', content: sys},
          ...chatHistory.slice(-8).slice(0, -1), // last 8 turns for conversation memory (exclude current)
          {role: 'user', content: fullUser}
        ],
        max_tokens: llmConfig.max_response_tokens || 2000,
        temperature: 0.82,
        stream: true
      };

      try {
        let llmUrl = '/api/llm';
        if (apiBase) {
          const base = apiBase.replace(/\/+$/, '');
          llmUrl = base + '/api/llm';
        }
        const res = await fetch(llmUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify(payload)
        });
        console.log('[Horror Roki] Curator LLM call to:', llmUrl);
        if (!res.ok) throw new Error('LLM proxy error ' + res.status + ' (check XAI_TOKEN in Worker + password)');

        // Stream parse (OpenAI SSE style)
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let full = '';
        // Remove typing indicator
        if (typingDiv && typingDiv.parentNode) typingDiv.parentNode.removeChild(typingDiv);

        const assistantDiv = document.createElement('div');
        assistantDiv.className = 'curator-msg';
        assistantDiv.innerHTML = `<span class="curator-avatar">👻</span> <span class="curator-text"></span>`;
        const textSpan = assistantDiv.querySelector('.curator-text');
        const box = document.getElementById('curator-messages');
        if (box) { box.appendChild(assistantDiv); box.scrollTop = box.scrollHeight; }

        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          const chunk = dec.decode(value, {stream:true});
          // parse data: lines
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const d = line.slice(6).trim();
              if (d === '[DONE]') continue;
              try {
                const j = JSON.parse(d);
                const delta = j.choices?.[0]?.delta?.content || '';
                if (delta) {
                  full += delta;
                  textSpan.textContent = full;
                  if (box) box.scrollTop = box.scrollHeight;
                }
              } catch(_) {}
            }
          }
        }

        // done: save assistant turn
        chatHistory.push({role: 'assistant', content: full});
        saveChat();

        // parse markers and render special UI (SUGGESTED cards + BATCH)
        await parseAndRenderCuratorExtras(full, assistantDiv);

        if (status) status.textContent = 'Grounded • streaming via Worker • history kept until explicit clear';

      } catch (err) {
        // Remove typing indicator (may already be removed if the error happened
        // mid-stream, after the success path's own removal).
        if (typingDiv && typingDiv.parentNode) typingDiv.parentNode.removeChild(typingDiv);
        const box = document.getElementById('curator-messages');
        if (box) {
          const errDiv = document.createElement('div');
          errDiv.className = 'curator-msg';
          errDiv.innerHTML = `<span class="text-red-400">The projector bulb flickers... ${escapeHtml(err.message)}</span>`;
          box.appendChild(errDiv);
        }
        if (status) status.textContent = 'Error talking to Curator. Check password + Worker XAI_TOKEN.';
      }
    }

    async function parseAndRenderCuratorExtras(fullText, parentDiv) {
      curatorPicks = [];
      // Strip TV/mini-series flag tags first so a "]" inside a title like
      // "Midnight Mass [TV Series]" can't prematurely terminate the array capture.
      const sugText = fullText.replace(/\s*\[(?:tv series|mini-?series|miniseries|tv|limited series)\]/gi, '');
      // Accept the title list under several labels the model actually uses
      // (SUGGESTED / SUGGEST / SUGGESTIONS / PICKS / RECOMMENDED ...), or a bare
      // quoted-string array anywhere in the reply if the label is missing.
      let sugMatch = sugText.match(/(?:SUGGEST(?:ED|IONS?)?|PICKS?|RECOMMEND(?:ED|ATIONS?)?)\s*:?\s*\[([^\]]+)\]/i);
      if (!sugMatch) {
        // Fallback: any array of 2+ quoted strings looks like a list of titles
        sugMatch = sugText.match(/\[\s*("(?:[^"\\]|\\.)*"(?:\s*,\s*"(?:[^"\\]|\\.)*")+)\s*\]/);
      }
      if (sugMatch) {
        try {
          const titlesStr = sugMatch[1];
          let titles;
          try {
            // Parse as JSON array — correctly handles commas inside titles like "As Above, So Below"
            titles = JSON.parse('[' + titlesStr + ']');
          } catch(e) {
            // Fallback: extract quoted tokens, then plain comma split
            const quoted = titlesStr.match(/"([^"]+)"|'([^']+)'/g);
            if (quoted && quoted.length) {
              titles = quoted.map(s => s.replace(/^["']|["']$/g, '').trim());
            } else {
              titles = titlesStr.split(',').map(s => s.trim().replace(/^"|"$/g,'').replace(/^'|'$/g,''));
            }
          }
          // Strip trailing flag tags like "[TV Series]" / "[Mini-Series]" so the
          // title enriches against TMDB cleanly (media type comes from the search).
          titles = titles.map(t => String(t).replace(/\s*\[[^\]]*\]\s*$/, '').trim()).filter(Boolean);
          // Normalize titles for robust matching: case/punctuation/(year)-insensitive
          const normTitle = s => String(s || '').toLowerCase().replace(/\(\d{4}\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
          // Strict filter: never suggest titles already in any list (normalized match)
          const libraryRows = [...(watchedList||[]), ...(toWatchList||[]), ...(dislikedList||[]), ...(typeof notInterestedList !== 'undefined' ? notInterestedList : [])];
          const seenTitles = new Set(libraryRows.map(x => normTitle(x.title || x.name)));
          const loggedIds = new Set(libraryRows.map(x => String(x && x.id)).filter(id => id && id !== 'undefined'));
          titles = titles.filter(t => t && !seenTitles.has(normTitle(t)));
          if (!titles.length) return;
          // Enrich with posters; prefer an EXACT title match so similarly-named films aren't mixed up
          const enrichedSuggested = await Promise.all(titles.map(async (t) => {
            if (!t || t.length < 2) return null;
            const nt = normTitle(t);
            let poster_path = null;
            let id = Date.now();
            let canonical = t;
            let enrichExtra = {};
            // Try local data first (exact normalized title)
            const local = (currentRecPool||[]).find(x => x.title && normTitle(x.title) === nt);
            if (local) {
              poster_path = local.poster_path || null;
              id = local.id || id;
              canonical = local.title || t;
            }
            if (!poster_path) {
              // Live search — pick an exact title match (most-voted) before falling back to top result
              try {
                const search = await apiFetch(`/api/tmdb/3/search/multi?query=${encodeURIComponent(t)}&page=1`);
                const results = (search.results || []).filter(x => x.media_type === 'movie' || x.media_type === 'tv');
                if (results.length) {
                  const titleOf = x => x.title || x.name || '';
                  const exact = results.filter(x => normTitle(titleOf(x)) === nt).sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0));
                  const r = exact[0] || results[0];
                  poster_path = r.poster_path;
                  id = r.id;
                  canonical = titleOf(r) || t;
                  enrichExtra = { year: (r.release_date || r.first_air_date || '').slice(0,4), vote: r.vote_average, mediaType: r.media_type || 'movie' };
                }
              } catch (e) {}
            }
            return {title: canonical, suggestedTitle: t, type: 'suggested', poster_path, id, year: enrichExtra.year || '', vote: enrichExtra.vote || null, mediaType: enrichExtra.mediaType || 'movie' };
          }));
          const excluded = getExcludedKeys();
          enrichedSuggested.filter(Boolean).forEach(item => {
            const key = `${item.id}:${item.mediaType || 'movie'}`;
            const nt = normTitle(item.title);
            const nst = normTitle(item.suggestedTitle);
            // Skip if already in any list (by id OR by normalized canonical/suggested title)
            if (excluded.has(key) || loggedIds.has(String(item.id)) || seenTitles.has(nt) || seenTitles.has(nst)) return;
            // Skip duplicates within this pick set (normalized title)
            if (curatorPicks.some(p => normTitle(p.title) === nt)) return;
            curatorPicks.push(item);
          });
        } catch(e){}
      }
      // BATCH_RATE: [ {title, suggested_rating, reason} ... ]
      const batchMatch = fullText.match(/BATCH_RATE:\s*(\[[\s\S]*?\])/i);
      if (batchMatch) {
        try {
          const arr = JSON.parse(batchMatch[1]);
          if (Array.isArray(arr)) {
            arr.slice(0,6).forEach(b => {
              if (b.title) curatorPicks.push({title: b.title, type: 'batch', rating: b.suggested_rating, reason: b.reason || ''});
            });
          }
        } catch(e){}
      }

      if (!curatorPicks.length) return;

      const wrap = document.createElement('div');
      wrap.className = 'suggested-card mt-2 space-y-2 border border-red-900/30 bg-zinc-950/50 rounded-2xl p-1';
      wrap.innerHTML = `<div class="text-[9px] uppercase tracking-[1px] text-red-400/80 px-1.5 py-0.5">Curator picks — act on them</div>`;

      curatorPicks.forEach((p, i) => {
        const row = document.createElement('div');
        row.className = 'curator-pick-row flex items-center gap-2 text-sm bg-zinc-950 border border-zinc-800 rounded-2xl px-2 py-1';
        const pTitleSafe = escapeHtml(p.title || 'Untitled'); // LLM-sourced — must escape before any innerHTML use
        if (p.type === 'batch') {
          row.innerHTML = `
            <input type="checkbox" class="accent-red-600" checked data-idx="${i}">
            <span class="flex-1 truncate">${pTitleSafe}</span>
            <span class="text-[11px] text-amber-400">${p.rating || 4}★</span>
            <button class="text-[11px] px-2 py-0.5 rounded-xl bg-emerald-700 text-white" data-apply-batch>Apply</button>
          `;
        } else {
          const posterHtml = p.poster_path
            ? `<img src="https://image.tmdb.org/t/p/w185${p.poster_path}" class="w-24 h-36 rounded-lg object-cover flex-shrink-0 border border-zinc-700" alt="${pTitleSafe} poster">`
            : `<div class="w-24 h-36 bg-zinc-800 rounded-lg flex-shrink-0 flex items-center justify-center text-2xl text-zinc-500">📽️</div>`;
          const pYear = p.year || '';
          const imdbUrl = `https://www.imdb.com/find/?q=${encodeURIComponent(p.title + (pYear ? ' ' + pYear : ''))}&s=tt&ttype=ft`;
          const rtHref = rtUrl(p.title, p._mediaType || 'movie');
          const voteStr = p.vote ? `<span class="text-[11px] text-amber-400/90 font-semibold">${p.vote.toFixed(1)}★</span>` : '';
          const yearStr = pYear ? `<span class="text-[11px] text-zinc-500">${pYear}</span>` : '';
          row.innerHTML = `
            <div class="flex items-center gap-2.5 flex-1 min-w-0">
              ${posterHtml}
              <div class="flex flex-col min-w-0 gap-1">
                <span class="truncate font-semibold text-[15px] leading-snug">${pTitleSafe}</span>
                <div class="flex items-center gap-1.5 flex-wrap">
                  ${yearStr}${voteStr}
                  <a href="${imdbUrl}" target="_blank" rel="noopener"
                     class="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-[#f5c518] text-black font-bold no-underline hover:brightness-90 leading-none flex-shrink-0">
                    IMDb
                  </a>
                  <a href="${rtHref}" target="_blank" rel="noopener"
                     class="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-[#fa320a] text-white font-bold no-underline hover:brightness-90 leading-none flex-shrink-0">
                    🍅 RT
                  </a>
                </div>
              </div>
            </div>
            <div class="flex flex-col gap-1 flex-shrink-0">
              <button class="text-[11px] px-2.5 py-1 rounded-xl bg-emerald-700 text-white" data-add-towatch>+ Watch</button>
              <button class="text-[11px] px-2.5 py-1 rounded-xl border border-zinc-700" data-mark-watched>Rate</button>
              <div class="flex gap-1">
                <button class="flex-1 text-[11px] px-1.5 py-1 rounded-xl border border-zinc-700 text-zinc-300" data-pass>Pass</button>
                <button class="flex-1 text-[11px] px-1.5 py-1 rounded-xl border border-zinc-700 text-zinc-600 hidden" data-trailer title="Watch trailer">▶</button>
              </div>
            </div>
          `;
        }
        wrap.appendChild(row);

        // wire (note: after append)
        setTimeout(() => {
          const addTw = row.querySelector('[data-add-towatch]');
          if (addTw) addTw.onclick = () => {
            const found = currentRecPool.find(x => x.title && x.title.toLowerCase() === p.title.toLowerCase()) || {title: p.title, id: p.id || Date.now()+i, poster_path: p.poster_path };
            addToToWatch(found);
            row.style.opacity = '0.4';
          };
          const markW = row.querySelector('[data-mark-watched]');
          if (markW) markW.onclick = () => {
            const found = currentRecPool.find(x => x.title && x.title.toLowerCase() === p.title.toLowerCase()) || {title: p.title, id: p.id || Date.now()+i, poster_path: p.poster_path };
            openInlineRatingPrompt(row, found, r => {
              addToWatched(found, r);
              row.style.opacity = '0.4';
            }, { hideButtons: Array.from(row.querySelectorAll('button')) });
          };
          const passPick = row.querySelector('[data-pass]');
          if (passPick) passPick.onclick = () => {
            const found = currentRecPool.find(x => x.title && x.title.toLowerCase() === p.title.toLowerCase()) || {title: p.title, id: p.id || Date.now()+i, poster_path: p.poster_path, _mediaType: p.mediaType || 'movie' };
            if (typeof addToNotInterested === 'function') addToNotInterested(found);
            row.style.opacity = '0.3';
            if (currentRecPool.length) recomputeRecommendations();
          };
          const chk = row.querySelector('input[type="checkbox"]');
          const apply = row.querySelector('[data-apply-batch]');
          if (apply && chk) {
            apply.onclick = () => {
              if (!chk.checked) return;
              const found = currentRecPool.find(x => x.title && x.title.toLowerCase() === p.title.toLowerCase()) || {title: p.title, id: p.id || Date.now()+i, poster_path: p.poster_path };
              addToWatched(found, p.rating || 4);
              row.style.opacity = '0.3';
            };
          }

          // Trailer: fetch a YouTube trailer for this pick and reveal the ▶ button
          if (p.type !== 'batch' && p.id) {
            const trailerBtn = row.querySelector('[data-trailer]');
            if (trailerBtn) {
              const mediaPath = (p.mediaType || 'movie') === 'tv' ? 'tv' : 'movie';
              apiFetch(`/api/tmdb/3/${mediaPath}/${p.id}/videos`).then(vdata => {
                const trailer = (vdata?.results || []).find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
                                (vdata?.results || []).find(v => v.site === 'YouTube');
                if (trailer) {
                  trailerBtn.classList.remove('hidden', 'text-zinc-600');
                  trailerBtn.classList.add('text-red-400');
                  trailerBtn.onclick = (ev) => {
                    ev.stopPropagation();
                    window.open(`https://www.youtube.com/watch?v=${trailer.key}`, '_blank', 'noopener');
                  };
                }
              }).catch(() => {});
            }
          }

          // Make the thumbnail (poster) + title area clickable for quick bio/detail modal (consistent with recs and search)
          if (p.type !== 'batch') {
            const posterEl = row.querySelector('img') || row.querySelector('div.w-10');
            const titleArea = row.querySelector('.flex.items-center.gap-2.flex-1') || row.querySelector('span.truncate');
            [posterEl, titleArea].forEach(el => {
              if (el) {
                el.style.cursor = 'pointer';
                el.title = 'View details';
                el.onclick = (ev) => {
                  ev.stopPropagation();
                  const found = currentRecPool.find(x => x.title && x.title.toLowerCase() === p.title.toLowerCase()) || {title: p.title, id: p.id || Date.now()+i, poster_path: p.poster_path };
                  openModal(found).catch(()=>{});
                };
              }
            });
          }
        }, 10);
      });

      parentDiv.appendChild(wrap);
    }

    function clearCuratorChat() {
      if (!confirm('Clear entire chat history?')) return;
      chatHistory = [];
      Store.removeItem('horror_roki_chat');
      const box = document.getElementById('curator-messages');
      if (box) box.innerHTML = '';
      refreshCuratorQuickReplies();
      showToast('Chat history cleared');
    }
    function clearCuratorPicks() {
      curatorPicks = [];
      // remove any extra suggested cards from DOM
      document.querySelectorAll('.suggested-card').forEach(el => el.remove());
      showToast('Curator picks cleared');
    }

    function copyShareableLink() {
      const url = new URL(window.location.href);
      if (apiBase) {
        url.searchParams.set('apiBase', apiBase);
      }
      navigator.clipboard.writeText(url.toString()).then(() => {
        alert('Shareable link copied! It includes the current API Endpoint Base so the recipient gets it automatically.');
      }).catch(() => {
        // fallback
        prompt('Copy this link (includes API endpoint):', url.toString());
      });
    }

// Settings (LLM config + backup + import) - simple modal using existing style
    // Map the single 0-100 "taste" slider position onto the two underlying weights.
    // 0 = popular-leaning (high quality weight, low genre weight); 50 = shipped defaults;
    // 100 = taste-heavy (low quality weight, high genre weight). Linear interpolation
    // through the default at the midpoint so the slider's centre == current behaviour.
    function tasteSliderToWeights(pos) {
      // pos in [0,100]
      if (pos <= 50) {
        const t = pos / 50; // 0..1
        return {
          qualityBaseline: 1.10 + (RECTUNE_DEFAULTS.qualityBaseline - 1.10) * t,
          genreAffinity:   2.50 + (RECTUNE_DEFAULTS.genreAffinity   - 2.50) * t,
        };
      } else {
        const t = (pos - 50) / 50; // 0..1
        return {
          qualityBaseline: RECTUNE_DEFAULTS.qualityBaseline + (0.45 - RECTUNE_DEFAULTS.qualityBaseline) * t,
          genreAffinity:   RECTUNE_DEFAULTS.genreAffinity   + (6.00 - RECTUNE_DEFAULTS.genreAffinity)   * t,
        };
      }
    }
    // Inverse: recover the closest slider position from stored weights (for re-opening
    // the panel). Uses genreAffinity as the reference axis since it's monotonic in pos.
    function weightsToTasteSlider() {
      const g = recTune.genreAffinity;
      if (g <= RECTUNE_DEFAULTS.genreAffinity) {
        return Math.round(((g - 2.50) / (RECTUNE_DEFAULTS.genreAffinity - 2.50)) * 50);
      }
      return Math.round(50 + ((g - RECTUNE_DEFAULTS.genreAffinity) / (6.00 - RECTUNE_DEFAULTS.genreAffinity)) * 50);
    }
    // Serendipity slider 0-100 <-> exploration 0..1.5
    function exploreSliderToVal(pos) { return (pos / 100) * 1.5; }
    function exploreValToSlider() { return Math.round((recTune.exploration / 1.5) * 100); }

    function initRecTuneSliders() {
      const tasteEl = document.getElementById('tune-taste');
      const exploreEl = document.getElementById('tune-explore');
      const tasteVal = document.getElementById('tune-taste-val');
      const exploreVal = document.getElementById('tune-explore-val');
      const applyBtn = document.getElementById('tune-apply');
      const resetBtn = document.getElementById('tune-reset');
      if (!tasteEl || !exploreEl) return;

      const tasteLabel = (pos) => pos < 33 ? 'Popular-leaning' : pos > 66 ? 'Taste-heavy' : 'Balanced';
      const exploreLabel = (pos) => pos < 20 ? 'Stable' : pos > 70 ? 'High variety' : 'Some variety';

      // Initialise positions from current (possibly saved) weights
      tasteEl.value = Math.max(0, Math.min(100, weightsToTasteSlider()));
      exploreEl.value = Math.max(0, Math.min(100, exploreValToSlider()));
      const refreshLabels = () => {
        if (tasteVal) tasteVal.textContent = tasteLabel(+tasteEl.value);
        if (exploreVal) exploreVal.textContent = exploreLabel(+exploreEl.value);
      };
      refreshLabels();
      tasteEl.oninput = refreshLabels;
      exploreEl.oninput = refreshLabels;

      if (applyBtn) applyBtn.onclick = () => {
        const w = tasteSliderToWeights(+tasteEl.value);
        recTune.qualityBaseline = w.qualityBaseline;
        recTune.genreAffinity = w.genreAffinity;
        recTune.exploration = exploreSliderToVal(+exploreEl.value);
        saveRecTune();
        try { showToast('Recommendation tuning applied'); } catch (_) {}
        document.getElementById('settings-modal').classList.add('hidden');
        // Re-rank the existing pool in place if we have one; otherwise a fresh fetch.
        if (typeof currentRecPool !== 'undefined' && currentRecPool && currentRecPool.length) {
          recomputeRecommendations();
        } else if (typeof refreshRecPool === 'function') {
          refreshRecPool();
        }
      };

      if (resetBtn) resetBtn.onclick = () => {
        recTune = { ...RECTUNE_DEFAULTS };
        saveRecTune();
        tasteEl.value = weightsToTasteSlider();
        exploreEl.value = exploreValToSlider();
        refreshLabels();
        try { showToast('Tuning reset to defaults'); } catch (_) {}
      };
    }

    // Chip row for picking subscribed services. Selecting one re-renders the availability
    // line on any cards already on screen, so the effect is visible without a Recompute —
    // unlike the tuning sliders below, this changes presentation, not ranking.
    function renderMyServicesPicker() {
      const container = document.getElementById('settings-services');
      if (!container) return;
      container.innerHTML = '';

      STREAMING_SERVICES.forEach(({ label }) => {
        const on = myServices.has(label);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.className = `px-3 py-1 text-xs rounded-2xl border transition-all active:scale-[0.985] ${on ? 'filter-chip-active' : 'filter-chip'}`;
        btn.onclick = () => {
          if (myServices.has(label)) myServices.delete(label); else myServices.add(label);
          saveMyServices(myServices);
          renderMyServicesPicker();
          // Repaint availability on whatever is currently rendered.
          if (typeof refreshVisibleAvailability === 'function') refreshVisibleAvailability();
          if (typeof refreshAllWtwSlots === 'function') refreshAllWtwSlots();
          if (typeof syncRecServicesToggleUI === 'function') syncRecServicesToggleUI();
          if (typeof syncBrowseServicesToggleUI === 'function') syncBrowseServicesToggleUI();
          if (typeof updateColdStartUI === 'function') updateColdStartUI();
          // Re-apply browse filter if results are on screen
          if (typeof browseServicesOnly !== 'undefined' && browseServicesOnly
              && typeof lastRenderedItems !== 'undefined' && lastRenderedItems.length
              && typeof renderResults === 'function') {
            renderResults(lastRenderedItems, lastRenderedOpts || {});
          }
          // Services-only ranking depends on the set — re-rank when it changes.
          if (typeof recServicesOnly !== 'undefined' && recServicesOnly && typeof recomputeRecommendations === 'function') {
            recomputeRecommendations();
          }
        };
        container.appendChild(btn);
      });

      const status = document.getElementById('settings-services-status');
      if (status) {
        status.textContent = myServices.size
          ? `${myServices.size} selected — cards show these as Stream, everything else as Rent.`
          : 'None selected — cards will show a Rent marker for anything that is rentable.';
      }
    }

    function showSettings(tab) {
      const modal = document.getElementById('settings-modal');
      if (!modal) return;

      const syncStatus = document.getElementById('settings-sync-status');
      const modelInput = document.getElementById('settings-model');

      if (syncStatus) {
        syncStatus.textContent = 'Cloud sync ready — library can auto-save when password is set.';
        syncStatus.style.color = '#818cf8';
      }
      if (modelInput) modelInput.value = llmConfig.model || 'grok-4.3';

      if (typeof updateSettingsPassStatus === 'function') updateSettingsPassStatus();
      if (typeof switchSettingsTab === 'function') {
        switchSettingsTab(tab || 'streaming');
      }

      modal.classList.remove('hidden');

      const cloudStatus = document.getElementById('settings-cloud-status');
      const setCloudStatus = (msg, color) => {
        if (cloudStatus) { cloudStatus.textContent = msg; cloudStatus.style.color = color || '#71717a'; }
      };

      const cloudSaveBtn = document.getElementById('settings-cloud-save');
      if (cloudSaveBtn) cloudSaveBtn.onclick = async () => {
        setCloudStatus('Saving...', '#fbbf24');
        await pushToServer(true);
        setCloudStatus('Saved (' + watchedList.length + ' watched, ' + toWatchList.length + ' queued)', '#4ade80');
      };

      const cloudLoadBtn = document.getElementById('settings-cloud-load');
      if (cloudLoadBtn) cloudLoadBtn.onclick = async () => {
        setCloudStatus('Loading from cloud...', '#fbbf24');
        const data = await syncFromServer();
        if (data) {
          setCloudStatus('Loaded! ' + watchedList.length + ' watched, ' + toWatchList.length + ' queued', '#4ade80');
          if (typeof updateColdStartUI === 'function') updateColdStartUI();
        } else {
          setCloudStatus('No cloud data found yet. Save from one device first.', '#f87171');
        }
      };

      const saveConfigBtn = document.getElementById('settings-save-config');
      if (saveConfigBtn) saveConfigBtn.onclick = () => {
        if (modelInput) llmConfig.model = modelInput.value.trim() || 'grok-4.3';
        Store.setItem('horror_roki_llm', JSON.stringify(llmConfig));
        setCloudStatus('Config saved', '#4ade80');
      };

      renderMyServicesPicker();
      initRecTuneSliders();
      if (typeof wireLetterboxdImport === 'function') wireLetterboxdImport();

      const backupBtn = document.getElementById('settings-backup');
      if (backupBtn) backupBtn.onclick = downloadFullBackup;

      const importBtn = document.getElementById('settings-import-btn');
      const importFile = document.getElementById('settings-import-file');
      if (importBtn && importFile) importBtn.onclick = () => {
        if (!importFile.files.length) return;
        const reader = new FileReader();
        reader.onload = ev => {
          const txt = ev.target.result || '';
          try {
            const data = JSON.parse(txt);
            if (data.watched) { watchedList = sanitizeLibraryList(data.watched); Store.setItem('horror_roki_watched', JSON.stringify(watchedList)); }
            if (data.to_watch) { toWatchList = sanitizeLibraryList(data.to_watch); Store.setItem('horror_roki_towatch', JSON.stringify(toWatchList)); }
            if (data.disliked) { dislikedList = sanitizeLibraryList(data.disliked); Store.setItem('horror_roki_disliked', JSON.stringify(dislikedList)); }
            if (data.not_interested) { notInterestedList = sanitizeLibraryList(data.not_interested); Store.setItem('horror_roki_not_interested', JSON.stringify(notInterestedList)); }
            if (data.chat_history) { chatHistory = data.chat_history; Store.setItem('horror_roki_chat', JSON.stringify(chatHistory)); }
            if (data.llm_config) { llmConfig = data.llm_config; Store.setItem('horror_roki_llm', JSON.stringify(llmConfig)); }
            updateAllLibraryRenders();
            if (typeof renderCuratorMessages === 'function') renderCuratorMessages();
            if (typeof updateColdStartUI === 'function') updateColdStartUI();
            if (typeof recomputeRecommendations === 'function') recomputeRecommendations();
            modal.classList.add('hidden');
            setCloudStatus('Import loaded', '#4ade80');
          } catch(e) { setCloudStatus('Import failed: ' + e.message, '#f87171'); }
        };
        reader.readAsText(importFile.files[0]);
      };
    }
    function downloadFullBackup() {
      const backup = {
        watched: watchedList,
        to_watch: toWatchList,
        disliked: dislikedList,
        not_interested: notInterestedList,
        chat_history: chatHistory.slice(-30),
        llm_config: llmConfig,
        chat_version: '1.0',
        exported_at: new Date().toISOString(),
        version: '3.0'
      };
      const blob = new Blob([JSON.stringify(backup, null, 2)], {type: 'application/json'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `brous_backup_${new Date().toISOString().slice(0,10)}.json`;
      a.click();
    }


