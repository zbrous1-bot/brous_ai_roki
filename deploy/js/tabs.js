    // ===================== MAIN PAGE TABS =====================
    function switchMainTab(tab) {
      // Update panels
      ['foryou','curator','browse','watched'].forEach(t => {
        const panel = document.getElementById('panel-' + t);
        const btn = document.getElementById('mtab-' + t);
        const navLink = document.getElementById('nav-' + t);
        if (panel) panel.classList.toggle('active', t === tab);
        if (btn) {
          btn.classList.toggle('active', t === tab);
          // Keep the ARIA state in sync with the visual active state so screen
          // readers announce the current tab correctly.
          btn.setAttribute('aria-selected', t === tab ? 'true' : 'false');
        }
        if (navLink) navLink.classList.toggle('page-active', t === tab);
      });
      const homeGrid = document.getElementById('home-command-grid');
      if (homeGrid) homeGrid.style.display = tab === 'foryou' ? '' : 'none';
      if (tab === 'foryou') { updateHomeSnapshot(); renderTasteStats(); }
      // On mobile, hide the main tab bar when Library is open to free up screen space
      document.body.classList.toggle('library-open', tab === 'watched');
      // Scroll to top of content
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (tab === 'watched') {
        renderToWatch(); renderWatched(); renderDisliked();
        renderPersonalStats();
      }
      if (tab === 'browse') {
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

