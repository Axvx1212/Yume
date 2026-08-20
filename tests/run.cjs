#!/usr/bin/env node
// Test runner.
//
//   node tests/run.js                    # everything, against the deployment
//   node tests/run.js visual touch       # only matching files
//   YUME_BASE=http://localhost:8420 node tests/run.js
//
// Each test file is a separate process, so one crash can't take the suite with
// it, and a leaked Chrome instance dies with its parent.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const dir = __dirname;
const filter = process.argv.slice(2);

const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => !filter.length || filter.some((k) => f.includes(k)))
  .sort();

if (!files.length) {
  console.error(filter.length ? `No test files match: ${filter.join(', ')}` : 'No test files found.');
  process.exit(2);
}

// Same precedence as tools/config.js, without importing ESM from CJS.
function envFile() {
  try {
    return Object.fromEntries(
      fs.readFileSync(path.join(dir, '..', '.env'), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    );
  } catch { return {}; }
}
const base = process.env.YUME_BASE || envFile().YUME_BASE || 'http://yume.local:8420';
console.log(`\n\x1b[1mYume test suite\x1b[0m`);
console.log(`target: ${base}`);
console.log(`files:  ${files.length}\n${'═'.repeat(58)}`);

(async () => {
  const results = [];
  const started = Date.now();

  for (const file of files) {
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(dir, file)], {
        stdio: 'inherit',
        env: process.env,
      });
      child.on('exit', (c) => resolve(c ?? 1));
      child.on('error', () => resolve(1));
    });
    results.push({ file, code });
  }

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\n${'═'.repeat(58)}`);
  console.log('\x1b[1mSummary\x1b[0m');
  for (const { file, code } of results) {
    const mark = code === 0 ? '\x1b[32m✓ pass\x1b[0m' : (code === 2 ? '\x1b[33m- skip\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m');
    console.log(`  ${mark}  ${file}`);
  }

  const failed = results.filter((r) => r.code === 1);
  console.log(`\n${failed.length ? `\x1b[31m${failed.length} file(s) failed\x1b[0m` : '\x1b[32mall green\x1b[0m'} in ${secs}s\n`);
  process.exit(failed.length ? 1 : 0);
})();
