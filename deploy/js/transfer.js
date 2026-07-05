    // ===================== DEVICE TRANSFER (no server needed) =====================
    // pako (zlib deflate) compression — synchronous, cross-browser, ~537 chars for 30 movies

    function _lzCompress(str) {
      try {
        const bytes = new TextEncoder().encode(str);
        const compressed = pako.deflateRaw(bytes);
        let bin = '';
        compressed.forEach(b => bin += String.fromCharCode(b));
        const b64 = btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
        return 'z' + b64;
      } catch(e) {
        console.error('compress error', e);
        return null;
      }
    }

    function _lzDecompress(s) {
      try {
        if (!s || s.length < 2) return null;
        const mode = s[0];
        if (mode !== 'z') {
          // Legacy plain base64 fallback (v1/v2)
          try { return decodeURIComponent(escape(atob(s.slice(1).replace(/-/g,'+').replace(/_/g,'/')))) } catch(e) { return null; }
        }
        const b64 = s.slice(1).replace(/-/g,'+').replace(/_/g,'/');
        // Pad base64 to multiple of 4
        const padded = b64 + '=='.slice((b64.length % 4) ? b64.length % 4 - 2 : 2);
        const bin = atob(padded);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder().decode(pako.inflateRaw(bytes));
      } catch(e) {
        console.error('decompress error', e);
        return null;
      }
    }

    function minifyPayload() {
      // v3 format: ultra-compact
      // watched: just {i:id, r:rating, m:mediaType} — we re-fetch poster/title from TMDB on import if needed
      // to_watch: keep enough to display (title, poster, year, genres)
      // disliked: just id numbers
      const wf = ['id','title','poster_path','vote_average','release_date','genre_ids','_mediaType','_rating'];
      const qf = ['id','title','poster_path','vote_average','release_date','genre_ids','_mediaType'];
      return {
        w: watchedList.map(x => ({i:x.id,r:x._rating||0,m:x._mediaType||'movie',t:x.title,p:x.poster_path,v:x.vote_average,d:x.release_date,g:x.genre_ids})),
        q: toWatchList.map(x => { const o={}; qf.forEach(f=>{if(x[f]!==undefined)o[f]=x[f];}); return o; }),
        d: dislikedList.map(x => x.id),
        v: '3'
      };
    }

    function expandPayload(raw) {
      if (raw.v === '3') {
        return {
          watched:  (raw.w||[]).map(x => ({id:x.i,_rating:x.r,_mediaType:x.m||'movie',title:x.t,poster_path:x.p,vote_average:x.v,release_date:x.d,genre_ids:x.g||[]})),
          to_watch: raw.q || [],
          disliked: (raw.d||[]).map(id => ({id, _mediaType:'movie'}))
        };
      }
      // v1/v2 legacy
      return {
        watched:  raw.watched  || raw.w || [],
        to_watch: raw.to_watch || raw.q || [],
        disliked: (raw.disliked || raw.d || []).map(x => typeof x === 'number' ? {id:x,_mediaType:'movie'} : x)
      };
    }

    function showTransferModal() {
      const modal = document.getElementById('transfer-modal');
      if (!modal) return;
      modal.classList.remove('hidden');
      const stats = document.getElementById('transfer-stats');
      if (stats) {
        const t = watchedList.length + toWatchList.length + dislikedList.length;
        stats.innerHTML = `<span style="color:#a5b4fc">${watchedList.length} watched</span> · <span style="color:#86efac">${toWatchList.length} queued</span> · <span style="color:#f87171">${dislikedList.length} disliked</span> · <strong style="color:#e4e4e7">${t} total</strong>`;
      }
      const linkArea = document.getElementById('transfer-link-area');
      if (linkArea) linkArea.classList.add('hidden');
      const genBtn = document.getElementById('transfer-gen-btn');
      if (genBtn) { genBtn.textContent = 'Generate Transfer Link'; genBtn.disabled = false; }
    }

    function closeTransferModal() {
      document.getElementById('transfer-modal')?.classList.add('hidden');
    }

    function generateTransferLink() {
      const btn = document.getElementById('transfer-gen-btn');
      if (btn) { btn.textContent = 'Generating...'; btn.disabled = true; }
      try {
        // Guard: pako must be available
        if (typeof pako === 'undefined') {
          alert('Compression library not loaded yet. Please wait a moment and try again, or refresh the page.');
          if (btn) { btn.textContent = 'Generate Transfer Link'; btn.disabled = false; }
          return;
        }
        const payload = minifyPayload();
        const json = JSON.stringify(payload);
        const encoded = _lzCompress(json);
        if (!encoded) { throw new Error('Compression returned empty result'); }

        // Build clean base URL (strip any existing ?t= so we don't double-encode)
        const url = new URL(window.location.href);
        url.hash = '';
        url.search = '';
        url.searchParams.set('t', encoded);
        const final = url.toString();

        const linkText = document.getElementById('transfer-link-text');
        if (linkText) linkText.value = final;
        const sizeEl = document.getElementById('transfer-link-size');
        const total = watchedList.length + toWatchList.length + dislikedList.length;
        if (sizeEl) sizeEl.textContent = `${final.length.toLocaleString()} chars · ${total} titles`;

        const linkArea = document.getElementById('transfer-link-area');
        if (linkArea) linkArea.classList.remove('hidden');

        showTransferQR(final);
      } catch(e) {
        alert('Failed to generate: ' + e.message);
      }
      if (btn) { btn.textContent = 'Regenerate'; btn.disabled = false; }
    }

    function copyTransferLink() {
      const txt = document.getElementById('transfer-link-text');
      if (!txt) return;
      navigator.clipboard.writeText(txt.value).then(() => {
        const btn = document.getElementById('transfer-copy-btn');
        if (btn) { const o = btn.textContent; btn.textContent = '✓ Copied!'; btn.style.background='#15803d'; setTimeout(() => { btn.textContent = o; btn.style.background=''; }, 2000); }
      }).catch(() => { txt.select(); document.execCommand('copy'); });
    }

    function showTransferQR(url) {
      const qrArea = document.getElementById('transfer-qr-area');
      if (!qrArea || !url) return;

      qrArea.innerHTML = `<div style="width:220px;height:220px;background:#18181b;border-radius:12px;display:flex;align-items:center;justify-content:center;margin:0 auto;">
        <div style="font-size:11px;color:#71717a;">Generating QR...</div>
      </div>`;

      // Use local QRCode library — no network request, works offline, always reliable
      if (typeof QRCode !== 'undefined') {
        const canvas = document.createElement('canvas');
        QRCode.toCanvas(canvas, url, {
          width: 220,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
          errorCorrectionLevel: 'M'
        }, (err) => {
          if (err) {
            console.error('QR generation error:', err);
            qrArea.innerHTML = `<div style="padding:16px;background:#1c1917;border:1px solid #3f3f46;border-radius:12px;text-align:center;max-width:220px;margin:0 auto;">
              <div style="font-size:20px;margin-bottom:6px;">📋</div>
              <div style="font-size:12px;color:#d4d4d8;font-weight:600;margin-bottom:4px;">QR unavailable — data too large</div>
              <div style="font-size:11px;color:#a1a1aa;">Use Copy Link instead and send via iMessage or Notes.</div>
            </div>`;
            return;
          }
          canvas.style.cssText = 'border-radius:12px;display:block;margin:0 auto;max-width:100%;';
          qrArea.innerHTML = '';
          qrArea.appendChild(canvas);
          const cap = document.createElement('div');
          cap.style.cssText = 'font-size:11px;color:#71717a;margin-top:8px;text-align:center;';
          cap.textContent = 'Scan with your phone camera';
          qrArea.appendChild(cap);
        });
      } else {
        // Fallback to API if qrcode.js didn't load
        const enc = encodeURIComponent(url);
        const apiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${enc}&margin=8`;
        const img = new Image(220, 220);
        img.alt = 'QR Code';
        img.style.cssText = 'border-radius:12px;background:#fff;display:block;margin:0 auto;';
        img.onerror = () => {
          qrArea.innerHTML = `<div style="padding:16px;background:#1c1917;border:1px solid #3f3f46;border-radius:12px;text-align:center;max-width:220px;margin:0 auto;">
            <div style="font-size:20px;margin-bottom:6px;">📋</div>
            <div style="font-size:12px;color:#d4d4d8;font-weight:600;margin-bottom:4px;">QR unavailable</div>
            <div style="font-size:11px;color:#a1a1aa;">Tap Copy Link and send via iMessage.</div>
          </div>`;
        };
        img.onload = () => {
          qrArea.innerHTML = '';
          qrArea.appendChild(img);
          const cap = document.createElement('div');
          cap.style.cssText = 'font-size:11px;color:#71717a;margin-top:8px;text-align:center;';
          cap.textContent = 'Scan with your phone camera';
          qrArea.appendChild(cap);
        };
        img.src = apiUrl;
      }
    }

    async function importFromTransferLink(urlStr) {
      const statusEl = document.getElementById('transfer-import-status');
      const setStatus = (msg, color) => {
        console.log('[Transfer]', msg);
        if (statusEl) { statusEl.textContent = msg; statusEl.style.color = color||'#71717a'; }
      };

      // Guard: pako must be available
      if (typeof pako === 'undefined') {
        setStatus('Compression library not loaded. Please refresh and try again.', '#f87171');
        return;
      }

      try {
        // Resolve the encoded payload — prefer window._pendingTransferData (set at page load
        // from URL params, immune to iOS URL mangling), then fallback to textarea/urlStr
        let encoded = window._pendingTransferData || null;

        if (!encoded) {
          // Sanitize — strip whitespace, smart quotes, invisible chars
          let rawSrc = urlStr || document.getElementById('transfer-import-text')?.value || '';
          rawSrc = rawSrc
            .replace(/[\u2018\u2019\u201C\u201D\u2026\uFEFF]/g, '')
            .replace(/\s+/g, '')
            .trim();
          if (!rawSrc) { setStatus('Paste a transfer link first.', '#f87171'); return; }

          // Try as full URL
          try { const u = new URL(rawSrc); encoded = u.searchParams.get('t') || u.searchParams.get('transfer'); } catch(_) {}
          // Try as raw encoded string
          if (!encoded && rawSrc.startsWith('z') && rawSrc.length > 10) encoded = rawSrc;
          if (!encoded) { setStatus('No transfer data found. Make sure you copied the full link.', '#f87171'); return; }
        }

        setStatus('Loading...', '#fbbf24');
        const json = _lzDecompress(encoded);
        if (!json) { setStatus('Could not decode — link may be corrupted. Try again.', '#f87171'); return; }

        const raw = JSON.parse(json);
        const data = expandPayload(raw);
        let count = 0;

        if (data.watched && data.watched.length)  {
          watchedList = data.watched;
          Store.setItem('horror_roki_watched', JSON.stringify(watchedList));
          count += data.watched.length;
        }
        if (data.to_watch && data.to_watch.length) {
          toWatchList = data.to_watch;
          Store.setItem('horror_roki_towatch', JSON.stringify(toWatchList));
          count += data.to_watch.length;
        }
        if (data.disliked && data.disliked.length) {
          dislikedList = data.disliked;
          Store.setItem('horror_roki_disliked', JSON.stringify(dislikedList));
        }
        if (data.not_interested && data.not_interested.length) {
          notInterestedList = data.not_interested;
          Store.setItem('horror_roki_not_interested', JSON.stringify(notInterestedList));
        }

        watchedIds = new Set([...toWatchList,...watchedList,...dislikedList,...notInterestedList].map(w=>`${w.id}:${w._mediaType||'movie'}`));

        // Safe render calls — each wrapped so one failure doesn’t block the rest
        try { updateAllLibraryRenders(); } catch(e) { console.warn('[Transfer] render error:', e); }
        try { renderPersonalStats(); } catch(e) { console.warn('[Transfer] stats error:', e); }
        try { if (typeof updateHomeSnapshot === 'function') updateHomeSnapshot(); } catch(e) { console.warn('[Transfer] home snapshot error:', e); }
        try { await pushToServer(true, true); } catch(e) { console.warn('[Transfer] cloud save error:', e); }

        setStatus(`✓ Loaded ${count} titles!`, '#4ade80');

        // Clean URL
        try {
          const clean = new URL(window.location.href);
          clean.searchParams.delete('t'); clean.searchParams.delete('transfer');
          window.history.replaceState({}, '', clean.toString());
        } catch(e) {}

        window._pendingTransferData = null;
        document.getElementById('transfer-banner')?.remove();

        // Native alert so mobile users definitely see success
        alert(`✓ Transfer complete! ${count} titles loaded to this device.`);
        setTimeout(closeTransferModal, 500);

      } catch(e) {
        console.error('[Transfer] import error:', e);
        setStatus('Error: ' + e.message, '#f87171');
        alert('Transfer failed: ' + e.message + '\n\nCheck browser console for details.');
      }
    }

    function checkIncomingTransfer() {
      const params = new URLSearchParams(window.location.search);
      const encoded = params.get('t') || params.get('transfer');
      if (!encoded) return;

      // Store the encoded data immediately so it survives any DOM delays
      window._pendingTransferData = encoded;

      // Helper that does the actual import with pako-readiness wait
      async function doImport(btn) {
        if (btn) { btn.textContent = 'Loading...'; btn.disabled = true; }
        let waited = 0;
        while (typeof pako === 'undefined' && waited < 6000) {
          await new Promise(r => setTimeout(r, 200));
          waited += 200;
        }
        if (typeof pako === 'undefined') {
          if (btn) { btn.textContent = 'Load'; btn.disabled = false; }
          alert('Could not load compression library. Please refresh and try again.');
          return;
        }
        // Decode directly from stored data (don't re-parse window.location which iOS may mangle)
        const statusEl = document.getElementById('transfer-import-status');
        const setStatus = (msg, color) => { if (statusEl) { statusEl.textContent = msg; statusEl.style.color = color||'#71717a'; } };
        try {
          setStatus('Loading...', '#fbbf24');
          const json = _lzDecompress(window._pendingTransferData);
          if (!json) { setStatus('Could not decode — try pasting the link manually.', '#f87171'); if (btn) { btn.textContent='Load'; btn.disabled=false; } return; }
          const raw = JSON.parse(json);
          const data = expandPayload(raw);
          let count = 0;
          if (data.watched.length)  { watchedList  = data.watched;  Store.setItem('horror_roki_watched',  JSON.stringify(watchedList));  count += data.watched.length; }
          if (data.to_watch.length) { toWatchList  = data.to_watch; Store.setItem('horror_roki_towatch',  JSON.stringify(toWatchList));  count += data.to_watch.length; }
          if (data.disliked.length) { dislikedList = data.disliked; Store.setItem('horror_roki_disliked', JSON.stringify(dislikedList)); }
          watchedIds = new Set([...toWatchList,...watchedList,...dislikedList,...notInterestedList].map(w=>`${w.id}:${w._mediaType||'movie'}`));
          if (typeof updateAllLibraryRenders === 'function') updateAllLibraryRenders();
          if (typeof renderPersonalStats === 'function') renderPersonalStats();
          if (typeof updateHomeSnapshot === 'function') updateHomeSnapshot();
          await pushToServer(true, true);
          setStatus(`✓ Loaded ${count} titles!`, '#4ade80');
          // Clean URL
          const clean = new URL(window.location.href);
          clean.searchParams.delete('t'); clean.searchParams.delete('transfer');
          window.history.replaceState({}, '', clean.toString());
          window._pendingTransferData = null;
          document.getElementById('transfer-banner')?.remove();
          setTimeout(closeTransferModal, 1200);
          // Show success alert on mobile where status text may be hidden
          setTimeout(() => alert(`✓ Transfer complete! ${count} titles loaded.`), 400);
        } catch(e) {
          setStatus('Error: ' + e.message, '#f87171');
          if (btn) { btn.textContent = 'Load'; btn.disabled = false; }
        }
      }

      // Show the Transfer modal open at Step 2 (most visible on mobile)
      // AND show the floating banner — belt-and-suspenders
      setTimeout(() => {
        // Open modal pre-filled
        if (typeof showTransferModal === 'function') {
          showTransferModal();
          // Pre-fill the import textarea
          const importTxt = document.getElementById('transfer-import-text');
          if (importTxt) importTxt.value = window.location.href;
          // Update status
          const statusEl = document.getElementById('transfer-import-status');
          if (statusEl) { statusEl.textContent = 'Transfer link detected — tap Load Data below'; statusEl.style.color = '#a5b4fc'; }
        }
      }, 800);

      // Also show floating banner
      const banner = document.createElement('div');
      banner.id = 'transfer-banner';
      banner.style.cssText = 'position:fixed;top:60px;left:0;right:0;z-index:9999;display:flex;justify-content:center;padding:0 16px;pointer-events:none;';
      banner.innerHTML = `
        <div style="background:linear-gradient(135deg,#1e1b4b,#312e81);border:1px solid rgba(99,102,241,0.5);border-radius:16px;padding:14px 20px;display:flex;align-items:center;gap:12px;max-width:480px;width:100%;box-shadow:0 4px 24px rgba(99,102,241,0.25);pointer-events:all;">
          <span style="font-size:22px;flex-shrink:0;">📲</span>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;color:#e0e7ff;font-size:14px;">Library transfer detected</div>
            <div style="font-size:12px;color:#a5b4fc;margin-top:2px;">Tap Load — or use the modal that just opened</div>
          </div>
          <button id="transfer-load-btn" style="padding:8px 16px;border-radius:12px;background:#4f46e5;color:white;font-size:13px;font-weight:600;border:none;cursor:pointer;flex-shrink:0;">Load</button>
          <button onclick="document.getElementById('transfer-banner').remove();" style="padding:8px 10px;border-radius:12px;background:rgba(255,255,255,0.08);color:#a5b4fc;font-size:13px;border:none;cursor:pointer;flex-shrink:0;">✕</button>
        </div>`;
      document.body.appendChild(banner);
      document.getElementById('transfer-load-btn').onclick = () => doImport(document.getElementById('transfer-load-btn'));
    }

        // Boot (extended for new library + recs + curator)
    function boot() {
      try {
        // Wire quick-reply chips for the Curator (cool, fast UX)
        const quickReplies = document.getElementById('curator-quick-replies');
        if (quickReplies) {
          quickReplies.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-q]');
            if (!btn) return;
            const q = btn.dataset.q;
            const inp = document.getElementById('curator-input');
            if (inp) {
              inp.value = q;
              sendToCurator();
            }
          });
        }

        // Click outside the modal content (on the dark backdrop) closes it
        const modalEl = document.getElementById('detail-modal');
        if (modalEl) {
          modalEl.addEventListener('click', (e) => {
            if (e.target === modalEl) {
              closeModal();
            }
          });
        }

        // Global keyboard shortcuts
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            const m = document.getElementById('detail-modal');
            if (m && !m.classList.contains('hidden')) closeModal();
          }
          // Enter on Browse panel: run search if input has text, otherwise discover
          if (e.key === 'Enter') {
            const browsePanel = document.getElementById('panel-browse');
            if (!browsePanel || !browsePanel.classList.contains('active')) return;
            const searchInput = document.getElementById('search-input');
            const hasQuery = searchInput && searchInput.value.trim().length > 0;
            // If search input has text, let its own onkeypress handle it
            if (hasQuery && document.activeElement === searchInput) return;
            e.preventDefault();
            performDiscover();
          }
        });

        // Initialize Discover UI
        if (typeof renderGenreChips === 'function') renderGenreChips();
        if (typeof renderRatingChips === 'function') renderRatingChips();
        if (typeof renderDecadeChips === 'function') renderDecadeChips();
        if (typeof setDiscoverType === 'function') setDiscoverType('movie'); // default to Movies

        // Initialize Search type
        if (typeof setSearchType === 'function') setSearchType('movie');

        // Watchlist (legacy)
        if (typeof renderWatchlist === 'function') renderWatchlist();

        // New Horror Roki inits
        // One-time seed: if new lists empty but legacy watchlist has data, treat legacy as To Watch
        if ((!toWatchList || toWatchList.length === 0) && watchlist && watchlist.length > 0) {
          toWatchList = watchlist.map(x => ({...x}));
          Store.setItem('horror_roki_towatch', JSON.stringify(toWatchList));
        }
        // Re-sync legacy exclusion set from all lists (watched disappear fix)
        watchedIds = new Set([...toWatchList, ...watchedList, ...dislikedList, ...notInterestedList, ...watchlist].map(w => `${w.id}:${w._mediaType || 'movie'}`));
        if (typeof updateAllLibraryRenders === 'function') updateAllLibraryRenders();
        if (typeof renderCuratorMessages === 'function') renderCuratorMessages();
        if (typeof refreshCuratorQuickReplies === 'function') refreshCuratorQuickReplies();
        if (typeof setCuratorMood === 'function') setCuratorMood();
        if (typeof setupPullToRefresh === 'function') setupPullToRefresh();
        if (typeof renderPersonalStats === 'function') renderPersonalStats();
        if (typeof updateHomeSnapshot === 'function') updateHomeSnapshot();

        // init top personal tabs (default to To Watch)
        if (typeof switchPersonalTab === 'function') switchPersonalTab('towatch');
        if (typeof applyListsCollapse === 'function') applyListsCollapse();

        // Pull latest from server KV (if configured). This is what makes phone + desktop share the same watched/disliked lists.
        // Non-blocking. Falls back silently to whatever is in localStorage on this device.
        setTimeout(() => {
          if (typeof syncFromServer === 'function') syncFromServer().catch(() => {});
        }, 650);

        // Check if page was opened from a Transfer link
        if (typeof checkIncomingTransfer === 'function') checkIncomingTransfer();

        // Hide the beginner help note once password is set
        const helpNote = document.getElementById('first-time-help');
        if (helpNote && Store.getItem('brous_password')) {
          helpNote.style.display = 'none';
        }

        // Show current apiBase in the help note for debugging
        const baseNote = document.getElementById('current-base-note');
        if (baseNote) {
          const currentBase = apiBase || '(using relative /api - good for live pages.dev)';
          baseNote.textContent = 'Current API base: ' + currentBase + '  |  After fixing secrets in Cloudflare, you MUST redeploy the Worker code (Save and Deploy) for the secret to become visible to the running code.';
        }
        // Optional: auto-seed a small rec pool for "Recommended for you" on first boot (user can Refresh)
        if (!currentRecPool.length && watchedList.length > 0) {
          // fire and forget; non blocking
          setTimeout(() => { if (typeof refreshRecPool === 'function') refreshRecPool().catch(()=>{}); }, 1200);
        }
        renderTasteStats();

        // Helpful console note for first-time setup (password is required for the Worker)
        if (!Store.getItem('brous_password')) {
          console.log('%c[Horror Roki] No API password set yet. Click the 🔐 Pass button or ⚙︎ Settings. (On live site with routes, leave API Endpoint Base empty.)', 'color:#f59e0b');
        }

        // Visible confirmation that JS booted successfully
        window.__appInitialized = true;
        console.log(`%c[Brous Movie Engine] Boot completed successfully (${APP_VERSION}). UI should be interactive.`, 'color:#4ade80');
        const footerVersionEl = document.getElementById('app-version-footer');
        if (footerVersionEl) footerVersionEl.textContent = APP_VERSION;
      } catch(e) {
        console.error('Error in boot():', e);
        var banner = document.createElement('div');
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#b91c1c;color:#fff;padding:12px;z-index:999999;font-size:13px;';
        banner.innerHTML = 'Error during app initialization: ' + e.message + '<br>Check Console (F12) for full stack. Try hard refresh (Ctrl/Cmd+Shift+R) or clear site data.';
        if (document.body) document.body.insertBefore(banner, document.body.firstChild);
      }
    }

    // Re-render watchlist when adding from anywhere
    const originalAddToWatchlist = addToWatchlist;
    window.addToWatchlist = function(item) {
      originalAddToWatchlist(item);
      renderWatchlist();
    };

    async function managePassword() {
      const current = Store.getItem('brous_password');
      if (current) {
        if (confirm('Password is currently set. Clear it and enter a new one?')) {
          Store.removeItem('brous_password');
          apiPassword = '';
        } else {
          return;
        }
      }
      const entered = prompt('Enter the shared password (matches your Worker PASSWORD secret):');
      if (!entered) return; // cancelled or empty — leave state untouched, no false "saved" message

      // Verify against the live backend before claiming success, so a typo is never silently treated as correct.
      const base = apiBase.replace(/\/+$/, '');
      let verifyRes;
      try {
        verifyRes = await fetch(base + '/api/data/check', {
          headers: { 'Authorization': 'Basic ' + btoa('user:' + entered) },
        });
      } catch (err) {
        alert('Could not reach the Worker to verify the password (network error). Not saved — try again.');
        return;
      }

      if (verifyRes.status === 401) {
        alert('Wrong password — the Worker rejected it. Not saved. Click 🔐 Pass to try again.');
        return;
      }
      if (!verifyRes.ok) {
        alert('Worker returned an unexpected error (status ' + verifyRes.status + ') while verifying. Password not saved.');
        return;
      }

      apiPassword = entered;
      Store.setItem('brous_password', apiPassword);
      const btn = document.getElementById('pass-btn');
      if (btn) {
        btn.textContent = '🔐 OK';
        btn.title = 'Password saved for this browser. Click to change or clear.';
      }
      alert('Password verified and saved for this browser. Reloading data now...');
      const helpNote = document.getElementById('first-time-help');
      if (helpNote) helpNote.style.display = 'none';
      // Refresh anything that depends on auth (library sync, etc.) now that we have a valid password.
      if (typeof syncFromServer === 'function') {
        syncFromServer().catch(() => {});
      } else {
        location.reload();
      }
    }

    // PWA Install support (especially useful on Android)
    let deferredPrompt;
    const installBtn = document.getElementById('install-btn');

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      if (installBtn) installBtn.classList.remove('hidden');
    });

    function installPWA() {
      if (installBtn) installBtn.classList.add('hidden');
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(() => {
          deferredPrompt = null;
        });
      }
    }

    // Also show install button on Android Chrome if available
    if (installBtn && /android/i.test(navigator.userAgent)) {
      setTimeout(() => {
        if (deferredPrompt) installBtn.classList.remove('hidden');
      }, 3000);
    }

    // Password button hint
    const passBtn = document.getElementById('pass-btn');
    if (passBtn && Store.getItem('brous_password')) {
      passBtn.textContent = '🔐 OK';
      passBtn.title = 'Password saved for this browser. Click to change or clear.';
    }

    // Defensive wiring for header buttons in case inline onclick has issues
    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) settingsBtn.onclick = showSettings;

    if (passBtn) passBtn.onclick = managePassword;

    // Wire the Load Data button via JS (not inline onclick) to guarantee correct scope
    document.addEventListener('DOMContentLoaded', function() {
      const loadBtn = document.getElementById('transfer-load-data-btn');
      if (loadBtn) {
        loadBtn.addEventListener('click', function() {
          try {
            importFromTransferLink();
          } catch(e) {
            alert('Transfer button error: ' + e.message);
            console.error('Transfer load btn error:', e);
          }
        });
      }
    });

    window.onload = function() {
      try {
        boot();
      } catch(e) {
        console.error('Boot error:', e);
        const err = document.createElement('div');
        err.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#b91c1c;color:white;padding:10px;z-index:99999;font-size:12px;';
        err.innerHTML = 'JS Error during boot: ' + e.message + '<br>Buttons may not work. Check browser console (long press page > Inspect). Data may need re-import via Settings once working. Try hard refresh or re-add PWA icon.';
        document.body.appendChild(err);
      }
    };
