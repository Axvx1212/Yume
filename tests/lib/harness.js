// Tiny test harness — assertions, reporting, and a GraphQL helper that can
// revert what a test changed.
//
// IMPORTANT: these tests run against the real Suwayomi server holding a real
// library. Anything that mutates state (marking read, adding to library,
// installing extensions) must revert itself. `withRevert` exists for that.

import http from 'node:http';
import { YUME_BASE, SUWAYOMI } from '../../tools/config.js';

export const BASE = YUME_BASE;
export const UPSTREAM = SUWAYOMI;

let passed = 0;
let failed = 0;
const failures = [];
let currentSuite = '';

export function suite(name) {
  currentSuite = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

export function ok(condition, label, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  } else {
    failed += 1;
    failures.push(`${currentSuite} → ${label}${detail ? `  (${detail})` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `  \x1b[31m${detail}\x1b[0m` : ''}`);
  }
  return condition;
}

export const eq = (actual, expected, label) =>
  ok(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

export const atMost = (actual, limit, label) =>
  ok(actual <= limit, label, `${actual} (limit ${limit})`);

export const atLeast = (actual, floor, label) =>
  ok(actual >= floor, label, `${actual} (min ${floor})`);

export function info(label, value) {
  console.log(`  \x1b[2m·\x1b[0m ${label}: \x1b[2m${value}\x1b[0m`);
}

export function report() {
  console.log(`\n${'─'.repeat(58)}`);
  if (failed === 0) {
    console.log(`\x1b[32m${passed} passed\x1b[0m, 0 failed`);
  } else {
    console.log(`\x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
    for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  }
  return failed === 0;
}

/** POST a GraphQL document straight to Suwayomi (bypassing the app). */
export function gql(query, variables = {}) {
  const url = new URL('/api/graphql', UPSTREAM);
  const body = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(out);
          if (parsed.errors?.length) reject(new Error(parsed.errors[0].message));
          else resolve(parsed.data);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Run a body that mutates server state, then restore it no matter what — so a
 * failing test can't leave the user's library dirty.
 */
export async function withRevert(capture, restore, body) {
  const before = await capture();
  try {
    return await body(before);
  } finally {
    await restore(before);
  }
}

/** Is the app reachable? Every test needs this before it means anything. */
export async function requireApp() {
  const res = await fetch(`${BASE}/manifest.json`).catch(() => null);
  if (!res?.ok) {
    console.error(`\n\x1b[31mCannot reach ${BASE}\x1b[0m`);
    console.error('Set YUME_BASE in .env (copy .env.example), or start the dev server.\n');
    process.exit(2);
  }
}
