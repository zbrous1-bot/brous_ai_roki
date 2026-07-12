# Hosting Options for Roki – Important Reality Check

Roki has two different parts that behave very differently when hosted:

1. **The website itself** (search, TMDB data, UI, settings)
2. **Controlling your Roku** (the "Launch" buttons + Quick Remote)

## The Core Problem

The Roku control features work by making direct requests from your phone's browser to your Roku's local IP address (using Roku's ECP protocol on port 8060).

Modern browsers have security restrictions (called "Private Network Access") that make this difficult or impossible when the website is loaded from the **public internet**.

### What This Means in Practice

| Hosting Method              | Website Works | Roku Control Works | Notes |
|----------------------------|---------------|--------------------|-------|
| Local server on your Mac   | Yes           | Yes (best)         | Recommended for full functionality |
| Public host (Netlify, Vercel, etc.) | Yes     | Usually **No**     | Control features are blocked by browser security |
| Public host + tunnel/proxy | Yes           | Yes                | More complex setup |

## Recommended Approaches

### Best & Simplest: Local Background Server (Recommended)

Use the files in this `deploy` folder and run the server locally on your Mac:

- Double-click `Start-Roki-in-Background.command` (sets it up as a proper background service)
- Or use `Start-Roki.command` for manual start

**Advantages**:
- Full functionality (search + actual Roku control)
- No 7-day limits or hosting costs
- Your data stays on your network

**Downside**: Your Mac needs to be on for the phone to access it.

See `NO_TERMINAL_NEEDED.md` for the easiest way to run it without keeping a terminal window open.

### Public Hosting (Only Partial Functionality)

You can host the static files on Netlify, Vercel, Cloudflare Pages, GitHub Pages, etc.

**This works great for**:
- The search interface
- TMDB movie data
- Your service preferences

**This usually breaks**:
- Entering your Roku IP and testing connection
- The "Launch on Roku" buttons
- The Quick Remote

This is **not** a bug — it's a deliberate browser security policy.

If you only care about the search + "where to watch" part and are okay using the normal Roku remote for control, public hosting is fine.

### Advanced Option: Public Hosting + Local Control

You can have the best of both worlds by running a small proxy/tunnel on your Mac:

- Tools like `cloudflared` (Cloudflare Tunnel), `ngrok`, or Tailscale Funnel
- The public site talks to your tunnel
- Your tunnel talks to your local Roku

This requires some setup and your Mac still needs to be on, but it gives you a public URL while keeping full Roku control.

If you want instructions for this route, let me know.

## Summary Recommendation

For most people who actually want to control their Roku from their phone:

→ Use the **local background server** method (the scripts in this folder).

Public hosting is great for convenience and sharing the search part, but it cannot reliably control devices on your local network due to browser security rules.

---

Last updated: 2026
