// Local configuration, read from .env at the project root.
//
// Host addresses are deliberately NOT hard-coded anywhere in the tracked
// source: this repo describes a self-hosted setup, and the next person's
// server is not on the same network. Real values live in .env (gitignored);
// .env.example documents them.
//
// Precedence: a real environment variable > .env > the placeholder default.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Parse a minimal KEY=value file. No expansion, no quotes handling beyond trimming. */
export function loadEnvFile(file = path.join(ROOT, '.env')) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;             // absent is fine — env vars or defaults take over
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const file = loadEnvFile();

/** Look up a setting: environment first, then .env, then the given fallback. */
export function setting(key, fallback) {
  return process.env[key] || file[key] || fallback;
}

// Placeholders, not addresses. If neither the environment nor .env supplies a
// value these will fail to resolve, which is the intended nudge to configure.
export const SUWAYOMI = setting('SUWAYOMI', 'http://suwayomi.local:4567');
export const YUME_BASE = setting('YUME_BASE', 'http://yume.local:8420');

/** True when the value is still an unconfigured placeholder. */
export const isPlaceholder = (url) => /\.local(:|$)/.test(url);
