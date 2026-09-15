const fs = require('fs'), vm = require('vm');
const BUNDLE = require('./bundle.js');

// Exactly the shape the HAR shows for a feed photo: no clips_metadata,
// has_audio null. Nothing that says "this post has music".
const feed = { data: { xdt_api__v1__feed__timeline__connection: { edges: [ { node: { media: {
  code: 'Dcja237lhkA', pk: '3986336339657397746',
  id: '3986336339657397746_51874599502',
  media_type: 1, has_audio: null, clips_metadata: null,
  image_versions2: { candidates: [{ url: 'https://cdn/photo.jpg' }] },
} } } ] } } };

const info = { items: [ { code: 'Dcja237lhkA', pk: '3986336339657397746', media_type: 1,
  clips_metadata: { music_info: {
    music_asset_info: { progressive_download_url: 'https://cdn/REAL.m4a', duration_in_ms: 208000 },
    music_consumption_info: { audio_asset_start_time_in_ms: 29000, overlap_duration_in_ms: 30000 } } } } ] };

const listeners = {}, dispatched = [], logs = [], requested = [];
const sb = {
  console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')) },
  document: {
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent: (e) => {
      if (e.type === 'IG_AUDIO_FOUND') dispatched.push(e.detail);
      (listeners[e.type] || []).forEach(fn => fn(e));
    },
  },
  CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i.detail; } },
  Request: class {}, XMLHttpRequest: function () {}, setTimeout,
};
sb.XMLHttpRequest.prototype = { open() {}, send() {}, setRequestHeader() {} };
sb.window = sb;
sb.window.fetch = (url, opts) => {
  requested.push(url);
  const body = String(url).includes('/info/') ? info : feed;
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body),
    clone: () => ({ text: () => Promise.resolve(JSON.stringify(body)) }) });
};

vm.createContext(sb);
vm.runInContext(BUNDLE.page(), sb);

// 1) page loads the feed
sb.window.fetch('https://www.instagram.com/graphql/query', { headers: { 'X-IG-App-ID': '936619743392459' } });

setTimeout(() => {
  console.log('apos o feed -> despachado:', dispatched.length, '| requisicoes /info/:',
              requested.filter(u => String(u).includes('/info/')).length);

  // 2) content.js says the post is on screen
  // Listener-only mode: the same request must produce nothing at all
  sb.document.dispatchEvent(new sb.CustomEvent('IG_AUDIO_CONFIG',
    { detail: { discoveryEnabled: false } }));
  sb.document.dispatchEvent(new sb.CustomEvent('IG_AUDIO_REQUEST',
    { detail: { shortcode: 'Dcja237lhkA' } }));

  setTimeout(() => {
    const quiet = requested.filter(u => String(u).includes('/info/')).length;
    console.log('modo so-ouvinte -> requisicoes /info/:', quiet,
                quiet === 0 ? '(correto)' : '(ERRO: deveria ser 0)');

    // Back to the normal mode for the rest of the check
    sb.document.dispatchEvent(new sb.CustomEvent('IG_AUDIO_CONFIG',
      { detail: { discoveryEnabled: true } }));
    sb.document.dispatchEvent(new sb.CustomEvent('IG_AUDIO_REQUEST',
      { detail: { shortcode: 'Dcja237lhkA' } }));
  }, 80);

  setTimeout(() => {
    console.log('\napos o post entrar na tela:');
    requested.filter(u => String(u).includes('/info/')).forEach(u => console.log('   ->', u));
    logs.filter(l => l.includes('IG Audio') && !l.includes('loaded')).forEach(l =>
      console.log('   ' + l.replace(/https:\/\/\S+/, '<url>')));
    console.log('\ndespachado:', JSON.stringify(dispatched));
  }, 400);
}, 150);
