/**
 * ============================================================
 * Instagram Photo Audio Enabler — Content Script (content.js)
 * ============================================================
 *
 * Runs in the content script isolated world. Responsibilities:
 * 1. Inject inject.js into the MAIN world at document_start
 * 2. Listen for IG_AUDIO_FOUND events from inject.js
 * 3. Attach floating audio players to matching <article> elements
 * 4. Use IntersectionObserver for auto-play/pause management
 * 5. MutationObserver for dynamic content (infinite scroll)
 * ============================================================
 */
(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────
  // 1. Inject inject.js into the MAIN world
  // ──────────────────────────────────────────────────────────
  const scriptEl = document.createElement('script');
  scriptEl.src = browser.runtime.getURL('inject.js');
  scriptEl.type = 'text/javascript';
  scriptEl.onload = function () {
    scriptEl.remove(); // Clean up after injection
  };
  (document.documentElement || document.head || document.body).appendChild(scriptEl);

  // ──────────────────────────────────────────────────────────
  // 2. Data Stores
  // ──────────────────────────────────────────────────────────

  /** Map<shortcode, { audioUrl, startTime, duration }> — stores discovered audio data */
  const audioDataMap = new Map();

  /** Map<HTMLElement, { audio: HTMLAudioElement, player: HTMLElement, shortcode: string }> */
  const activePlayers = new Map();

  /** The <article> element currently playing audio (only one at a time) */
  let currentlyPlaying = null;

  /**
   * Autoplay unlock flag.
   * Browsers block audio.play() until the user interacts with the page.
   * We track this and retry playback on the first user gesture.
   */
  let autoplayUnlocked = false;

  /** The article that was waiting for autoplay unlock (pending play) */
  let pendingAutoplayArticle = null;

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

  let debounceTimer = null;

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

  /** Regex to extract shortcode from Instagram post URLs */
  const SHORTCODE_REGEX = /\/(p|reel|reels)\/([A-Za-z0-9_-]+)/;

  function tryAttachPlayers() {
    if (audioDataMap.size === 0) return;

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

      // Skip if already has a player
      if (article.querySelector('.ig-audio-player-container')) continue;

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

  function removePlayerFromArticle(article) {
    const playerData = activePlayers.get(article);
    if (!playerData) return;

    // Stop audio
    playerData.audio.pause();
    playerData.audio.src = '';

    // Remove DOM element
    if (playerData.player && playerData.player.parentNode) {
      playerData.player.remove();
    }

    // Unobserve
    visibilityObserver.unobserve(article);

    // Clear state
    if (currentlyPlaying === article) {
      currentlyPlaying = null;
    }
    activePlayers.delete(article);
  }

  // ──────────────────────────────────────────────────────────
  // 6. injectPlayer() — create and inject the audio player UI
  // ──────────────────────────────────────────────────────────

  function injectPlayer(article, audioUrl, shortcode, startTime, duration) {
    try {
      // Prevent duplicate injection
      if (article.querySelector('.ig-audio-player-container')) return;
      if (activePlayers.has(article)) return;

      // ── Guard: skip if article contains a native video ──
      // Video posts have their own audio track — our player would
      // cause double/desync audio
      if (article.querySelector('video')) {
        console.log('[IG Audio Enabler] Skipping video article for:', shortcode);
        return;
      }

      // ── Segment boundaries (seconds) ──
      const segStart = (typeof startTime === 'number' && isFinite(startTime)) ? startTime : 0;
      const segDuration = (typeof duration === 'number' && isFinite(duration) && duration > 0) ? duration : 15;
      const segEnd = segStart + segDuration;

      // ── Create Audio Element ──
      // IMPORTANT: Do NOT set crossOrigin / crossorigin='anonymous'.
      // The Instagram CDN (fbcdn.net) serves audio fine via native <audio>
      // src, but adding CORS attributes forces the browser to send an
      // Origin header which the CDN rejects.
      const audio = new Audio();
      audio.src = audioUrl;
      audio.preload = 'metadata';
      audio.volume = 0.7;
      // Do NOT use audio.loop — we handle looping manually within segment bounds

      // Set initial playback position to segment start once metadata loads
      audio.addEventListener('loadedmetadata', () => {
        if (audio.currentTime < segStart || audio.currentTime >= segEnd) {
          audio.currentTime = segStart;
        }
      }, { once: true });

      // ── Create Player Container ──
      const container = document.createElement('div');
      container.className = 'ig-audio-player-container';
      container.setAttribute('data-shortcode', shortcode);

      // ── Play/Pause Button ──
      const playBtn = document.createElement('div');
      playBtn.className = 'ig-audio-btn';
      playBtn.textContent = '♫';
      playBtn.title = 'Play/Pause';

      playBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        // A direct user click always counts as a gesture → unlock autoplay
        autoplayUnlocked = true;
        pendingAutoplayArticle = null;

        if (audio.paused) {
          // Pause any other playing audio first
          pauseCurrentlyPlaying();
          // Ensure we start from segment start if outside bounds
          if (audio.currentTime < segStart || audio.currentTime >= segEnd) {
            audio.currentTime = segStart;
          }
          safePlay(audio, article);
        } else {
          audio.pause();
          if (currentlyPlaying === article) {
            currentlyPlaying = null;
          }
          updateButtonState(article, false);
        }
      });

      // ── Volume Slider ──
      const volumeSlider = document.createElement('input');
      volumeSlider.type = 'range';
      volumeSlider.className = 'ig-audio-volume';
      volumeSlider.min = '0';
      volumeSlider.max = '1';
      volumeSlider.step = '0.05';
      volumeSlider.value = '0.7';
      volumeSlider.title = 'Volume';

      volumeSlider.addEventListener('input', (e) => {
        e.stopPropagation();
        audio.volume = parseFloat(volumeSlider.value);
      });

      volumeSlider.addEventListener('click', (e) => e.stopPropagation());

      // ── Segment-bounded looping via timeupdate ──
      // When playback reaches the segment end, loop back to start
      audio.addEventListener('timeupdate', () => {
        if (audio.currentTime >= segEnd) {
          audio.currentTime = segStart;
        }
      });

      // ── Fallback: if the audio file ends before segEnd, restart ──
      audio.addEventListener('ended', () => {
        audio.currentTime = segStart;
        if (currentlyPlaying === article) {
          audio.play().catch(() => {});
        }
      });

      // ── Assemble Player (button + volume only) ──
      container.appendChild(playBtn);
      container.appendChild(volumeSlider);

      // Prevent clicks from propagating to Instagram's handlers
      container.addEventListener('click', (e) => e.stopPropagation());

      // ── Find the best injection target ──
      const mediaContainer = findMediaContainer(article);

      if (mediaContainer) {
        // Ensure relative positioning for absolute player placement
        const currentPosition = window.getComputedStyle(mediaContainer).position;
        if (currentPosition === 'static') {
          mediaContainer.style.position = 'relative';
        }
        mediaContainer.appendChild(container);
      } else {
        // Fallback: append directly to article
        article.style.position = 'relative';
        article.appendChild(container);
      }

      // ── Store reference (including segment info for safePlay resets) ──
      activePlayers.set(article, { audio, player: container, shortcode, segStart, segEnd });

      // ── Register with IntersectionObserver ──
      visibilityObserver.observe(article);

      console.log('[IG Audio Enabler] Player injected for:', shortcode,
        'segment=' + segStart.toFixed(2) + 's-' + segEnd.toFixed(2) + 's');
    } catch (err) {
      console.warn('[IG Audio Enabler] Error injecting player:', err);
    }
  }

  // ──────────────────────────────────────────────────────────
  // Helper: Find the media container inside an article
  // ──────────────────────────────────────────────────────────

  function findMediaContainer(article) {
    // Strategy 1: div[role="presentation"] (Instagram's media wrapper)
    const presentation = article.querySelector('div[role="presentation"]');
    if (presentation) return presentation;

    // Strategy 2: Known Instagram class for media containers
    const aagv = article.querySelector('div._aagv');
    if (aagv) return aagv;

    // Strategy 3: Container that holds an <img> or <video>
    const mediaEl = article.querySelector('img[src], video[src], video source[src]');
    if (mediaEl) {
      // Walk up to find a suitable container
      let parent = mediaEl.parentElement;
      let levels = 0;
      while (parent && parent !== article && levels < 4) {
        if (parent.tagName === 'DIV') {
          return parent;
        }
        parent = parent.parentElement;
        levels++;
      }
    }

    // Strategy 4: First child div of reasonable size
    const firstDiv = article.querySelector('div > div');
    if (firstDiv) return firstDiv;

    return null;
  }

  // ──────────────────────────────────────────────────────────
  // 7. IntersectionObserver — auto-play/pause based on visibility
  // ──────────────────────────────────────────────────────────

  const visibilityObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const article = entry.target;
        const playerData = activePlayers.get(article);
        if (!playerData) continue;

        const { audio, segStart, segEnd } = playerData;

        if (entry.intersectionRatio >= 0.6) {
          // Article is sufficiently visible — auto-play from segment start
          if (currentlyPlaying !== article) {
            pauseCurrentlyPlaying();
            // Ensure playback starts at segment position
            if (audio.currentTime < segStart || audio.currentTime >= segEnd) {
              audio.currentTime = segStart;
            }
            safePlay(audio, article);
          }
        } else if (entry.intersectionRatio < 0.3) {
          // Article scrolled mostly out of view — pause
          if (currentlyPlaying === article) {
            audio.pause();
            currentlyPlaying = null;
            updateButtonState(article, false);
          }
        }
      }
    },
    {
      threshold: [0, 0.3, 0.6, 0.7, 1.0],
    }
  );

  // ──────────────────────────────────────────────────────────
  // Helper: Pause the currently playing audio (if any)
  // ──────────────────────────────────────────────────────────

  function pauseCurrentlyPlaying() {
    if (!currentlyPlaying) return;

    const playerData = activePlayers.get(currentlyPlaying);
    if (playerData) {
      playerData.audio.pause();
      updateButtonState(currentlyPlaying, false);
    }
    currentlyPlaying = null;
  }

  // ──────────────────────────────────────────────────────────
  // 8. updateButtonState — update button icon and CSS class
  // ──────────────────────────────────────────────────────────

  function updateButtonState(article, isPlaying) {
    if (!article) return;

    const container = article.querySelector('.ig-audio-player-container');
    if (!container) return;

    const btn = container.querySelector('.ig-audio-btn');
    if (!btn) return;

    if (isPlaying) {
      btn.textContent = '⏸';
      btn.title = 'Pause';
      container.classList.add('is-playing');
    } else {
      btn.textContent = '▶';
      btn.title = 'Play';
      container.classList.remove('is-playing');
    }
  }

  // ──────────────────────────────────────────────────────────
  // Safe play helper with autoplay policy handling
  // ──────────────────────────────────────────────────────────

  /**
   * Attempts to play audio. If the browser rejects due to autoplay
   * policy (NotAllowedError), stores the article as pending so the
   * global click-to-unlock handler can retry.
   */
  function safePlay(audio, article) {
    currentlyPlaying = article;
    updateButtonState(article, true);

    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch((err) => {
        if (err.name === 'NotAllowedError') {
          // Autoplay blocked — queue for unlock on next user gesture
          console.log('[IG Audio Enabler] Autoplay blocked, waiting for user gesture...');
          pendingAutoplayArticle = article;
        } else {
          console.warn('[IG Audio Enabler] Play error:', err.message);
        }
      });
    }
  }

  // ──────────────────────────────────────────────────────────
  // Global click-to-unlock autoplay
  // ──────────────────────────────────────────────────────────
  // Browsers require a user gesture before allowing audio.play().
  // This listener catches the FIRST click/tap anywhere on the page
  // and retries playback for the pending article.
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

  console.log('[IG Audio Enabler] content.js loaded');
})();
