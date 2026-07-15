/** @type {import('tailwindcss').Config} */
// Static build that replaces the old cdn.tailwindcss.com runtime <script>.
// `content` must list every file that can contain Tailwind class names — the
// markup in index.html AND the JS modules that render HTML strings — so the
// build keeps exactly the utilities the app uses and purges the rest.
//
// This app builds all Tailwind class names as complete literal string tokens
// (verified: even the dynamic ones like PROVIDER_COLORS / library-status badges
// resolve to literal 'bg-…' strings that appear in js/*.js), so no `safelist`
// is required. If you ever introduce a class assembled from fragments
// (e.g. `bg-${color}-500`), add it to `safelist` below or it will be purged.
module.exports = {
  content: [
    './index.html',
    './js/**/*.js',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
