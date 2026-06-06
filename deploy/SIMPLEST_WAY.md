# Simplest Way to Use Roki on Your Phone (No Terminal Window)

This is currently the simplest reliable method:

## Step-by-step (Updated for reliability)

1. Open the `deploy` folder.

2. Double-click **`Start-Roki.command`**.

3. A Terminal window will appear and a dialog will show the address (e.g. `http://192.168.1.42:8000`).

4. On your iPhone, open Safari and go to **exactly** the address shown (do not add anything after the port).

5. **If you see a list of files** instead of the app:
   - Just tap on **index.html** in the list. This will load Roki.

6. The first time you use it on your phone, go to **Settings** inside the app and add your TMDB API key + select your services.

7. When finished, close the Terminal window to stop the server.

## Why this is the simplest

- You only need to double-click one file.
- No need to type commands.
- You get the correct address automatically in a dialog.
- Works reliably for local network access to your Roku (unlike public hosting).

## Notes

- Your iPhone must be on the same Wi-Fi as your computer.
- The first time you use the app on your phone, go to Settings and add your TMDB API key + your streaming services.
- You can leave this file on your Desktop or Dock for one-click access if you want.
