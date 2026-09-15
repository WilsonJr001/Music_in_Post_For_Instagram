/**
 * Asking the page world for audio metadata
 *
 * The feed ships photos with no hint that they carry music, so posts that
 * reach the screen are looked up individually. See docs/ARCHITECTURE.md.
 *
 * Part of the Instagram Photo Audio Enabler content script.
 * Loaded in the order declared in manifest.json; all content-script
 * files share one scope, so these names are visible across files.
 */
'use strict';

/**
 * The feed withholds every trace of music on photo and carousel posts —
 * clips_metadata and has_audio both come back null, so there is no field
 * to test. The audio only exists behind /api/v1/media/<pk>/info/, which
 * Instagram itself only calls when you open a post.
 *
 * Rather than querying every post in the feed, we ask only for the ones
 * that actually reach the screen. That keeps the request count close to
 * what the page would have made had you opened those posts yourself.
 */
const discoveryObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const article = entry.target;
      if (!article.isConnected) continue;

      const viewportH = (entry.rootBounds && entry.rootBounds.height) || window.innerHeight;
      const targetH = entry.boundingClientRect.height || 1;
      const visible = entry.intersectionRect.height / Math.min(targetH, viewportH);
      if (visible < 0.4) continue;

      const shortcode = shortcodeOf(article);
      if (!shortcode) continue;

      if (audioDataMap.has(shortcode) || infoAsked.has(shortcode)) {
        discoveryObserver.unobserve(article);
        continue;
      }

      if (!discoveryEnabled) continue; // listener-only mode, see state.js

      infoAsked.add(shortcode);
      discoveryObserver.unobserve(article);

      dispatchInfoRequest(shortcode, mediaIdFromDom(article), 'now');
    }
  },
  { threshold: Array.from({ length: 11 }, (_, i) => i / 10) }
);

/**
 * Hand a shortcode to inject.js.
 *
 * Firefox keeps the content script and the page in separate security
 * compartments: an object created HERE is opaque to page-world code,
 * which fails with 'Permission denied to access property "shortcode"'.
 * cloneInto() gives the page an object it owns. Where it is missing, a
 * bare string still crosses cleanly — primitives need no wrapper — so
 * inject.js accepts either shape.
 */
function dispatchInfoRequest(shortcode, mediaId, priority) {
  let detail = shortcode;

  try {
    if (typeof cloneInto === 'function') {
      detail = cloneInto(
        { shortcode, mediaId: mediaId || null, priority: priority || 'now' },
        window);
    }
  } catch (err) {
    detail = shortcode; // fall back to the primitive
  }

  document.dispatchEvent(new CustomEvent('IG_AUDIO_REQUEST', { detail }));
}

function registerForDiscovery(article) {
  if (discoveryObserved.has(article)) return;
  discoveryObserved.add(article);

  discoveryObserver.observe(article);
  prefetchObserver.observe(article);
}

/**
 * Look ahead.
 *
 * The observer above only reacts once a post is on screen, which means the
 * track arrives a round trip late. This one watches a band below the fold
 * and asks early, so by the time a post is scrolled to, its audio is
 * usually already known.
 *
 * These go in as low priority: if a post reaches the screen while still
 * queued, the request above jumps it to the front. The same per-media and
 * per-page-load caps apply, and the band is bounded, so this changes when
 * requests happen rather than how many.
 */
const prefetchObserver = new IntersectionObserver(
  (entries) => {
    if (!discoveryEnabled) return;

    for (const entry of entries) {
      const article = entry.target;
      if (!entry.isIntersecting || !article.isConnected) continue;
      if (article.querySelector('video')) continue;

      const shortcode = shortcodeOf(article);
      if (!shortcode) continue;

      if (audioDataMap.has(shortcode) || infoAsked.has(shortcode)) {
        prefetchObserver.unobserve(article);
        continue;
      }

      infoAsked.add(shortcode);
      prefetchObserver.unobserve(article);
      dispatchInfoRequest(shortcode, mediaIdFromDom(article), 'ahead');
    }
  },
  { rootMargin: `0px 0px ${PREFETCH_MARGIN_PX}px 0px`, threshold: 0 }
);
