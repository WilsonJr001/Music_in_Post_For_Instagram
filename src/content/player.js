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
    playBtn.textContent = soundEnabled ? '🔊' : '🔇';
    playBtn.title = soundEnabled ? 'Silenciar' : 'Ativar som';

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

  btn.textContent = soundEnabled ? '🔊' : '🔇';
  btn.title = soundEnabled ? 'Silenciar' : 'Ativar som';

  // "Playing" here means this is the post the audio is following. The
  // badge stays visible so you can see that a track is attached and
  // whether it is muted — the same affordance every feed uses.
  container.classList.toggle('is-playing', !!isPlaying);
  container.classList.toggle('is-muted', !soundEnabled);
}

// ──────────────────────────────────────────────────────────
// Safe play helper with autoplay policy handling
// ──────────────────────────────────────────────────────────
