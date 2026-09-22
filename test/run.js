/**
 * Test runner — plain Node, no dependencies, no build step.
 *
 *   node test/run.js
 *
 * Both suites load the real extension sources, concatenated in the order
 * manifest.json declares, so they exercise what Firefox actually runs.
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const SUITES = [
  ['content script, end to end', 'content.e2e.js'],
  ['page world, on-demand lookup', 'page.ondemand.js'],
  ['player anchoring', 'anchor.test.js'],
  ['request ordering', 'queue.test.js'],
];

let failed = 0;
for (const [title, file] of SUITES) {
  process.stdout.write(`\n=== ${title} (${file}) ===\n`);
  try {
    process.stdout.write(execFileSync(process.execPath, [path.join(__dirname, file)],
      { encoding: 'utf8' }));
  } catch (err) {
    failed++;
    process.stdout.write((err.stdout || '') + (err.stderr || ''));
  }
}

process.stdout.write(failed ? `\n${failed} suite(s) failed\n` : '\nall suites passed\n');
process.exit(failed ? 1 : 0);
