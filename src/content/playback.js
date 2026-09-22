/**
 * What plays, and when
 *
 * Visibility decides which post owns the audio, and only one ever does.
 * enforceSinglePlayback() is the hard guarantee behind that rule.
 *
 * Part of the Instagram Photo Audio Enabler content script.
 * Loaded in the order declared in manifest.json; all content-script
 * files share one scope, so these names are visible across files.
 */
'use strict';

const visibilityObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const article = observedTargets.get(entry.target);
      if (!article) continue;

      const playerData = activePlayers.get(article);
      if (!playerData) continue;

      const { audio, segStart, segEnd } = playerData;

      // Normalize against the window, not the element: a target taller
      // than the viewport can never reach a high intersectionRatio, so
      // the raw ratio alone would silently never cross the threshold.
      const viewportH = (entry.rootBounds && entry.rootBounds.height) || window.innerHeight;
      const targetH = entry.boundingClientRect.height || 1;
      const reference = Math.min(targetH, viewportH);
      const visible = entry.intersectionRect.height / reference;

      // Record it and decide once, after the whole batch. Acting inside
      // the loop meant the LAST entry won whenever two posts were both
      // visible, so the feed could flip between two tracks batch after
      // batch instead of settling on the one you are looking at.
      playerData.visibility = visible;

      // Attached before you scrolled to it? Announce it now instead.
      if (visible >= PLAY_THRESHOLD && !soundEnabled) {
        showMutedHint(article);
      }

      if (visible < 0.3) {
        // Article scrolled mostly out of view — pause
        if (currentlyPlaying === article) {
          audio.pause();
          currentlyPlaying = null;
          updateButtonState(article, false);
          cancelIdle(article);
        }
      }
    }

    selectActivePost();
  },
  {
    // Fine-grained steps: we derive our own viewport-normalized fraction
    // from the callback, so the observer has to fire often enough for
    // that number to cross 0.6/0.3 — a sparse threshold list could skip
    // straight past both, especially on tall media.
    threshold: Array.from({ length: 21 }, (_, i) => i / 20),
  }
);

// ──────────────────────────────────────────────────────────
// Exactly one post may sound at a time
// ──────────────────────────────────────────────────────────

/**
 * Pick the most visible eligible post and give it the floor. Ties and
 * near-ties settle on whichever is genuinely more on screen, so two
 * posts sharing the viewport cannot trade the audio back and forth.
 */
function selectActivePost() {
  // Muted means silent, everywhere: no post takes the floor until you
  // ask for sound. Unmuting calls back in here to start the right one.
  if (!soundEnabled) return;

  let best = null;
  let bestVisibility = 0;

  for (const [article, data] of activePlayers) {
    if (!article.isConnected) continue;

    const v = data.visibility || 0;
    if (v >= PLAY_THRESHOLD && v > bestVisibility) {
      best = article;
      bestVisibility = v;
    }
  }

  if (!best) return;

  if (currentlyPlaying === best) {
    // Already the right post — but still assert the rule. Something else
    // can have started playing meanwhile (an 'ended' handler, a blob
    // reload finishing, a re-anchored player), and the early return used
    // to let that second track run alongside this one.
    enforceSinglePlayback(best);
    return;
  }

  const data = activePlayers.get(best);
  if (!data) return;

  if (data.audio.currentTime < data.segStart || data.audio.currentTime >= data.segEnd) {
    data.audio.currentTime = data.segStart;
  }
  safePlay(data.audio, best);
}

/**
 * Belt and braces for the one-at-a-time rule: whatever the bookkeeping
 * says, silence every element except the one taking over. Two tracks
 * overlapping is the single worst failure this player can have, so it
 * is enforced against the actual <audio> state rather than trusting
 * currentlyPlaying to have stayed accurate.
 */
function enforceSinglePlayback(keep) {
  for (const [article, data] of activePlayers) {
    if (article === keep || !data.audio) continue;

    if (!data.audio.paused) {
      data.audio.pause();
      updateButtonState(article, false);
      cancelIdle(article);
    }
  }
}

// ──────────────────────────────────────────────────────────
// Helper: Pause the currently playing audio (if any)
// ──────────────────────────────────────────────────────────

function pauseCurrentlyPlaying() {
  if (!currentlyPlaying) return;

  const playerData = activePlayers.get(currentlyPlaying);
  if (playerData) {
    playerData.audio.pause();
    updateButtonState(currentlyPlaying, false);
    cancelIdle(currentlyPlaying);
  }
  currentlyPlaying = null;
}

// ──────────────────────────────────────────────────────────
// 8. updateButtonState — update button icon and CSS class
// ──────────────────────────────────────────────────────────

/**
 * Attempts to play audio. If the browser rejects due to autoplay
 * policy (NotAllowedError), stores the article as pending so the
 * global click-to-unlock handler can retry.
 */
function safePlay(audio, article) {
  enforceSinglePlayback(article);
  currentlyPlaying = article;
  updateButtonState(article, true);
  scheduleIdle(article);

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
