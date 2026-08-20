// Router + shell. Hash routes:
//   #/library
//   #/browse
//   #/manga/:id
//   #/reader/:chapterId
//   #/more

import { prefs, setPref } from './state.js';
import { el, clear } from './dom.js';

import { renderLibrary } from './views/library.js';
import { renderBrowse } from './views/browse.js';
import { renderMangaDetail } from './views/manga-detail.js';
import { renderReader } from './views/reader.js';
import { renderMore } from './views/more.js';
import { renderSource } from './views/source.js';

const viewEl = document.getElementById('view');
const tabbarEl = document.getElementById('tabbar');

/** Views may return a cleanup fn to tear down listeners/observers. */
let disposeCurrent = null;

const ROUTES = [
  { re: /^\/library\/?$/,        tab: 'library', render: () => renderLibrary() },
  { re: /^\/browse\/?$/,         tab: 'browse',  render: () => renderBrowse() },
  { re: /^\/more\/?$/,           tab: 'more',    render: () => renderMore() },
  // Source ids are LongStrings (can exceed Number.MAX_SAFE_INTEGER) — keep as text.
  { re: /^\/source\/([\w-]+)$/,  tab: 'browse',  render: (m) => renderSource(m[1]) },
  { re: /^\/manga\/(\d+)$/,      tab: null,      render: (m) => renderMangaDetail(Number(m[1])) },
  { re: /^\/reader\/(\d+)$/,     tab: null,      render: (m) => renderReader(Number(m[1])) },
];

function currentPath() {
  const raw = location.hash.replace(/^#/, '');
  return raw || '/library';
}

let renderedPath = null;
let routeSeq = 0;          // identifies the render currently in flight

async function route() {
  const path = currentPath();
  if (path === renderedPath) return;
  renderedPath = path;

  const mine = ++routeSeq;

  if (typeof disposeCurrent === 'function') {
    try { disposeCurrent(); } catch { /* a failed teardown must not block navigation */ }
  }
  disposeCurrent = null;

  const match = ROUTES.map((r) => ({ r, m: path.match(r.re) })).find((x) => x.m);

  if (!match) {
    location.replace('#/library');
    return;
  }

  const { r, m } = match;

  // The reader is full-bleed; every other screen sits above the tab bar.
  const showTabs = r.tab != null;
  tabbarEl.hidden = !showTabs;
  for (const a of tabbarEl.querySelectorAll('.tab')) {
    if (a.dataset.tab === r.tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (r.tab) setPref('lastTab', r.tab);

  clear(viewEl);
  viewEl.scrollTop = 0;

  try {
    const dispose = await r.render(m, viewEl);
    if (mine === routeSeq) {
      disposeCurrent = dispose;
    } else if (typeof dispose === 'function') {
      // A newer navigation started while this view was still rendering; it
      // already tore down what it could, so this view cleans up after itself
      // rather than leaking its listeners for the rest of the session.
      try { dispose(); } catch { /* nothing more we can do */ }
    }
  } catch (err) {
    console.error('[yume] view crashed', err);
    clear(viewEl).append(
      el('div', { class: 'error-box' },
        el('div', { class: 'msg' }, 'This screen failed to render.'),
        el('code', {}, String(err?.message || err)),
        el('button', { class: 'btn btn-sm', onClick: () => { renderedPath = null; route(); } }, 'Reload'),
      ),
    );
  }
}

/** Mount point every view renders into. */
export function mount(node) {
  clear(viewEl).append(node);
  return viewEl;
}

/**
 * Navigation is a real history stack, indexed in history.state. Hash strings
 * alone can't tell a forward push from a back pop, which is what made the
 * reader's back button push a duplicate detail entry — pressing back from the
 * detail then landed on that duplicate and looked like the manga reopening.
 */
let seq = 0;

export function navigate(path, { replace = false, reload = false } = {}) {
  if (reload) {
    renderedPath = null;      // defeat the same-path guard
    route();
    return;
  }
  if (path === location.hash && !replace) return;
  if (replace) {
    history.replaceState({ i: seq }, '', path);
  } else {
    seq += 1;
    history.pushState({ i: seq }, '', path);
  }
  route();
}

/**
 * Go back if there's an in-app entry to go back to, otherwise fall back to a
 * known parent. Deep-linking straight into a reader (from the Home Screen, or
 * a shared URL) leaves nothing to pop, hence the fallback.
 */
export function goBack(fallback = '#/library') {
  if ((history.state?.i ?? 0) > 0) history.back();
  else navigate(fallback, { replace: true });
}

// Tabs are peers, not a path — switching between them replaces the current
// entry so Back never walks through a trail of tab switches.
document.getElementById('tabbar')?.addEventListener('click', (e) => {
  const link = e.target.closest('.tab');
  if (!link) return;
  e.preventDefault();
  navigate(link.getAttribute('href'), { replace: true });
});

window.addEventListener('popstate', () => {
  seq = history.state?.i ?? 0;
  route();
});

// Only fires when the hash is edited by hand — pushState/replaceState don't
// emit it. The guard in route() keeps this from double-rendering.
window.addEventListener('hashchange', route);

// Start exactly once. Both paths below can be reachable depending on when the
// module executes, and running both would render every screen twice — which
// also doubles the queries the server sees.
let started = false;
function start() {
  if (started) return;
  started = true;
  if (!location.hash) location.replace(`#/${prefs.lastTab || 'library'}`);
  history.replaceState({ i: 0 }, '', location.hash);   // stack bottom
  route();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
