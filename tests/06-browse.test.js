// Browse — the three tabs, and the searches behind them.
//
// Sources and Extensions are deliberately separate tabs: an installed extension
// usually contributes a source of the same name, so a combined list showed each
// one twice. Each tab also keeps its own query — sharing one string made a
// title search silently filter the extension list.

import { launch, sleep } from './lib/cdp.js';
import { BASE, suite, ok, eq, atLeast, info, report, requireApp, gql } from './lib/harness.js';

await requireApp();

const driver = await launch();

try {
  suite('Three tabs, each with its own query');

  await driver.goto(`${BASE}/index.html#/browse`, 6000);
  const tabs = await driver.eval(`JSON.stringify([...document.querySelectorAll('.seg button')].map(b => b.textContent))`);
  eq(tabs, '["Results","Sources","Extensions"]', 'Results / Sources / Extensions');

  // Type a title search on Results...
  await driver.eval(`
    (() => {
      const i = document.querySelector('.search input');
      i.value = 'solo';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(9000);
  const resultTiles = await driver.eval(`document.querySelectorAll('.tile').length`);
  atLeast(resultTiles, 1, 'search returns results from installed sources', `${resultTiles} tiles`);

  // ...then switch to Sources; the query must not follow.
  await driver.eval(`[...document.querySelectorAll('.seg button')].find(b => b.textContent === 'Sources').click()`);
  await sleep(7000);

  const sources = await driver.json(`
    return {
      field: document.querySelector('.search input').value,
      placeholder: document.querySelector('.search input').placeholder,
      names: [...document.querySelectorAll('.row-name')].map(n => n.textContent),
    };
  `);
  eq(sources.field, '', 'Sources tab has its own (empty) query');
  ok(sources.placeholder.toLowerCase().includes('source'), 'placeholder matches the tab', sources.placeholder);
  atLeast(sources.names.length, 1, 'installed sources are listed', sources.names.join(', '));

  suite('No duplicate entries between Sources and Extensions');

  const { sources: srv } = await gql(`{ sources { nodes { name } } }`);
  const installedNames = srv.nodes.map((s) => s.name.toLowerCase());
  for (const name of installedNames) {
    const shown = sources.names.filter((n) => n.toLowerCase().includes(name)).length;
    if (shown > 0) {
      eq(shown, 1, `"${name}" appears once in Sources`);
    }
  }

  await driver.eval(`[...document.querySelectorAll('.seg button')].find(b => b.textContent === 'Extensions').click()`);
  await sleep(9000);
  const ext = await driver.json(`
    return {
      labels: [...document.querySelectorAll('.section-label')].map(s => s.textContent),
      installButtons: [...document.querySelectorAll('.row button')].filter(b => b.textContent.trim() === 'Install').length,
      placeholder: document.querySelector('.search input').placeholder,
    };
  `);
  ok(ext.labels.some((l) => l.includes('Installed')), 'Extensions lists installed packages', ext.labels.join(' | '));
  atLeast(ext.installButtons, 1, 'available extensions are installable');
  ok(ext.placeholder.toLowerCase().includes('extension'), 'placeholder matches the tab', ext.placeholder);

  suite('Source catalog opens');

  await driver.eval(`[...document.querySelectorAll('.seg button')].find(b => b.textContent === 'Sources').click()`);
  await sleep(7000);
  // Pick a source with real content. "Local source" is always present and
  // always empty unless files were added on the server, so skip it.
  const opened = await driver.eval(`
    (() => {
      const rows = [...document.querySelectorAll('.row')]
        .filter(r => r.querySelector('.row-meta')?.textContent.includes('Tap to browse'))
        .filter(r => !/local/i.test(r.querySelector('.row-name').textContent));
      if (!rows.length) return '';
      const name = rows[0].querySelector('.row-name').textContent;
      rows[0].click();
      return name;
    })()
  `);

  if (!opened) {
    info('skipped', 'no non-local source installed to browse');
  } else {
    await sleep(16000);
    const hash = await driver.eval(`location.hash`);
    ok(hash.startsWith('#/source/'), `tapping "${opened}" opens its catalog`, hash);
    atLeast(await driver.eval(`document.querySelectorAll('.tile').length`), 1, 'catalog shows titles');
  }

  ok(driver.errors.length === 0, 'no console errors across Browse', driver.errors[0] || '');
} finally {
  driver.close();
}

// Setting exitCode (rather than calling process.exit) lets inherited stdio
// flush before the process ends — process.exit truncated output and produced
// a spurious non-zero status under the runner.
process.exitCode = report() ? 0 : 1;
