/**
 * ============================================================
 * Instagram Photo Audio Enabler — Network Interceptor (inject.js)
 * ============================================================
 *
 * This script runs in the MAIN world (page context) to intercept
 * Instagram API responses and extract audio metadata from photo
 * and carousel posts. It monkey-patches both fetch() and XHR.
 *
 * When audio data is found, it dispatches a CustomEvent
 * 'IG_AUDIO_FOUND' with { shortcode, audioUrl } for content.js.
 * ============================================================
 */
(function () {
  'use strict';

  // Set of shortcodes already dispatched to avoid duplicate events
  const dispatchedShortcodes = new Set();

  // ──────────────────────────────────────────────────────────
  // Utility: Check if a URL is an Instagram GraphQL endpoint
  // ──────────────────────────────────────────────────────────
  function isGraphQLEndpoint(url) {
    if (!url || typeof url !== 'string') return false;
    return (
      url.includes('/api/graphql') ||
      url.includes('/graphql/query') ||
      url.includes('/api/v1/feed') ||
      url.includes('/api/v1/media')
    );
  }

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
  const AUDIO_KEYS = new Set([
    'music_metadata',
    'clips_metadata',
    'original_sound_info',
    'music_info',
    'audio_src',
    'progressive_download_url',
    'audio_asset_url',
    'audio_url',
    'dash_manifest_url',
    'song_url',
    'media_url',
    'uri',
    'url',
  ]);

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

    // Check for audio clip timing metadata
    // Instagram sends these as milliseconds integers
    if (typeof obj.audio_asset_start_time_in_ms === 'number') {
      results.startTimeMs = obj.audio_asset_start_time_in_ms;
    }
    if (typeof obj.duration_in_ms === 'number' && obj.duration_in_ms > 0) {
      results.durationMs = obj.duration_in_ms;
    }
    // Some payloads use snake_case variants or nested structures
    if (typeof obj.audio_start_timestamp_in_ms === 'number') {
      results.startTimeMs = obj.audio_start_timestamp_in_ms;
    }
    if (typeof obj.overlap_duration_in_ms === 'number' && obj.overlap_duration_in_ms > 0 && results.durationMs === null) {
      results.durationMs = obj.overlap_duration_in_ms;
    }

    // Check for audio URLs at this level
    for (const key of keys) {
      const val = obj[key];

      if (typeof val === 'string' && isAudioUrl(val)) {
        // Only collect audio URLs from audio-relevant contexts
        if (isAudioContext || AUDIO_KEYS.has(key)) {
          results.audioUrls.add(val);
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
      audioUrls: new Set(),
      startTimeMs: null,
      durationMs: null,
    };
  }

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
          if (isVideoMedia(data)) {
            console.log('[IG Audio Enabler] Skipping video post (broad sweep):', shortcode);
            return;
          }

          const audioUrl = [...globalResults.audioUrls][0];
          const startTime = (globalResults.startTimeMs || 0) / 1000;
          const duration = (globalResults.durationMs || 15000) / 1000;
          dispatchAudioFound(shortcode, audioUrl, startTime, duration);
        }
      }
    } catch (err) {
      // Silent fail — we don't want to break Instagram
    }
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
    if (depth > 5) return false; // Don't go too deep
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
      // ── SKIP video posts ──
      // is_video=true → single video/reel
      // media_type=2  → video in Instagram's numeric taxonomy
      // We allow media_type=8 (carousel) to pass through — the
      // carousel itself isn't a video; individual slides may be
      if (isVideoMedia(obj)) {
        console.log('[IG Audio Enabler] Skipping video post:', shortcode);
        return;
      }

      // Collect audio URLs and timing metadata from this subtree
      const results = createResults();
      collectFromSubtree(obj, false, results);

      if (results.audioUrls.size > 0) {
        const audioUrl = [...results.audioUrls][0];
        // Convert ms → seconds with fallbacks
        const startTime = (results.startTimeMs || 0) / 1000;
        const duration = (results.durationMs || 15000) / 1000;
        dispatchAudioFound(shortcode, audioUrl, startTime, duration);
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
  function dispatchAudioFound(shortcode, audioUrl, startTime, duration) {
    if (!shortcode || !audioUrl) return;
    if (dispatchedShortcodes.has(shortcode)) return;

    dispatchedShortcodes.add(shortcode);

    // Ensure sensible defaults
    const st = (typeof startTime === 'number' && isFinite(startTime)) ? startTime : 0;
    const dur = (typeof duration === 'number' && isFinite(duration) && duration > 0) ? duration : 15;

    console.log('[IG Audio Enabler] Audio found:', shortcode, audioUrl,
      'startTime=' + st.toFixed(2) + 's', 'duration=' + dur.toFixed(2) + 's');

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

  // ============================================================
  // MONKEY-PATCH: window.fetch
  // ============================================================
  const originalFetch = window.fetch;

  window.fetch = function (...args) {
    const request = args[0];
    let url = '';

    if (typeof request === 'string') {
      url = request;
    } else if (request instanceof Request) {
      url = request.url;
    } else if (request && typeof request === 'object' && request.url) {
      url = request.url;
    }

    const promise = originalFetch.apply(this, args);

    if (isGraphQLEndpoint(url)) {
      promise
        .then((response) => {
          // Clone the response so the original consumer can still read it
          const cloned = response.clone();
          cloned
            .text()
            .then((text) => {
              processResponseBody(text);
            })
            .catch(() => {
              // Ignore clone/read errors
            });
        })
        .catch(() => {
          // Ignore fetch errors — they'll be handled by the original caller
        });
    }

    return promise;
  };

  // ============================================================
  // MONKEY-PATCH: XMLHttpRequest (fallback)
  // ============================================================
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    // Store the URL on the XHR instance for later inspection
    this._igAudioUrl = typeof url === 'string' ? url : '';
    return originalXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this._igAudioUrl && isGraphQLEndpoint(this._igAudioUrl)) {
      this.addEventListener('load', function () {
        try {
          if (this.readyState === 4 && this.status >= 200 && this.status < 300) {
            processResponseBody(this.responseText);
          }
        } catch (err) {
          // Silent fail
        }
      });
    }

    return originalXHRSend.apply(this, args);
  };

  console.log('[IG Audio Enabler] inject.js loaded — monitoring API responses');
})();
