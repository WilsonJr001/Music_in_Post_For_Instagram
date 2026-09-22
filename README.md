<img src="icons/icon-256.png" alt="Instagram Web Photo Audio Enabler icon" width="96">

# Instagram Web Photo Audio Enabler

A Firefox extension that plays the music attached to photo and carousel
posts on Instagram's web client.

## The problem

Post a photo with a song and the mobile app plays it. The web client shows
the same post in silence — it has no UI for a non-video track and never
asks for one.

The data is not missing for lack of trying. Open a post on the web and
Instagram fetches the progressive `.m4a`/`.mp4` URL, the start offset in
milliseconds, and the clip length. It just never does anything with them.

This extension does.

## What it does

- Plays the author's chosen segment over photo and carousel posts, in the
  feed, on profiles and on post pages
- Follows whichever post you are looking at, one at a time
- Starts muted, every time — a page load never begins playing on its own
- Leaves video posts alone; Instagram already handles those

## Install (temporary add-on)

1. Clone the repository
2. Open `about:debugging#/runtime/this-firefox`
3. **Load Temporary Add-on…** and select `manifest.json`
4. Open Instagram and scroll

Requires Firefox 128 or newer, for `world: "MAIN"` content scripts.

Temporary add-ons are unloaded when Firefox closes, and editing a file does
not reload them — use **Reload** in `about:debugging` after changes.

## Using it

A muted badge appears briefly on posts that have a track, then fades. Hover
a post to bring it back. Click 🔇 to turn sound on; the choice applies to
every post and the volume is remembered between visits. The unmuted state
is not — closing Instagram and reopening it starts quiet.

## Choosing when it asks

Because the feed hides the audio, playing music while you scroll means
asking Instagram about posts as they reach the screen. That is a request
per post looked at, and most come back with nothing. The options page
(`about:addons` -> this extension -> Preferences) offers both behaviours:

- **While scrolling the feed** (default) - looks posts up as they appear.
  This is what makes feed playback work.
- **Only when a photo is opened** - makes no requests of its own and only
  reads what Instagram fetches anyway, the way earlier versions behaved.

Open tabs pick up the change immediately.

## How it works

Instagram withholds the audio from the feed entirely and only sends it when
you open a post, so the extension asks for it itself, for posts that reach
the screen. The details, and the reasoning behind the less obvious parts,
are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Tests

```
node test/run.js
```

No dependencies, no build step.

## Known limitations

- **Mixed carousels.** A carousel that mixes photos with a video drops the
  player once the video slide renders, to avoid two tracks at once.
- **Request cost.** Nothing in the feed says which photos have music, so
  posts are looked up as they reach the screen and most lookups find
  nothing. Serialised, one per post, capped per page load.
- **Clip length.** A few responses carry only the full track length. The
  segment is capped at 90 seconds when that happens, Instagram's own limit.

## License

MIT, see [LICENSE](LICENSE).

Not affiliated with, endorsed by, or sponsored by Meta or Instagram. The
sound glyphs are Instagram's own, used so the control reads as part of the
page; see [docs/INTEGRATION.md](docs/INTEGRATION.md) for what native
support would take.
