// Touch behaviour in the reader.
//
// This suite exists because a full-bleed tap overlay once made the reader
// completely unscrollable on a phone, and every test at the time passed:
// they set scrollTop directly, which bypasses hit-testing entirely. Only
// synthesized touch gestures catch that class of bug, so everything here uses
// real input.

import { launch, sleep } from './lib/cdp.js';
import { BASE, suite, ok, eq, info, report, requireApp, gql } from './lib/harness.js';

await requireApp();

const { chapters } = await gql(`{ chapters(first: 1) { nodes { id } } }`);
const chapterId = chapters.nodes[0]?.id;

const driver = await launch();
const scrollTop = () => driver.eval(`document.querySelector('.reader-scroll').scrollTop`);

try {
  suite('Webtoon mode responds to real touch');

  await driver.gotoWithPrefs(BASE, `#/reader/${chapterId}`,
    { readerMode: 'webtoon', brightness: 100, gridCols: 3 }, 15000);

  const hit = await driver.eval(`document.elementFromPoint(196, 420)?.className || '(none)'`);
  ok(!hit.includes('tapzone') && !hit.includes('reader-tapzones'),
    'no overlay intercepts touches mid-screen', `topmost: ${hit || 'image'}`);

  const before = await scrollTop();
  await driver.swipe({ dy: -800 });
  const afterDown = await scrollTop();
  ok(afterDown > before, 'swipe up scrolls the page', `${before} → ${afterDown}`);

  await driver.swipe({ dy: 400 });
  const afterUp = await scrollTop();
  ok(afterUp < afterDown, 'swipe down scrolls back', `${afterDown} → ${afterUp}`);

  suite('Chrome toggles on tap, not on drag');

  const chromeOn = () => driver.eval(`!!document.querySelector('.chrome')`);
  const wasOn = await chromeOn();
  await driver.tap(196, 420);
  const nowOn = await chromeOn();
  ok(wasOn !== nowOn, 'a tap toggles the chrome', `${wasOn} → ${nowOn}`);

  const beforeDrag = await chromeOn();
  await driver.swipe({ dy: -300 });
  eq(await chromeOn(), beforeDrag, 'a drag leaves the chrome alone');

  suite('Paged mode tap zones');

  await driver.gotoWithPrefs(BASE, `#/reader/${chapterId}`,
    { readerMode: 'ltr', brightness: 100, gridCols: 3 }, 15000);

  ok(await driver.eval(`!!document.querySelector('.paged')`), 'paged mode activates from prefs');
  eq(await driver.eval(`getComputedStyle(document.querySelector('.reader-scroll')).display`),
    'none', 'the webtoon column is hidden in paged mode');

  const label = () => driver.eval(`document.querySelector('.seek-labels')?.innerText.split('\\n')[0]`);
  const p0 = await label();
  await driver.tap(350, 420);            // right third = forward in LTR
  const p1 = await label();
  ok(p0 !== p1, 'right tap advances a page', `${p0} → ${p1}`);

  await driver.tap(40, 420);             // left third = back
  eq(await label(), p0, 'left tap goes back a page');

  info('RTL', 'mirrors these handlers; the layout itself never flips');
} finally {
  driver.close();
}

// Setting exitCode (rather than calling process.exit) lets inherited stdio
// flush before the process ends — process.exit truncated output and produced
// a spurious non-zero status under the runner.
process.exitCode = report() ? 0 : 1;
