# How to Use Roki (Final Version)

Roki is now focused on helping you quickly find where to watch movies and TV shows.

## Quick Start

1. Open the hosted link on your phone (or use the local server).
2. The first time, go to **Settings** (in the accordions) and:
   - Paste your free TMDB API key (get one at themoviedb.org)
   - Check the services you actually subscribe to
3. Search for any movie or show.
4. Use the **"My services only"** checkbox to filter results to just the services you pay for.

## Features

- Search with real TMDB data
- See Streaming, Rent, Buy, and Free options
- Highlight services you subscribe to
- Track rental/purchase prices you've seen (Price Tracker)
- Quick links to IMDb and Rotten Tomatoes

## Roku Control (Optional)

The Roku IP connection and Quick Remote are still available but collapsed by default. Expand the "Roku Connection" and "Quick Remote" sections only if you want to use them.

## Updating the App

When you want the latest version:
1. Replace the `index.html` in your `deploy` folder with the new one.
2. Re-upload to your hosting service (Netlify, Vercel, etc.).

## Notes

- Works great as a Progressive Web App (install it to your home screen).
- Your phone must be on the same Wi-Fi as your Roku only if you want to use the remote features.
- All your data (API key, services, price tracker) stays in your browser.

Enjoy using it!
