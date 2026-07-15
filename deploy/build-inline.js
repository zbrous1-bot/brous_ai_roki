// Build step: inline the two local stylesheets into .pages-dist/index.html.
//
// Why: Cloudflare Pages' edge occasionally serves index.html (HTTP 200) in place
// of a real asset path for a window after each deploy (the "SPA-fallback" bug —
// see .github/workflows/deploy.yml). When that hit styles.css/tailwind.css the
// whole page lost its styling. By inlining the CSS INTO index.html, the styling
// ships inside the document itself, so even when the edge serves the fallback
// (which *is* index.html) the page is fully styled. The CSS can no longer go
// missing independently of the HTML.
//
// The source index.html keeps its <link> tags (readable for local dev); this
// script only rewrites the copy that goes into .pages-dist for deploy.

const fs = require('fs');
const path = require('path');

const DIST = '.pages-dist';

const html = fs.readFileSync('index.html', 'utf8');
const tailwind = fs.readFileSync('tailwind.css', 'utf8');
const styles = fs.readFileSync('styles.css', 'utf8');

// Guard: a literal "</style" inside the CSS would prematurely close the <style>
// element and corrupt the page. build:pages checks for this too, but fail loudly
// here as well rather than ship a broken document.
for (const [name, css] of [['tailwind.css', tailwind], ['styles.css', styles]]) {
  if (/<\/style/i.test(css)) {
    console.error(`build-inline: ${name} contains "</style" and cannot be safely inlined`);
    process.exit(1);
  }
}

let out = html
  .replace(
    '<link rel="stylesheet" href="tailwind.css">',
    `<style id="tailwind-inline">\n${tailwind}\n</style>`
  )
  .replace(
    '<link rel="stylesheet" href="styles.css">',
    `<style id="styles-inline">\n${styles}\n</style>`
  );

// Sanity: both replacements must have happened, and no local stylesheet <link>
// should remain (external font/icon CDNs are fine — we only inline our own CSS).
if (out.includes('href="tailwind.css"') || out.includes('href="styles.css"')) {
  console.error('build-inline: a local stylesheet <link> was not replaced — aborting');
  process.exit(1);
}
if (!out.includes('id="tailwind-inline"') || !out.includes('id="styles-inline"')) {
  console.error('build-inline: expected inline <style> markers missing — aborting');
  process.exit(1);
}

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'index.html'), out);
console.log(
  `build-inline: inlined tailwind.css (${(tailwind.length / 1024).toFixed(1)}kB) + ` +
  `styles.css (${(styles.length / 1024).toFixed(1)}kB) into ${DIST}/index.html`
);
