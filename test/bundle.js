// Builds exactly what Firefox loads, in manifest order.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

function world(w) {
  const cs = mf.content_scripts.find(c => (c.world || 'ISOLATED') === w);
  if (!cs) throw new Error('no content_scripts entry for world ' + w);
  return cs.js.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n');
}
module.exports = { page: () => world('MAIN'), content: () => world('ISOLATED'), files: (w) =>
  mf.content_scripts.find(c => (c.world || 'ISOLATED') === w).js };
