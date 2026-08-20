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
const argv = process.argv.slice(2);

// --jobs N runs N test files at once. Tests are I/O-bound (waiting on the
// network and on Chrome), so parallelism helps far more than the core count
// suggests. Default 3: each job is a full Chrome instance plus a share of the
// load on a home server, and going wider mostly queues on the server.
const jobsArg = argv.findIndex((a) => a === '--jobs' || a === '-j');
const JOBS = jobsArg >= 0 ? Math.max(1, Number(argv[jobsArg + 1]) || 1) : 3;
const filter = argv.filter((a, i) => !a.startsWith('-') && i !== jobsArg + 1);

// Files that mutate server state and restore it afterwards cannot run beside
// anything that also writes — a concurrent reader would land progress writes
// inside their snapshot/restore window. These run alone, after the rest.
const EXCLUSIVE = /05-writes/;

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
console.log(`files:  ${files.length}   jobs: ${JOBS}\n${'═'.repeat(58)}`);

/**
 * Run one file. In parallel mode its output is buffered and printed whole, so
 * concurrent suites don't interleave into unreadable noise.
 */
function runFile(file, { buffered }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, file)], {
      stdio: buffered ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: process.env,
    });
    let out = '';
    if (buffered) {
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
    }
    child.on('exit', (c) => resolve({ file, code: c ?? 1, out }));
    child.on('error', () => resolve({ file, code: 1, out }));
  });
}

/** Run a list with at most `limit` in flight. */
async function runPool(list, limit, buffered) {
  const results = [];
  const queue = [...list];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      const r = await runFile(file, { buffered });
      if (buffered && r.out) process.stdout.write(r.out);
      results.push(r);
    }
  });
  await Promise.all(workers);
  return results;
}

(async () => {
  const started = Date.now();
  const parallel = files.filter((f) => !EXCLUSIVE.test(f));
  const exclusive = files.filter((f) => EXCLUSIVE.test(f));

  const results = await runPool(parallel, JOBS, JOBS > 1);
  // State-mutating suites run alone, once nothing else is touching the server.
  for (const file of exclusive) {
    results.push(await runFile(file, { buffered: false }));
  }
  results.sort((a, b) => files.indexOf(a.file) - files.indexOf(b.file));

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
