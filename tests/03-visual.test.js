// Visual correctness — a separate axis from behaviour.
//
// Two defects shipped past a full behavioural suite because nothing was broken
// by any assertion's definition:
//   1. a dead band at the bottom of the screen (status-bar meta), and
//   2. a 1px border that drew a hairline through webtoon artwork.
// Both were only found by decoding a screenshot and reading pixel rows. This
// suite does that automatically.

import { launch, sleep } from './lib/cdp.js';
import { decodePNG, rowColour, lastContentRow, darkestRowIn } from './lib/png.js';
import { BASE, suite, ok, eq, atMost, info, report, requireApp, gql } from './lib/harness.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

await requireApp();

const { chapters } = await gql(`{ chapters(first: 1) { nodes { id mangaId } } }`);
const chapterId = chapters.nodes[0]?.id;
const shot = (n) => join(tmpdir(), `yume-visual-${n}.png`);

const driver = await launch();
const DPR = 3;
const SCREEN_CSS = 852;
const HOME_INDICATOR = 34;      // iOS reserves this much at the bottom

try {
  suite('The shell reaches the bottom of the screen');

  // A percentage height chain, or status-bar-style: black-translucent, leaves
  // dead space below the tab bar that no DOM assertion notices.
  await driver.goto(`${BASE}/index.html#/library`, 8000);

  const layout = await driver.json(`
    const vh = window.innerHeight;
    const app = document.querySelector('.app')?.getBoundingClientRect();
    const bar = document.getElementById('tabbar');
    const t = (bar && !bar.hidden) ? bar.getBoundingClientRect() : null;
    return {
      innerHeight: vh,
      appGap: app ? Math.round(vh - app.bottom) : null,
      tabGap: t ? Math.round(vh - t.bottom) : null,
    };
  `);
  eq(layout.appGap, 0, 'app shell ends exactly at the viewport bottom');
  eq(layout.tabGap, 0, 'tab bar ends exactly at the viewport bottom');

  await driver.screenshot(shot('library'));
  const lib = decodePNG(shot('library'));
  const last = lastContentRow(lib);
  const deadCss = (lib.height - 1 - last) / DPR;
  atMost(deadCss, HOME_INDICATOR + 6,
    'no dead band under the tab bar', `${deadCss.toFixed(0)}px empty (inset is ${HOME_INDICATOR})`);

  suite('Reader ground runs to the edge');

  await driver.gotoWithPrefs(BASE, `#/reader/${chapterId}`,
    { readerMode: 'webtoon', brightness: 100, gridCols: 3 }, 16000);
  await driver.screenshot(shot('reader'));
  const rd = decodePNG(shot('reader'));
  const bottom = rowColour(rd, rd.height - 4);
  // #0b0c14 = (11,12,20); the app ground #161826 = (22,24,38) would mean the
  // shell ended early and the page showed through.
  ok(bottom[0] < 18 && bottom[2] < 30,
    'bottom row is the reader ground, not app background', `rgb(${bottom})`);

  suite('Webtoon pages join seamlessly');

  // Find a boundary where both sides are near-white — a seam is unmistakable
  // there, and invisible to the eye at full webtoon scale.
  const boundary = await driver.json(`
    const holders = [...document.querySelectorAll('.page')]
      .filter(h => { const i = h.querySelector('img'); return i && i.naturalWidth > 0; });
    const sc = document.querySelector('.reader-scroll');
    const canvas = document.createElement('canvas');
    canvas.width = 8; canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);

    for (let k = 0; k < holders.length - 1; k++) {
      const A = holders[k].querySelector('img');
      const B = holders[k + 1].querySelector('img');
      ctx.clearRect(0, 0, 8, 1);
      ctx.drawImage(A, 0, A.naturalHeight - 1, A.naturalWidth, 1, 0, 0, 8, 1);
      const aEnd = avg([...ctx.getImageData(0, 0, 8, 1).data].filter((_, i) => i % 4 < 3));
      ctx.clearRect(0, 0, 8, 1);
      ctx.drawImage(B, 0, 0, B.naturalWidth, 1, 0, 0, 8, 1);
      const bStart = avg([...ctx.getImageData(0, 0, 8, 1).data].filter((_, i) => i % 4 < 3));
      const gap = B.getBoundingClientRect().top - A.getBoundingClientRect().bottom;
      if (aEnd > 200 && bStart > 200) {
        return { found: true, k, aEnd, bStart, gap: +gap.toFixed(3),
                 docY: sc.scrollTop + A.getBoundingClientRect().bottom };
      }
    }
    return { found: false };
  `);

  if (!boundary.found) {
    info('skipped', 'no white/white page boundary in the loaded pages');
  } else {
    eq(boundary.gap, 0, 'stacked page images have no layout gap');

    // Park the boundary mid-screen, drop the chrome, and read the pixels.
    await driver.eval(
      `(() => { document.querySelector('.reader-scroll').scrollTop = ${boundary.docY} - ${SCREEN_CSS / 2}; })()`,
    );
    await sleep(2500);
    await driver.eval(`document.querySelector('.chrome')?.remove()`);
    await sleep(500);
    await driver.screenshot(shot('seam'));

    const img = decodePNG(shot('seam'));
    const mid = Math.round((SCREEN_CSS / 2) * DPR);
    const darkest = darkestRowIn(img, mid - 9, mid + 9);
    ok(darkest.sum >= 735,
      'no seam line between pages',
      `darkest row in the join: rgb(${darkest.colour})`);
  }
} finally {
  driver.close();
}

// Setting exitCode (rather than calling process.exit) lets inherited stdio
// flush before the process ends — process.exit truncated output and produced
// a spurious non-zero status under the runner.
process.exitCode = report() ? 0 : 1;
