# Instagram Web Photo Audio Enabler

A lightweight Firefox (Manifest V3) extension that restores background music playback for static photos and carousels on the Instagram Web client.

## 📌 The Concept & The Problem

The desktop/web version of Instagram is intentionally limited by Meta compared to its mobile counterpart. When a user posts a photo or a carousel with an attached music track, the mobile app downloads and plays the selected audio segment. 

However, on the web client:
1. Photos and carousels are rendered purely as static elements (`<img>`).
2. The web interface completely lacks the UI and logic to play the background audio track for non-video posts.

**The catch?** The music metadata, including the direct progressive download URL (`.m4a`/`.mp4`), the exact start time in milliseconds, and the track duration, **are still being transmitted by the server** in the GraphQL/API responses. The frontend simply ignores them.

## 🚀 The Solution

This extension acts as a transparent middleware that bridges the gap between the incoming data and the UI:

1. **Network Interception (`inject.js`):** 
   Injected directly into the page's `MAIN` execution world, it monkey-patches the native `window.fetch` to listen to Instagram's API responses.
2. **Resilient Data Parsing (BFS Scanner):** 
   Instead of relying on fragile, hardcoded JSON paths that break when Meta updates their GraphQL structure, the script uses a Breadth-First Search (BFS) algorithm to efficiently scan the response payload, extracting the `shortcode`, `audio_url`, `start_time`, and `duration`.
3. **Seamless UI Injection (`content.js`):** 
   When a match is found, the extension attaches a custom HTML5 `<audio>` player over the target `<article>`. It respects the exact time slice chosen by the post author and loops the segment seamlessly.
4. **Smart Playback:** 
   Utilizes the `IntersectionObserver` API to play the audio only when the photo is centered on the user's screen, automatically pausing when scrolled out of view.

## Installation (Developer Mode)

Currently, this extension is meant to be loaded locally as a temporary add-on in Firefox.

1. Clone or download this repository.
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
3. Click on **Load Temporary Add-on...**
4. Select the `manifest.json` file from the project directory.
5. Open [Instagram](https://www.instagram.com) and scroll through your feed.

*Note: Ensure Firefox's Autoplay policies are set to "Allow Audio and Video" for `instagram.com` so the music can play seamlessly as you scroll.*

## Project Structure

- `manifest.json`: Configuration and permissions for Firefox (Manifest V3).
- `inject.js`: Runs in the page context. Intercepts `fetch` calls, parses JSON via BFS, and dispatches custom DOM events.
- `content.js`: Runs in the extension sandbox. Listens for audio metadata, maps it to the DOM, handles the IntersectionObserver, and controls playback logic (looping specific segments).
- `styles.css`: Styles the minimalist floating player overlay.

## Known Limitations

- **SSR (Server-Side Rendering) Initial Load:** The very first batch of posts in the feed might load via inline scripts rather than `fetch`, requiring the user to scroll slightly for the interception to catch subsequent API calls.
- **Autoplay Policies:** Browsers actively block unmuted autoplay without prior user interaction. You may need to click on the page at least once for the audio playback to commence.

## License

This project is for educational and experimental purposes only. It is not affiliated with, endorsed, or sponsored by Meta or Instagram.
