# Notes toward native support

Written for whoever at Meta might read this. Everything below was observed
from the outside, by watching what instagram.com sends its own web client.
There is no reverse engineering of anything private here, only a record of
what the public web app receives and what it does with it.

The short version: the web client already has almost everything it needs to
play the music on a photo post. What it lacks is one field in one response,
and a control it already ships elsewhere.

## What works today

Open a photo post on the web, directly or from the feed, and the client
requests `/api/v1/media/<pk>/info/`. That response carries the complete
track:

```json
"clips_metadata": {
  "audio_type": "licensed_music",
  "music_info": {
    "music_asset_info": {
      "progressive_download_url": "...",
      "duration_in_ms": 208000,
      "title": "...", "display_artist": "..."
    },
    "music_consumption_info": {
      "audio_asset_start_time_in_ms": 29000,
      "overlap_duration_in_ms": 30000
    }
  }
}
```

A progressive URL an `<audio>` element plays directly, the offset the author
picked, and the length of the segment. Nothing is missing. The client simply
never builds a player for it, because on the web a non-video post has no
audio surface.

## What is missing

### 1. The feed response omits the audio entirely

In `xdt_api__v1__feed__timeline__connection`, a photo or carousel arrives
like this:

```json
"media_type": 1,
"clips_metadata": null,
"has_audio": null
```

Not empty, absent. In one captured session that held for 20 of 20 photos and
11 of 11 carousels, without exception. Video posts in the same response do
carry `clips_metadata`.

Where a photo does carry music metadata, on a profile grid query for
instance, it is the cosmetic subset only:

```json
"music_asset_info": {
  "audio_cluster_id": "...", "title": "...",
  "display_artist": "...", "cover_artwork_thumbnail_uri": "...",
  "is_explicit": false
}
```

Title, artist, cover art. No URL, no timing.

The practical consequence is that nothing client side can tell which photos
in a feed have a track. Anything wanting to play them has to ask per post,
which is a request each, and most find nothing. Including
`progressive_download_url`, `audio_asset_start_time_in_ms` and
`overlap_duration_in_ms` for `media_type` 1 and 8 in the timeline response,
exactly as they already appear for videos, would remove that entire class of
traffic.

Even just a boolean, some `has_music: true` on photos, would cut it by
roughly two thirds. Right now the only way to find out is to ask.

### 2. There is no control for it

The web client already draws a volume control on video posts: a vertical
track that fills upward with a mute toggle beneath, `role="slider"` with
`aria-valuenow`, the fill by `height` percentage and the knob by `bottom`
percentage. It is the right control, already built, already accessible.
Photo posts do not get it.

### 3. Two fields that read alike and are not

`music_asset_info.duration_in_ms` is the length of the whole track.
`music_consumption_info.overlap_duration_in_ms` is the segment the author
chose. Preferring the wrong one turns a 15 second clip into a four minute
one. Some responses carry only the first, which leaves no way to know the
intended segment. Sending the clip length consistently would settle it.

## What a native implementation would do

1. Include the audio asset and timing for `media_type` 1 and 8 in the
   timeline response, as already happens for `media_type` 2.
2. Render the existing volume control on photo and carousel posts that have
   a track.
3. Start muted. Autoplay policy blocks unmuted playback without a gesture
   anyway, and a feed that starts making noise on load is its own problem.
4. Play the segment between `audio_asset_start_time_in_ms` and that plus
   `overlap_duration_in_ms`, looping while the post is on screen, one post
   at a time.

That is the entire feature. The data is already computed, already stored,
already sent on request. Parity with mobile here is a rendering decision,
not an infrastructure one.

## Why this document exists

This extension does the above from outside, and every awkward part of it
exists to work around the two gaps. It intercepts responses because there is
no other way to see the metadata. It makes a request per visible post
because the feed will not say which posts need one. It reads media ids out
of `ig_cache_key` in image URLs because server rendered posts never pass
through a response it can see.

None of that would be necessary if the web client shipped the feature. If it
ever does, this extension should stop existing, and that would be the right
outcome.
