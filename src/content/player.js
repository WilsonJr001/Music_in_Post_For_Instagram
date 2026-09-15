/**
 * The player element
 *
 * Builds the floating control, keeps its visual state in sync, and tears
 * it down. Owns the two timed behaviours: the muted hint on arrival and the
 * idle retreat once playing.
 *
 * Part of the Instagram Photo Audio Enabler content script.
 * Loaded in the order declared in manifest.json; all content-script
 * files share one scope, so these names are visible across files.
 */
'use strict';

/**
 * Instagram's own volume glyphs, so the control reads as part of the page
 * rather than as something bolted on. Taken from the markup Instagram
 * renders for video posts; the two use different viewBoxes, which is why
 * each carries its own.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

const SOUND_ICONS = {
  on: {
    viewBox: '0 0 24 24',
    evenOdd: false,
    d: 'M16.636 7.028a1.5 1.5 0 10-2.395 1.807 5.365 5.365 0 011.103 3.17 5.378 '
     + '5.378 0 01-1.105 3.176 1.5 1.5 0 102.395 1.806 8.396 8.396 0 '
     + '001.71-4.981 8.39 8.39 0 00-1.708-4.978zm3.73-2.332A1.5 1.5 0 1018.04 '
     + '6.59 8.823 8.823 0 0120 12.007a8.798 8.798 0 01-1.96 5.415 1.5 1.5 0 '
     + '002.326 1.894 11.672 11.672 0 002.635-7.31 11.682 11.682 0 '
     + '00-2.635-7.31zm-8.963-3.613a1.001 1.001 0 00-1.082.187L5.265 6H2a1 1 0 '
     + '00-1 1v10.003a1 1 0 001 1h3.265l5.01 4.682.02.021a1 1 0 '
     + '001.704-.814L12.005 2a1 1 0 00-.602-.917z',
  },
  off: {
    viewBox: '0 0 48 48',
    evenOdd: true,
    d: 'M1.5 13.3c-.8 0-1.5.7-1.5 1.5v18.4c0 .8.7 1.5 1.5 1.5h8.7l12.9 12.9c.9.9 '
     + '2.5.3 2.5-1v-9.8c0-.4-.2-.8-.4-1.1l-22-22c-.3-.3-.7-.4-1.1-.4h-.6zm46.8 '
     + '31.4-5.5-5.5C44.9 36.6 48 31.4 48 24c0-11.4-7.2-17.4-7.2-17.4-.6-.6-1.6-.6-2.2 '
     + '0L37.2 8c-.6.6-.6 1.6 0 2.2 0 0 5.7 5 5.7 13.8 0 5.4-2.1 9.3-3.8 11.6L35.5 '
     + '32c1.1-1.7 2.3-4.4 2.3-8 0-6.8-4.1-10.3-4.1-10.3-.6-.6-1.6-.6-2.2 0l-1.4 '
     + '1.4c-.6.6-.6 1.6 0 2.2 0 0 2.6 2 2.6 6.7 0 1.8-.4 3.2-.9 4.3L25.5 '
     + '22V1.4c0-1.3-1.6-1.9-2.5-1L13.5 10 3.3-.3c-.6-.6-1.5-.6-2.1 0L-.2 '
     + '1.1c-.6.6-.6 1.5 0 2.1L4 7.6l26.8 26.8 13.9 13.9c.6.6 1.5.6 2.1 0l1.4-1.4c.7-.6.7-1.6.1-2.2z',
  },
};

/** Build a fresh icon element for the given sound state */
function buildSoundIcon(enabled) {
  const spec = enabled ? SOUND_ICONS.on : SOUND_ICONS.off;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', spec.viewBox);
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', spec.d);
  if (spec.evenOdd) {
    path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute('clip-rule', 'evenodd');
  }

  svg.appendChild(path);
  return svg;
}

/** Swap the button's glyph, and keep its label honest for screen readers */
function setButtonIcon(btn, enabled) {
  btn.replaceChildren(buildSoundIcon(enabled));
  btn.setAttribute('aria-label', enabled ? 'Silenciar' : 'Ativar som');
  btn.title = enabled ? 'Silenciar' : 'Ativar som';
}

/**
 * Flash the badge so a muted post still announces that it has a track.
 * Without this the only way to discover the audio is to happen to hover
 * the photo, since nothing plays and the player sits at opacity 0.
 * Shown once per post — a marker, not a nag.
 */
function showMutedHint(article) {
  if (soundEnabled) return;

  const data = activePlayers.get(article);
  if (!data || !data.player || data.hintShown) return;

  data.hintShown = true;
  data.player.classList.add('is-hinting');

  data.hintTimer = setTimeout(() => {
    if (data.player) data.player.classList.remove('is-hinting');
    data.hintTimer = null;
  }, HINT_DURATION_MS);
}

function clearHint(article) {
  const data = activePlayers.get(article);
  if (!data) return;

  if (data.hintTimer) {
    clearTimeout(data.hintTimer);
    data.hintTimer = null;
  }
  if (data.player) data.player.classList.remove('is-hinting');
}

/**
 * Start (or restart) the countdown to the idle retreat. The staging —
 * volume slider first, then the pill — lives in styles.css; here we only
 * decide when it begins. Hover is handled purely in CSS, so moving the
 * mouse over the post brings the player back without touching this.
 */
function scheduleIdle(article) {
  const data = activePlayers.get(article);
  if (!data || !data.player) return;

  if (data.idleTimer) clearTimeout(data.idleTimer);
  data.idleTimer = setTimeout(() => {
    if (data.player && data.player.isConnected) {
      data.player.classList.add('is-idle');
    }
  }, IDLE_AFTER_MS);
}

/** Bring the player back and restart the countdown */
function wakePlayer(article) {
  const data = activePlayers.get(article);
  if (!data || !data.player) return;

  data.player.classList.remove('is-idle');
  scheduleIdle(article);
}

function cancelIdle(article) {
  const data = activePlayers.get(article);
  if (!data) return;

  if (data.idleTimer) {
    clearTimeout(data.idleTimer);
    data.idleTimer = null;
  }
  if (data.player) data.player.classList.remove('is-idle');
}

function removePlayerFromArticle(article) {
  const playerData = activePlayers.get(article);
  if (!playerData) return;

  if (playerData.idleTimer) {
    clearTimeout(playerData.idleTimer);
    playerData.idleTimer = null;
  }

  if (playerData.hintTimer) {
    clearTimeout(playerData.hintTimer);
    playerData.hintTimer = null;
  }

  // Stop audio.
  // NOT audio.src = '': the empty string resolves against the document
  // URL, so the browser tried to load the Instagram page as a media file
  // ("URI inválida. Falha no carregamento do recurso de mídia") on every
  // teardown. removeAttribute + load() detaches the source cleanly.
  playerData.audio.pause();
  playerData.audio.removeAttribute('src');
  playerData.audio.load();

  if (playerData.objectUrl) {
    URL.revokeObjectURL(playerData.objectUrl);
    playerData.objectUrl = null;
  }

  // Remove DOM element
  if (playerData.player && playerData.player.parentNode) {
    playerData.player.remove();
  }

  // Unobserve whatever we actually registered (the media container)
  const observed = playerData.observeTarget || article;
  visibilityObserver.unobserve(observed);
  observedTargets.delete(observed);

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

    // Tracked already, but the player element is no longer in the DOM:
    // Instagram recycled the carousel slide it was living in. Re-anchor
    // the existing player (keeping its audio) instead of bailing out —
    // the old code returned here, leaving the post with no UI while the
    // audio kept running.
    const existing = activePlayers.get(article);
    if (existing) {
      if (existing.player && !existing.player.isConnected) {
        const target = findMediaContainer(article) || article;
        ensureRelative(target);
        target.appendChild(existing.player);
        console.log('[IG Audio Enabler] Re-anchored player for:', shortcode);
      }
      return;
    }

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
    audio.volume = globalVolume;   // see setGlobalVolume()
    audio.muted = !soundEnabled;   // see setSoundEnabled()
    // Do NOT use audio.loop — we handle looping manually within segment bounds

    // ── Firefox Opaque Response Blocking fallback ──
    // The CDN serves the track as an audio-only .mp4. A bare <audio src>
    // loads it no-cors, and Firefox's ORB sometimes refuses the response
    // ("A resource is blocked by OpaqueResponseBlocking") — the player
    // appears but stays silent. A fetch() from the content script runs
    // with the extension's host permissions, which ORB does not police,
    // so we retry once through a blob.
    let blobFallbackTried = false;

    audio.addEventListener('error', () => {
      if (blobFallbackTried) return;
      // No src means we are tearing the player down, not failing to load
      if (!audio.getAttribute('src')) return;
      if (!article.isConnected) return;
      blobFallbackTried = true;

      console.log('[IG Audio Enabler] Direct load failed, retrying via blob:', shortcode);

      fetch(audioUrl)
        .then((res) => (res.ok ? res.blob() : Promise.reject(new Error('HTTP ' + res.status))))
        .then((blob) => {
          const entry = activePlayers.get(article);
          if (!entry || entry.audio !== audio) return; // torn down meanwhile

          const objectUrl = URL.createObjectURL(blob);
          entry.objectUrl = objectUrl;
          audio.src = objectUrl;
          audio.load();

          console.log('[IG Audio Enabler] Blob fallback loaded for:', shortcode);
          if (currentlyPlaying === article) {
            safePlay(audio, article);
          }
        })
        .catch((err) => {
          console.warn('[IG Audio Enabler] Blob fallback failed for', shortcode, err.message);
        });
    });

    // Set initial playback position to segment start once metadata loads
    audio.addEventListener('loadedmetadata', () => {
      // Metadata from the API can put segStart past the end of the file;
      // seeking there fails and nothing ever plays.
      if (isFinite(audio.duration) && segStart >= audio.duration) {
        console.warn('[IG Audio Enabler] segStart beyond track length for', shortcode,
          segStart.toFixed(2) + 's >= ' + audio.duration.toFixed(2) + 's — starting at 0');
        audio.currentTime = 0;
        return;
      }
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
    setButtonIcon(playBtn, soundEnabled);

    // The button is a SOUND toggle, not play/pause: playback itself is
    // driven by which post you are looking at. Clicking is a user gesture,
    // which is exactly what the browser needs to allow unmuted audio.
    playBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      autoplayUnlocked = true;
      pendingAutoplayArticle = null;

      setSoundEnabled(!soundEnabled);

      // Let the new state be seen before the player retreats again
      wakePlayer(article);

      // Turning sound on for a post that is not playing yet: start it
      if (soundEnabled && audio.paused) {
        pauseCurrentlyPlaying();
        if (audio.currentTime < segStart || audio.currentTime >= segEnd) {
          audio.currentTime = segStart;
        }
        safePlay(audio, article);
      }
    });

    // ── Volume Slider ──
    const volumeSlider = document.createElement('input');
    volumeSlider.type = 'range';
    volumeSlider.className = 'ig-audio-volume';
    volumeSlider.min = '0';
    volumeSlider.max = '1';
    volumeSlider.step = '0.05';
    volumeSlider.value = String(globalVolume);
    volumeSlider.title = 'Volume';

    volumeSlider.addEventListener('input', (e) => {
      e.stopPropagation();
      setGlobalVolume(parseFloat(volumeSlider.value));
      wakePlayer(article);
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
      ensureRelative(mediaContainer);
      mediaContainer.appendChild(container);
    } else {
      // Fallback: append directly to article
      ensureRelative(article);
      article.appendChild(container);
    }

    // ── Store reference (including segment info for safePlay resets) ──
    activePlayers.set(article, {
      audio,
      player: container,
      shortcode,
      segStart,
      segEnd,
      objectUrl: null,
      reanchorAttempts: 0,
      idleTimer: null,
      visibility: 0,
      hintShown: false,
      hintTimer: null,
      observeTarget: mediaContainer || article,
    });

    // ── Register with IntersectionObserver ──
    // Observe the MEDIA, not the <article>. In the feed an article also
    // holds the header, action bar, caption and comments, so it is often
    // taller than the window — and intersectionRatio, being visible area
    // over TOTAL area, then has a ceiling below the 0.6 threshold and can
    // never fire. That is why playback only worked on the expanded post
    // page. The media box fits on screen, so its ratio is meaningful.
    const observeTarget = mediaContainer || article;
    observedTargets.set(observeTarget, article);
    visibilityObserver.observe(observeTarget);

    updateButtonState(article, false);
    showMutedHint(article);

    console.log('[IG Audio Enabler] Player injected for:', shortcode,
      'segment=' + segStart.toFixed(2) + 's-' + segEnd.toFixed(2) + 's');
  } catch (err) {
    console.warn('[IG Audio Enabler] Error injecting player:', err);
  }
}

// ──────────────────────────────────────────────────────────
// Helper: Find the media container inside an article
// ──────────────────────────────────────────────────────────

function updateButtonState(article, isPlaying) {
  if (!article) return;

  const container = article.querySelector('.ig-audio-player-container');
  if (!container) return;

  const btn = container.querySelector('.ig-audio-btn');
  if (!btn) return;

  setButtonIcon(btn, soundEnabled);

  // "Playing" here means this is the post the audio is following. The
  // badge stays visible so you can see that a track is attached and
  // whether it is muted — the same affordance every feed uses.
  container.classList.toggle('is-playing', !!isPlaying);
  container.classList.toggle('is-muted', !soundEnabled);
}

// ──────────────────────────────────────────────────────────
// Safe play helper with autoplay policy handling
// ──────────────────────────────────────────────────────────
