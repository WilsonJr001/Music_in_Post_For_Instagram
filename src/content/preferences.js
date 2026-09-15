/**
 * Sound and volume preferences
 *
 * Both settings are global rather than per-post. Volume is remembered
 * across visits; the muted/unmuted state deliberately is not, so reopening
 * Instagram never starts playing on its own.
 *
 * Part of the Instagram Photo Audio Enabler content script.
 * Loaded in the order declared in manifest.json; all content-script
 * files share one scope, so these names are visible across files.
 */
'use strict';

// soundEnabled is deliberately NOT restored from storage. It is global
// across posts and survives in-app navigation (the content script keeps
// running), but every fresh page load starts muted — otherwise closing
// Instagram and reopening it lands you on a post already playing out
// loud, which is exactly the surprise this is meant to avoid. Volume is
// a level, not a trigger, so that one is remembered.
try {
  window.localStorage.removeItem('igAudioSoundEnabled'); // drop older builds' value

  const storedVolume = parseFloat(window.localStorage.getItem('igAudioVolume'));
  if (isFinite(storedVolume) && storedVolume >= 0 && storedVolume <= 1) {
    globalVolume = storedVolume;
  }
} catch (err) {
  // Private window or blocked storage — stay with the defaults
}

/** Volume is one setting for the whole session, not per post */
function setGlobalVolume(value) {
  const v = Math.min(1, Math.max(0, value));
  globalVolume = v;

  try {
    window.localStorage.setItem('igAudioVolume', String(v));
  } catch (err) {
    // Session-only when storage is unavailable
  }

  for (const [, data] of activePlayers) {
    data.audio.volume = v;
    applyVolumeToSlider(data.player && data.player.querySelector('.ig-audio-volume'), v);
  }
}

function setSoundEnabled(enabled) {
  soundEnabled = enabled; // page-lifetime only, on purpose — see above

  // Apply to every player at once, so the choice is not per-post
  for (const [article, data] of activePlayers) {
    data.audio.muted = !enabled;
  }

  if (!enabled) {
    // Nothing plays while muted — stop, do not just silence
    for (const [article, data] of activePlayers) {
      data.audio.pause();
      updateButtonState(article, false);
      cancelIdle(article);
    }
    currentlyPlaying = null;
  } else {
    // The marker has done its job — the player speaks for itself now
    for (const [article] of activePlayers) clearHint(article);

    // Hand the floor to whichever post is most on screen right now
    selectActivePost();
    for (const [article, data] of activePlayers) {
      updateButtonState(article, !data.audio.paused);
    }
  }

  console.log('[IG Audio Enabler] Sound', enabled ? 'ON' : 'OFF (muted)');
}

/**
 * Discovery mode lives in extension storage rather than localStorage: it is
 * set from the options page, which runs in a different context and has no
 * access to the page's storage.
 */
function loadDiscoveryPreference() {
  if (typeof browser === 'undefined' || !browser.storage) return;

  browser.storage.local.get({ discoveryEnabled: true }).then((stored) => {
    setDiscoveryEnabled(stored.discoveryEnabled !== false);
  }).catch(() => {
    // Storage unavailable — keep the default
  });

  // Apply a change from the options page without needing a reload
  if (browser.storage.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.discoveryEnabled) return;
      setDiscoveryEnabled(changes.discoveryEnabled.newValue !== false);
    });
  }
}

function setDiscoveryEnabled(enabled) {
  discoveryEnabled = enabled;

  // The page world enforces this too, so a stale content script cannot
  // leave requests going after the setting is turned off.
  let detail = { discoveryEnabled: enabled };
  try {
    if (typeof cloneInto === 'function') detail = cloneInto(detail, window);
  } catch (err) {
    detail = { discoveryEnabled: enabled };
  }
  document.dispatchEvent(new CustomEvent('IG_AUDIO_CONFIG', { detail }));

  console.log('[IG Audio Enabler] Discovery',
    enabled ? 'ON (asks about posts on screen)' : 'OFF (listens only)');
}

loadDiscoveryPreference();
