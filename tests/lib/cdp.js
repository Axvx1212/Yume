// Headless Chrome over the DevTools protocol, with no npm dependencies.
//
// Every test in this suite drives a real browser at real device dimensions.
// That matters more than usual here: two shipped bugs (a tap overlay that made
// the reader unscrollable, and a 1px seam through webtoon artwork) were
// invisible to DOM assertions and only showed up under real input or real
// pixels.

import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** iPhone 14 Pro — the device Yume is actually used on. */
export const IPHONE = { width: 393, height: 852, deviceScaleFactor: 3, mobile: true };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextPort = 9400 + Math.floor(Math.random() * 200);

function getJSON(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/**
 * Launch headless Chrome and return a small driver.
 *
 * The driver collects console errors, page exceptions and failed requests as
 * they happen, so a test can assert on them after the fact.
 */
export async function launch({ device = IPHONE, trackNetwork = false, concurrencyFilter = null } = {}) {
  const port = nextPort++;
  const profile = `/tmp/yume-test-${port}`;

  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    '--hide-scrollbars',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const list = await getJSON(port, '/json/list');
      target = list.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
  }
  if (!target) {
    chrome.kill();
    throw new Error('Chrome did not start — is CHROME_PATH correct?');
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  let id = 0;
  const pending = new Map();
  const errors = [];
  const netFailures = [];
  const requests = [];       // {url, requestId} for image/network accounting
  const openRequests = new Set();
  let peakConcurrent = 0;

  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);

    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }

    switch (msg.method) {
      case 'Runtime.exceptionThrown':
        errors.push('EXCEPTION: '
          + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text));
        break;
      case 'Runtime.consoleAPICalled':
        if (msg.params.type === 'error') {
          errors.push('CONSOLE: ' + msg.params.args.map((a) => a.value || a.description || '').join(' '));
        }
        break;
      case 'Network.requestWillBeSent': {
        const url = msg.params.request.url;
        requests.push({ url, requestId: msg.params.requestId });
        // Only count what the caller asked about: measuring "concurrency"
        // across scripts, fonts and CSS says nothing about the image queue.
        if (trackNetwork && (!concurrencyFilter || concurrencyFilter(url))) {
          openRequests.add(msg.params.requestId);
          peakConcurrent = Math.max(peakConcurrent, openRequests.size);
        }
        break;
      }
      case 'Network.loadingFinished':
      case 'Network.loadingFailed':
        openRequests.delete(msg.params.requestId);
        if (msg.method === 'Network.loadingFailed'
            && !String(msg.params.errorText).includes('ERR_ABORTED')) {
          netFailures.push(msg.params.errorText);
        }
        break;
    }
  };

  const send = (method, params = {}) => {
    const msgId = ++id;
    ws.send(JSON.stringify({ id: msgId, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(msgId, { resolve, reject });
      setTimeout(() => {
        if (pending.has(msgId)) { pending.delete(msgId); reject(new Error(`${method} timed out`)); }
      }, 45000);
    });
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', device);
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  const driver = {
    port,
    errors,
    netFailures,
    requests,
    peakConcurrent: () => peakConcurrent,
    resetCounters() {
      errors.length = 0;
      netFailures.length = 0;
      requests.length = 0;
      openRequests.clear();
      peakConcurrent = 0;
    },

    send,

    /** Evaluate an expression in the page and return its value. */
    async eval(expression) {
      const r = await send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      });
      if (r?.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
      }
      return r?.result?.value;
    },

    /** Evaluate and JSON-parse — for expressions that build an object. */
    async json(expression) {
      return JSON.parse(await driver.eval(`JSON.stringify((() => { ${expression} })())`));
    },

    /**
     * Poll a page-side expression until it is truthy. Returns as soon as the
     * condition holds, so a step that is ready in 300ms costs 300ms instead of
     * whatever fixed timeout was guessed. Throws on timeout, which turns a
     * silent "we waited long enough, probably" into a real failure.
     */
    async waitFor(expression, { timeout = 20000, every = 200, label = expression } = {}) {
      const deadline = Date.now() + timeout;
      let consecutiveErrors = 0;
      for (;;) {
        let value;
        try {
          value = await driver.eval(expression);
          consecutiveErrors = 0;
        } catch (err) {
          // A failure mid-navigation is normal and worth retrying. A run of
          // them means the browser is gone — polling a dead connection would
          // otherwise hang until the harness timeout, which is what a swallowed
          // disconnect did once: 7 minutes of nothing with no Chrome alive.
          consecutiveErrors += 1;
          if (consecutiveErrors >= 10) {
            throw new Error(`browser stopped responding while waiting for: ${label}`);
          }
          value = null;
        }
        if (value) return value;
        if (Date.now() > deadline) {
          throw new Error(`waitFor timed out after ${timeout}ms: ${label}`);
        }
        await sleep(every);
      }
    },

    /**
     * Navigate with a real document load, then wait for the app to render
     * rather than for a fixed duration. Hash-only changes do NOT reload the
     * page, so a test that seeds localStorage first must come through here to
     * see it (this cost real debugging time — see CLAUDE.md).
     */
    async goto(url, ready = 'document.querySelector("#view")?.children.length > 0') {
      await send('Page.navigate', { url });
      if (typeof ready === 'number') { await sleep(ready); return; }   // legacy call sites
      await driver.waitFor(ready, { label: `render after ${url}` });
    },

    /** Seed prefs, then hard-load the target route so modules read them. */
    async gotoWithPrefs(base, hash, prefs, ready = null) {
      await driver.goto(`${base}/index.html#/library`);
      await driver.eval(
        `localStorage.setItem('yume.prefs.v1', ${JSON.stringify(JSON.stringify(prefs))})`,
      );
      await send('Page.reload', { ignoreCache: true });
      await driver.waitFor('document.querySelector("#view")?.children.length > 0',
        { label: 'reload' });
      await driver.eval(`location.hash=${JSON.stringify(hash)}`);

      if (typeof ready === 'number') { await sleep(ready); return; }
      // Default: a reader route is ready once its first page image decodes.
      const fallback = hash.includes('/reader/')
        ? '[...document.querySelectorAll(".page img, .paged-stage img")].some(i => i.naturalWidth > 0)'
        : 'document.querySelector("#view")?.children.length > 0';
      await driver.waitFor(ready || fallback, { timeout: 30000, label: `ready at ${hash}` });
    },

    /** A real finger swipe — not a scrollTop assignment, which skips hit-testing. */
    async swipe({ x = 200, y = 450, dx = 0, dy = -600, speed = 1500 } = {}) {
      await send('Input.synthesizeScrollGesture', {
        x, y, xDistance: dx, yDistance: dy, gestureSourceType: 'touch', speed,
      });
      await sleep(2200);
    },

    /** A real tap. */
    async tap(x, y, holdMs = 50) {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await sleep(holdMs);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(1200);
    },

    async screenshot(path) {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path, Buffer.from(s.data, 'base64'));
      return path;
    },

    close() {
      try { ws.close(); } catch { /* already gone */ }
      chrome.kill('SIGKILL');
      // Unref so a lingering child can't hold the event loop open — the test
      // sets process.exitCode and relies on a natural exit.
      try { chrome.unref(); } catch { /* already reaped */ }
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };

  return driver;
}
