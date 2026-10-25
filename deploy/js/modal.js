    // ===================== MODAL =====================

    let currentModalItem = null;
    let _modalCloseTimer = null;

    /**
     * Soft poster continuity into the modal — short flight that dissolves mid-path
     * (no land-and-pause). sourceEl: card/img that opened the modal.
     */
    function playModalPosterFlip(sourceEl, item) {
      if (typeof prefersReducedMotion === 'function' && prefersReducedMotion()) return;
      if (!item || !item.poster_path) return;
      let srcImg = null;
      if (sourceEl) {
        if (sourceEl.tagName === 'IMG') srcImg = sourceEl;
        else if (sourceEl.querySelector) {
          srcImg = sourceEl.querySelector('.tonight-hero-poster, .browse-card-poster, img');
        }
      }
      if (!srcImg) return;
      const s = srcImg.getBoundingClientRect();
      if (s.width < 8 || s.height < 8) return;

      const modal = document.getElementById('detail-modal');
      const sheet = modal && modal.querySelector('.modal-sheet');
      if (!sheet) return;
      const t = sheet.getBoundingClientRect();
      // Aim toward the sheet center-top; dissolve before a hard “land”
      const tw = Math.min(96, Math.max(64, s.width * 0.85));
      const th = tw * 1.5;
      const tLeft = t.left + (t.width - tw) / 2;
      const tTop = t.top + Math.min(48, t.height * 0.12);

      document.querySelectorAll('.modal-flip-flyer').forEach(el => el.remove());

      const flyer = document.createElement('div');
      flyer.className = 'modal-flip-flyer';
      flyer.setAttribute('aria-hidden', 'true');
      flyer.innerHTML = `<img src="https://image.tmdb.org/t/p/w342${item.poster_path}" alt="">`;
      flyer.style.left = s.left + 'px';
      flyer.style.top = s.top + 'px';
      flyer.style.width = s.width + 'px';
      flyer.style.height = s.height + 'px';
      flyer.style.opacity = '1';
      document.body.appendChild(flyer);

      // One continuous move + dissolve (opacity starts dropping immediately)
      requestAnimationFrame(() => {
        flyer.classList.add('modal-flip-flyer-go');
        flyer.style.left = tLeft + 'px';
        flyer.style.top = tTop + 'px';
        flyer.style.width = tw + 'px';
        flyer.style.height = th + 'px';
        flyer.style.opacity = '0';
      });
      const cleanup = () => { try { flyer.remove(); } catch (_) {} };
      flyer.addEventListener('transitionend', (ev) => {
        if (ev.propertyName === 'opacity' || ev.propertyName === 'left') cleanup();
      }, { once: true });
      setTimeout(cleanup, 280);
    }

    async function openModal(item, opts) {
      if (!item) return;
      const options = opts && typeof opts === 'object' ? opts : {};
      currentModalItem = item;
      const modal = document.getElementById('detail-modal');
      if (!modal) return;
      const titleEl = document.getElementById('modal-title');
      const metaEl = document.getElementById('modal-meta');
      const overviewEl = document.getElementById('modal-overview');
      const genresEl = document.getElementById('modal-genres');
      const availEl = document.getElementById('modal-availability');
      const addBtn = document.getElementById('modal-add-button');

      if (_modalCloseTimer) {
        clearTimeout(_modalCloseTimer);
        _modalCloseTimer = null;
      }

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

      modal.classList.remove('hidden', 'modal-out', 'modal-in');
      // Force reflow so enter transition always plays
      void modal.offsetWidth;
      modal.classList.add('modal-in');
      titleEl.textContent = item.title || item.name || 'Untitled';
      metaEl.innerHTML = '';
      const sidePoster = document.getElementById('modal-poster');
      if (sidePoster) {
        if (item.poster_path) {
          sidePoster.src = `https://image.tmdb.org/t/p/w185${item.poster_path}`;
          sidePoster.alt = (item.title || item.name || '') + ' poster';
          sidePoster.classList.remove('hidden');
        } else {
          sidePoster.removeAttribute('src');
          sidePoster.classList.add('hidden');
        }
      }

      // Poster FLIP from the card/hero that opened the modal
      playModalPosterFlip(options.sourceEl || null, item);

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

        // Persist runtime for tonight-fit scoring when user later rates / queues from modal
        if (isMovie && detail.runtime) {
          item.runtime = detail.runtime;
          currentModalItem = item;
          if (typeof _runtimeByKey !== 'undefined') {
            try { _runtimeByKey[`${item.id}:movie`] = detail.runtime; } catch (_) {}
          }
        } else if (!isMovie && Array.isArray(detail.episode_run_time) && detail.episode_run_time[0]) {
          item.runtime = detail.episode_run_time[0];
          currentModalItem = item;
          if (typeof _runtimeByKey !== 'undefined') {
            try { _runtimeByKey[`${item.id}:tv`] = item.runtime; } catch (_) {}
          }
        }

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
          // Per-item JustWatch credit — same TMDB requirement as the rec cards.
          availEl.innerHTML = `<div class="flex flex-wrap gap-1 items-center">${allHtml}<span style="font-size:9px;color:#52525b;white-space:nowrap;" title="Streaming availability data by JustWatch">via JustWatch</span></div>`;
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
        <button class="flex-1 px-4 py-2 rounded-3xl bg-emerald-700 text-white text-sm" id="ma-towatch">+ Queue</button>
        <button class="flex-1 px-4 py-2 rounded-3xl bg-zinc-800 border border-zinc-700 text-sm" id="ma-watched">Watched</button>
        <button class="px-4 py-2 rounded-3xl border border-zinc-700 text-zinc-300 text-sm" id="ma-pass">Pass</button>
      `;
      document.getElementById('ma-towatch').onclick = () => { addToToWatch(item); closeModal(); };
      document.getElementById('ma-watched').onclick = () => {
        const actions = document.getElementById('modal-actions-row');
        openInlineRatingPrompt(actions, item, r => {
          addToWatched(item, r);
          closeModal();
        }, { hideButtons: actions ? Array.from(actions.querySelectorAll('button')) : [] });
      };
      const passBtn = document.getElementById('ma-pass');
      if (passBtn) passBtn.onclick = () => {
        if (typeof addToNotInterested === 'function') addToNotInterested(item);
        closeModal();
      };
    }

    function finishCloseModal() {
      const modal = document.getElementById('detail-modal');
      if (!modal) return;
      modal.classList.remove('settings-mode', 'modal-in', 'modal-out');
      modal.classList.add('hidden');
      document.querySelectorAll('.modal-flip-flyer').forEach(el => el.remove());
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

    function closeModal() {
      const modal = document.getElementById('detail-modal');
      if (!modal || modal.classList.contains('hidden')) return;
      if (_modalCloseTimer) {
        clearTimeout(_modalCloseTimer);
        _modalCloseTimer = null;
      }
      const reduced = typeof prefersReducedMotion === 'function' && prefersReducedMotion();
      if (reduced) {
        finishCloseModal();
        return;
      }
      modal.classList.remove('modal-in');
      modal.classList.add('modal-out');
      _modalCloseTimer = setTimeout(() => {
        _modalCloseTimer = null;
        finishCloseModal();
      }, 200);
    }

    // Global Escape-to-close for the detail and settings modals (the transfer
    // modal registers its own Escape handler in transfer.js). Closes whichever
    // is currently visible so keyboard users aren't trapped in a dialog.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const detail = document.getElementById('detail-modal');
      const settings = document.getElementById('settings-modal');
      if (detail && !detail.classList.contains('hidden')) {
        closeModal();
      } else if (settings && !settings.classList.contains('hidden')) {
        settings.classList.add('hidden');
      }
    });

    // Make cards clickable and add watchlist buttons
    function enhanceCard(card, item) {
      card.style.cursor = 'pointer';
      card.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('a')) return;
        openModal(item, { sourceEl: card });
      });
    }



    // My Services UI and filtering removed (user no longer wants to see subscribed services visually).
    // getUserServices now always returns empty so no provider filtering happens.
    function getUserServices() { return {}; }

