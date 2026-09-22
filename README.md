<img src="icons/icon-256.png" alt="Instagram Web Photo Audio Enabler icon" width="96">

# Instagram Web Photo Audio Enabler

A Firefox extension that plays the music attached to photo and carousel posts
on Instagram's web client.

## The problem

A photo posted with a song plays that song in the mobile app. The web client
renders the same post in silence, because it offers no interface for a track
that is not attached to a video, and never requests one.

The data itself is present. When a post is opened on the web, Instagram
fetches the progressive `.m4a`/`.mp4` URL, the start offset in milliseconds,
and the clip length. Those values are simply never used.

This extension uses them.

## What it does

- Plays the segment chosen by the author over photo and carousel posts, in
  the feed, on profiles, and on post pages.
- Follows whichever post is currently in view, one at a time.
- Starts muted on every page load, so playback never begins unprompted.
- Ignores video posts, which Instagram already handles.

## Installation (temporary add-on)

1. Clone the repository.
2. Open `about:debugging#/runtime/this-firefox`.
3. Select **Load Temporary Add-on**, then choose `manifest.json`.
4. Open Instagram.

Firefox 128 or newer is required, for `world: "MAIN"` content scripts.

Temporary add-ons are unloaded when Firefox closes, and editing a file does
not reload them. Use **Reload** in `about:debugging` after making changes.

## Usage

A muted badge appears briefly on posts that carry a track, then fades.
Hovering over a post brings it back. Clicking the badge turns sound on. The
choice applies to every post, and the volume is remembered between visits.
The unmuted state is not: closing Instagram and reopening it starts quiet.

## Choosing when lookups happen

Because the feed withholds the audio, playing music during scrolling requires
querying Instagram about posts as they reach the screen. That amounts to one
request per post viewed, and most return nothing. Both behaviours are
available from the options page, reached through the Preferences button for
this extension in `about:addons`:

- **While scrolling the feed** (default). Posts are looked up as they
  appear, which is what makes feed playback possible.
- **Only when a photo is opened.** The extension issues no requests of its
  own and reads only what Instagram fetches anyway, matching the behaviour of
  earlier versions.

Open tabs apply the change immediately.

## How it works

Instagram withholds the audio from the feed entirely and sends it only when a
post is opened, so the extension requests it directly for posts that reach
the screen. The design, including the reasoning behind the less obvious
decisions, is documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Tests

```
node test/run.js
```

No dependencies and no build step.

## Known limitations

- **Mixed carousels.** A carousel combining photos with a video drops the
  player once the video slide renders, which avoids two tracks playing at
  once.
- **Request cost.** Nothing in the feed indicates which photos carry music,
  so posts are looked up as they reach the screen and most lookups find
  nothing. Requests are serialised, one per post, and capped per page load.
- **Clip length.** A small number of responses carry only the full track
  length. The segment is capped at 90 seconds in that case, matching
  Instagram's own limit.

## License

MIT. See [LICENSE](LICENSE).

This project is not affiliated with, endorsed by, or sponsored by Meta or
Instagram. The sound glyphs are Instagram's own, used so that the control
reads as part of the page. See [docs/INTEGRATION.md](docs/INTEGRATION.md) for
an outline of what native support would require.
