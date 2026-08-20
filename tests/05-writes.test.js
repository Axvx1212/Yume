// Write paths — progress, library membership, and incognito.
//
// These mutate a REAL library, so every test captures the prior state and
// restores it in a finally block. A failing assertion must never leave the
// user's data changed.

import { launch, sleep } from './lib/cdp.js';
import { BASE, suite, ok, eq, atLeast, info, report, requireApp, gql, withRevert } from './lib/harness.js';

await requireApp();

// Work against a title that is NOT in the library, so nothing user-owned moves.
const { mangas } = await gql(`{ mangas(condition: {inLibrary: false}, first: 1) { nodes { id title } } }`);
const manga = mangas.nodes[0];
if (!manga) {
  console.error('No out-of-library manga to test against; skipping.');
  process.exit(0);
}
const { chapters } = await gql(
  `query C($id: Int!) { chapters(condition: {mangaId: $id}, first: 1) { nodes { id } } }`,
  { id: manga.id },
);
const chapterId = chapters.nodes[0]?.id;

const chapterState = () =>
  gql(`query C($id: Int!) { chapter(id: $id) { id isRead lastPageRead } }`, { id: chapterId })
    .then((d) => d.chapter);

/**
 * Snapshot every chapter of the test manga that carries progress. Reading
 * scrolls through several chapters and auto-marks each one finished, so
 * restoring only the chapter we opened leaves the rest dirty.
 */
const progressSnapshot = () =>
  gql(
    `query All($id: Int!) {
       chapters(condition: {mangaId: $id}) { nodes { id isRead lastPageRead } }
     }`,
    { id: manga.id },
  ).then((d) => d.chapters.nodes.filter((c) => c.isRead || c.lastPageRead > 0));

async function restoreProgress(before) {
  const wasRead = new Map(before.map((c) => [c.id, c]));
  const now = await progressSnapshot();
  const ids = now.filter((c) => !wasRead.has(c.id)).map((c) => c.id);
  if (ids.length) {
    await gql(
      `mutation R($ids: [Int!]!) {
         updateChapters(input: {ids: $ids, patch: {isRead: false, lastPageRead: 0}}) { chapters { id } }
       }`,
      { ids },
    );
  }
  // Put back anything whose original values we changed.
  for (const c of before) {
    await gql(
      `mutation U($id: Int!, $r: Boolean!, $p: Int!) {
         updateChapter(input: {id: $id, patch: {isRead: $r, lastPageRead: $p}}) { chapter { id } }
       }`,
      { id: c.id, r: c.isRead, p: c.lastPageRead },
    );
  }
}

const driver = await launch({ trackNetwork: true });
const writeCount = () =>
  driver.requests.filter((r) => r.url.includes('/api/graphql')).length;

try {
  suite(`Library membership (${manga.title})`);

  await withRevert(
    () => gql(`query M($id: Int!) { manga(id: $id) { id inLibrary } }`, { id: manga.id })
      .then((d) => d.manga.inLibrary),
    (was) => gql(
      `mutation L($id: Int!, $v: Boolean!) { updateManga(input: {id: $id, patch: {inLibrary: $v}}) { manga { id } } }`,
      { id: manga.id, v: was },
    ),
    async () => {
      await driver.goto(`${BASE}/index.html#/manga/${manga.id}`, 14000);
      const clicked = await driver.eval(`
        (() => {
          const b = [...document.querySelectorAll('.btn')].find(x => x.textContent.includes('Add to library'));
          if (!b) return false;
          b.click();
          return true;
        })()
      `);
      ok(clicked, 'found the Add to library button');
      await sleep(4000);

      const server = await gql(`query M($id: Int!) { manga(id: $id) { inLibrary } }`, { id: manga.id });
      eq(server.manga.inLibrary, true, 'membership persisted to the server');
    },
  );

  suite('Incognito writes nothing');

  await withRevert(
    progressSnapshot,
    restoreProgress,
    async () => {
      await gql(
        `mutation U($id: Int!) { updateChapter(input: {id: $id, patch: {isRead: false, lastPageRead: 0}}) { chapter { id } } }`,
        { id: chapterId },
      );

      // Incognito ON — read the whole chapter, expect zero writes.
      await driver.gotoWithPrefs(BASE, `#/reader/${chapterId}`,
        { readerMode: 'webtoon', brightness: 100, gridCols: 3, incognito: true }, 14000);

      ok(await driver.eval(`!!document.querySelector('.incognito-tag')`),
        'reader shows the incognito badge');

      driver.resetCounters();
      for (let i = 0; i < 6; i++) {
        await driver.eval(`(() => { const s = document.querySelector('.reader-scroll'); s.scrollTop = s.scrollHeight; })()`);
        await sleep(1200);
      }
      await driver.goto(`${BASE}/index.html#/library`, 4000);   // triggers the dispose flush
      await sleep(2000);

      const after = await chapterState();
      eq(after.isRead, false, 'incognito did not mark the chapter read');
      eq(after.lastPageRead, 0, 'incognito did not record a position');

      // Incognito OFF — the same read must record.
      await driver.gotoWithPrefs(BASE, `#/reader/${chapterId}`,
        { readerMode: 'webtoon', brightness: 100, gridCols: 3, incognito: false }, 14000);
      for (let i = 0; i < 6; i++) {
        await driver.eval(`(() => { const s = document.querySelector('.reader-scroll'); s.scrollTop = s.scrollHeight; })()`);
        await sleep(1200);
      }
      await sleep(4000);

      const recorded = await chapterState();
      ok(recorded.isRead || recorded.lastPageRead > 0,
        'with incognito off, reading is recorded',
        `isRead=${recorded.isRead} lastPageRead=${recorded.lastPageRead}`);
    },
  );

  suite('Chapter read toggle');

  await withRevert(
    progressSnapshot,
    restoreProgress,
    async () => {
      await driver.goto(`${BASE}/index.html#/manga/${manga.id}`, 14000);
      driver.resetCounters();

      // One tap must send exactly one write (dblclick once sent three).
      await driver.eval(`
        (() => {
          const b = document.querySelector('.chapter .icon-btn');
          b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
          b.click();
        })()
      `);
      await sleep(3500);
      eq(writeCount(), 1, 'a single tap sends exactly one mutation');
    },
  );

  suite('Chapter and title menus');

  await withRevert(
    progressSnapshot,
    restoreProgress,
    async () => {
      await driver.goto(`${BASE}/index.html#/manga/${manga.id}`, 16000);

      // Overflow menu, top right of the hero.
      ok(await driver.eval(`!!document.querySelector('.detail-topbar .icon-btn[aria-label="More actions"]')`),
        'title screen has an overflow button');

      await driver.eval(`document.querySelector('.detail-topbar .icon-btn[aria-label="More actions"]').click()`);
      await sleep(1200);
      const titleActions = await driver.eval(
        `JSON.stringify([...document.querySelectorAll('.sheet-action .l')].map(n => n.textContent))`,
      );
      ok(titleActions.includes('Mark all read'), 'title menu offers Mark all read', titleActions);

      await driver.eval(`[...document.querySelectorAll('.sheet-action')].find(b => b.textContent.includes('Mark all read')).click()`);
      await sleep(8000);
      const allRead = await gql(
        `query C($id: Int!) { chapters(condition: {mangaId: $id, isRead: true}) { totalCount } }`,
        { id: manga.id },
      );
      atLeast(allRead.chapters.totalCount, 1, 'Mark all read wrote to the server',
        `${allRead.chapters.totalCount} chapters`);

      // The menu adapts once everything is read.
      await driver.eval(`document.querySelector('.detail-topbar .icon-btn[aria-label="More actions"]').click()`);
      await sleep(1200);
      const nowOffers = await driver.eval(
        `JSON.stringify([...document.querySelectorAll('.sheet-action .l')].map(n => n.textContent))`,
      );
      ok(nowOffers.includes('Mark all unread'), 'menu offers Mark all unread once read', nowOffers);
      await driver.eval(`[...document.querySelectorAll('.sheet-action')].find(b => b.textContent.includes('Mark all unread')).click()`);
      await sleep(8000);

      // Long-press a chapter row opens its own menu, and releasing must NOT
      // fall through to opening the reader.
      await driver.eval(`
        (() => {
          const r = document.querySelector('.chapter');
          const b = r.getBoundingClientRect();
          r.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: b.x + 40, clientY: b.y + 20 }));
        })()
      `);
      await sleep(900);
      ok(await driver.eval(`!!document.querySelector('.sheet-wrap')`), 'long-press opens the chapter menu');
      const chapterActions = await driver.eval(
        `JSON.stringify([...document.querySelectorAll('.sheet-action .l')].map(n => n.textContent))`,
      );
      ok(chapterActions.includes('Mark previous read') && chapterActions.includes('Mark previous unread'),
        'chapter menu offers read and unread in bulk', chapterActions);

      await driver.eval(`document.querySelector('.chapter').dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))`);
      await sleep(300);
      await driver.eval(`document.querySelector('.chapter').click()`);
      await sleep(1500);
      ok(!(await driver.eval(`location.hash`)).startsWith('#/reader/'),
        'releasing a long-press does not open the reader');
    },
  );

  info('cleanup', 'all mutated state restored');
} finally {
  driver.close();
}

// Setting exitCode (rather than calling process.exit) lets inherited stdio
// flush before the process ends — process.exit truncated output and produced
// a spurious non-zero status under the runner.
process.exitCode = report() ? 0 : 1;
