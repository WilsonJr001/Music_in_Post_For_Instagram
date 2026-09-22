/**
 * Where the player gets anchored.
 *
 * The bug this guards against: on a single photo in view mode the player
 * was rendering outside the picture, because the old first strategy took
 * the first div[role="presentation"] in the article, which there is a box
 * wrapping the photo AND the caption/comments column.
 */
// Note: no 'use strict' here on purpose. Under strict mode eval() puts its
// declarations in a scope that is discarded when the call returns, so the
// functions lifted out of the bundle below would not be visible.
const src = require('./bundle.js').content();

function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
}

// Minimal element: a name, a box, and optional overflow.
function el(name, tag, w, h, overflow) {
  const node = {
    name, tagName: tag.toUpperCase(), children: [], parentElement: null,
    _overflow: overflow || 'visible',
    getBoundingClientRect: () => ({ width: w, height: h }),
    appendChild(c) { c.parentElement = node; node.children.push(c); return c; },
    closest: () => null,
    querySelectorAll(sel) {
      const want = sel.split(',').map(s => s.trim().split(/[[ ]/)[0].toUpperCase());
      const out = [];
      (function walk(n) {
        for (const c of n.children) {
          if (want.includes(c.tagName)) out.push(c);
          walk(c);
        }
      })(node);
      return out;
    },
    querySelector(sel) { return node.querySelectorAll(sel)[0] || null; },
    contains(n) { let p = n; while (p) { if (p === node) return true; p = p.parentElement; } return false; },
  };
  return node;
}

const window = { getComputedStyle: (e) => ({ overflowX: e._overflow, overflowY: 'visible' }) };

eval(grab('largestMedia'));
eval(grab('mediaViewport'));
eval(grab('isScrollContainer'));
eval(grab('escapeCarouselViewport'));
eval(grab('ensureRelative'));
eval(grab('findMediaContainer'));

const chain = (...nodes) => { nodes.reduce((a, b) => (a.appendChild(b), b)); return nodes[0]; };
const check = (label, got, want) =>
  console.log(`${label.padEnd(44)} ${String(got).padEnd(14)} ${got === want ? 'ok' : 'FALHOU (esperado ' + want + ')'}`);

// 1. Single photo, view mode — the reported bug.
//    The post body is wider than the picture: photo on the left, comments right.
{
  const article = el('article', 'article', 900, 700);
  const body    = el('corpo-do-post', 'div', 900, 700);
  const hug     = el('caixa-da-foto', 'div', 500, 500);
  const img     = el('img', 'img', 500, 500);
  chain(article, body, hug, img);
  check('foto unica (modo view)', findMediaContainer(article).name, 'caixa-da-foto');
}

// 2. Carousel — must still land outside the horizontal scroller.
{
  const article  = el('article', 'article', 500, 700);
  const viewport = el('viewport', 'div', 500, 500);
  const scroller = el('scroller', 'div', 500, 500, 'auto');
  const img      = el('img', 'img', 500, 500);
  chain(article, viewport, scroller, img);
  const got = findMediaContainer(article);
  check('carrossel (scroll-snap)', got.name, 'viewport');
  check('  a ancora rola o conteudo?', isScrollContainer(got), false);
}

// 3. Avatars must not be mistaken for the post media.
{
  const article = el('article', 'article', 900, 700);
  const header  = el('cabecalho', 'div', 900, 60);
  const avatar  = el('avatar', 'img', 32, 32);
  const hug     = el('caixa-da-foto', 'div', 500, 500);
  const img     = el('img', 'img', 500, 500);
  article.appendChild(header); header.appendChild(avatar);
  article.appendChild(hug); hug.appendChild(img);
  check('avatar no cabecalho e ignorado', findMediaContainer(article).name, 'caixa-da-foto');
}

// 4. Before layout there are no boxes; the older strategies take over.
{
  const article = el('article', 'article', 0, 0);
  const wrap    = el('wrapper', 'div', 0, 0);
  const img     = el('img', 'img', 0, 0);
  chain(article, wrap, img);
  const got = findMediaContainer(article);
  check('sem layout ainda (fallback)', got && got.name, 'wrapper');
}
