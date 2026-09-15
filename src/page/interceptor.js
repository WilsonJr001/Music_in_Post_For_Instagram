/**
 * Tapping the page's own requests
 *
 * Wraps fetch and XMLHttpRequest so responses Instagram requests for its
 * own purposes are read on the way past. Loaded last: the wrappers must not
 * be installed until everything they call exists.
 *
 * Runs in the PAGE world (manifest world: "MAIN"), not the extension
 * sandbox, so it can see Instagram's own fetch/XHR traffic. Files load
 * in manifest order and share one scope.
 */
'use strict';

// ──────────────────────────────────────────────────────────
// Utility: Check if a URL is an Instagram GraphQL endpoint
// ──────────────────────────────────────────────────────────
function isGraphQLEndpoint(url) {
  if (!url || typeof url !== 'string') return false;
  return (
    url.includes('/api/graphql') ||
    url.includes('/graphql/query') ||
    url.includes('/api/v1/feed') ||
    url.includes('/api/v1/media')
  );
}

// ============================================================
// MONKEY-PATCH: window.fetch
// ============================================================
const originalFetch = window.fetch;

window.fetch = function (...args) {
  const request = args[0];
  let url = '';

  if (typeof request === 'string') {
    url = request;
  } else if (request instanceof Request) {
    url = request.url;
  } else if (request && typeof request === 'object' && request.url) {
    url = request.url;
  }

  // Learn the app id the page uses; the info endpoint requires it
  if (request instanceof Request) rememberAppId(request.headers);
  if (args[1] && args[1].headers) rememberAppId(args[1].headers);

  const promise = originalFetch.apply(this, args);

  if (isGraphQLEndpoint(url)) {
    promise
      .then((response) => {
        // Clone the response so the original consumer can still read it
        const cloned = response.clone();
        cloned
          .text()
          .then((text) => {
            processResponseBody(text);
          })
          .catch(() => {
            // Ignore clone/read errors
          });
      })
      .catch(() => {
        // Ignore fetch errors — they'll be handled by the original caller
      });
  }

  return promise;
};

// ============================================================
// MONKEY-PATCH: XMLHttpRequest (fallback)
// ============================================================
const originalXHROpen = XMLHttpRequest.prototype.open;

const originalXHRSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (method, url, ...rest) {
  // Store the URL on the XHR instance for later inspection
  this._igAudioUrl = typeof url === 'string' ? url : '';
  return originalXHROpen.call(this, method, url, ...rest);
};

const originalXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;

XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
  if (!igAppId && typeof name === 'string' && name.toLowerCase() === 'x-ig-app-id') {
    igAppId = value;
  }
  return originalXHRSetHeader.call(this, name, value);
};

XMLHttpRequest.prototype.send = function (...args) {
  if (this._igAudioUrl && isGraphQLEndpoint(this._igAudioUrl)) {
    this.addEventListener('load', function () {
      try {
        if (this.readyState === 4 && this.status >= 200 && this.status < 300) {
          processResponseBody(this.responseText);
        }
      } catch (err) {
        // Silent fail
      }
    });
  }

  return originalXHRSend.apply(this, args);
};

console.log('[IG Audio Enabler] inject.js loaded — build 2026-09-15-feed-ondemand — monitoring API responses');
