const { readdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

// Discover new frontend suites automatically; the live Bun backend has its
// separate entry point and must never be started twice by frontend checks.
const files = readdirSync(path.resolve('tests'))
  .filter((name) => name.endsWith('.test.cjs') && name !== 'login-live.test.cjs')
  .sort().map((name) => path.join('tests', name));
if (!files.length) throw new Error('No frontend test files found');
console.log(`Frontend test files (${files.length}): ${files.join(', ')}`);
const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
