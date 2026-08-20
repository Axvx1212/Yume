// More — server status, reading defaults, and library shortcuts.
// The prototype's fifth screen; kept because the tab bar it designed has three
// entries and this is one of them.

import * as api from '../api.js';
import { prefs, setPref, cache, READER_MODES, nextGridCols } from '../state.js';
import { el, icon, ICONS, clear, toast } from '../dom.js';
import { navigate, mount } from '../app.js';

export async function renderMore() {
  const body = el('div', { class: 'more-body scroll pad-tabs' });

  mount(el('div', { class: 'screen' },
    el('header', { class: 'hdr', style: { paddingBottom: '14px' } },
      el('div', { class: 'hdr-kicker' }, 'yume'),
      el('h1', { class: 'hdr-title' }, 'More'),
    ),
    body,
  ));

  const statusRow = el('div', { class: 'status-row' },
    el('span', { class: 'status-dot' }),
    el('div', { class: 'row-main' },
      el('div', { class: 'row-name' }, 'Checking server…'),
      el('div', { class: 'status-sub' }, location.host),
    ),
  );

  function paint() {
    clear(body);

    body.append(statusRow);

    body.append(
      el('div', { class: 'more-group' },
        el('div', { class: 'section-label' }, 'Privacy'),
        el('div', { class: 'toggle-row' },
          el('div', { class: 'row-main' },
            el('div', { class: 'row-name' }, 'Incognito reading'),
            el('div', { class: 'row-meta' },
              'Read without recording anything: no reading position, no auto mark-read.'),
          ),
          el('button', {
            class: 'switch',
            role: 'switch',
            'aria-checked': String(!!prefs.incognito),
            'aria-label': 'Incognito reading',
            onClick: () => {
              const next = !prefs.incognito;
              setPref('incognito', next);
              toast(next
                ? 'Incognito on — reading is no longer recorded.'
                : 'Incognito off — reading is recorded again.');
              paint();
            },
          }),
        ),
      ),
    );

    body.append(
      el('div', { class: 'more-group' },
        el('div', { class: 'section-label' }, 'Reading defaults'),
        el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          READER_MODES.map((m) => el('button', {
            class: 'opt',
            role: 'radio',
            'aria-checked': String((prefs.readerMode || 'webtoon') === m.id),
            onClick: () => { setPref('readerMode', m.id); paint(); },
          },
            el('span', { class: 'opt-dot' }),
            el('span', { class: 'opt-text' },
              el('span', { class: 'l' }, m.label),
              el('span', { class: 'h' }, m.hint),
            ),
          )),
        ),
      ),
    );

    body.append(
      el('div', { class: 'more-group' },
        el('div', { class: 'section-label' }, 'Library'),
        el('button', {
          class: 'link-row',
          onClick: () => navigate('#/browse'),
        },
          el('div', { class: 'row-main' },
            el('div', { class: 'row-name' }, 'Sources & extensions'),
            el('div', { class: 'row-meta' }, 'Install, update, or remove extensions'),
          ),
          icon(ICONS.forward, { size: 17 }),
        ),
        el('button', {
          class: 'link-row',
          onClick: () => {
            cache.clear();
            toast('Cached data cleared.');
          },
        },
          el('div', { class: 'row-main' },
            el('div', { class: 'row-name' }, 'Clear in-app cache'),
            el('div', { class: 'row-meta' }, 'Forces a refetch of manga, chapters, and pages'),
          ),
          icon(ICONS.forward, { size: 17 }),
        ),
        el('button', {
          class: 'link-row',
          onClick: () => {
            setPref('gridCols', nextGridCols(prefs.gridCols));
            paint();
          },
        },
          el('div', { class: 'row-main' },
            el('div', { class: 'row-name' }, 'Library grid density'),
            el('div', { class: 'row-meta' }, `${prefs.gridCols} columns — tap to change`),
          ),
          icon(ICONS.forward, { size: 17 }),
        ),
      ),
    );

    body.append(
      el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', paddingTop: '2px' } },
        el('hr', { class: 'hr' }),
        el('div', { class: 'fine' }, 'Yume · personal build · no accounts, no telemetry.'),
      ),
    );
  }

  paint();

  try {
    const about = await api.aboutServer();
    statusRow.querySelector('.status-dot').classList.add('is-up');
    statusRow.querySelector('.row-name').textContent = 'Server connected';
    statusRow.querySelector('.status-sub').textContent =
      `${about.name} ${about.version} · ${about.revision}`;
  } catch (err) {
    statusRow.querySelector('.row-name').textContent = 'Server unreachable';
    statusRow.querySelector('.status-sub').textContent = err.message;
    statusRow.append(
      el('button', {
        class: 'btn btn-sm',
        onClick: () => renderMore(),
      }, 'Retry'),
    );
  }
}
