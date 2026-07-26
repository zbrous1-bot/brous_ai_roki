#!/usr/bin/env node
/**
 * Load IMDb's public ratings dataset into the `brous-ratings` D1 database.
 *
 * Why this exists: every quality judgment in the rec engine used to route through
 * TMDB's vote_average alone (see bayesianRating in js/recs.js). TMDB's vote counts are
 * thin for exactly the obscure horror this app is built to surface — measured against
 * the live Cosmic Horror pool, the median title had 205 TMDB votes versus 9,730 on
 * IMDb, and on the tail TMDB actively misleads (Eldritch, USA: 5.8 from 4 votes on
 * TMDB, 4.4 from 159 on IMDb). This table is the fix.
 *
 * IMDb has no free API — the official one is enterprise-priced via AWS Data Exchange.
 * But they publish the same ratings as a daily bulk dump, free for personal and
 * non-commercial use, which is what this pulls. Source:
 *   https://datasets.imdbws.com/title.ratings.tsv.gz   (~8 MB gzipped, ~1.7M rows)
 *
 * Usage:
 *   node scripts/load-imdb-ratings.js            # load into remote D1
 *   node scripts/load-imdb-ratings.js --local    # load into the local dev D1
 *   node scripts/load-imdb-ratings.js --dry-run  # download + build SQL, don't import
 *
 * Run it by hand every month or so. IMDb refreshes the dump daily, but ratings on the
 * titles this app surfaces move slowly enough that a monthly refresh is plenty, and a
 * manual run keeps a 900k-row import from ever firing unattended.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const DATASET_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const DB_NAME = 'brous-ratings';

// Only titles at or above this vote count get loaded. The full dump is ~1.7M rows;
// this cutoff halves it to ~880k (~24MB in D1) while keeping everything the app could
// realistically show — the least-voted title in the entire Cosmic Horror pool has 65
// IMDb votes, so 25 leaves a wide margin. Raise it if the table ever needs to shrink;
// lower it only if real titles start coming back unmatched.
const MIN_VOTES = 25;

// Rows per INSERT statement. D1's HTTP API rejects oversized payloads, and wrangler
// streams the file statement-by-statement, so this trades import time against the risk
// of a single statement being too large. 500 keeps each statement well under any limit
// while still cutting the statement count ~500x versus one INSERT per row.
const ROWS_PER_INSERT = 500;

const args = process.argv.slice(2);
const isLocal = args.includes('--local');
const isDryRun = args.includes('--dry-run');

function log(msg) {
  process.stdout.write(`[load-imdb-ratings] ${msg}\n`);
}

async function download(url) {
  log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  log(`downloaded ${(buf.length / 1e6).toFixed(1)} MB gzipped`);
  return buf;
}

function buildSql(tsv, outPath) {
  // Rebuild the table from scratch rather than upserting into the existing one. The
  // dump is a full snapshot, not a delta, so a fresh table is both simpler and
  // self-healing — a row IMDb has since removed disappears instead of lingering
  // forever. DROP + CREATE + INSERT runs inside wrangler's import as one file.
  const out = fs.createWriteStream(outPath);
  out.write('DROP TABLE IF EXISTS imdb_ratings;\n');
  out.write('CREATE TABLE imdb_ratings (tconst TEXT PRIMARY KEY, rating REAL NOT NULL, votes INTEGER NOT NULL);\n');

  let kept = 0;
  let skipped = 0;
  let batch = [];

  const flush = () => {
    if (!batch.length) return;
    out.write(`INSERT INTO imdb_ratings (tconst,rating,votes) VALUES ${batch.join(',')};\n`);
    batch = [];
  };

  // Split on newline and walk manually — the file is ~28MB uncompressed, small enough
  // to hold in memory, and a hand-rolled loop avoids pulling in a CSV dependency for
  // a format this rigid (three tab-separated columns, no quoting, no embedded tabs).
  const lines = tsv.split('\n');
  for (let i = 1; i < lines.length; i++) { // i=1 skips the header row
    const line = lines[i];
    if (!line) continue;
    const tab1 = line.indexOf('\t');
    const tab2 = line.indexOf('\t', tab1 + 1);
    if (tab1 < 0 || tab2 < 0) { skipped++; continue; }

    const tconst = line.slice(0, tab1);
    const rating = Number(line.slice(tab1 + 1, tab2));
    const votes = Number(line.slice(tab2 + 1));

    // Guard the three things that would corrupt the table: a malformed id (everything
    // joins on tconst, so a bad one is a silently unmatchable row), non-numeric
    // ratings, and the vote floor above.
    if (!/^tt\d+$/.test(tconst) || !Number.isFinite(rating) || !Number.isFinite(votes)) { skipped++; continue; }
    if (votes < MIN_VOTES) { skipped++; continue; }

    // tconst is regex-validated above and rating/votes are numbers, so there's nothing
    // here that needs escaping — no user input ever reaches this string.
    batch.push(`('${tconst}',${rating},${votes})`);
    kept++;
    if (batch.length >= ROWS_PER_INSERT) flush();
  }
  flush();
  out.end();

  return new Promise((resolve, reject) => {
    out.on('finish', () => resolve({ kept, skipped }));
    out.on('error', reject);
  });
}

async function main() {
  const gz = await download(DATASET_URL);
  const tsv = zlib.gunzipSync(gz).toString('utf8');

  const sqlPath = path.join(os.tmpdir(), 'imdb-ratings.sql');
  log(`building SQL (keeping votes >= ${MIN_VOTES})`);
  const { kept, skipped } = await buildSql(tsv, sqlPath);
  const sqlMb = (fs.statSync(sqlPath).size / 1e6).toFixed(1);
  log(`${kept.toLocaleString()} rows kept, ${skipped.toLocaleString()} skipped -> ${sqlPath} (${sqlMb} MB)`);

  if (isDryRun) {
    log('--dry-run: stopping before import');
    return;
  }

  log(`importing into ${DB_NAME}${isLocal ? ' (local)' : ' (remote)'} — this takes a few minutes`);
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB_NAME, isLocal ? '--local' : '--remote', '--file', sqlPath, '--yes'],
    { stdio: 'inherit', cwd: path.join(__dirname, '..') }
  );
  log('done');
}

main().catch(err => {
  process.stderr.write(`[load-imdb-ratings] FAILED: ${err.message}\n`);
  process.exit(1);
});
