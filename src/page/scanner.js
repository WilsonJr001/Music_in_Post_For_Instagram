/**
 * Walking a response and announcing what it found
 *
 * Locates media nodes, refuses video posts, and emits IG_AUDIO_FOUND for
 * each photo or carousel with a usable track. Also records shortcode -> media
 * id so the lookup in media-info.js has something to ask about.
 *
 * Runs in the PAGE world (manifest world: "MAIN"), not the extension
 * sandbox, so it can see Instagram's own fetch/XHR traffic. Files load
 * in manifest order and share one scope.
 */
'use strict';

// Set of shortcodes already dispatched to avoid duplicate events
const dispatchedShortcodes = new Set();

// ──────────────────────────────────────────────────────────
// On-demand media info fetching
// ──────────────────────────────────────────────────────────
// The feed payload (PolarisFeedRootPaginationCachedQuery) carries only
// cosmetic music fields — audio_cluster_id, title, display_artist,
// cover_artwork_thumbnail_uri, is_explicit. No audio URL, no timing.
// Instagram only fetches those from /api/v1/media/<pk>/info/ when you
// OPEN a post, which is why playback only ever worked on the post page.
// So we request it ourselves for photo/carousel posts that advertise
// music but came without a URL.

/**
 * shortcode -> media id, harvested from any payload that names both.
 * The feed gives us these even though it withholds the audio, so when
 * content.js later says "this post is on screen", we already know which
 * media id to ask about.
 */
const shortcodeToMediaId = new Map();

// Shortcodes positively identified as video posts. findMediaNodes used to
// skip these and then the broad sweep (Strategy 2) dispatched them anyway
// — the console showed "Skipping video post: X" immediately followed by
// "Audio found: X". A skip now sticks for the rest of the session.
const videoShortcodes = new Set();

/** Longest music segment Instagram allows on a photo/carousel post */
const MAX_SEGMENT_SECONDS = 90;

// ──────────────────────────────────────────────────────────
// Core: Scan the top-level payload for media nodes and
// extract shortcode + audioUrl + timing pairs
// ──────────────────────────────────────────────────────────
function scanPayload(data) {
  if (!data || typeof data !== 'object') return;

  try {
    // Strategy 1: Walk known Instagram data structures looking
    // for media nodes that contain both shortcode and audio info
    findMediaNodes(data, 0);

    // Strategy 2: If we have media items at the top level, try
    // a broad sweep to pair shortcodes with audio URLs
    const globalResults = createResults();
    collectFromSubtree(data, false, globalResults);

    if (globalResults.shortcodes.size > 0 && globalResults.audioUrls.size > 0) {
      // If there's exactly one shortcode and one audio URL, pair them
      if (globalResults.shortcodes.size === 1 && globalResults.audioUrls.size >= 1) {
        const shortcode = [...globalResults.shortcodes][0];

        // Strategy 2 fallback: check if the top-level data indicates
        // a video post — if so, skip it entirely
        // subtreeHasVideo() was written for exactly this and then never
        // called — isVideoMedia(data) only inspected the root wrapper,
        // which never carries is_video/media_type, so every video leaked
        // through here.
        if (subtreeHasVideo(data, 0)) {
          videoShortcodes.add(shortcode);
          console.log('[IG Audio Enabler] Skipping video post (broad sweep):', shortcode);
          return;
        }

        const audioUrl = pickBestAudioUrl(globalResults);
        const startTime = (globalResults.startTimeMs || 0) / 1000;
        const duration = (globalResults.durationMs || 15000) / 1000;
        dispatchAudioFound(shortcode, audioUrl, startTime, duration, globalResults);
      }
    }
  } catch (err) {
    // Silent fail — we don't want to break Instagram
  }
}

// ──────────────────────────────────────────────────────────
// Walk the JSON tree looking for "media" nodes that contain
// both a shortcode and audio metadata (skip video nodes)
// ──────────────────────────────────────────────────────────
function findMediaNodes(obj, depth) {
  if (depth > 20) return; // Guard against extremely deep nesting
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      findMediaNodes(item, depth + 1);
    }
    return;
  }

  // Check if this object looks like a media node (has shortcode)
  const shortcode = obj.shortcode || obj.code;
  if (shortcode && isValidShortcode(shortcode)) {
    const knownId = mediaIdOf(obj);
    if (knownId) shortcodeToMediaId.set(shortcode, knownId);

    // ── SKIP video posts ──
    // is_video=true → single video/reel
    // media_type=2  → video in Instagram's numeric taxonomy
    // We allow media_type=8 (carousel) to pass through — the
    // carousel itself isn't a video; individual slides may be
    if (isVideoMedia(obj)) {
      videoShortcodes.add(shortcode);
      console.log('[IG Audio Enabler] Skipping video post:', shortcode);
      return;
    }

    // Collect audio URLs and timing metadata from this subtree
    const results = createResults();
    collectFromSubtree(obj, false, results);

    // Music advertised but no asset in this payload: this is the feed,
    // which ships only title/artist/cover. Go get the real thing.
    if (results.audioUrls.size === 0 && advertisesMusic(obj)) {
      queueMediaInfo(mediaIdOf(obj), shortcode);
    }

    if (results.audioUrls.size > 0) {
      const audioUrl = pickBestAudioUrl(results);
      // Convert ms → seconds with fallbacks
      const startTime = (results.startTimeMs || 0) / 1000;
      const duration = (results.durationMs || 15000) / 1000;
      dispatchAudioFound(shortcode, audioUrl, startTime, duration, results);
      return; // Don't recurse further into this node
    }
  }

  // Recurse into child objects
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'object' && val !== null) {
      findMediaNodes(val, depth + 1);
    }
  }
}

// ──────────────────────────────────────────────────────────
// Dispatch the IG_AUDIO_FOUND event (with deduplication)
// Includes timing: startTime (seconds), duration (seconds)
// ──────────────────────────────────────────────────────────
function dispatchAudioFound(shortcode, audioUrl, startTime, duration, results) {
  if (!shortcode || !audioUrl) return;
  if (dispatchedShortcodes.has(shortcode)) return;

  if (videoShortcodes.has(shortcode)) {
    console.log('[IG Audio Enabler] Suppressed (known video post):', shortcode);
    return;
  }

  dispatchedShortcodes.add(shortcode);

  // Ensure sensible defaults
  const st = (typeof startTime === 'number' && isFinite(startTime)) ? startTime : 0;
  let dur = (typeof duration === 'number' && isFinite(duration) && duration > 0) ? duration : 15;

  // Instagram caps music on a photo/carousel at 90s. Anything longer is
  // the full track length leaking through, not the clip — cap it so the
  // segment loop still has somewhere to loop back from.
  if (dur > MAX_SEGMENT_SECONDS) {
    console.log('[IG Audio Enabler] Clamping implausible segment for', shortcode,
      dur.toFixed(2) + 's -> ' + MAX_SEGMENT_SECONDS + 's');
    dur = MAX_SEGMENT_SECONDS;
  }

  // Say WHERE each number came from. A duration sourced from
  // 'duration_in_ms' (or from nothing at all) is the full track length,
  // not the clip the author picked — that is what the clamp above is
  // papering over, and the log should make it obvious which is which.
  const from = results || {};
  console.log('[IG Audio Enabler] Audio found:', shortcode, audioUrl,
    'startTime=' + st.toFixed(2) + 's (' + (from.startTimeMsFrom || 'AUSENTE, usando 0') + ')',
    'duration=' + dur.toFixed(2) + 's (' + (from.durationMsFrom || 'AUSENTE, usando padrao') + ')');

  document.dispatchEvent(
    new CustomEvent('IG_AUDIO_FOUND', {
      detail: { shortcode, audioUrl, startTime: st, duration: dur },
    })
  );
}

// ──────────────────────────────────────────────────────────
// Process a raw JSON response body
// ──────────────────────────────────────────────────────────
function processResponseBody(text) {
  if (!text || typeof text !== 'string') return;

  try {
    const data = JSON.parse(text);
    scanPayload(data);
  } catch (err) {
    // Not valid JSON — silently ignore
  }
}
