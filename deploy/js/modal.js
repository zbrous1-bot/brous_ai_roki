    // ===================== MODAL =====================

    let currentModalItem = null;

    async function openModal(item) {
      currentModalItem = item;
      const modal = document.getElementById('detail-modal');
      const titleEl = document.getElementById('modal-title');
      const metaEl = document.getElementById('modal-meta');
      const overviewEl = document.getElementById('modal-overview');
      const genresEl = document.getElementById('modal-genres');
      const availEl = document.getElementById('modal-availability');
      const addBtn = document.getElementById('modal-add-button');

      // Reset availability wrap visibility for each modal open
      const whereWrap = document.getElementById('modal-availability-wrap');
      if (whereWrap) whereWrap.style.display = '';
      // Reset trailer wrap so a previous title's trailer never flashes before this fetch
      const trailerWrap = document.getElementById('modal-trailer-wrap');
      if (trailerWrap) { trailerWrap.style.display = 'none'; trailerWrap.innerHTML = ''; }
      // Reset backdrop so a previous title's image never lingers
      const backdropEl = document.getElementById('modal-backdrop');
      if (backdropEl) { backdropEl.classList.add('hidden'); backdropEl.style.backgroundImage = ''; }
      if (addBtn && addBtn.parentElement) addBtn.parentElement.style.display = '';

      modal.classList.remove('hidden');
      titleEl.textContent = item.title || item.name || 'Untitled';
      metaEl.innerHTML = '';

      const isMovie = (item._mediaType || 'movie') === 'movie';
      const mediaPath = isMovie ? 'movie' : 'tv';

      try {
        // Fetch richer details
        const detail = await apiFetch(`/api/tmdb/3/${mediaPath}/${item.id}`);

        metaEl.innerHTML = `
          ${detail.release_date || detail.first_air_date ? (detail.release_date || detail.first_air_date).slice(0,4) + ' · ' : ''}
          ${detail.vote_average ? detail.vote_average.toFixed(1) + ' ★ · ' : ''}
          ${isMovie ? (detail.runtime ? detail.runtime + ' min' : '') : (detail.number_of_seasons ? detail.number_of_seasons + ' seasons' : '')}
        `;

        overviewEl.textContent = detail.overview || 'No overview available.';

        genresEl.innerHTML = (detail.genres || []).map(g =>
          `<span class="text-xs px-2.5 py-1 bg-zinc-800 rounded-2xl modal-genre-chip">${escapeHtml(g.name)}</span>`
        ).join('');

        // Backdrop banner — prefer the wide backdrop, fall back to the poster.
        const bd = detail.backdrop_path
          ? `https://image.tmdb.org/t/p/w780${detail.backdrop_path}`
          : (detail.poster_path ? `https://image.tmdb.org/t/p/w780${detail.poster_path}` : null);
        const backdropEl2 = document.getElementById('modal-backdrop');
        if (backdropEl2 && bd) {
          backdropEl2.style.backgroundImage = `url('${bd}')`;
          backdropEl2.classList.remove('hidden');
        }

        // Trailer button — fetch /videos and, if a YouTube trailer exists, show a button
        // that opens it (user-initiated; matches the To Watch list's existing trailer flow).
        try {
          const vdata = await apiFetch(`/api/tmdb/3/${mediaPath}/${item.id}/videos`).catch(() => null);
          const trailer = (vdata?.results || []).find(v => v.site === 'YouTube' && v.type === 'Trailer')
                       || (vdata?.results || []).find(v => v.site === 'YouTube' && v.type === 'Teaser')
                       || (vdata?.results || []).find(v => v.site === 'YouTube');
          const tWrap = document.getElementById('modal-trailer-wrap');
          if (tWrap) {
            if (trailer) {
              tWrap.style.display = '';
              tWrap.innerHTML = `<button id="modal-trailer-btn" class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-2xl bg-red-600 hover:bg-red-500 text-white">▶ Watch Trailer</button>`;
              const tb = document.getElementById('modal-trailer-btn');
              if (tb) tb.onclick = (e) => { e.stopPropagation(); window.open(`https://www.youtube.com/watch?v=${trailer.key}`, '_blank', 'noopener'); };
            } else {
              tWrap.style.display = 'none';
              tWrap.innerHTML = '';
            }
          }
        } catch (_) {}

      } catch (e) {
        overviewEl.textContent = 'Could not load additional details for this title.';
      }

      // Availability - now horizontal compact row (scaled down, no vertical stacking)
      if (item.providers) {
        const groups = { stream: item.providers.flatrate || [], rent: item.providers.rent || [], buy: item.providers.buy || [] };
        let allHtml = '';
        Object.entries(groups).forEach(([type, items]) => {
          if (!items.length) return;
          const short = type === 'stream' ? 'S' : type.charAt(0).toUpperCase();
          items.forEach(p => {
            const name = getProviderName(p);
            const colorClass = PROVIDER_COLORS[name] || 'bg-zinc-700 text-zinc-200';
            allHtml += `<span class="inline-flex items-center px-1.5 py-px text-[9px] rounded-2xl ${colorClass} border border-white/10 mr-1 mb-0.5" title="${type}">${short}: ${escapeHtml(name)}</span>`;
          });
        });
        const wrap = document.getElementById('modal-availability-wrap');
        if (allHtml) {
          availEl.innerHTML = `<div class="flex flex-wrap gap-1">${allHtml}</div>`;
          if (wrap) wrap.style.display = '';
        } else {
          availEl.innerHTML = '';
          if (wrap) wrap.style.display = 'none';
        }
      } else {
        availEl.innerHTML = '';
        const wrap = document.getElementById('modal-availability-wrap');
        if (wrap) wrap.style.display = 'none';
      }

      // Rich actions (full lists support)
      addBtn.style.display = 'none'; // hide single, use our row
      let actions = document.getElementById('modal-actions-row');
      if (!actions) {
        actions = document.createElement('div');
        actions.id = 'modal-actions-row';
        actions.className = 'flex gap-2 mt-2';
        const footer = addBtn.parentNode;
        footer.appendChild(actions);
      }
      actions.innerHTML = `
        <button class="flex-1 px-4 py-2 rounded-3xl bg-emerald-700 text-white text-sm" id="ma-towatch">+ To Watch</button>
        <button class="flex-1 px-4 py-2 rounded-3xl bg-zinc-800 border border-zinc-700 text-sm" id="ma-watched">⭐ Mark Watched</button>
        <button class="px-4 py-2 rounded-3xl border border-zinc-700 text-red-400 text-sm" id="ma-dislike">👎 Dislike</button>
      `;
      document.getElementById('ma-towatch').onclick = () => { addToToWatch(item); closeModal(); };
      document.getElementById('ma-watched').onclick = () => {
        const actions = document.getElementById('modal-actions-row');
        openInlineRatingPrompt(actions, item, r => {
          addToWatched(item, r);
          closeModal();
        }, { hideButtons: actions ? Array.from(actions.querySelectorAll('button')) : [] });
      };
      document.getElementById('ma-dislike').onclick = () => { addToDisliked(item); closeModal(); };
    }

    function closeModal() {
      const modal = document.getElementById('detail-modal');
      if (modal) {
        modal.classList.remove('settings-mode');
        modal.classList.add('hidden');
        // cleanup any temp Settings-only hides/styles
        const st = document.getElementById('settings-modal-hide-style');
        if (st) st.remove();
        const whereWrap = document.querySelector('#detail-modal .mb-2');
        if (whereWrap) {
          whereWrap.style.display = '';
          // Restore the "Where to watch" label text for normal movie modals
          const label = whereWrap.querySelector('div');
          if (label && label.dataset.originalText !== undefined) {
            label.textContent = label.dataset.originalText;
            delete label.dataset.originalText;
          }
        }
      }
    }

    // Make cards clickable and add watchlist buttons
    function enhanceCard(card, item) {
      card.style.cursor = 'pointer';
      card.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('a')) return;
        openModal(item);
      });
    }



    // My Services UI and filtering removed (user no longer wants to see subscribed services visually).
    // getUserServices now always returns empty so no provider filtering happens.
    function getUserServices() { return {}; }

