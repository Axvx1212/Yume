// Browse — three tabs. "Results" searches installed sources and lays each
// source's hits out as a horizontal rail; "Sources" lists the sources you can
// open and browse; "Extensions" installs, updates, and removes the extensions
// that provide those sources.
//
// Sources and extensions are deliberately separate: an installed extension
// usually contributes a source of the same name, so listing both together
// showed each one twice.

import * as api from '../api.js';
import { prefs, setPref, cache } from '../state.js';
import { el, icon, ICONS, img, clear, toast, spinnerRow, emptyState, errorBox } from '../dom.js';
import { navigate, mount } from '../app.js';

export async function renderBrowse() {
  const panel = el('div', { class: 'scroll pad-tabs' });

  // Each tab keeps its own query, so a title search never doubles as a filter
  // on another tab's list.
  const TABS = ['search', 'sources', 'extensions'];
  let tab = TABS.includes(prefs.browseTab) ? prefs.browseTab : 'search';

  const queries = {
    search: prefs.lastQuery || '',
    sources: prefs.lastSourcesFilter || '',
    extensions: prefs.lastExtensionsFilter || '',
  };
  const PREF_KEY = {
    search: 'lastQuery',
    sources: 'lastSourcesFilter',
    extensions: 'lastExtensionsFilter',
  };

  const PLACEHOLDER = {
    search: 'Search all sources',
    sources: 'Filter sources',
    extensions: 'Search 1000+ extensions',
  };
  const ARIA = {
    search: 'Search all installed sources',
    sources: 'Filter your installed sources',
    extensions: 'Search extensions by name',
  };

  const input = el('input', {
    type: 'search',
    value: queries[tab],
    placeholder: PLACEHOLDER[tab],
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    'aria-label': ARIA[tab],
  });

  const tabButtons = {
    search: el('button', { role: 'tab', onClick: () => switchTab('search') }, 'Results'),
    sources: el('button', { role: 'tab', onClick: () => switchTab('sources') }, 'Sources'),
    extensions: el('button', { role: 'tab', onClick: () => switchTab('extensions') }, 'Extensions'),
  };

  const screen = el('div', { class: 'screen' },
    el('header', { class: 'hdr', style: { paddingBottom: '12px' } },
      el('h1', { class: 'hdr-title' }, 'Browse'),
      el('div', { class: 'search', style: { marginTop: 'var(--space-4)' } },
        icon(ICONS.search, { size: 17 }),
        input,
      ),
      el('div', { class: 'seg', role: 'tablist', style: { marginTop: 'var(--space-3)' } },
        TABS.map((t) => tabButtons[t]),
      ),
    ),
    panel,
  );

  mount(screen);

  let searchToken = 0;      // guards against out-of-order search responses
  let debounce = null;

  function paintTabs() {
    for (const t of TABS) tabButtons[t].setAttribute('aria-selected', String(tab === t));
  }

  function switchTab(next) {
    if (tab === next) return;
    clearTimeout(debounce);      // else the old tab's timer renders this one twice
    tab = next;
    setPref('browseTab', next);
    input.value = queries[next];
    input.placeholder = PLACEHOLDER[next];
    input.setAttribute('aria-label', ARIA[next]);
    paintTabs();
    render();
  }

  input.addEventListener('input', () => {
    queries[tab] = input.value;
    setPref(PREF_KEY[tab], input.value);
    clearTimeout(debounce);
    debounce = setTimeout(render, 320);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
      clearTimeout(debounce);
      render();
    }
  });

  /* ── results tab ─────────────────────────────────────────────────────── */

  async function runSearch() {
    const q = queries.search.trim();
    const token = ++searchToken;

    if (!q) {
      clear(panel).append(emptyState({
        iconPath: ICONS.search,
        title: 'Search your sources',
        body: 'Type a title and Yume queries every installed source at once.',
      }));
      return;
    }

    clear(panel).append(spinnerRow('Searching sources…'));

    let sources;
    try {
      if (!cache.sources) cache.sources = await api.getSources();
      sources = cache.sources;
    } catch (err) {
      if (token === searchToken) clear(panel).append(errorBox(err, runSearch));
      return;
    }

    if (token !== searchToken) return;

    if (!sources.length) {
      clear(panel).append(emptyState({
        iconPath: ICONS.plus,
        title: 'No sources installed',
        body: 'Install an extension first — its sources then become searchable here.',
        action: 'Go to Extensions',
        onAction: () => switchTab('extensions'),
      }));
      return;
    }

    clear(panel);
    const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '22px', padding: '12px 0' } });
    panel.append(list);

    const status = el('div', { class: 'loading-row' },
      el('div', { class: 'spinner' }), `Searching ${sources.length} source${sources.length === 1 ? '' : 's'}…`);
    panel.append(status);

    let found = 0;
    let done = 0;

    // Each source resolves independently — a slow or broken source must not
    // hold up the ones that already answered.
    await Promise.all(sources.map(async (src) => {
      let result = null;
      let failed = null;
      try {
        result = await api.searchSource(src.id, q, 1);
      } catch (err) {
        failed = err;
      }

      if (token !== searchToken) return;
      done += 1;
      status.lastChild.textContent = ` Searching ${sources.length - done} more…`;
      if (done === sources.length) status.remove();

      if (failed) {
        list.append(el('div', { class: 'rail-head', style: { opacity: '0.6' } },
          el('div', { class: 'name' }, src.displayName || src.name),
          el('div', { class: 'n' }, 'unavailable'),
        ));
        return;
      }

      const items = result?.mangas || [];
      if (!items.length) return;
      found += items.length;

      list.append(
        el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          el('div', { class: 'rail-head' },
            el('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: '0' } },
              el('div', { class: 'name' }, src.displayName || src.name),
              el('div', { class: 'n' }, `${items.length}${result.hasNextPage ? '+' : ''}`),
            ),
          ),
          el('div', { class: 'rail' },
            items.map((m) => el('div', {
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
            )),
          ),
        ),
      );
    }));

    if (token === searchToken && !found && !list.childElementCount) {
      clear(panel).append(emptyState({
        iconPath: ICONS.search,
        title: 'No results',
        body: `Nothing matched “${q}” in your installed sources.`,
      }));
    }
  }

  /* ── sources tab — only the sources you can open ─────────────────────── */

  async function renderSources() {
    clear(panel).append(spinnerRow('Loading sources…'));
    const filter = queries.sources.trim().toLowerCase();

    let sources;
    try {
      if (!cache.sources) cache.sources = await api.getSources();
      sources = cache.sources;
    } catch (err) {
      clear(panel).append(errorBox(err, renderSources));
      return;
    }

    const list = sources.filter(
      (s) => !filter || (s.displayName || s.name).toLowerCase().includes(filter),
    );

    clear(panel);

    if (!list.length) {
      panel.append(emptyState({
        iconPath: filter ? ICONS.search : ICONS.plus,
        title: filter ? 'No matching source' : 'No sources yet',
        body: filter
          ? `Nothing installed matches “${queries.sources.trim()}”.`
          : 'Install an extension and the sources it provides will appear here.',
        action: filter ? null : 'Go to Extensions',
        onAction: () => switchTab('extensions'),
      }));
      return;
    }

    const rows = el('div', { class: 'rows' });
    panel.append(rows);
    rows.append(el('div', { class: 'section-label' }, `Installed · ${list.length}`));
    for (const src of list) rows.append(sourceRow(src));
    rows.append(el('div', { class: 'fine' },
      'Tap a source to browse its catalog. Manage what is installed under Extensions.'));
  }

  /* ── extensions tab — install / update / remove ──────────────────────── */

  async function renderExtensions() {
    clear(panel).append(spinnerRow('Loading extensions…'));
    const filter = queries.extensions.trim();

    let installed;
    let available;
    try {
      [installed, available] = await Promise.all([
        api.getInstalledExtensions(),
        api.getAvailableExtensions({ search: filter, limit: filter ? 40 : 30 }),
      ]);
    } catch (err) {
      clear(panel).append(errorBox(err, renderExtensions));
      return;
    }

    clear(panel);
    const rows = el('div', { class: 'rows' });
    panel.append(rows);

    const installedList = installed.nodes.filter(
      (x) => !filter || x.name.toLowerCase().includes(filter.toLowerCase()),
    );

    // Anything with an update waiting is worth surfacing on its own.
    const updatable = installedList.filter((x) => x.hasUpdate);
    if (updatable.length) {
      rows.append(el('div', { class: 'section-label' }, `Updates · ${updatable.length}`));
      for (const ext of updatable) rows.append(extensionRow(ext, true));
    }

    const rest = installedList.filter((x) => !x.hasUpdate);
    rows.append(el('div', {
      class: 'section-label',
      style: updatable.length ? { paddingTop: '14px' } : null,
    }, `Installed${installedList.length ? ` · ${installedList.length}` : ''}`));

    if (!installedList.length) {
      rows.append(el('div', { class: 'row-meta', style: { padding: '2px 2px 6px' } },
        filter ? 'No installed extension matches that.' : 'No extensions installed yet.'));
    }

    for (const ext of rest) rows.append(extensionRow(ext, true));

    rows.append(el('div', { class: 'section-label', style: { paddingTop: '14px' } },
      filter ? 'Available' : 'Available · popular'));

    if (!available.nodes.length) {
      rows.append(el('div', { class: 'row-meta', style: { padding: '2px' } },
        filter ? 'Nothing available matches that.' : 'No extensions available.'));
    }

    for (const ext of available.nodes) rows.append(extensionRow(ext, false));

    if (!filter && available.totalCount > available.nodes.length) {
      rows.append(el('div', { class: 'fine' },
        `Showing ${available.nodes.length} of ${available.totalCount} available extensions — search above to narrow it down.`));
    }

    rows.append(
      el('button', {
        class: 'btn btn-block',
        style: { marginTop: 'var(--space-4)' },
        onClick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = 'Refreshing…';
          try {
            const n = await api.refreshExtensions();
            toast(`Extension index refreshed — ${n} available.`);
            renderExtensions();
          } catch (err) {
            toast(err.message);
            btn.disabled = false;
            btn.textContent = 'Refresh extension index';
          }
        },
      }, 'Refresh extension index'),
    );
  }

  /** A tappable source — opens that source's catalog. */
  function sourceRow(src) {
    const label = src.displayName || src.name;
    return el('button', {
      class: 'row',
      style: { width: '100%', textAlign: 'left', border: '0', cursor: 'pointer' },
      onClick: () => navigate(`#/source/${src.id}`),
    },
      el('div', { class: 'row-icon' },
        src.iconUrl ? img(src.iconUrl, '') : el('span', {}, (label || '?').charAt(0).toUpperCase()),
      ),
      el('div', { class: 'row-main' },
        el('div', { class: 'row-name' }, label),
        el('div', { class: 'row-meta' },
          [src.lang ? src.lang.toUpperCase() : null, 'Tap to browse'].filter(Boolean).join(' · ')),
      ),
      icon(ICONS.forward, { size: 17 }),
    );
  }

  function extensionRow(ext, isInstalled) {
    const meta = [
      ext.versionName ? `v${ext.versionName}` : null,
      ext.lang ? ext.lang.toUpperCase() : null,
      ext.isObsolete ? 'obsolete' : null,
      isInstalled && ext.hasUpdate ? 'update available' : null,
    ].filter(Boolean).join(' · ');

    const row = el('div', { class: isInstalled ? 'row' : 'row is-ghost' },
      el('div', { class: 'row-icon' },
        ext.iconUrl ? img(ext.iconUrl, '') : el('span', {}, (ext.name || '?').charAt(0).toUpperCase()),
      ),
      el('div', { class: 'row-main' },
        el('div', { class: 'row-name' }, ext.name),
        el('div', { class: 'row-meta' }, meta || '—'),
      ),
    );

    async function act(fn, busyLabel, doneMsg, trigger) {
      const buttons = [...row.querySelectorAll('button')];
      // Remember which were already disabled ("Latest" has no handler and is
      // meant to stay that way), so failure restores the row as it was.
      const wasDisabled = new Map(buttons.map((b) => [b, b.disabled]));
      for (const b of buttons) b.disabled = true;

      // Feedback belongs on the button the user pressed, not buttons[0].
      const target = trigger || buttons[0];
      const original = target.textContent;
      if (busyLabel) target.textContent = busyLabel;

      try {
        await fn();
        cache.sources = null;      // installing/removing changes the source list
        toast(doneMsg);
        renderExtensions();
      } catch (err) {
        toast(err.message);
        target.textContent = original;
        for (const b of buttons) b.disabled = wasDisabled.get(b) ?? false;
      }
    }

    if (isInstalled) {
      row.append(
        ext.hasUpdate
          ? el('button', {
              class: 'btn btn-sm btn-accent',
              onClick: (e) => act(() => api.upgradeExtension(ext.pkgName), 'Updating…', `${ext.name} updated.`, e.currentTarget),
            }, 'Update')
          : el('button', { class: 'btn btn-sm', disabled: true }, 'Latest'),
        el('button', {
          class: 'icon-btn',
          'aria-label': `Uninstall ${ext.name}`,
          style: { width: '36px', height: '36px' },
          onClick: (e) => act(() => api.uninstallExtension(ext.pkgName), '', `${ext.name} uninstalled.`, e.currentTarget),
        }, icon(ICONS.trash, { size: 17, width: 1.7 })),
      );
    } else {
      row.append(
        el('button', {
          class: 'btn btn-sm btn-accent',
          onClick: (e) => act(() => api.installExtension(ext.pkgName), 'Installing…', `${ext.name} installed.`, e.currentTarget),
        }, 'Install'),
      );
    }

    return row;
  }

  function render() {
    if (tab === 'search') runSearch();
    else if (tab === 'sources') renderSources();
    else renderExtensions();
  }

  paintTabs();
  render();

  // Without this, a debounce armed just before navigating away fires against a
  // detached panel and kicks off a live scrape per source for a screen the
  // user has left. Bumping the token also makes any in-flight search discard
  // its results instead of painting into nothing.
  return () => {
    clearTimeout(debounce);
    searchToken += 1;
  };
}
