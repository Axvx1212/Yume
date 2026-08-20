// Page prefetch — the queue that keeps pages ready without flooding the server.
//
// Page images run 234KB–1.1MB each, so concurrency is what a small server
// feels. The cap must hold even when the user scrolls violently or jumps
// chapters mid-download (detaching an <img> does NOT abort its request, and its
// load handler still fires — that once drove inFlight negative and silently
// doubled the cap).

import { launch, sleep } from './lib/cdp.js';
import { BASE, suite, ok, eq, atMost, atLeast, info, report, requireApp, gql } from './lib/harness.js';

await requireApp();

const { chapters } = await gql(`{ chapters(first: 1) { nodes { id } } }`);
const chapterId = chapters.nodes[0]?.id;

// Must match MAX_IN_FLIGHT / PREFETCH_AHEAD in js/views/reader.js.
const MAX_IN_FLIGHT = 3;
const PREFETCH_AHEAD = 5;

// Count ONLY page images — the queue's job is bounding those, not the shell's
// scripts and fonts.
const driver = await launch({
  trackNetwork: true,
  concurrencyFilter: (url) => url.includes('/page/'),
});
const pageRequests = () => driver.requests.filter((r) => r.url.includes('/page/')).length;

try {
  suite('Prefetch keeps pages ready');

  await driver.send('Network.setCacheDisabled', { cacheDisabled: true });
  await driver.gotoWithPrefs(BASE, `#/reader/${chapterId}`,
    { readerMode: 'webtoon', brightness: 100, gridCols: 3 }, 16000);

  atMost(driver.peakConcurrent(), MAX_IN_FLIGHT,
    'concurrency capped on open', `peak ${driver.peakConcurrent()}`);

  // Read straight through and check the buffer never runs dry.
  let stalls = 0;
  let aheadTotal = 0;
  let samples = 0;
  for (let i = 0; i < 10; i++) {
    await driver.eval(
      `(() => { const s = document.querySelector('.reader-scroll'); s.scrollTop += s.clientHeight * 0.9; })()`,
    );
    await sleep(1300);
    const s = await driver.json(`
      const hs = [...document.querySelectorAll('.page')];
      let cur = -1;
      hs.forEach((h, i) => {
        const r = h.getBoundingClientRect();
        if (r.top <= 426 && r.bottom >= 426) cur = i;
      });
      const img = hs[cur]?.querySelector('img');
      let ahead = 0;
      for (let i = cur + 1; i < hs.length; i++) {
        const g = hs[i]?.querySelector('img');
        if (g && g.naturalWidth > 0) ahead++; else break;
      }
      return { cur, decoded: img ? img.naturalWidth > 0 : null, ahead };
    `);
    if (s.cur >= 0) {
      samples += 1;
      aheadTotal += s.ahead;
      if (s.decoded === false) stalls += 1;
    }
  }

  eq(stalls, 0, 'no page was undecoded when reached', `${samples} samples`);
  atLeast(aheadTotal / Math.max(samples, 1), 2,
    'buffer stays ahead of the reader', `avg ${(aheadTotal / Math.max(samples, 1)).toFixed(1)} pages`);
  atMost(driver.peakConcurrent(), MAX_IN_FLIGHT,
    'concurrency cap held while reading', `peak ${driver.peakConcurrent()}`);

  suite('Cap survives abuse');

  driver.resetCounters();
  for (let i = 0; i < 15; i++) {
    await driver.eval(
      `(() => { const s = document.querySelector('.reader-scroll'); s.scrollTop += s.clientHeight * 2.5; })()`,
    );
    await sleep(150);
  }
  await sleep(6000);
  atMost(driver.peakConcurrent(), MAX_IN_FLIGHT,
    'rapid scrolling does not exceed the cap', `peak ${driver.peakConcurrent()}`);

  // Chapter switches mid-download are where inFlight went negative before.
  driver.resetCounters();
  for (let i = 0; i < 3; i++) {
    await driver.eval(
      `[...document.querySelectorAll('.chrome-bottom .btn')].find(b => b.textContent.includes('Next'))?.click()`,
    );
    await sleep(1200);
  }
  await sleep(9000);
  // A switch cancels the outgoing column's requests; cancellation is observed
  // a beat after the new ones start, so one frame of overlap is expected.
  atMost(driver.peakConcurrent(), MAX_IN_FLIGHT + 1,
    'mid-flight chapter switches stay near the cap', `peak ${driver.peakConcurrent()}`);

  info('window', `${MAX_IN_FLIGHT} in flight, ${PREFETCH_AHEAD} pages ahead`);
  info('total page requests', pageRequests());

  suite('Paged mode does not load the hidden column');

  driver.resetCounters();
  await driver.gotoWithPrefs(BASE, `#/reader/${chapterId}`,
    { readerMode: 'ltr', brightness: 100, gridCols: 3 }, 14000);
  const hidden = await driver.eval(
    `[...document.querySelectorAll('.reader-scroll .page img')].filter(i => i.getAttribute('src')).length`,
  );
  eq(hidden, 0, 'hidden webtoon column downloads nothing in paged mode');
} finally {
  driver.close();
}

// Setting exitCode (rather than calling process.exit) lets inherited stdio
// flush before the process ends — process.exit truncated output and produced
// a spurious non-zero status under the runner.
process.exitCode = report() ? 0 : 1;
