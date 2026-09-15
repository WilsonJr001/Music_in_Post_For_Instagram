# Architecture

The extension exists because of one asymmetry: Instagram's servers send the
web client everything needed to play the music attached to a photo, and the
web client ignores it. Everything here is about getting that data and
handing it to an `<audio>` element.

## The two worlds

Firefox runs extension code in a sandbox isolated from the page. That
sandbox cannot see `window.fetch` as the page sees it, so it cannot observe
Instagram's API traffic. The page world can, but has no extension
privileges.

So the extension lives in both, and they talk over DOM events:

```
  PAGE WORLD  (src/page/*, manifest world: "MAIN")
      │  taps window.fetch / XMLHttpRequest
      │  parses responses, decides what is playable
      │
      │   IG_AUDIO_FOUND    { shortcode, audioUrl, startTime, duration }
      ▼
  CONTENT SCRIPT  (src/content/*, extension sandbox)
      │  matches posts in the DOM, builds the player, rules playback
      │
      │   IG_AUDIO_REQUEST  { shortcode, mediaId }
      ▲
      └── back to the page world when a post needs a lookup
```

`IG_AUDIO_REQUEST` travels the harder direction. An object created in the
sandbox is opaque to page code — reading a property throws *"Permission
denied to access property"*. `cloneInto()` hands the page an object it
owns; where that is unavailable the shortcode goes as a bare string, since
primitives need no wrapper. The page side accepts either shape.

## Where the audio actually comes from

This is the part worth knowing before changing anything.

**The feed does not contain the audio.** A photo or carousel in
`xdt_api__v1__feed__timeline__connection` arrives with `clips_metadata:
null` and `has_audio: null`. Not "empty" — absent. There is no field to
test, so there is no way to tell from the feed which photos have music.

**Videos are different.** They do carry `clips_metadata`, which is why an
early version appeared to work: it was only ever seeing reels, which the
extension must skip anyway (Instagram already plays their sound).

**The audio lives behind `/api/v1/media/<pk>/info/`**, which Instagram
requests only when you open a post. That is why playback worked on a post
page and never in the feed.

So the extension issues that request itself — the same call the page would
have made — but only for posts that actually reach the screen:

1. `content/discovery.js` watches every photo/carousel article.
2. At 40% visible it sends `IG_AUDIO_REQUEST`.
3. `page/media-info.js` looks up the media id and fetches `/info/`.
4. The response goes through the normal scanner and comes back as
   `IG_AUDIO_FOUND`.

Requests are serialised, one media id is asked at most once, and there is a
hard cap per page load. The whole behaviour is also a setting: the options
page can switch the extension back to reading only what Instagram fetches
on its own, in which case the feed stays silent and audio appears when a
post is opened. The flag is enforced twice, in `content/discovery.js` before
a request is asked for and in `page/media-info.js` before one is made, so a
content script that missed the change cannot leave requests running. Expect roughly a 1-in-3 hit rate: most photos have
no music and there is no way to know beforehand.

Getting the media id has two sources. Normally the page world recorded
`shortcode -> pk` from a payload it already saw. For server-rendered posts
it never saw one, so the content script decodes it from the post's own
image URLs: `ig_cache_key` is base64 of the pk. On a carousel this can
yield a slide's id instead of the post's; results are keyed on whatever
shortcode the response contains, so a wrong guess costs a request and
never mislabels audio.

## Picking the right values out of a response

`page/payload.js` holds the rules, and they are less obvious than they look.

- **Audio URL.** Any `.mp4` passes a naive URL test, including the video
  track of a carousel slide. Keys are ranked — `progressive_download_url`
  first, generic `url`/`uri` only inside an audio subtree and last.
  `dash_manifest_url` is excluded: `<audio>` cannot play a DASH manifest,
  it only fails silently.
- **Clip length.** Responses carry both the segment the author chose
  (`overlap_duration_in_ms`) and the full track length (`duration_in_ms` on
  `music_asset_info`). Preferring the wrong one turns a 15-second clip into
  a 4-minute one and the loop never fires. Field precision decides;
  subtree context breaks ties.
- **Video posts.** Skipped in two places, because a single check was not
  enough: a targeted pass, and the broad sweep that runs afterwards. A
  shortcode rejected once stays rejected for the session.

## Playback rules

Exactly one post sounds at a time. Visibility is measured against the
window rather than the element — an article taller than the viewport can
never reach a high `intersectionRatio`, so a raw ratio silently never
crosses any threshold. The most visible eligible post wins, decided once
per observer batch rather than per entry, so two posts sharing the screen
cannot trade the audio back and forth. `enforceSinglePlayback()` then
asserts the rule against the actual `<audio>` state instead of trusting the
bookkeeping.

Sound is off until asked for, and that choice is global but deliberately
not persisted: reopening Instagram should never land on a post already
playing out loud. Volume is a level rather than a trigger, so that one is
remembered.

The volume control is a vertical track that fills upward, matching how
Instagram draws its own — fill by `height: X%`, knob at `bottom: X%`. It is
built by hand rather than styled from `<input type="range">`, because
vertical range inputs need vendor-specific hacks that differ per engine and
because the collapse animation needs a height this code controls.
Instagram's own markup cannot be reused: its class names are generated and
change between deploys, so only the behaviour is mirrored.

The sound button uses Instagram's own volume glyphs, lifted from the markup
it renders for video posts, so the control reads as part of the page. They
are drawn with `createElementNS` rather than assigned as markup, and the
two states use different viewBoxes (48 for muted, 24 for unmuted) because
Instagram ships them that way.

## Anchoring the player

Instagram's carousel is a horizontal scroll-snap container. A
`position: absolute` player placed inside it is positioned against the
container's *content*, so swiping carries it one slide-width out of view.
`content/dom.js` climbs out to the nearest ancestor that does not scroll.
Older builds used a `<ul>` track of `<li>` slides, which is handled too.

If Instagram changes this again, the symptom is a player that drifts off
the post. There is a runtime guard for that: a drifted player is
re-anchored one level up and logs `Player drifted outside post`.

## Files

| | |
|---|---|
| `src/page/payload.js` | pure rules over a decoded response |
| `src/page/scanner.js` | walks a response, emits `IG_AUDIO_FOUND` |
| `src/page/media-info.js` | the on-demand `/info/` queue |
| `src/page/interceptor.js` | the fetch/XHR taps — loaded last |
| `src/content/state.js` | shared state |
| `src/content/preferences.js` | sound and volume |
| `src/content/dom.js` | everything that reads Instagram's markup |
| `src/content/player.js` | the player element and its timed behaviours |
| `src/content/playback.js` | what plays, and when |
| `src/content/discovery.js` | asking the page world for metadata |
| `src/content/main.js` | bootstrap |
| `src/options/` | the options page |

Load order is the order in `manifest.json`. All files in a world share one
scope, so names are visible across files without any module plumbing.
`interceptor.js` is last on purpose: the wrappers must not be installed
before the functions they call exist.

## Tests

```
node test/run.js
```

No dependencies and no build step. Both suites concatenate the real sources
in manifest order and run them against a stub DOM, so they exercise what
Firefox loads rather than a copy.
