/**
 * Request ordering in the page world.
 *
 * Posts below the fold are queued ahead of time on the guess that scrolling
 * continues. The guess must never cost the post actually being looked at:
 * when one reaches the screen while still queued, it jumps the line.
 */
'use strict';

const fs = require('fs'), vm = require('vm');
const BUNDLE = require('./bundle.js');

const requested = [];
const listeners = {};
const sb = {
  console: { log() {}, warn() {} },
  document: {
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent: (e) => { (listeners[e.type] || []).forEach(fn => fn(e)); },
  },
  CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } },
  Request: class {}, XMLHttpRequest: function () {}, setTimeout,
};
sb.XMLHttpRequest.prototype = { open() {}, send() {}, setRequestHeader() {} };
sb.window = sb;
sb.window.fetch = (url) => {
  if (String(url).includes('/info/')) requested.push(String(url).match(/media\/(\d+)/)[1]);
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [] }),
    clone: () => ({ text: () => Promise.resolve('{}') }) });
};

vm.createContext(sb);
vm.runInContext(BUNDLE.page(), sb, { filename: 'page-bundle.js' });

const ask = (shortcode, mediaId, priority) =>
  sb.document.dispatchEvent(new sb.CustomEvent('IG_AUDIO_REQUEST',
    { detail: { shortcode, mediaId, priority } }));

// Three posts queued ahead, in the order they came into the band below.
ask('AAAAAAAAAAA', '1001', 'ahead');
ask('BBBBBBBBBBB', '1002', 'ahead');
ask('CCCCCCCCCCC', '1003', 'ahead');

// The user scrolls past B and lands on C while both are still waiting.
ask('CCCCCCCCCCC', '1003', 'now');

setTimeout(() => {
  console.log('ordem das requisicoes:', requested.join(' -> '));
  const ok = requested[0] === '1001' && requested[1] === '1003' && requested[2] === '1002';
  console.log('1001 ja estava em voo, 1003 passou na frente de 1002:',
    ok ? 'ok' : 'FALHOU');

  const unique = new Set(requested).size === requested.length;
  console.log('nenhuma midia pedida duas vezes:', unique ? 'ok' : 'FALHOU');
}, 1200);
