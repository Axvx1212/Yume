// Library — category strip over a cover grid, unread badge and progress rail
// per tile. Mirrors the prototype's Library screen.

import * as api from '../api.js';
import { prefs, setPref, cache, nextGridCols } from '../state.js';
import { el, icon, ICONS, img, clear, skeletonGrid, emptyState, errorBox } from '../dom.js';
import { navigate, mount } from '../app.js';

export async function renderLibrary() {
  const body = el('div', { class: 'scroll pad-tabs' });
  const catsRow = el('div', { class: 'cats', role: 'tablist' });

  const screen = el('div', { class: 'screen' },
    el('header', { class: 'hdr' },
      el('div', { class: 'hdr-row' },
        el('div', {},
          el('div', { class: 'hdr-kicker' }, 'yume'),
          el('h1', { class: 'hdr-title' }, 'Library'),
        ),
        el('div', { class: 'hdr-actions' },
          el('button', {
            class: 'icon-btn',
            'aria-label': 'Search sources',
            onClick: () => navigate('#/browse'),
          }, icon(ICONS.search)),
          el('button', {
            class: 'icon-btn',
            'aria-label': 'Grid density',
            onClick: cycleDensity,
          }, icon(ICONS.filter)),
        ),
      ),
      catsRow,
    ),
    body,
  );

  mount(screen);

  function cycleDensity() {
    const next = nextGridCols(prefs.gridCols);
    setPref('gridCols', next);
    const grid = body.querySelector('.grid');
    if (grid) grid.style.setProperty('--cols', next);
  }

  let counts = {};

  async function loadCategories() {
    if (!cache.categories) cache.categories = await api.getCategories();
    const cats = cache.categories;

    // A lone "Default" category is Suwayomi's uncategorised bucket — showing a
    // one-tab strip would be noise, so the strip only appears with real ones.
    const meaningful = cats.filter((c) => !(c.default && cats.length === 1));

    try {
      counts = await api.getCategoryCounts(meaningful.map((c) => c.id));
    } catch {
      counts = {};
    }

    clear(catsRow);
    if (!meaningful.length) return;

    const entries = [{ id: null, name: 'All' }, ...meaningful];
    for (const c of entries) {
      const selected = (prefs.libraryCategory ?? null) === (c.id ?? null);
      const n = c.id == null ? counts.all : counts[c.id];
      catsRow.append(
        el('button', {
          class: 'cat',
          role: 'tab',
          'aria-selected': String(selected),
          onClick: () => {
            setPref('libraryCategory', c.id ?? null);
            loadCategories();
            loadShelf();
          },
        },
          el('span', {}, c.name),
          n == null ? null : el('span', { class: 'n' }, String(n)),
        ),
      );
    }
  }

  async function loadShelf() {
    clear(body).append(skeletonGrid(9));
    try {
      const result = await api.getLibrary(prefs.libraryCategory);
      renderShelf(result.nodes);
    } catch (err) {
      clear(body).append(errorBox(err, loadShelf));
    }
  }

  function renderShelf(items) {
    clear(body);

    if (!items.length) {
      body.append(emptyState({
        iconPath: ICONS.book,
        title: prefs.libraryCategory == null ? 'Your library is empty' : 'Nothing in this category',
        body: prefs.libraryCategory == null
          ? 'Find something in Browse and add it to your library — it will show up here.'
          : 'Titles you file into this category will appear here.',
        action: 'Go to Browse',
        onAction: () => navigate('#/browse'),
      }));
      return;
    }

    const grid = el('div', { class: 'grid' });
    grid.style.setProperty('--cols', prefs.gridCols);

    for (const m of items) {
      const unread = m.unreadCount ?? 0;
      const total = m.chapters?.totalCount ?? 0;
      // Read fraction drives the rail under each cover, as in the prototype.
      const pct = total > 0 ? Math.round(((total - unread) / total) * 100) : 0;
      grid.append(
        el('div', {
          class: 'tile',
          role: 'button',
          tabindex: '0',
          onClick: () => navigate(`#/manga/${m.id}`),
          onKeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`#/manga/${m.id}`); }
          },
        },
          el('div', { class: 'cover' },
            m.thumbnailUrl ? img(m.thumbnailUrl, '') : null,
            el('div', { class: 'cover-scrim' }),
            unread > 0 ? el('div', { class: 'badge' }, unread > 999 ? '999+' : String(unread)) : null,
            total > 0
              ? el('div', { class: 'progress-rail' }, el('i', { style: { width: `${pct}%` } }))
              : null,
          ),
          el('div', { class: 'tile-title' }, m.title),
        ),
      );
    }

    body.append(grid);
    body.append(el('div', { class: 'foot' }, `${items.length} title${items.length === 1 ? '' : 's'}`));
  }

  await loadCategories();
  await loadShelf();
}
