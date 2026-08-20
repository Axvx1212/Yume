#!/usr/bin/env node
// Dev server for Yume.
//
// Serves the static app and reverse-proxies /api/* to Suwayomi, which is the
// same same-origin arrangement nginx provides in production (see nginx.conf).
// The browser therefore never makes a cross-origin request and CORS never
// enters the picture — in dev or in prod.
//
// The upstream address is not hard-coded: set SUWAYOMI in .env (see
// .env.example) or pass --upstream.
//
//   node dev-server.js [--port 8420] [--upstream http://host:4567]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SUWAYOMI, isPlaceholder } from './tools/config.js';

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

// 8420 by default — clear of the 8080/8000 range most self-hosted stacks use.
const PORT = Number(argOf('--port', process.env.PORT || 8420));
const HOST = argOf('--host', '0.0.0.0');           // LAN-visible, for the phone
const UPSTREAM = new URL(argOf('--upstream', process.env.UPSTREAM || SUWAYOMI));
const ROOT = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const stamp = () => new Date().toISOString().slice(11, 19);

/**
 * Log every proxied call with its GraphQL operation and timing. Without this,
 * a phone-side failure leaves no trace anywhere.
 */
function logProxy(req, res, opName, started) {
  const ms = Date.now() - started;
  const code = res.statusCode;
  const mark = code >= 400 ? '!!' : '  ';
  console.log(`${mark} ${stamp()}  ${String(code)}  ${ms}ms  ${req.method} ${req.url}${opName ? `  [${opName}]` : ''}`);
}

/** Pipe /api/* straight through to Suwayomi, preserving method, body, status. */
function proxy(req, res) {
  const target = new URL(req.url, UPSTREAM);
  const started = Date.now();

  const headers = { ...req.headers, host: UPSTREAM.host };
  delete headers['accept-encoding'];   // avoid re-encoding surprises on the way back

  const upstreamReq = http.request(
    {
      protocol: UPSTREAM.protocol,
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port,
      method: req.method,
      path: target.pathname + target.search,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);

      // GraphQL errors arrive as HTTP 200 with an `errors` array, so the status
      // code alone hides them — sniff the body for those.
      if (req.url.startsWith('/api/graphql')) {
        const chunks = [];
        upstreamRes.on('data', (c) => { chunks.push(c); res.write(c); });
        upstreamRes.on('end', () => {
          res.end();
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (body.errors?.length) {
              console.log(`!! ${stamp()}  GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`);
            }
          } catch { /* not JSON — nothing to report */ }
          logProxy(req, res, opName, started);
        });
      } else {
        upstreamRes.pipe(res);
        upstreamRes.on('end', () => logProxy(req, res, opName, started));
      }
    },
  );

  upstreamReq.on('error', (err) => {
    console.error(`!! ${stamp()}  PROXY FAIL  ${req.method} ${req.url} → ${err.message}`);
    if (!res.headersSent) {
      send(res, 502, JSON.stringify({ errors: [{ message: `Upstream unreachable: ${err.message}` }] }),
        { 'Content-Type': 'application/json' });
    } else {
      res.end();
    }
  });

  let opName = '';
  if (req.method === 'POST' && req.url.startsWith('/api/graphql')) {
    const seen = [];
    req.on('data', (c) => {
      if (seen.length < 4) seen.push(c);       // first chunks carry the operation
      upstreamReq.write(c);
    });
    req.on('end', () => {
      try {
        const q = JSON.parse(Buffer.concat(seen).toString('utf8')).query || '';
        opName = (q.match(/(?:query|mutation)\s+(\w+)/) || q.match(/\{\s*(\w+)/) || [])[1] || '';
      } catch { /* oversized or split body — the URL alone still identifies it */ }
      upstreamReq.end();
    });
  } else {
    req.pipe(upstreamReq);
  }
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);

  // Resolve inside ROOT only — no traversal out of the app directory.
  const rel = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) return send(res, 403, 'Forbidden');

  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');

  // Hash routing means every unknown path falls back to the shell.
  if (!fs.existsSync(file)) file = path.join(ROOT, 'index.html');

  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
}

const VERBOSE = args.includes('--verbose');

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return proxy(req, res);
  if (VERBOSE) console.log(`   ${stamp()}  static  ${req.method} ${req.url}`);
  return serveStatic(req, res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Try:  node dev-server.js --port ${PORT + 1}\n`);
    process.exit(1);
  }
  throw err;
});

if (isPlaceholder(UPSTREAM.origin)) {
  console.error(`\n  Suwayomi's address is not configured (${UPSTREAM.origin} is a placeholder).`);
  console.error('  Copy .env.example to .env and set SUWAYOMI, or pass --upstream.\n');
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const lan = Object.values(nets).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);

  console.log(`\n  Yume dev server`);
  console.log(`  ───────────────────────────────────────────`);
  console.log(`  Local:    http://localhost:${PORT}`);
  for (const ip of lan) console.log(`  Network:  http://${ip}:${PORT}`);
  console.log(`  Proxying  /api/*  →  ${UPSTREAM.origin}`);
  console.log(`  Logging   every /api call below (--verbose adds static files)`);
  console.log(`  ───────────────────────────────────────────\n`);
});
