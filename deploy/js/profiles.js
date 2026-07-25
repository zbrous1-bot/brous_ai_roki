    // ===================== PROFILES =====================
    // Per-person libraries (you / Bradlee) plus the joint "Together" rec mode.
    //
    // The whole feature rests on one property of the recs engine: the taste profile is
    // DERIVED, not stored. buildTasteProfile() in recs.js recomputes genre affinities,
    // decade counts and genre-pair scores from the library lists on every recompute.
    // So there is no stored profile to fork — swapping whose lists are in memory and
    // recomputing is sufficient to swap the recommendations.
    //
    // Storage is namespaced by Store.setProfile() (see the profile-scoping block in
    // store.js). The primary profile uses the original unsuffixed keys, so the data that
    // existed before profiles landed stays exactly where it was.

    // Accents deliberately avoid purple and indigo: this app reserves purple for the
    // Curator sub-brand and indigo for Cloud Sync, so reusing either here would make a
    // profile pill read as one of those features. Crimson stays the engine/primary,
    // teal and amber are unclaimed.
    const PROFILES = [
      { id: 'me', name: 'Zach', accent: '#dc2626' },      // crimson — engine primary
      { id: 'bradlee', name: 'Bradlee', accent: '#14b8a6' }, // teal
    ];
    const TOGETHER_ACCENT = '#f59e0b'; // amber — the blend of the two, and unclaimed

    // 'together' is a rec MODE, not a profile — you can't rate as Together, and it never
    // owns storage. It's tracked separately from the active profile for exactly that
    // reason: while it's on, writes still belong to whoever the active profile is.
    const TOGETHER_MODE = 'together';
    let togetherMode = false;

    function getProfile(id) {
      return PROFILES.find(p => p.id === id) || PROFILES[0];
    }

    function activeProfileId() {
      return Store.getProfile();
    }

    function otherProfileId() {
      const active = activeProfileId();
      const other = PROFILES.find(p => p.id !== active);
      return other ? other.id : null;
    }

    // Read another profile's library straight out of its namespace, without switching.
    // This is the read-only mirror Together mode scores against — on your phone,
    // Bradlee's lists live under `brous_watched__bradlee` etc., refreshed by the sync
    // layer (syncMirrorProfile in sync.js) rather than edited locally.
    function readProfileLists(profileId) {
      const parse = (key, fallback) => {
        try {
          const raw = Store.getItemFor(key, profileId);
          return raw === null ? fallback : JSON.parse(raw);
        } catch (e) {
          console.warn(`[Profiles] ${key} for ${profileId} parse failed:`, e);
          return fallback;
        }
      };
      return {
        watched: parse('horror_roki_watched', []),
        toWatch: parse('horror_roki_towatch', []),
        disliked: parse('horror_roki_disliked', []),
        notInterested: parse('horror_roki_not_interested', []),
      };
    }

    // Switch which person the app is acting as. Order matters here:
    //  1. flush any debounced write FIRST, so an edit made seconds ago is saved against
    //     the profile that actually made it rather than following us to the new one;
    //  2. move the Store pointer;
    //  3. reload every in-memory list from the new namespace;
    //  4. re-render, and pull that profile's cloud copy.
    async function switchProfile(profileId) {
      if (profileId === activeProfileId() && !togetherMode) return;

      // (1) Never let a pending push land under the wrong profile.
      try {
        if (typeof pushToServer === 'function') await pushToServer(true);
      } catch (e) {
        console.warn('[Profiles] flush before switch failed:', e);
      }

      // Leaving Together always returns to a real, writable profile.
      togetherMode = false;
      if (!Store.setProfile(profileId)) return;

      // (3) Store now resolves personal keys into the new namespace, so simply
      // re-running the boot-time loader swaps the entire library.
      loadPersonalStateFromStore();

      // (4)
      renderProfileSwitcher();
      updateAllLibraryRenders();
      renderPersonalStats();
      if (typeof renderCuratorMessages === 'function') { try { renderCuratorMessages(); } catch (e) {} }
      if (typeof updateHomeSnapshot === 'function') updateHomeSnapshot();
      if (typeof recomputeRecommendations === 'function') recomputeRecommendations();
      showToast(`Switched to ${getProfile(profileId).name}`);

      // Pull this profile's server copy in the background; it re-renders on its own.
      if (typeof syncFromServer === 'function') {
        syncFromServer().catch(e => console.warn('[Profiles] post-switch sync failed:', e));
      }
    }

    // Turn the joint rec view on/off. This does NOT change the active profile — ratings
    // and library edits continue to belong to whoever is signed in — it only changes how
    // recommendations are scored (see scoreItemTogether in recs.js).
    async function toggleTogetherMode() {
      if (togetherMode) {
        togetherMode = false;
        renderProfileSwitcher();
        recomputeRecommendations();
        return;
      }
      const other = otherProfileId();
      if (!other) return;

      // Together needs both libraries present locally. On separate phones the other
      // person's copy only arrives via the mirror pull, so refresh it before scoring —
      // otherwise the joint recs would silently be scored against an empty profile,
      // which looks like it's working but is really just your own recs again.
      if (typeof syncMirrorProfile === 'function') {
        showToast(`Loading ${getProfile(other).name}'s library…`);
        try {
          await syncMirrorProfile(other);
        } catch (e) {
          console.warn('[Profiles] mirror pull failed:', e);
        }
      }
      const lists = readProfileLists(other);
      const rated = lists.watched.length + lists.disliked.length;
      if (rated === 0) {
        showToast(`No library found for ${getProfile(other).name} yet — nothing to blend.`);
        return;
      }

      togetherMode = true;
      renderProfileSwitcher();
      recomputeRecommendations();
    }

    // Header control: one pill per person plus a Together toggle. The active profile is
    // always visible rather than tucked into a menu — the costly mistake with per-person
    // libraries is rating a film onto the wrong one, and that only happens when you can't
    // see who you're signed in as.
    function renderProfileSwitcher() {
      const wrap = document.getElementById('profile-switcher');
      if (!wrap) return;
      const active = activeProfileId();
      wrap.innerHTML = '';

      PROFILES.forEach(p => {
        const isActive = !togetherMode && p.id === active;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = p.name;
        btn.title = `Switch to ${p.name}'s library`;
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        btn.className = 'profile-pill' + (isActive ? ' profile-pill-active' : '');
        if (isActive) btn.style.setProperty('--profile-accent', p.accent);
        btn.onclick = () => switchProfile(p.id);
        wrap.appendChild(btn);
      });

      const togetherBtn = document.createElement('button');
      togetherBtn.type = 'button';
      togetherBtn.textContent = '👥 Together';
      togetherBtn.title = 'Recommend films that suit both of you (recs only — ratings still save to the active profile)';
      togetherBtn.setAttribute('aria-pressed', togetherMode ? 'true' : 'false');
      togetherBtn.className = 'profile-pill' + (togetherMode ? ' profile-pill-active' : '');
      if (togetherMode) togetherBtn.style.setProperty('--profile-accent', TOGETHER_ACCENT);
      togetherBtn.onclick = () => toggleTogetherMode();
      wrap.appendChild(togetherBtn);

      // While Together is on, make it unmistakable that edits still land on one person.
      const note = document.getElementById('profile-mode-note');
      if (note) {
        if (togetherMode) {
          note.textContent = `Joint picks · rating saves to ${getProfile(active).name}`;
          note.classList.remove('hidden');
        } else {
          note.classList.add('hidden');
        }
      }
    }
