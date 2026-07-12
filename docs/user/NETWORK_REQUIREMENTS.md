# Important: Network Requirements

This app has two parts that work differently:

## 1. The Website Itself
- Can be opened from anywhere (phone on cellular, different Wi-Fi, etc.)
- No problem

## 2. Controlling Your Roku (the important part)
- Your phone's browser must be able to reach your **computer's local IP** on port 8060.
- This ONLY works when your **phone is on the same Wi-Fi** as your Roku/computer.

### Common Problem You're Probably Seeing

You published the site → opened the public link on your phone → tried to enter your computer's IP → got "can't be found".

**This almost always means your phone is not on the same Wi-Fi right now.**

### How to Fix

1. Make sure your phone is connected to **Wi-Fi** (not using cellular data).
2. The Wi-Fi network must be the **same one** your computer + Roku are on.
3. Re-enter the computer's local IP in the app and click Test again.

### How to Confirm You're on the Right Network

- On your computer, run this again and note the IP:
  ```bash
  ipconfig getifaddr en0 || ipconfig getifaddr en1
  ```

- On your phone, make sure it's using the same Wi-Fi network name (SSID).

- Try the Test button in the app again.

If it still fails after confirming you're on the same Wi-Fi, reply with:
- What IP you're entering
- Whether the phone is definitely on Wi-Fi
- Any error message you're seeing exactly

This is the #1 issue people hit with this kind of local-remote app.