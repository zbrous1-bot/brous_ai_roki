# How to Run Roki Without Keeping Terminal Open (Best Method)

This is the cleanest solution: Run Roki as a true background service.

## First Time Setup

1. Double-click **`Start-Roki-in-Background.command`** (in the `deploy` folder).

2. A dialog will appear telling you the address to use on your phone.

3. On your iPhone, go to that address (example: `http://192.168.1.42:8000`).

4. You can now **close the Terminal window**. The server will keep running in the background.

## How to Stop It Later

Just double-click **`Stop-Roki-Background.command`**.

## How to Start It Automatically Every Time You Log In

If you want Roki to start automatically when your Mac boots:

1. Open **System Settings** → **General** → **Login Items**.
2. Click the **+** button.
3. Add the file: `Start-Roki-in-Background.command`

Now it will start automatically in the background every time you log into your Mac.

## Notes

- Your iPhone must still be on the same Wi-Fi as your Mac.
- The first time you open it on your phone, go to Settings inside the app and add your TMDB API key + your services.
- You can move the two `.command` files to your Desktop or Applications folder for easier access.
