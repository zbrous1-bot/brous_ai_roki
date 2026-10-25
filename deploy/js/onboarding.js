// ===================== ONBOARDING + LETTERBOXD + SETTINGS TABS =====================
// Cold-start checklist, starter rate grid, Letterboxd CSV import, settings tab switcher.
// Depends on: Store, myServices, watchedList, addToWatched, apiFetch, showSettings wiring.

const COLD_START_TARGET = 8;
const COLD_START_DISMISS_KEY = 'brous_cold_start_dismissed';

function ratedCount() {
  return (watchedList || []).filter(m => typeof m.rating === 'number' && m.rating > 0).length;
}

function coldStartDismissed() {
  try { return Store.getItem(COLD_START_DISMISS_KEY) === '1'; } catch (_) { return false; }
}

function dismissColdStart() {
  try { Store.setItem(COLD_START_DISMISS_KEY, '1'); } catch (_) {}
  updateColdStartUI();
}

function scrollToStarterRates() {
  const sec = document.getElementById('starter-rate-section');
  if (sec) {
    sec.classList.remove('hidden');
    loadStarterRateGrid();
    sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function updateColdStartUI() {
  const root = document.getElementById('cold-start');
  if (!root) return;

  const servicesOk = !!(myServices && myServices.size > 0);
  const rated = ratedCount();
  const ratesOk = rated >= COLD_START_TARGET;
  const dismissed = coldStartDismissed();

  // Once there are enough ratings, the For You pick is the page. Services stay in Settings.
  // A true first run (no ratings) still shows setup until it is dismissed.
  const show = !ratesOk && !dismissed;
  root.classList.toggle('hidden', !show);
  // The three stat chips read "— / 0 / 0" on a fresh profile, which tells a new user
  // nothing and pushes setup down the page. Show them once setup is done or dismissed.
  const statBar = document.getElementById('home-command-grid');
  if (statBar) statBar.classList.toggle('setup-hidden', show);
  if (!show) return;

  // One next action: highlight the first unfinished step and show overall progress
  // (services = half, ratings = the other half).
  const stepSvc = document.getElementById('cs-step-services');
  const stepRate = document.getElementById('cs-step-rate');
  if (stepSvc) stepSvc.classList.toggle('is-current', !servicesOk);
  if (stepRate) stepRate.classList.toggle('is-current', servicesOk && !ratesOk);
  const pct = Math.round(((servicesOk ? 1 : 0) + Math.min(rated, COLD_START_TARGET) / COLD_START_TARGET) * 50);
  const fill = document.getElementById('cs-progress-fill');
  if (fill) fill.style.width = pct + '%';
  const bar = root.querySelector('.cold-start-progress');
  if (bar) bar.setAttribute('aria-valuenow', String(pct));

  const mark = (checkId, stepId, done) => {
    const check = document.getElementById(checkId);
    const step = document.getElementById(stepId);
    if (check) {
      check.textContent = done ? '✓' : checkId.includes('import') ? '↗' : check.textContent.replace('✓', '') || check.dataset.n || '';
      if (!checkId.includes('import')) {
        if (!check.dataset.n) check.dataset.n = checkId.includes('services') ? '1' : '2';
        check.textContent = done ? '✓' : check.dataset.n;
      }
    }
    if (step) step.classList.toggle('done', !!done);
  };

  mark('cs-check-services', 'cs-step-services', servicesOk);
  mark('cs-check-rate', 'cs-step-rate', ratesOk);

  const hintS = document.getElementById('cs-hint-services');
  if (hintS) hintS.textContent = servicesOk
    ? `${myServices.size} service${myServices.size === 1 ? '' : 's'} selected`
    : 'So we know where you can watch';

  const hintR = document.getElementById('cs-hint-rate');
  if (hintR) hintR.textContent = ratesOk
    ? `${rated} rated — engine is warming up`
    : `${rated} / ${COLD_START_TARGET} — trains recommendations`;

  const starter = document.getElementById('starter-rate-section');
  if (starter) {
    if (!ratesOk) {
      starter.classList.remove('hidden');
      loadStarterRateGrid();
    } else {
      starter.classList.add('hidden');
    }
  }
}

let _starterLoaded = false;
let _starterLoading = false;

async function loadStarterRateGrid(force) {
  const grid = document.getElementById('starter-rate-grid');
  if (!grid) return;
  if (_starterLoading) return;
  if (_starterLoaded && !force) return;
  _starterLoading = true;
  grid.innerHTML = Array.from({ length: 8 }, () =>
    `<div class="starter-skel"><div class="skel-poster"></div><div class="skel-line"></div></div>`
  ).join('');

  try {
    // Popular horror + thriller mix for cold-start rating (genre 27 horror).
    const data = await apiFetch('/api/tmdb/3/discover/movie?with_genres=27&sort_by=popularity.desc&vote_count.gte=500&include_adult=false&page=1');
    const results = (data && data.results) || [];
    const excluded = typeof getExcludedKeys === 'function' ? getExcludedKeys() : new Set();
    const picks = results
      .filter(m => !excluded.has(`${m.id}:movie`))
      .slice(0, 12);

    if (!picks.length) {
      grid.innerHTML = `<div class="text-xs text-zinc-500 col-span-full py-4 text-center">No starter titles available. Use Browse to rate films you’ve seen.</div>`;
      _starterLoaded = true;
      return;
    }

    grid.innerHTML = '';
    picks.forEach(m => {
      const item = {
        id: m.id,
        title: m.title || m.name,
        name: m.name,
        poster_path: m.poster_path,
        release_date: m.release_date || m.first_air_date,
        vote_average: m.vote_average,
        genre_ids: m.genre_ids || [],
        overview: m.overview || '',
        _mediaType: 'movie',
      };
      const year = (item.release_date || '').slice(0, 4);
      const poster = item.poster_path
        ? `https://image.tmdb.org/t/p/w185${item.poster_path}`
        : (typeof FALLBACK_POSTER !== 'undefined' ? FALLBACK_POSTER : '');
      const card = document.createElement('div');
      card.className = 'starter-card';
      card.innerHTML = `
        <img class="starter-poster" src="${poster}" alt="" loading="lazy"
             onerror="this.style.opacity='0.3'">
        <div class="starter-title">${escapeHtml(item.title || 'Untitled')}</div>
        <div class="starter-year">${year || ''}</div>
        <div class="starter-stars" role="group" aria-label="Rate ${escapeHtml(item.title || '')}"></div>`;
      const stars = card.querySelector('.starter-stars');
      for (let r = 1; r <= 5; r++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = '★';
        b.setAttribute('aria-label', `${r} stars`);
        b.onclick = (e) => {
          e.stopPropagation();
          addToWatched(item, r);
          card.classList.add('starter-rated');
          const done = document.createElement('div');
          done.className = 'starter-rated-msg';
          done.textContent = `Rated ${r}★`;
          stars.replaceWith(done);
          updateColdStartUI();
          if (typeof updateHomeSnapshot === 'function') updateHomeSnapshot();
        };
        stars.appendChild(b);
      }
      grid.appendChild(card);
    });
    _starterLoaded = true;
  } catch (e) {
    console.warn('[onboarding] starter grid failed', e);
    grid.innerHTML = `<div class="text-xs text-zinc-500 col-span-full py-4 text-center">Couldn’t load starters. Check your connection, or use Browse instead.<br><button type="button" class="starter-retry" onclick="loadStarterRateGrid(true)">Try again</button></div>`;
  } finally {
    _starterLoading = false;
  }
}

// ---- Settings tabs ----
function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-tab').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-settings-tab') === tab);
  });
  document.querySelectorAll('.settings-panel').forEach(panel => {
    const id = panel.id.replace('settings-panel-', '');
    panel.classList.toggle('hidden', id !== tab);
  });
}

// ---- Letterboxd CSV import ----
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parseLetterboxdCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const nameIdx = headers.findIndex(h => h === 'name' || h === 'title');
  const yearIdx = headers.findIndex(h => h === 'year');
  const ratingIdx = headers.findIndex(h => h === 'rating');
  if (nameIdx < 0) throw new Error('CSV needs a Name/Title column (Letterboxd export)');

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const name = (cols[nameIdx] || '').trim();
    if (!name) continue;
    let year = yearIdx >= 0 ? parseInt(cols[yearIdx], 10) : NaN;
    if (!Number.isFinite(year)) year = null;
    // Letterboxd ratings are often 0.5–5 stars
    let rating = ratingIdx >= 0 ? parseFloat(cols[ratingIdx]) : NaN;
    if (!Number.isFinite(rating) || rating <= 0) rating = 3;
    if (rating > 5) rating = 5;
    // Round half-stars to nearest int for our 1–5 scale
    rating = Math.max(1, Math.min(5, Math.round(rating)));
    rows.push({ name, year, rating });
  }
  return rows;
}

async function tmdbSearchMovie(name, year) {
  const q = encodeURIComponent(name);
  let url = `/api/tmdb/3/search/movie?query=${q}&include_adult=false`;
  if (year) url += `&year=${year}`;
  const data = await apiFetch(url);
  const results = (data && data.results) || [];
  if (!results.length && year) {
    const data2 = await apiFetch(`/api/tmdb/3/search/movie?query=${q}&include_adult=false`);
    return ((data2 && data2.results) || [])[0] || null;
  }
  if (!results.length) return null;
  if (year) {
    const exact = results.find(r => (r.release_date || '').startsWith(String(year)));
    if (exact) return exact;
  }
  return results[0];
}

async function importLetterboxdFile(file, statusEl) {
  if (!file) return;
  const setStatus = (msg, color) => {
    if (statusEl) { statusEl.textContent = msg; statusEl.style.color = color || '#a1a1aa'; }
  };
  setStatus('Reading CSV…', '#fbbf24');
  let text;
  try { text = await file.text(); }
  catch (e) { setStatus('Could not read file', '#f87171'); return; }

  let rows;
  try { rows = parseLetterboxdCsv(text); }
  catch (e) { setStatus(e.message || 'Invalid CSV', '#f87171'); return; }

  if (!rows.length) { setStatus('No rows found in CSV', '#f87171'); return; }

  // Cap for UI responsiveness / TMDB rate limits
  const MAX = 250;
  const batch = rows.slice(0, MAX);
  let added = 0, skipped = 0, failed = 0;
  const genreHits = Object.create(null);
  const t0 = Date.now();

  for (let i = 0; i < batch.length; i++) {
    const row = batch[i];
    const pct = Math.round(((i + 1) / batch.length) * 100);
    setStatus(`Matching ${i + 1}/${batch.length} (${pct}%) · ${row.name}`, '#fbbf24');
    try {
      const m = await tmdbSearchMovie(row.name, row.year);
      if (!m) { failed++; continue; }
      const key = `${m.id}:movie`;
      const already = watchedList.some(w => `${w.id}:${w._mediaType || 'movie'}` === key);
      if (already) { skipped++; continue; }
      addToWatched({
        id: m.id,
        title: m.title || row.name,
        poster_path: m.poster_path,
        release_date: m.release_date,
        vote_average: m.vote_average,
        genre_ids: m.genre_ids || [],
        overview: m.overview || '',
        _mediaType: 'movie',
      }, row.rating);
      (m.genre_ids || []).forEach(g => { genreHits[g] = (genreHits[g] || 0) + 1; });
      added++;
    } catch (_) { failed++; }
  }

  const topGenres = Object.entries(genreHits)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([id]) => (typeof GENRES !== 'undefined' ? GENRES.find(g => g.id == id) : null)?.name)
    .filter(Boolean);
  const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
  const learned = topGenres.length
    ? ` We learned: ${topGenres.join(', ')}.`
    : '';
  setStatus(
    `Imported ${added} title${added === 1 ? '' : 's'} in ${secs}s` +
    (skipped ? ` · ${skipped} already watched` : '') +
    (failed ? ` · ${failed} unmatched` : '') +
    (rows.length > MAX ? ` · first ${MAX} of ${rows.length} rows` : '') +
    learned,
    '#4ade80'
  );
  try {
    showToast(`Letterboxd: +${added} rated${learned ? ' · taste updated' : ''}`, 'success');
  } catch (_) {}
  if (typeof refreshProductChrome === 'function') refreshProductChrome();
  if (typeof recomputeRecommendations === 'function') recomputeRecommendations();
  try { Store.removeItem(COLD_START_DISMISS_KEY); } catch (_) {}
  updateColdStartUI();
  if (typeof recomputeRecommendations === 'function') recomputeRecommendations();
  if (typeof showToast === 'function') showToast(`Letterboxd: +${added} watched`);
}

function wireLetterboxdImport() {
  const btn = document.getElementById('settings-letterboxd-btn');
  const file = document.getElementById('settings-letterboxd-file');
  const status = document.getElementById('settings-letterboxd-status');
  if (!btn || !file) return;
  btn.onclick = () => {
    if (!file.files || !file.files.length) {
      if (status) { status.textContent = 'Choose a Letterboxd CSV first'; status.style.color = '#f87171'; }
      return;
    }
    importLetterboxdFile(file.files[0], status);
  };
}

function updateSettingsPassStatus() {
  const el = document.getElementById('settings-pass-status');
  if (!el) return;
  const has = !!(Store.getItem('brous_password'));
  el.textContent = has
    ? 'Password saved for this browser.'
    : 'Not set for this browser.';
  el.style.color = has ? '#4ade80' : '#71717a';
}
