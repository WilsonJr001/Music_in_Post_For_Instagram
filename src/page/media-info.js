/**
 * Fetching what the feed leaves out
 *
 * The feed returns photos with clips_metadata:null, so nothing in it says
 * a post has music. The content script reports which posts reached the
 * screen and each is looked up once, serialised and capped.
 *
 * Runs in the PAGE world (manifest world: "MAIN"), not the extension
 * sandbox, so it can see Instagram's own fetch/XHR traffic. Files load
 * in manifest order and share one scope.
 */
'use strict';

/**
 * Mirrors the content script's discovery setting. Enforced here as well, so
 * that turning it off stops the requests at the point they are made.
 */
let discoveryEnabled = true;

/** Media ids already requested (or queued), so we ask at most once */
const infoRequested = new Set();

const infoQueue = [];

let infoInFlight = false;

/** Hard ceiling per page load — never hammer the endpoint */
const MAX_INFO_FETCHES = 60;

let infoFetchCount = 0;

/** Captured from Instagram's own requests; required by the info endpoint */
let igAppId = null;

/** Web client app id, used only until we observe the real one */
const DEFAULT_IG_APP_ID = '936619743392459';

function rememberAppId(headers) {
  if (igAppId || !headers) return;
  try {
    if (typeof headers.get === 'function') {
      igAppId = headers.get('x-ig-app-id') || igAppId;
      return;
    }
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'x-ig-app-id') {
        igAppId = headers[k];
        return;
      }
    }
  } catch (err) {
    // Header bag we don't understand — ignore
  }
}

// ──────────────────────────────────────────────────────────
// Queue a media id for an info lookup
// ──────────────────────────────────────────────────────────
function queueMediaInfo(mediaId, shortcode, priority) {
  if (!discoveryEnabled) return;
  if (!mediaId) return;
  if (dispatchedShortcodes.has(shortcode) || videoShortcodes.has(shortcode)) return;

  // Already waiting its turn. If it has since come on screen, move it to
  // the front: the post being looked at should not sit behind ones queued
  // ahead of it on the guess that scrolling would continue.
  const waiting = infoQueue.findIndex((entry) => entry.mediaId === mediaId);
  if (waiting !== -1) {
    if (priority === 'now' && waiting > 0) {
      infoQueue.unshift(infoQueue.splice(waiting, 1)[0]);
    }
    return;
  }

  if (infoRequested.has(mediaId)) return;
  if (infoFetchCount >= MAX_INFO_FETCHES) return;

  infoRequested.add(mediaId);
  if (priority === 'now') infoQueue.unshift({ mediaId, shortcode });
  else infoQueue.push({ mediaId, shortcode });

  drainInfoQueue();
}

// ──────────────────────────────────────────────────────────
// One request at a time — the feed can surface many posts at once and
// we are standing in for a call the page would have made on open.
// ──────────────────────────────────────────────────────────
function drainInfoQueue() {
  if (infoInFlight || infoQueue.length === 0) return;
  if (infoFetchCount >= MAX_INFO_FETCHES) return;

  const { mediaId, shortcode } = infoQueue.shift();
  infoInFlight = true;
  infoFetchCount++;

  const headers = { 'X-IG-App-ID': igAppId || DEFAULT_IG_APP_ID };

  // originalFetch: our own patch would re-scan the same body otherwise
  originalFetch('/api/v1/media/' + mediaId + '/info/', {
    headers,
    credentials: 'same-origin',
  })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))))
    .then((data) => {
      // A DOM-derived id can belong to a carousel slide rather than the
      // post. scanPayload keys everything on the shortcode inside the
      // response, so the result is still correct — just not the post we
      // were after. Say so rather than letting it look like a success.
      const body = JSON.stringify(data);
      if (body.indexOf('"' + shortcode + '"') === -1) {
        console.log('[IG Audio Enabler] Media info returned a different post than',
          shortcode, '— keeping whatever it describes');
      } else {
        console.log('[IG Audio Enabler] Fetched media info for:', shortcode);
      }
      scanPayload(data);
    })
    .catch((err) => {
      console.warn('[IG Audio Enabler] Media info failed for', shortcode, err.message);
    })
    .then(() => {
      infoInFlight = false;
      // Small gap between calls
      setTimeout(drainInfoQueue, 250);
    });
}

// ============================================================
// On-demand requests from content.js
// ============================================================
// The feed ships photos and carousels with clips_metadata:null and
// has_audio:null — no hint at all that music is attached. There is
// nothing to test for, so content.js tells us which posts are actually
// on screen and we look those up, instead of querying the whole feed.
document.addEventListener('IG_AUDIO_REQUEST', function (e) {
  try {
    // detail is either a page-owned { shortcode } object (cloneInto)
    // or a bare string, depending on what content.js could produce.
    const detail = e.detail;
    const shortcode = typeof detail === 'string' ? detail : (detail && detail.shortcode);
    if (!shortcode) return;

    // content.js can recover the id from the post's image URLs when we
    // never saw the payload (server-rendered posts)
    const domMediaId = (detail && typeof detail === 'object') ? detail.mediaId : null;
    const priority = (detail && typeof detail === 'object' && detail.priority) || 'now';
    if (dispatchedShortcodes.has(shortcode) || videoShortcodes.has(shortcode)) return;

    const mediaId = shortcodeToMediaId.get(shortcode) || domMediaId;
    if (!mediaId) {
      console.log('[IG Audio Enabler] No media id known yet for:', shortcode);
      return;
    }
    if (!shortcodeToMediaId.has(shortcode)) {
      console.log('[IG Audio Enabler] Using media id from DOM for:', shortcode, mediaId);
    }
    queueMediaInfo(mediaId, shortcode, priority);
  } catch (err) {
    console.warn('[IG Audio Enabler] Error handling IG_AUDIO_REQUEST:', err);
  }
});

document.addEventListener('IG_AUDIO_CONFIG', function (e) {
  const detail = e.detail;
  if (!detail) return;
  discoveryEnabled = detail.discoveryEnabled !== false;
});
