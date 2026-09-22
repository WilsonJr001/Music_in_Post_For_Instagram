/**
 * Reading Instagram's DOM
 *
 * Everything that depends on how Instagram happens to build its markup.
 * When their markup changes, this is the file to look at first.
 *
 * Part of the Instagram Photo Audio Enabler content script.
 * Loaded in the order declared in manifest.json; all content-script
 * files share one scope, so these names are visible across files.
 */
'use strict';

/**
 * Recover Instagram's media id from the post's own image URLs.
 *
 * Posts rendered server-side never pass through our fetch interception,
 * so inject.js has no shortcode -> pk mapping for them and the lookup is
 * skipped ("No media id known yet"). The CDN URLs carry the id anyway:
 * ig_cache_key is base64 of the media pk (all 19 digits), sometimes with
 * a child id appended, so we take the leading 19.
 *
 * On a carousel the visible image can belong to a slide rather than the
 * post, giving a neighbouring id — inject.js keys the result on whatever
 * shortcode the response actually contains, so a wrong guess costs one
 * request and never mislabels audio.
 */
function mediaIdFromDom(article) {
  const images = article.querySelectorAll('img[src], source[srcset]');

  for (const el of images) {
    const url = el.getAttribute('src') || el.getAttribute('srcset') || '';
    const match = url.match(/ig_cache_key=([^&\s]+)/);
    if (!match) continue;

    try {
      const encoded = decodeURIComponent(match[1]).split('.')[0];
      const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
      const digits = window.atob(padded).match(/^[0-9]+/);
      if (digits) return digits[0].slice(0, 19);
    } catch (err) {
      // Not valid base64 — try the next image
    }
  }
  return null;
}

/** Read the post's shortcode out of its permalink */
function shortcodeOf(article) {
  for (const link of article.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href');
    if (!href) continue;
    const match = href.match(SHORTCODE_REGEX);
    if (match && match[2]) return match[2];
  }
  return null;
}

/** True when the element scrolls its own content (carousel viewport) */
function isScrollContainer(el) {
  const cs = window.getComputedStyle(el);
  return /(auto|scroll)/.test(cs.overflowX) || /(auto|scroll)/.test(cs.overflowY);
}

/**
 * Instagram's carousel is a horizontal scroll-snap container
 * (div[role="presentation"] with overflow-x:auto), not a <ul> track with
 * a transform. A position:absolute player placed inside it is positioned
 * against the container's CONTENT, so swiping to slide 2 carries it one
 * slide-width out of view — measured at x=426 on slide 1 vs x=-64 on
 * slide 2, a 490px slide exactly.
 *
 * Climb out to the nearest ancestor that does not scroll. <li>/<ul> are
 * still handled because older Instagram builds (and the post modal) use
 * a track of slides instead.
 */
function escapeCarouselViewport(el, article) {
  if (!el) return el;

  let node = el;

  // When the element sits inside a slide, start the climb at the slide
  // itself — otherwise the loop stops on the first plain <div> wrapper.
  const slide = el.closest && el.closest('li');
  if (slide && article.contains(slide)) node = slide;

  for (let hops = 0; hops < 8; hops++) {
    if (!node || node === article || !article.contains(node)) break;

    const tag = node.tagName;
    if (tag !== 'LI' && tag !== 'UL' && !isScrollContainer(node)) break;

    node = node.parentElement;
  }

  if (node && node !== article && article.contains(node)) return node;
  return el;
}

/** Absolute placement needs a positioned ancestor */
function ensureRelative(el) {
  if (window.getComputedStyle(el).position === 'static') {
    el.style.position = 'relative';
  }
}

/**
 * The post's own media, by area.
 *
 * Avatars, verified badges and emoji are all <img> too, so size is what
 * separates them: anything below roughly 200x200 is furniture, not the
 * photo. Returns null before layout has happened, which sends
 * findMediaContainer() to its older strategies.
 */
function largestMedia(article) {
  let best = null;
  let bestArea = 0;

  for (const el of article.querySelectorAll('img, video')) {
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return bestArea >= 40000 ? best : null;
}

/**
 * The box the media actually fills.
 *
 * Climbs from the image while each ancestor still hugs it, and stops at the
 * first one that is meaningfully larger. That larger box is the post body —
 * on a single photo in view mode it holds the picture, the caption and the
 * comments column, and anchoring there is what put the player outside the
 * photo. Geometry rather than role or class, so Instagram renaming things
 * does not break it.
 */
function mediaViewport(media, article) {
  const m = media.getBoundingClientRect();
  if (!m.width || !m.height) return null;

  let node = media.parentElement;
  let best = null;

  for (let hops = 0; node && node !== article && hops < 6; hops++) {
    const r = node.getBoundingClientRect();
    const hugs = r.width <= m.width * 1.15 && r.height <= m.height * 1.15;
    if (!hugs) break;

    best = node;
    node = node.parentElement;
  }
  return best;
}

function findMediaContainer(article) {
  // Strategy 1: the box the photo itself occupies. Tried first because it
  // is measured rather than guessed from markup that changes.
  const media = largestMedia(article);
  if (media) {
    const viewport = mediaViewport(media, article);
    if (viewport) return escapeCarouselViewport(viewport, article);
  }

  // Strategy 2: div[role="presentation"] (Instagram's media wrapper)
  const presentation = article.querySelector('div[role="presentation"]');
  if (presentation) return escapeCarouselViewport(presentation, article);

  // Strategy 3: Known Instagram class for media containers
  const aagv = article.querySelector('div._aagv');
  if (aagv) return escapeCarouselViewport(aagv, article);

  // Strategy 4: Container that holds an <img> or <video>
  const mediaEl = article.querySelector('img[src], video[src], video source[src]');
  if (mediaEl) {
    // Walk up to find a suitable container
    let parent = mediaEl.parentElement;
    let levels = 0;
    while (parent && parent !== article && levels < 4) {
      if (parent.tagName === 'DIV') {
        return escapeCarouselViewport(parent, article);
      }
      parent = parent.parentElement;
      levels++;
    }
  }

  // Strategy 5: First child div of reasonable size
  const firstDiv = article.querySelector('div > div');
  if (firstDiv) return escapeCarouselViewport(firstDiv, article);

  return null;
}

// ──────────────────────────────────────────────────────────
// 7. IntersectionObserver — auto-play/pause based on visibility
// ──────────────────────────────────────────────────────────
