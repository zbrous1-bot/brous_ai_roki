# UI Refinement - Latest

## Changes
- Replaced the old toggle-based Settings panel with clean native `<details>` accordions.
- Roku IP and TMDB API Key are now in their own collapsible sections (dropdowns).
- "My Services" checkboxes are also in a collapsible section (open by default).
- Improved overall spacing, typography, and card styling.
- Better visual hierarchy and more modern feel.
- Quick Remote buttons got larger touch targets and icons.
- Cleaner header.

The app should now feel more refined and organized while keeping all functionality.

## Grid Layout Update
- Movie results switched from vertical stack to responsive grid:
  - 1 column on mobile
  - 2 columns on tablets
  - 3 columns on larger screens / landscape
- Quick Remote + Activity Log now sit side-by-side on lg+ screens.
- Container widened to `max-w-7xl` so the app actually uses more horizontal space on bigger devices instead of staying narrow.

## Focus Shift
The app is now primarily positioned as a **"where to watch" search tool**.
- Search and availability are the main experience.
- Roku control features (IP connection + Quick Remote) are available but collapsed by default and de-emphasized in the UI.
- Visual improvements continue to prioritize scannability of streaming options, rent, buy, and "Yours" services.

## iPhone + Android Mobile Improvements
- Added proper safe-area-inset support (notch, Dynamic Island, home indicator)
- Disabled zoom on input focus (better iOS experience)
- Larger minimum touch targets (48px) for Android friendliness
- Better tap highlight removal and overscroll behavior
- Improved Quick Remote with bigger, thumb-friendly buttons
- Full PWA manifest + install support on both platforms
- Added `no-pull-refresh` protection while using the remote

## Notes
- All accordions use native HTML `<details>`, so no extra JavaScript is needed.
- Values are still saved to localStorage as before.
- The app remains a single self-contained HTML file.