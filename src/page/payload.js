/**
 * Reading Meta's JSON
 *
 * Pure functions over a decoded API response: what counts as a shortcode,
 * which key holds the real audio URL, which timing field describes the clip
 * the author chose rather than the whole track. No I/O, no side effects —
 * the rules here are the ones that break when Meta reshapes its schema.
 *
 * Runs in the PAGE world (manifest world: "MAIN"), not the extension
 * sandbox, so it can see Instagram's own fetch/XHR traffic. Files load
 * in manifest order and share one scope.
 */
'use strict';

// ──────────────────────────────────────────────────────────
// Utility: Check if a string looks like a valid shortcode
// ──────────────────────────────────────────────────────────
function isValidShortcode(value) {
  return (
    typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

// ──────────────────────────────────────────────────────────
// Utility: Check if a string looks like an audio URL
// ──────────────────────────────────────────────────────────
function isAudioUrl(value) {
  if (typeof value !== 'string') return false;
  return (
    (value.startsWith('http://') || value.startsWith('https://')) &&
    (value.includes('.mp4') || value.includes('.m4a') || value.includes('.mp3') || value.includes('.aac'))
  );
}

// ──────────────────────────────────────────────────────────
// Audio-related key names we look for in the JSON tree
// ──────────────────────────────────────────────────────────
// Preference order for audio URLs — lower wins. The old code kept a flat
// Set and took whichever URL the JSON happened to yield first, so a
// carousel with a video slide handed us video_versions[].url (an .mp4
// that passes isAudioUrl) instead of the music track.
// 'dash_manifest_url' is gone on purpose: it points at a DASH manifest,
// which <audio> cannot play — it only ever failed silently.
const AUDIO_KEY_PRIORITY = {
  progressive_download_url: 0,
  audio_asset_url: 1,
  audio_url: 2,
  audio_src: 3,
  song_url: 4,
  media_url: 5,
  // Generic keys: only trusted inside an audio subtree, and ranked last
  uri: 8,
  url: 8,
};

/** Rank given to an audio-looking URL under an unlisted key */
const UNKNOWN_KEY_RANK = 9;

const AUDIO_PARENT_KEYS = new Set([
  'music_metadata',
  'clips_metadata',
  'original_sound_info',
  'music_info',
  'music_asset_info',
  'music_canonical_info',
  'audio',
  'audio_info',
  'sound_info',
]);

// ──────────────────────────────────────────────────────────
// Core: Recursively scan a JSON payload to collect shortcodes,
// audio URLs, and timing metadata from the same subtree context
// ──────────────────────────────────────────────────────────
function collectFromSubtree(obj, isAudioContext, results) {
  if (obj === null || obj === undefined) return;
  if (typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      collectFromSubtree(obj[i], isAudioContext, results);
    }
    return;
  }

  const keys = Object.keys(obj);

  // Check for shortcode at this level
  if (obj.shortcode && isValidShortcode(obj.shortcode)) {
    results.shortcodes.add(obj.shortcode);
  }
  if (obj.code && isValidShortcode(obj.code)) {
    results.shortcodes.add(obj.code);
  }

  // Check for audio clip timing metadata (milliseconds integers).
  // A carousel's subtree is far bigger than a single photo's, so a
  // duration_in_ms belonging to something else (a video slide, a story)
  // used to overwrite the real one — last write won. Now a value found
  // inside an audio subtree beats one found outside, and ties keep the
  // first match.
  recordTiming(results, 'startTimeMs', obj.audio_asset_start_time_in_ms, isAudioContext, 0,
    'audio_asset_start_time_in_ms');
  recordTiming(results, 'startTimeMs', obj.audio_start_timestamp_in_ms, isAudioContext, 1,
    'audio_start_timestamp_in_ms');

  // Instagram sends BOTH the segment the author picked
  // (overlap_duration_in_ms) and the full track length (duration_in_ms on
  // music_asset_info). The old order preferred duration_in_ms, so a clip
  // of a 4-minute song came out as duration=256s and the segment loop
  // never fired. Clip fields now win.
  recordTiming(results, 'durationMs', obj.overlap_duration_in_ms, isAudioContext, 0,
    'overlap_duration_in_ms');
  recordTiming(results, 'durationMs', obj.audio_asset_duration_in_ms, isAudioContext, 1,
    'audio_asset_duration_in_ms');
  recordTiming(results, 'durationMs', obj.duration_in_ms, isAudioContext, 2,
    'duration_in_ms');

  // Check for audio URLs at this level
  for (const key of keys) {
    const val = obj[key];

    if (typeof val === 'string' && isAudioUrl(val)) {
      const priority = AUDIO_KEY_PRIORITY[key];
      const rank = priority === undefined ? UNKNOWN_KEY_RANK : priority;
      // Dedicated audio keys count anywhere; generic ones only inside an
      // audio subtree, where a video slide's .mp4 cannot reach us.
      const isDedicatedKey = priority !== undefined && priority < 8;

      if (isDedicatedKey || isAudioContext) {
        const known = results.audioUrls.get(val);
        if (known === undefined || rank < known) {
          results.audioUrls.set(val, rank);
        }
      }
    }

    // Recurse into children
    if (typeof val === 'object' && val !== null) {
      const childIsAudioContext = isAudioContext || AUDIO_PARENT_KEYS.has(key);
      collectFromSubtree(val, childIsAudioContext, results);
    }
  }
}

// ──────────────────────────────────────────────────────────
// Helper: Create a fresh results object for subtree collection
// ──────────────────────────────────────────────────────────
function createResults() {
  return {
    shortcodes: new Set(),
    /** Map<url, rank> — see AUDIO_KEY_PRIORITY */
    audioUrls: new Map(),
    startTimeMs: null,
    startTimeMsRank: Infinity,
    startTimeMsFrom: null,
    durationMs: null,
    durationMsRank: Infinity,
    durationMsFrom: null,
  };
}

// ──────────────────────────────────────────────────────────
// Helper: Record a timing value, best context wins, first wins on ties
// ──────────────────────────────────────────────────────────
function recordTiming(results, field, value, isAudioContext, sourceRank, fieldName) {
  if (typeof value !== 'number' || !isFinite(value) || value < 0) return;
  if (field === 'durationMs' && value <= 0) return;

  // Field precision dominates; subtree context breaks ties.
  const rank = sourceRank * 2 + (isAudioContext ? 0 : 1);
  if (rank < results[field + 'Rank']) {
    results[field] = value;
    results[field + 'Rank'] = rank;
    results[field + 'From'] = fieldName;
  }
}

// ──────────────────────────────────────────────────────────
// Helper: Pick the best-ranked audio URL collected from a subtree
// ──────────────────────────────────────────────────────────
function pickBestAudioUrl(results) {
  let best = null;
  let bestRank = Infinity;

  for (const [url, rank] of results.audioUrls) {
    if (rank < bestRank) {
      best = url;
      bestRank = rank;
    }
  }
  return best;
}

// ──────────────────────────────────────────────────────────
// Check if a JSON node represents a video post
// Returns true for videos/reels that should NOT get our player
// ──────────────────────────────────────────────────────────
function isVideoMedia(obj) {
  if (!obj || typeof obj !== 'object') return false;
  // Direct video indicators on the media node
  if (obj.is_video === true) return true;
  if (obj.media_type === 2) return true;
  if (obj.product_type === 'clips' || obj.product_type === 'igtv') return true;
  // For carousels (media_type 8), check if the specific items are videos
  // — we allow carousels through because individual slides may be photos
  return false;
}

// ──────────────────────────────────────────────────────────
// Recursively check if a subtree contains video indicators
// Used by Strategy 2 (broad sweep) where we don't have a
// clear media node boundary
// ──────────────────────────────────────────────────────────
function subtreeHasVideo(obj, depth) {
  // Matches findMediaNodes' budget. The old limit of 5 never reached the
  // media node in a GraphQL payload, so this always returned false.
  if (depth > 20) return false;
  if (!obj || typeof obj !== 'object') return false;
  if (isVideoMedia(obj)) return true;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (subtreeHasVideo(item, depth + 1)) return true;
    }
    return false;
  }

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'object' && val !== null) {
      if (subtreeHasVideo(val, depth + 1)) return true;
    }
  }
  return false;
}

// ──────────────────────────────────────────────────────────
// Does this media node claim to have music attached?
// ──────────────────────────────────────────────────────────
function advertisesMusic(obj) {
  const clips = obj.clips_metadata;
  if (clips && typeof clips === 'object') {
    if (clips.music_info || clips.original_sound_info) return true;
  }
  if (obj.music_metadata || obj.music_info) return true;
  return false;
}

// ──────────────────────────────────────────────────────────
// Instagram's media id: 'pk', or the leading half of 'id' (pk_userid)
// ──────────────────────────────────────────────────────────
function mediaIdOf(obj) {
  if (typeof obj.pk === 'string' && /^[0-9]+$/.test(obj.pk)) return obj.pk;
  if (typeof obj.pk === 'number') return String(obj.pk);
  if (typeof obj.id === 'string') {
    const head = obj.id.split('_')[0];
    if (/^[0-9]+$/.test(head)) return head;
  }
  return null;
}
