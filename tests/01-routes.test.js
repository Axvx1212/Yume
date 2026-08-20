// Every route renders against the live server with no console errors, and the
// data-bearing screens actually show data.

import { launch, sleep } from './lib/cdp.js';
import { BASE, suite, ok, eq, atLeast, info, report, requireApp, gql } from './lib/harness.js';

await requireApp();

// Pick a real manga and chapter from the server rather than hard-coding ids.
const { mangas } = await gql(`{ mangas(first: 1) { nodes { id } } }`);
const mangaId = mangas.nodes[0]?.id;
const { chapters } = await gql(
  `query C($id: Int!) { chapters(condition: {mangaId: $id}, first: 1) { nodes { id } } }`,
  { id: mangaId },
);
const chapterId = chapters.nodes[0]?.id;

const driver = await launch();

try {
  suite('Routes render without errors');

  const routes = [
    ['#/library', {}],
    ['#/browse', {}],
    ['#/more', {}],
    [`#/manga/${mangaId}`, { chapters: 1 }],
    [`#/reader/${chapterId}`, { pages: 1 }],
  ];

  for (const [hash, expect] of routes) {
    driver.resetCounters();
    await driver.goto(`${BASE}/index.html${hash}`, hash.includes('reader') ? 14000 : 6000);

    const state = await driver.json(`
      const view = document.getElementById('view');
      return {
        nodes: view?.querySelectorAll('*').length || 0,
        tiles: document.querySelectorAll('.tile').length,
        chapters: document.querySelectorAll('.chapter').length,
        pages: document.querySelectorAll('.page').length,
        text: (view?.innerText || '').slice(0, 60),
      };
    `);

    ok(driver.errors.length === 0, `${hash} — no console errors`, driver.errors[0] || '');
    ok(state.nodes > 5, `${hash} — rendered content`, `${state.nodes} nodes`);
    if (expect.chapters) atLeast(state.chapters, 1, `${hash} — chapter list populated`);
    if (expect.pages) atLeast(state.pages, 1, `${hash} — reader built its column`);
  }

  suite('Navigation unwinds correctly');

  // Reader back must not push a duplicate detail entry (it did once, which made
  // Back from the detail screen look like the manga reopening).
  await driver.goto(`${BASE}/index.html#/manga/${mangaId}`, 12000);
  await driver.eval(`document.querySelector('.dock .btn')?.click()`);
  await sleep(12000);
  const atReader = await driver.eval(`location.hash`);
  ok(atReader.startsWith('#/reader/'), 'resume button opens the reader', atReader);

  await driver.eval(`document.querySelector('.chrome-top .icon-btn')?.click()`);
  await sleep(4000);
  const backOnce = await driver.eval(`location.hash`);
  eq(backOnce, `#/manga/${mangaId}`, 'reader back returns to the detail screen');

  info('tab switches replace history', 'so Back never walks a trail of tab taps');
  await driver.goto(`${BASE}/index.html#/library`, 4000);
  for (const tab of ['browse', 'more', 'library']) {
    await driver.eval(`document.querySelector('.tab[data-tab="${tab}"]').click()`);
    await sleep(2000);
  }
  eq(await driver.eval(`location.hash`), '#/library', 'tab bar navigates');
} finally {
  driver.close();
}

// Setting exitCode (rather than calling process.exit) lets inherited stdio
// flush before the process ends — process.exit truncated output and produced
// a spurious non-zero status under the runner.
process.exitCode = report() ? 0 : 1;
