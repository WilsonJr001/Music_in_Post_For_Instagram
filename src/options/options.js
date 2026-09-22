/**
 * Options page.
 *
 * One setting: whether the extension may ask Instagram about posts that
 * reach the screen. Without it the feed stays silent, because Instagram
 * sends photos with no audio metadata at all — see docs/ARCHITECTURE.md.
 */
'use strict';

const DEFAULTS = { discoveryEnabled: true };

function render(enabled) {
  const value = enabled ? 'active' : 'listener';
  for (const input of document.querySelectorAll('input[name="mode"]')) {
    input.checked = input.value === value;
  }
}

let savedTimer = null;
function flashSaved() {
  const el = document.getElementById('saved');
  el.hidden = false;
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { el.hidden = true; }, 1600);
}

browser.storage.local.get(DEFAULTS)
  .then((stored) => render(stored.discoveryEnabled !== false))
  .catch(() => render(true));

document.addEventListener('change', (e) => {
  if (!e.target.matches('input[name="mode"]')) return;

  browser.storage.local
    .set({ discoveryEnabled: e.target.value === 'active' })
    .then(flashSaved)
    .catch(() => {});
});
