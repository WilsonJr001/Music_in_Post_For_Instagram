// Loads the whole content-script bundle in a fake DOM and drives it.
const vm = require('vm');
const BUNDLE = require('./bundle.js');

function makeEl(tag, attrs = {}) {
  const el = {
    tagName: tag.toUpperCase(), children: [], parentElement: null,
    isConnected: true, style: {}, dataset: {}, _attrs: attrs, _cls: new Set(),
    classList: {
      add: (c) => el._cls.add(c), remove: (c) => el._cls.delete(c),
      contains: (c) => el._cls.has(c),
      toggle: (c, on) => (on ? el._cls.add(c) : el._cls.delete(c)),
    },
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    setAttribute: (n, v) => { attrs[n] = v; },
    appendChild: (c) => { c.parentElement = el; el.children.push(c); return c; },
    replaceChildren: (...kids) => { el.children = []; kids.forEach(k => {
      k.parentElement = el; el.children.push(k); }); },
    remove() { if (el.parentElement) el.parentElement.children =
      el.parentElement.children.filter(c => c !== el); el.isConnected = false; },
    _handlers: {},
    addEventListener(t, fn) { (el._handlers[t] = el._handlers[t] || []).push(fn); },
    fire(t, ev = {}) { (el._handlers[t] || []).forEach(fn => fn(
      Object.assign({ preventDefault() {}, stopPropagation() {} }, ev))); },
    closest: () => null,
    contains(n) { let p = n; while (p) { if (p === el) return true; p = p.parentElement; } return false; },
    querySelector: (sel) => el.querySelectorAll(sel)[0] || null,
    querySelectorAll: (sel) => {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          const cls = sel.startsWith('.') ? sel.slice(1) : null;
          if (cls ? c._cls.has(cls) : c.tagName === sel.split(/[\[ ]/)[0].toUpperCase()) out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    },
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 500, height: 500, top: 0,
                                    left: 0, right: 500, bottom: 500 }),
  };
  // className must feed classList, since the code sets both ways
  Object.defineProperty(el, 'className', {
    get: () => [...el._cls].join(' '),
    set: (v) => { el._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
  });
  return el;
}

const logs = [];
const observers = { visibility: null, discovery: null, mutation: null };
const listeners = {};
const store = {};

const body = makeEl('body');
const sandbox = {
  console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')) },
  setTimeout, clearTimeout, setInterval, clearInterval,
  document: {
    readyState: 'complete', body, documentElement: makeEl('html'),
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: () => {},
    dispatchEvent: (e) => { (listeners[e.type] || []).forEach(fn => fn(e)); return true; },
    createElement: (t) => makeEl(t),
    createElementNS: (ns, t) => makeEl(t),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
  },
  CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } },
  IntersectionObserver: class {
    constructor(cb) { this.cb = cb; this.targets = new Set();
      if (!observers.visibility) observers.visibility = this; else observers.discovery = this; }
    observe(t) { this.targets.add(t); } unobserve(t) { this.targets.delete(t); } disconnect() {}
  },
  MutationObserver: class { constructor(cb) { this.cb = cb; observers.mutation = this; } observe() {} },
  Audio: class {
    constructor() { this.paused = true; this.muted = false; this.volume = 1;
      this.currentTime = 0; this.duration = 200; this._l = {}; }
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
    removeAttribute() {} load() {} pause() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
  },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
};
sandbox.window = sandbox;
sandbox.window.innerHeight = 800;
sandbox.window.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
sandbox.window.getComputedStyle = () => ({ position: 'relative', overflowX: 'visible', overflowY: 'visible' });
sandbox.window.atob = (b) => Buffer.from(b, 'base64').toString('binary');
sandbox.window.fetch = () => Promise.resolve({ ok: true, blob: () => Promise.resolve({}) });

vm.createContext(sandbox);
const EPILOGUE = `
;globalThis.__t = { audioDataMap, activePlayers, soundEnabled, globalVolume,
  tryAttachPlayers, selectActivePost, setSoundEnabled, injectPlayer };
`;
vm.runInContext(BUNDLE.content() + EPILOGUE, sandbox, { filename: 'content-bundle.js' });

module.exports = { sandbox, logs, observers, listeners, store, makeEl, body };
