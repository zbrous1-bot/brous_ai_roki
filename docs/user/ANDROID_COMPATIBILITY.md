# iPhone & Android Compatibility

The Roki app is a Progressive Web App (PWA) and has been optimized for both platforms.

## iPhone Optimizations
- Proper safe-area handling for notched devices (Dynamic Island, notch)
- `black-translucent` status bar
- Disabled zoom on inputs (prevents iOS from zooming when focusing search)
- Better touch targets (minimum 44–48px)
- No pull-to-refresh while using the remote

## Android Optimizations
- Proper theme-color and manifest
- Larger touch targets (good for Android guidelines)
- Installable as a standalone app via Chrome
- `overscroll-behavior` to reduce unwanted pull-to-refresh

## How to Install

**Android (Chrome recommended):**
1. Open the link in Chrome.
2. Tap the three dots menu → **"Add to Home screen"** or **"Install app"**.

**iPhone (Safari):**
1. Open the link in Safari.
2. Tap the Share button → **"Add to Home Screen"**.

Once installed, it launches full-screen and feels much more like a native app.

## Important

Your phone **must still be on the same Wi-Fi** as your Roku for the remote and launch features to work.

The same hosted link works great on both iPhone and Android.
