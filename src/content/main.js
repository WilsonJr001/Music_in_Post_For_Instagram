/**
 * Bootstrap
 *
 * Wires the modules together: listens for metadata from the page world,
 * watches the DOM for new posts, and keeps players attached.
 *
 * Part of the Instagram Photo Audio Enabler content script.
 * Loaded in the order declared in manifest.json; all content-script
 * files share one scope, so these names are visible across files.
 */
'use strict';

// ──────────────────────────────────────────────────────────
// 3. Listen for IG_AUDIO_FOUND events
// ──────────────────────────────────────────────────────────
document.addEventListener('IG_AUDIO_FOUND', function (e) {
  try {
    const { shortcode, audioUrl, startTime, duration } = e.detail || {};
    if (!shortcode || !audioUrl) return;

    if (audioDataMap.has(shortcode)) return; // Already known

    // Store full metadata including segment timing
    const st = (typeof startTime === 'number' && isFinite(startTime)) ? startTime : 0;
    const dur = (typeof duration === 'number' && isFinite(duration) && duration > 0) ? duration : 15;

    console.log('[IG Audio Enabler] Received audio data:', shortcode,
      'segment=' + st.toFixed(2) + 's-' + (st + dur).toFixed(2) + 's');
    audioDataMap.set(shortcode, { audioUrl, startTime: st, duration: dur });

    // Try to attach players to any existing articles
    tryAttachPlayers();
  } catch (err) {
    console.warn('[IG Audio Enabler] Error handling IG_AUDIO_FOUND:', err);
  }
});

// ──────────────────────────────────────────────────────────
// 4. MutationObserver for dynamic content (infinite scroll)
// ──────────────────────────────────────────────────────────

function debouncedTryAttach() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(tryAttachPlayers, 300);
}

function initMutationObserver() {
  if (!document.body) {
    // Body not ready yet — wait for it
    const bodyWaiter = setInterval(() => {
      if (document.body) {
        clearInterval(bodyWaiter);
        initMutationObserver();
      }
    }, 100);
    return;
  }

  const observer = new MutationObserver((mutations) => {
    let hasRelevantChange = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        hasRelevantChange = true;
        break;
      }
    }
    if (hasRelevantChange) {
      debouncedTryAttach();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

initMutationObserver();

// ──────────────────────────────────────────────────────────
// 5. tryAttachPlayers() — scan articles and attach players
// ──────────────────────────────────────────────────────────

/**
 * Instagram virtualizes the feed: <article> elements are dropped as you
 * scroll past them. Their entries stayed in activePlayers — still
 * observed, and sometimes still playing, which is how two tracks end up
 * overlapping. Drop anything no longer attached to the document.
 */
function sweepDetachedArticles() {
  for (const article of [...activePlayers.keys()]) {
    if (!article.isConnected) {
      removePlayerFromArticle(article);
    }
  }
}

/**
 * Last-resort guard for the failure above. If the player ends up outside
 * its own post horizontally, whatever we anchored it to is scrolling or
 * being transformed — move it one level up and try again. Instagram's
 * DOM changes often enough that this is worth having.
 */
function reanchorDriftedPlayers() {
  for (const [article, data] of activePlayers) {
    if (!article.isConnected || !data.player || !data.player.isConnected) continue;
    if (data.reanchorAttempts >= 3) continue;

    const p = data.player.getBoundingClientRect();
    if (p.width === 0) continue; // not laid out yet

    const a = article.getBoundingClientRect();
    const drifted = p.right < a.left || p.left > a.right;
    if (!drifted) continue;

    const parent = data.player.parentElement;
    const target = parent && parent.parentElement;
    if (!target || target === article || !article.contains(target)) continue;

    data.reanchorAttempts = (data.reanchorAttempts || 0) + 1;
    ensureRelative(target);
    target.appendChild(data.player);
    console.log('[IG Audio Enabler] Player drifted outside post, re-anchored:', data.shortcode);
  }
}

function tryAttachPlayers() {
  sweepDetachedArticles();
  reanchorDriftedPlayers();

  const articles = document.querySelectorAll('article');
  if (!articles.length) return;

  for (const article of articles) {
    // ── Skip video posts ──
    // If the article contains a native <video> element, the Instagram
    // player is already handling audio — do not inject our player
    if (article.querySelector('video')) {
      // Clean up any player that was injected before the video loaded
      removePlayerFromArticle(article);
      continue;
    }

    // Ask about this post once it is actually on screen. This runs even
    // with an empty audioDataMap — in the feed the map STARTS empty and
    // only fills because of these requests, so an early return here
    // (as the old code did) meant discovery could never begin.
    registerForDiscovery(article);

    // Skip if already has a player
    if (article.querySelector('.ig-audio-player-container')) continue;

    if (audioDataMap.size === 0) continue;

    // Find shortcode from links within this article
    const links = article.querySelectorAll('a[href]');
    let matchedShortcode = null;

    for (const link of links) {
      const href = link.getAttribute('href');
      if (!href) continue;

      const match = href.match(SHORTCODE_REGEX);
      if (match && match[2]) {
        const shortcode = match[2];
        if (audioDataMap.has(shortcode)) {
          matchedShortcode = shortcode;
          break;
        }
      }
    }

    if (!matchedShortcode) continue;

    const audioData = audioDataMap.get(matchedShortcode);
    if (audioData) {
      injectPlayer(article, audioData.audioUrl, matchedShortcode, audioData.startTime, audioData.duration);
    }
  }
}

// ──────────────────────────────────────────────────────────
// Helper: Remove a player from an article (cleanup)
// ──────────────────────────────────────────────────────────

function onFirstUserGesture() {
  if (autoplayUnlocked) return;
  autoplayUnlocked = true;

  console.log('[IG Audio Enabler] Autoplay unlocked by user gesture');

  // Retry pending playback
  if (pendingAutoplayArticle) {
    const playerData = activePlayers.get(pendingAutoplayArticle);
    if (playerData) {
      safePlay(playerData.audio, pendingAutoplayArticle);
    }
    pendingAutoplayArticle = null;
  }

  // Remove listeners — no longer needed
  document.removeEventListener('click', onFirstUserGesture, true);
  document.removeEventListener('touchstart', onFirstUserGesture, true);
  document.removeEventListener('keydown', onFirstUserGesture, true);
}

document.addEventListener('click', onFirstUserGesture, true);

document.addEventListener('touchstart', onFirstUserGesture, true);

document.addEventListener('keydown', onFirstUserGesture, true);

// ──────────────────────────────────────────────────────────
// Initial scan (in case content is already loaded)
// ──────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', tryAttachPlayers);
} else {
  tryAttachPlayers();
}

console.log('[IG Audio Enabler] content.js loaded — build 2026-09-15-feed-ondemand');
