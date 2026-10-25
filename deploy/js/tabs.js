    // ===================== MAIN PAGE TABS =====================
    function switchMainTab(tab) {
      // Curator is behind CURATOR_ENABLED — bounce any entry point to For You.
      if (tab === 'curator' && typeof CURATOR_ENABLED !== 'undefined' && !CURATOR_ENABLED) {
        tab = 'foryou';
      }
      const reduced = typeof prefersReducedMotion === 'function' && prefersReducedMotion();
      // Update panels
      ['foryou','curator','browse','watched'].forEach(t => {
        const panel = document.getElementById('panel-' + t);
        const btn = document.getElementById('mtab-' + t);
        const navLink = document.getElementById('nav-' + t);
        const bottomBtn = document.getElementById('bnav-' + t);
        if (panel) {
          const on = t === tab;
          panel.classList.toggle('active', on);
          panel.classList.remove('panel-enter');
          if (on && !reduced) {
            // Restart enter animation each time this tab becomes active
            void panel.offsetWidth;
            panel.classList.add('panel-enter');
          }
        }
        if (btn) {
          btn.classList.toggle('active', t === tab);
          // Keep the ARIA state in sync with the visual active state so screen
          // readers announce the current tab correctly.
          btn.setAttribute('aria-selected', t === tab ? 'true' : 'false');
        }
        if (navLink) navLink.classList.toggle('page-active', t === tab);
        if (bottomBtn) {
          bottomBtn.classList.toggle('active', t === tab);
          if (t === tab) bottomBtn.setAttribute('aria-current', 'page');
          else bottomBtn.removeAttribute('aria-current');
        }
      });
      const homeGrid = document.getElementById('home-command-grid');
      if (homeGrid) homeGrid.style.display = tab === 'foryou' ? '' : 'none';
      if (tab === 'foryou') {
        updateHomeSnapshot();
        renderTasteStats();
        // Ensure recs appear when landing on For You without a manual Refresh
        if (typeof currentRecPool !== 'undefined' && currentRecPool.length) {
          if (typeof recomputeRecommendations === 'function') recomputeRecommendations();
        } else if (typeof refreshRecPool === 'function' && !(typeof _recPoolLoading !== 'undefined' && _recPoolLoading)) {
          if (!(typeof keywordPoolActive !== 'undefined' && keywordPoolActive)) {
            refreshRecPool().catch(() => {});
          }
        }
      }
      // On mobile, hide the main tab bar when Library is open to free up screen space
      document.body.classList.toggle('library-open', tab === 'watched');
      // Scroll to top of content
      window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
      if (tab === 'watched') {
        renderToWatch(); renderWatched(); renderDisliked();
        renderPersonalStats();
      }
      if (tab === 'browse') {
        if (typeof syncBrowseServicesToggleUI === 'function') syncBrowseServicesToggleUI();
        setTimeout(() => {
          const inp = document.getElementById('search-input');
          if (inp) inp.focus();
        }, 200);
      }
      // When switching to Curator, jump the chat to the latest message so the
      // newest reply and the input bar are immediately in view (no scrolling).
      if (tab === 'curator') {
        setTimeout(() => {
          const msgs = document.getElementById('curator-messages');
          if (msgs) msgs.scrollTop = msgs.scrollHeight;
          // Focus the input on desktop only; on mobile this can pop the keyboard
          // and cover the chat, so we just make sure it's visible instead.
          const inp = document.getElementById('curator-input');
          if (inp && window.innerWidth > 640) inp.focus();
        }, 200);
      }
    }

