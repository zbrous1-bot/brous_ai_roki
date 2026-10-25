// ===================== PRODUCT LAYER =====================
// Watch Tonight, share, weekly recap, taste explain, export, eval, health, version.
// Loaded after recs.js so it can call into scoring / recompute.
// APP_VERSION is owned by store.js (single global) — do not redeclare here.

function productAppBuild() {
  try {
    return (typeof APP_VERSION === 'string' ? APP_VERSION.replace(/^v/, '') : '2026-07-31');
  } catch (_) {
    return '2026-07-31';
  }
}

// ── Watch Tonight mode ──────────────────────────────────────────────────────
let watchTonightMode = false;
try { watchTonightMode = Store.getItem('brous_watch_tonight') === '1'; } catch (_) {}

function syncWatchTonightUI() {
  const btn = document.getElementById('rec-watch-tonight');
  if (!btn) return;
  const on = !!watchTonightMode;
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.className = `text-xs px-3 py-1.5 rounded-full border transition-all ${on ? 'type-toggle-active' : 'filter-chip'}`;
  btn.title = on
    ? 'Watch Tonight on — prioritizing streamable + good runtime. Tap to turn off.'
    : 'Watch Tonight — rank for something you can finish tonight on your services';
}

function toggleWatchTonightMode() {
  if (!myServices || !myServices.size) {
    try { showToast('Pick streaming services in Settings first', 'info'); } catch (_) {}
    if (typeof showSettings === 'function') showSettings('streaming');
    return;
  }
  watchTonightMode = !watchTonightMode;
  try { Store.setItem('brous_watch_tonight', watchTonightMode ? '1' : '0'); } catch (_) {}
  syncWatchTonightUI();
  if (typeof recomputeRecommendations === 'function') recomputeRecommendations();
  try {
    showToast(watchTonightMode ? 'Watch Tonight on — streamable + good length first' : 'Watch Tonight off', 'success');
  } catch (_) {}
}

// Extra score applied when Watch Tonight is on (called from scoreItemDetailed if present)
function watchTonightExtra(item) {
  if (!watchTonightMode) return { boost: 0, note: null };
  let boost = 0;
  let note = null;
  const svc = typeof softServicesSignal === 'function' ? softServicesSignal(item) : { boost: 0 };
  if (svc.boost > 0.5) { boost += 1.35; note = 'Watch Tonight · on your services'; }
  else if (svc.boost < 0) { boost += svc.boost * 1.5; note = 'Watch Tonight · harder to stream'; }
  else { boost -= 0.35; }
  const fit = typeof tonightFitSignal === 'function' ? tonightFitSignal(item) : { boost: 0 };
  if (fit.boost > 0.3) boost += 0.55;
  else if (fit.boost < -0.2) boost += fit.boost;
  const mt = item._mediaType === 'tv' ? 'tv' : 'movie';
  if (mt === 'tv') boost -= 0.15; // prefer a single movie finish tonight
  return { boost, note };
}

// ── Share Tonight’s pick ────────────────────────────────────────────────────
async function shareTonightPick() {
  const el = document.getElementById('tonight-hero');
  if (!el || el.classList.contains('hidden')) {
    try { showToast('No Tonight’s pick yet', 'info'); } catch (_) {}
    return;
  }
  const title = (el.querySelector('.tonight-hero-title') || {}).textContent || 'Tonight’s pick';
  const why = (el.querySelector('.tonight-hero-why') || {}).textContent || '';
  const wtw = el.querySelector('.wtw-block-body, .tonight-hero-wtw');
  const where = wtw ? wtw.innerText.replace(/\s+/g, ' ').trim() : '';
  const text = [
    `🎬 Tonight’s pick: ${title}`,
    why ? `Why: ${why}` : '',
    where ? `Where: ${where}` : '',
    '— Brous Movie Engine',
  ].filter(Boolean).join('\n');
  try {
    if (navigator.share) {
      await navigator.share({ title: `Tonight: ${title}`, text });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast('Tonight’s pick copied', 'success');
  } catch (_) {
    showToast(text, 'info');
  }
}

// ── Weekly recap ────────────────────────────────────────────────────────────
function buildWeeklyRecap() {
  const weekAgo = Date.now() - 7 * 86400000;
  const rated = (watchedList || []).filter(w => (w._ts || 0) >= weekAgo);
  const queued = (toWatchList || []).filter(w => (w._queuedAt || w._ts || 0) >= weekAgo);
  const avg = rated.length
    ? (rated.reduce((s, w) => s + (w.rating || 0), 0) / rated.length).toFixed(1)
    : null;
  return { rated, queued, avg, count: rated.length };
}

function renderWeeklyRecap() {
  const host = document.getElementById('weekly-recap');
  if (!host) return;
  const { rated, queued, avg, count } = buildWeeklyRecap();
  if (count < 1 && queued.length < 1) {
    host.classList.add('hidden');
    host.innerHTML = '';
    if (typeof syncInsightStrip === 'function') syncInsightStrip();
    return;
  }
  host.classList.remove('hidden');
  if (typeof syncInsightStrip === 'function') syncInsightStrip();
  const top = [...rated].sort((a, b) => (b.rating || 0) - (a.rating || 0))[0];
  host.innerHTML = `
    <div class="weekly-recap-inner">
      <div class="weekly-recap-kicker">Your week</div>
      <div class="weekly-recap-body">
        <span><strong>${count}</strong> rated</span>
        ${avg ? `<span>· avg <strong>${avg}★</strong></span>` : ''}
        <span>· <strong>${queued.length}</strong> queued</span>
        ${top ? `<span class="weekly-recap-top">· highlight: ${escapeHtml(top.title || top.name || '')}</span>` : ''}
      </div>
    </div>`;
}

// ── Explain my taste ────────────────────────────────────────────────────────
function buildTasteExplain() {
  const profile = typeof buildTasteProfile === 'function' ? buildTasteProfile() : null;
  const curve = typeof personalizationCurve === 'function' ? personalizationCurve() : { n: watchedList.length, t: 0 };
  const genres = [];
  if (profile && profile.genreScores) {
    Object.entries(profile.genreScores)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .forEach(([id, score]) => {
        const g = (typeof GENRES !== 'undefined' ? GENRES.find(x => x.id == id) : null);
        if (g) genres.push({ name: g.name, score });
      });
  }
  const decades = [];
  if (profile && profile.decadeCounts) {
    Object.entries(profile.decadeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([d, c]) => decades.push({ decade: d, count: c }));
  }
  const unrated = (watchedList || []).filter(w => w.rating == null || w.rating === 0).length;
  const stage = curve.t < 0.25 ? 'Learning' : curve.t < 0.65 ? 'Warming up' : 'Dialed in';
  return { genres, decades, curve, unrated, stage, n: curve.n || watchedList.length };
}

function renderTasteExplainPanel() {
  const el = document.getElementById('settings-taste-explain');
  if (!el) return;
  const t = buildTasteExplain();
  const genreHtml = t.genres.length
    ? t.genres.map(g => `<span class="taste-explain-chip">${escapeHtml(g.name)}</span>`).join('')
    : '<span class="text-zinc-500 text-xs">Rate more titles to surface genres.</span>';
  const decadeHtml = t.decades.length
    ? t.decades.map(d => `<span class="taste-explain-chip">${escapeHtml(String(d.decade))}s</span>`).join('')
    : '';
  el.innerHTML = `
    <div class="text-sm font-semibold text-zinc-200 mb-1">Your taste profile</div>
    <div class="text-[11px] text-zinc-500 mb-2">Stage: <strong class="text-zinc-300">${escapeHtml(t.stage)}</strong> · ${t.n} watched</div>
    <div class="taste-explain-chips mb-2">${genreHtml}</div>
    ${decadeHtml ? `<div class="text-[10px] text-zinc-500 mb-1">Decades</div><div class="taste-explain-chips mb-2">${decadeHtml}</div>` : ''}
    ${t.unrated ? `<div class="text-[11px] text-amber-400/90 mb-2">${t.unrated} watched without a rating — rate them to sharpen picks.</div>` : ''}
    <button type="button" class="w-full py-2 rounded-xl bg-zinc-800 border border-zinc-700 text-sm text-white" onclick="exportTasteProfile()">Export taste JSON</button>
  `;
}

function exportTasteProfile() {
  const t = buildTasteExplain();
  const payload = {
    exportedAt: new Date().toISOString(),
    app: 'brous-movie-engine',
    version: (typeof APP_VERSION !== 'undefined' ? APP_VERSION : 'v' + productAppBuild()),
    stage: t.stage,
    watchedCount: t.n,
    topGenres: t.genres,
    decades: t.decades,
    recTune: typeof recTune !== 'undefined' ? recTune : null,
    services: myServices ? [...myServices] : [],
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `brous-taste-${productAppBuild()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  try { showToast('Taste profile exported', 'success'); } catch (_) {}
}

// ── Offline-ish eval harness (holdout hit rate) ──────────────────────────────
function runTasteEval() {
  if (typeof scoreItem !== 'function' || typeof buildTasteProfile !== 'function') {
    try { showToast('Scoring not ready', 'error'); } catch (_) {}
    return null;
  }
  const pool = (typeof currentRecPool !== 'undefined' && currentRecPool) ? currentRecPool : [];
  const rated = (watchedList || []).filter(w => (w.rating || 0) >= 4);
  if (rated.length < 8) {
    try { showToast('Need at least 8 high ratings for eval', 'info'); } catch (_) {}
    return null;
  }
  if (pool.length < 20) {
    try { showToast('Refresh the rec pool first', 'info'); } catch (_) {}
    return null;
  }
  const hold = rated.slice(0, Math.max(3, Math.floor(rated.length * 0.2)));
  const train = rated.slice(hold.length);
  // Score pool with full profile; measure if holdout IDs appear in top-N of similar genre titles
  const profile = buildTasteProfile();
  const stats = typeof computePoolStats === 'function' ? computePoolStats(pool) : null;
  const scored = pool.map(it => ({ ...it, _score: scoreItem(it, profile, stats) }))
    .sort((a, b) => b._score - a._score);
  const top40 = new Set(scored.slice(0, 40).map(x => `${x.id}:${x._mediaType || 'movie'}`));
  // Proxy metric: share of holdout titles' primary genres that appear in top-40 genre mix
  const holdGenres = new Set();
  hold.forEach(h => (h.genre_ids || []).slice(0, 2).forEach(g => holdGenres.add(g)));
  let hits = 0;
  scored.slice(0, 40).forEach(it => {
    if ((it.genre_ids || []).some(g => holdGenres.has(g))) hits++;
  });
  const genreHitRate = hits / 40;
  const result = {
    holdout: hold.length,
    train: train.length,
    pool: pool.length,
    top40GenreOverlap: Math.round(genreHitRate * 100),
    personalization: typeof personalizationCurve === 'function' ? personalizationCurve() : null,
  };
  const el = document.getElementById('settings-eval-result');
  if (el) {
    el.textContent = `Eval: ${result.top40GenreOverlap}% of top-40 share holdout genres · holdout ${result.holdout} · pool ${result.pool}`;
    el.style.color = '#6ee7b7';
  }
  try { showToast(`Eval ready — ${result.top40GenreOverlap}% genre overlap in top 40`, 'success'); } catch (_) {}
  console.log('[Recs eval]', result);
  return result;
}

// ── Ratings health banner ───────────────────────────────────────────────────
function renderRatingsHealth() {
  const el = document.getElementById('ratings-health');
  if (!el) return;
  const unrated = (watchedList || []).filter(w => w.rating == null || w.rating === 0);
  if (unrated.length < 3) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="ratings-health-inner">
      <span><strong>${unrated.length}</strong> watched titles have no stars</span>
      <button type="button" class="ratings-health-btn" onclick="switchMainTab('watched')">Rate them →</button>
    </div>`;
}

// ── Pool refresh progress ───────────────────────────────────────────────────
function setPoolProgress(msg) {
  const el = document.getElementById('pool-progress');
  if (!el) return;
  if (!msg) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.classList.remove('hidden');
  el.textContent = msg;
}

// ── Version stamp ───────────────────────────────────────────────────────────
function paintAppVersion() {
  const ver = (typeof APP_VERSION !== 'undefined' ? APP_VERSION : 'v' + productAppBuild());
  const el = document.getElementById('app-version-footer');
  if (el) el.textContent = ver;
  document.documentElement.dataset.appBuild = productAppBuild();
}

// ── PWA install nudge ───────────────────────────────────────────────────────
let _deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstall = e;
  const btn = document.getElementById('pwa-install-btn');
  if (btn) btn.classList.remove('hidden');
});

async function promptPwaInstall() {
  if (!_deferredInstall) {
    try { showToast('Install from your browser menu (Add to Home Screen)', 'info'); } catch (_) {}
    return;
  }
  _deferredInstall.prompt();
  try { await _deferredInstall.userChoice; } catch (_) {}
  _deferredInstall = null;
  const btn = document.getElementById('pwa-install-btn');
  if (btn) btn.classList.add('hidden');
}

// ── Social proof empty / cold start meter ───────────────────────────────────
function updateTasteFormingMeter() {
  const el = document.getElementById('taste-forming-meter');
  if (!el) return;
  const n = (watchedList || []).length;
  const target = typeof COLD_START_TARGET !== 'undefined' ? COLD_START_TARGET : 8;
  const pct = Math.min(100, Math.round((n / target) * 100));
  if (n >= target) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="taste-meter-label">Taste forming · ${n}/${target}</div>
    <div class="taste-meter-bar"><div class="taste-meter-fill" style="width:${pct}%"></div></div>
  `;
}

// ── Debounced recompute ─────────────────────────────────────────────────────
let _recomputeTimer = null;
function recomputeRecommendationsDebounced(ms) {
  clearTimeout(_recomputeTimer);
  _recomputeTimer = setTimeout(() => {
    if (typeof recomputeRecommendations === 'function') recomputeRecommendations();
  }, ms == null ? 280 : ms);
}

// ── Init product chrome ─────────────────────────────────────────────────────
function initProductLayer() {
  paintAppVersion();
  syncWatchTonightUI();
  renderWeeklyRecap();
  renderRatingsHealth();
  updateTasteFormingMeter();
  updateRatingAsPill();
  applyRecDensity();
  syncInsightStrip();
  // Hook settings open to refresh taste explain
  const origShow = typeof showSettings === 'function' ? showSettings : null;
  if (origShow && !showSettings._productWrapped) {
    window.showSettings = function(tab) {
      origShow(tab);
      setTimeout(() => {
        renderTasteExplainPanel();
        syncWatchTonightUI();
      }, 50);
    };
    window.showSettings._productWrapped = true;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  try { initProductLayer(); } catch (e) { console.warn('[product]', e); }
});

// Refresh chrome when library may have changed
const _productRefreshHooks = ['renderTasteStats', 'saveWatched', 'saveToWatch'];
// Called from library after mutations if available
function refreshProductChrome() {
  try {
    renderWeeklyRecap();
    renderRatingsHealth();
    updateTasteFormingMeter();
    renderTasteExplainPanel();
    updateRatingAsPill();
    syncInsightStrip();
    applyRecDensity();
  } catch (_) {}
}

function syncInsightStrip() {
  const strip = document.getElementById('home-insight-strip');
  if (!strip) return;
  const kids = [...strip.children].filter(el => !el.classList.contains('hidden') && el.innerHTML.trim());
  strip.classList.toggle('hidden', kids.length === 0);
}

function updateRatingAsPill() {
  const el = document.getElementById('rating-as-pill');
  if (!el || typeof getProfile !== 'function') return;
  const p = getProfile(typeof activeProfileId === 'function' ? activeProfileId() : 'me');
  const together = typeof togetherMode !== 'undefined' && togetherMode;
  el.textContent = together ? `Picks for both · rating as ${p.name}` : `Rating as ${p.name}`;
  el.style.setProperty('--profile-accent', together ? '#f59e0b' : (p.accent || '#dc2626'));
}

// ── Density ────────────────────────────────────────────────────────────────
let recDensity = 4;
try {
  const d = parseInt(Store.getItem('brous_rec_density') || '4', 10);
  recDensity = (d === 3 || d === 4) ? d : 4;
} catch (_) {}

function applyRecDensity() {
  const grid = document.getElementById('recs-grid');
  if (grid) grid.setAttribute('data-density', String(recDensity));
  const b3 = document.getElementById('density-3');
  const b4 = document.getElementById('density-4');
  if (b3) b3.classList.toggle('density-btn-active', recDensity === 3);
  if (b4) b4.classList.toggle('density-btn-active', recDensity === 4);
}

function setRecDensity(n) {
  recDensity = n === 3 ? 3 : 4;
  try { Store.setItem('brous_rec_density', String(recDensity)); } catch (_) {}
  applyRecDensity();
}

function paintTonightFilterChips() {
  const el = document.getElementById('tonight-active-filters');
  if (!el) return;
  const chips = [];
  if (typeof recMediaFilter !== 'undefined' && recMediaFilter === 'tv') chips.push('TV');
  if (typeof recMediaFilter !== 'undefined' && recMediaFilter === 'all') chips.push('All');
  if (typeof recServicesOnly !== 'undefined' && recServicesOnly) chips.push('On your services');
  if (typeof recGenreFilter !== 'undefined' && recGenreFilter != null && typeof GENRES !== 'undefined') {
    const g = GENRES.find(x => x.id === recGenreFilter);
    if (g) chips.push(g.name);
  }
  el.innerHTML = chips.map(c => `<span class="tonight-filter-chip">${escapeHtml(c)}</span>`).join('');
  el.classList.toggle('hidden', !chips.length);
}

// ── Queue peek drawer ──────────────────────────────────────────────────────
function closeQueuePeek() {
  const el = document.getElementById('queue-peek');
  if (el) el.classList.add('hidden');
}

function toggleQueuePeek(ev) {
  if (ev) ev.stopPropagation();
  const el = document.getElementById('queue-peek');
  if (!el) {
    switchMainTab('watched');
    return;
  }
  if (!el.classList.contains('hidden')) {
    closeQueuePeek();
    return;
  }
  renderQueuePeek();
  el.classList.remove('hidden');
}

function renderQueuePeek() {
  const list = document.getElementById('queue-peek-list');
  const sub = document.getElementById('queue-peek-sub');
  if (!list) return;
  const items = (typeof toWatchList !== 'undefined' ? toWatchList : []).slice(0, 5);
  if (sub) sub.textContent = `${(toWatchList || []).length} in queue`;
  if (!items.length) {
    list.innerHTML = '<div class="queue-peek-empty">Queue is empty — add from For You.</div>';
    return;
  }
  list.innerHTML = items.map(it => {
    const title = escapeHtml(it.title || it.name || 'Untitled');
    const poster = it.poster_path
      ? `https://image.tmdb.org/t/p/w92${it.poster_path}`
      : '';
    const mt = it._mediaType === 'tv' ? 'tv' : 'movie';
    return `<button type="button" class="queue-peek-row" data-qid="${it.id}" data-qmt="${mt}">
      ${poster ? `<img src="${poster}" alt="">` : '<span class="queue-peek-ph">▶</span>'}
      <span class="queue-peek-name">${title}</span>
    </button>`;
  }).join('');
  list.querySelectorAll('.queue-peek-row').forEach(btn => {
    btn.onclick = () => {
      const id = Number(btn.getAttribute('data-qid'));
      const mt = btn.getAttribute('data-qmt');
      const item = (toWatchList || []).find(x => x.id == id && (x._mediaType || 'movie') === mt);
      closeQueuePeek();
      if (item && typeof openModal === 'function') openModal(item, { sourceEl: btn });
    };
  });
}

// ── Keyboard ───────────────────────────────────────────────────────────────
function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

document.addEventListener('keydown', (e) => {
  if (isTypingTarget(e.target)) return;
  if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    if (typeof switchMainTab === 'function') switchMainTab('browse');
    setTimeout(() => {
      const inp = document.getElementById('search-input');
      if (inp) inp.focus();
    }, 50);
    return;
  }
  if (e.key === 'j' || e.key === 'k') {
    const cards = [...document.querySelectorAll('#recs-grid .rec-card')];
    if (!cards.length) return;
    const i = cards.findIndex(c => c === document.activeElement || c.contains(document.activeElement));
    let next = e.key === 'j' ? (i < 0 ? 0 : i + 1) : (i < 0 ? 0 : i - 1);
    next = Math.max(0, Math.min(cards.length - 1, next));
    cards[next].setAttribute('tabindex', '0');
    cards[next].focus();
  }
});

document.addEventListener('click', (e) => {
  const peek = document.getElementById('queue-peek');
  const chip = document.getElementById('home-queue-card');
  if (!peek || peek.classList.contains('hidden')) return;
  if (peek.contains(e.target) || (chip && chip.contains(e.target))) return;
  closeQueuePeek();
});
