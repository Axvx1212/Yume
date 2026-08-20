// Source catalog — browse one source's Popular / Latest listings, or search
// within just that source. Reached by tapping a source row in Browse.

import * as api from '../api.js';
import { prefs, setPref, cache } from '../state.js';
import { el, icon, ICONS, img, clear, skeletonGrid, emptyState, errorBox, spinnerRow } from '../dom.js';
import { navigate, goBack, mount } from '../app.js';

export async function renderSource(sourceId) {
  const body = el('div', { class: 'scroll pad-tabs' });
  const titleEl = el('h1', { class: 'hdr-title' }, 'Source');
  const segRow = el('div', { class: 'seg', role: 'tablist', style: { marginTop: 'var(--space-3)' } });

  const input = el('input', {
    type: 'search',
    placeholder: 'Search this source',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    'aria-label': 'Search this source',
  });

  mount(el('div', { class: 'screen' },
    el('header', { class: 'hdr', style: { paddingBottom: '12px' } },
      el('div', { class: 'hdr-row' },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '4px', minWidth: '0' } },
          el('button', {
            class: 'icon-btn',
            style: { marginLeft: '-10px' },
            'aria-label': 'Back to Browse',
            onClick: () => goBack('#/browse'),
          }, icon(ICONS.back, { size: 21 })),
          titleEl,
        ),
      ),
      el('div', { class: 'search', style: { marginTop: 'var(--space-4)' } },
        icon(ICONS.search, { size: 17 }),
        input,
      ),
      segRow,
    ),
    body,
  ));

  let source = null;
  let listType = 'POPULAR';     // POPULAR | LATEST | SEARCH
  let query = '';
  let page = 1;
  let hasNext = false;
  let items = [];
  let loading = false;
  let token = 0;
  let debounce = null;

  // Resolve the source name for the header.
  try {
    if (!cache.sources) cache.sources = await api.getSources();
    source = cache.sources.find((s) => String(s.id) === String(sourceId)) || null;
  } catch {
    /* header falls back to a generic label; the listing below reports the error */
  }
  titleEl.textContent = source?.displayName || source?.name || 'Source';

  function paintSeg() {
    clear(segRow);
    const tabs = [['POPULAR', 'Popular']];
    if (source?.supportsLatest !== false) tabs.push(['LATEST', 'Latest']);
    if (query.trim()) tabs.push(['SEARCH', 'Search']);

    for (const [id, label] of tabs) {
      segRow.append(el('button', {
        role: 'tab',
        'aria-selected': String(listType === id),
        onClick: () => { if (listType !== id) { listType = id; load({ reset: true }); } },
      }, label));
    }
  }

  input.addEventListener('input', () => {
    query = input.value;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      listType = query.trim() ? 'SEARCH' : 'POPULAR';
      load({ reset: true });
    }, 340);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
      clearTimeout(debounce);
      listType = query.trim() ? 'SEARCH' : 'POPULAR';
      load({ reset: true });
    }
  });

  async function load({ reset = false } = {}) {
    // Not a mutex: a newer query must supersede an in-flight one, not be
    // dropped. `token` already discards the stale response, so the only thing
    // `loading` guards is the "Load more" button double-firing.
    const mine = ++token;
    loading = true;

    if (reset) {
      page = 1;
      items = [];
      clear(body).append(skeletonGrid(9));
    }
    paintSeg();

    try {
      const result = listType === 'SEARCH'
        ? await api.searchSource(sourceId, query.trim(), page)
        : await api.browseSource(sourceId, listType, page);

      if (mine !== token) return;

      items = items.concat(result.mangas || []);
      hasNext = !!result.hasNextPage;
      paint();
    } catch (err) {
      if (mine !== token) return;
      clear(body).append(errorBox(err, () => load({ reset: true })));
    } finally {
      if (mine === token) loading = false;
    }
  }

  function paint() {
    clear(body);

    if (!items.length) {
      body.append(emptyState({
        iconPath: ICONS.search,
        title: listType === 'SEARCH' ? 'No results' : 'Nothing here',
        body: listType === 'SEARCH'
          ? `Nothing matched “${query.trim()}” in this source.`
          : 'This source returned no titles.',
      }));
      return;
    }

    const grid = el('div', { class: 'grid' });
    grid.style.setProperty('--cols', prefs.gridCols);

    for (const m of items) {
      grid.append(el('div', {
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
          m.inLibrary ? el('div', { class: 'pill' }, 'In library') : null,
        ),
        el('div', { class: 'tile-title' }, m.title),
      ));
    }

    body.append(grid);

    if (hasNext) {
      const more = el('button', {
        class: 'btn btn-block',
        style: { marginTop: 'var(--space-4)' },
        onClick: async () => {
          more.disabled = true;
          more.textContent = 'Loading…';
          page += 1;
          await load();
        },
      }, 'Load more');
      body.append(el('div', { style: { padding: '0 var(--space-6)' } }, more));
    } else {
      body.append(el('div', { class: 'foot' }, `${items.length} titles`));
    }
  }

  setPref('browseSource', String(sourceId));
  await load({ reset: true });

  return () => {
    clearTimeout(debounce);
    token += 1;            // abandon any in-flight listing
  };
}
