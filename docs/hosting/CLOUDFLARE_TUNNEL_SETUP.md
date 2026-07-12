# Cloudflare Tunnel Setup for Roki (Recommended)

This is currently the best way to get a public link for Roki while still being able to control your Roku from your phone.

## Why Cloudflare Tunnel?

- Gives you a real public HTTPS URL
- Your Mac still runs the actual server locally
- Local network requests to your Roku still work (unlike Netlify/Vercel)
- Free
- Can run in the background

---

## Step 1: Create a Free Cloudflare Account

1. Go to https://dash.cloudflare.com/sign-up
2. Sign up (use Google or email)
3. Verify your email

---

## Step 2: Install cloudflared on your Mac

The easiest way:

```bash
brew install cloudflare/cloudflare/cloudflared
```

If you don't have Homebrew, install it first from https://brew.sh

After installing, verify with:

```bash
cloudflared --version
```

---

## Step 3: Login to Cloudflare

Run this command:

```bash
cloudflared tunnel login
```

This will open a browser window. Log in with your Cloudflare account and authorize the tunnel.

---

## Step 4: Create a Tunnel

Run:

```bash
cloudflared tunnel create roki
```

This creates a tunnel named "roki". You will see output that includes a **Tunnel ID** (a long string like `12345678-1234-1234-1234-123456789abc`). Save this ID — you'll need it.

---

## Step 5: Get a Public URL (Two Options)

### Option A: Quick & Dirty (Temporary URL)

Just run this whenever you want to share Roki:

```bash
cloudflared tunnel --url http://localhost:8000
```

This gives you a random URL like `https://random-words-1234.trycloudflare.com`

You can stop it with `Ctrl + C`.

### Option B: Permanent Named Tunnel (Recommended)

1. Create a DNS record (you need a domain added to Cloudflare for this to be clean).

   If you have a domain in Cloudflare (e.g. `example.com`):

   ```bash
   cloudflared tunnel route dns roki roki.example.com
   ```

   This creates `https://roki.example.com`

2. Create a config file so the tunnel knows what to do:

   ```bash
   mkdir -p ~/.cloudflared
   ```

   Create a file at `~/.cloudflared/config.yml` with this content:

   ```yaml
   tunnel: roki
   credentials-file: /Users/yourusername/.cloudflared/<TUNNEL-ID>.json

   ingress:
     - hostname: roki.example.com
       service: http://localhost:8000
     - service: http_status:404
   ```

   Replace:
   - `yourusername` with your actual Mac username
   - `<TUNNEL-ID>` with the ID from step 4
   - `roki.example.com` with your actual subdomain (or use the trycloudflare method above)

3. Start the tunnel:

   ```bash
   cloudflared tunnel run roki
   ```

---

## Step 6: Combine with Roki Background Service (Best Experience)

You already have `Start-Roki-in-Background.command` that runs the local server.

The cleanest setup is:

1. Start the local Roki server in the background (using the script we made).
2. Start the Cloudflare Tunnel in another background process.

You can create a combined launcher if you want. Let me know and I can make one for you.

---

## Quick Start Recommendation (Right Now)

For the absolute simplest thing that gives you a public link today:

```bash
# Make sure Roki local server is running first (port 8000)
# Then in another terminal:

cloudflared tunnel --url http://localhost:8000
```

Copy the `https://...trycloudflare.com` URL it gives you and open it on your phone.

---

## Important Notes

- Your Mac must stay on and connected to the internet.
- Your phone must still be on the same Wi-Fi as your Roku for the remote features to work.
- The Cloudflare URL is public — anyone with the link can see your movie search interface.

Would you like me to create a combined "Start Everything" script that launches both the local Roki server + Cloudflare Tunnel together?