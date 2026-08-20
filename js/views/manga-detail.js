// Manga detail — hero, metadata, chapter list with per-chapter read state,
// and a docked resume button. Mirrors the prototype's Detail screen.

import * as api from '../api.js';
import { prefs, setPref, cache, chapterLabel, relativeTime, statusLabel } from '../state.js';
import { el, icon, ICONS, img, clear, toast, spinnerRow, errorBox, sampleCoverColor,
         actionSheet, onLongPress } from '../dom.js';
import { navigate, goBack, mount } from '../app.js';

export async function renderMangaDetail(mangaId) {
  const scroll = el('div', { class: 'scroll', style: { paddingBottom: '150px' } });
  const dock = el('div', { class: 'dock' });
  const screen = el('div', { class: 'screen' }, scroll, dock);

  mount(screen);
  scroll.append(spinnerRow('Loading…'));

  let heroTint = null;
  let disposed = false;      // set when the router tears this view down
  // Long-press listeners are re-attached on every paint; drop the old ones or
  // they accumulate across repaints for the life of the view.
  let disposers = [];
  let manga = cache.manga.get(mangaId) || null;
  let chapters = cache.chapters.get(mangaId)?.nodes || null;

  async function load({ force = false } = {}) {
    try {
      if (force) {
        const fresh = await api.refreshManga(mangaId);
        manga = fresh.manga;
        chapters = fresh.chapters;
      } else {
        if (!manga) manga = await api.getManga(mangaId);
        if (!chapters) chapters = (await api.getChapters(mangaId)).nodes;

        // A title first seen through a source catalog has no chapters stored
        // locally yet — Suwayomi only scrapes them on demand. Without this the
        // chapter list would sit empty forever.
        if (!chapters.length) {
          clear(scroll).append(spinnerRow('Fetching chapters from source…'));
          const fresh = await api.refreshManga(mangaId);
          manga = fresh.manga || manga;
          chapters = fresh.chapters || [];
        }
      }
      cache.manga.set(mangaId, manga);
      cache.chapters.set(mangaId, { nodes: chapters });
      paint();

      if (!heroTint && manga.thumbnailUrl) {
        const hero = scroll.querySelector('.detail-hero');
        sampleCoverColor(manga.thumbnailUrl).then((tint) => {
          // Scope to this view's own node and bail if it's gone — a global
          // selector would tint whichever manga is on screen when the image
          // finishes decoding.
          if (!tint || disposed || !hero.isConnected) return;
          heroTint = tint;
          hero.style.setProperty('--hero', tint);
        });
      }
    } catch (err) {
      clear(scroll).append(errorBox(err, () => { clear(scroll).append(spinnerRow()); load(); }));
    }
  }

  /* ── actions ─────────────────────────────────────────────────────────── */

  async function toggleLibrary() {
    const next = !manga.inLibrary;
    manga.inLibrary = next;                 // optimistic — paint before the round trip
    paint();
    try {
      await api.setInLibrary(mangaId, next);
      toast(next ? 'Added to library.' : 'Removed from library.');
    } catch (err) {
      manga.inLibrary = !next;              // roll back on failure
      paint();
      toast(err.message);
    }
  }

  async function toggleRead(ch) {
    const next = !ch.isRead;
    const prevPage = ch.lastPageRead;      // restored if the write fails
    ch.isRead = next;
    if (next) ch.lastPageRead = 0;
    paint();
    try {
      await api.updateChapter(ch.id, { isRead: next, ...(next ? { lastPageRead: 0 } : {}) });
    } catch (err) {
      ch.isRead = !next;
      ch.lastPageRead = prevPage;          // else a part-read chapter looks unstarted
      paint();
      toast(err.message);
    }
  }

  /**
   * Bulk read/unread over a slice of the chapter list. `pick` selects which
   * chapters are affected; everything is applied optimistically and rolled
   * back together if the write fails.
   */
  async function setReadBulk(pick, isRead, describe) {
    const targets = (chapters || []).filter((c) => pick(c) && c.isRead !== isRead);
    if (!targets.length) {
      toast(isRead ? 'Those are already read.' : 'Those are already unread.');
      return;
    }

    const before = targets.map((c) => ({ c, isRead: c.isRead, lastPageRead: c.lastPageRead }));
    for (const c of targets) {
      c.isRead = isRead;
      if (isRead) c.lastPageRead = 0;
    }
    paint();

    try {
      await api.updateChapters(targets.map((c) => c.id), {
        isRead,
        ...(isRead ? { lastPageRead: 0 } : {}),
      });
      cache.invalidateManga(mangaId);
      toast(`${describe} ${targets.length} chapter${targets.length === 1 ? '' : 's'}.`);
    } catch (err) {
      for (const b of before) { b.c.isRead = b.isRead; b.c.lastPageRead = b.lastPageRead; }
      paint();
      toast(err.message);
    }
  }

  /** Long-press menu for one chapter. */
  function openChapterMenu(ch, row) {
    row?.classList.add('is-pressed');
    const above = (chapters || []).filter((c) => c.sourceOrder > ch.sourceOrder).length;
    const below = (chapters || []).filter((c) => c.sourceOrder < ch.sourceOrder).length;

    const sheet = actionSheet({
      title: chapterLabel(ch),
      subtitle: ch.isRead ? 'Read' : (ch.lastPageRead > 0 ? `Stopped on page ${ch.lastPageRead + 1}` : 'Unread'),
      actions: [
        {
          label: ch.isRead ? 'Mark unread' : 'Mark read',
          icon: ch.isRead ? ICONS.x : ICONS.check,
          onPick: () => toggleRead(ch),
        },
        below > 0 && {
          label: 'Mark previous read',
          hint: `${below} earlier chapter${below === 1 ? '' : 's'}`,
          icon: ICONS.check,
          onPick: () => setReadBulk((c) => c.sourceOrder < ch.sourceOrder, true, 'Marked read'),
        },
        below > 0 && {
          label: 'Mark previous unread',
          hint: `${below} earlier chapter${below === 1 ? '' : 's'}`,
          icon: ICONS.x,
          onPick: () => setReadBulk((c) => c.sourceOrder < ch.sourceOrder, false, 'Marked unread'),
        },
        above > 0 && {
          label: 'Mark following read',
          hint: `${above} later chapter${above === 1 ? '' : 's'}`,
          icon: ICONS.check,
          onPick: () => setReadBulk((c) => c.sourceOrder > ch.sourceOrder, true, 'Marked read'),
        },
        {
          label: 'Open in reader',
          icon: ICONS.play,
          onPick: () => navigate(`#/reader/${ch.id}`),
        },
      ],
    });

    sheet.addEventListener('click', () => row?.classList.remove('is-pressed'), { once: true });
    screen.append(sheet);
  }

  /** Overflow menu for the whole title. */
  function openTitleMenu() {
    const unreadCount = (chapters || []).filter((c) => !c.isRead).length;
    const readCount = (chapters || []).length - unreadCount;

    screen.append(actionSheet({
      title: manga.title,
      subtitle: `${(chapters || []).length} chapters · ${unreadCount} unread`,
      actions: [
        unreadCount > 0 && {
          label: 'Mark all read',
          hint: `${unreadCount} unread chapter${unreadCount === 1 ? '' : 's'}`,
          icon: ICONS.check,
          onPick: () => setReadBulk(() => true, true, 'Marked read'),
        },
        readCount > 0 && {
          label: 'Mark all unread',
          hint: `${readCount} read chapter${readCount === 1 ? '' : 's'}`,
          icon: ICONS.x,
          danger: true,
          onPick: () => setReadBulk(() => true, false, 'Marked unread'),
        },
        {
          label: prefs.sortDesc ? 'Sort oldest first' : 'Sort newest first',
          icon: ICONS.sort,
          onPick: () => { setPref('sortDesc', !prefs.sortDesc); paint(); },
        },
        {
          label: manga.inLibrary ? 'Remove from library' : 'Add to library',
          icon: ICONS.bookmark,
          onPick: toggleLibrary,
        },
        {
          label: 'Refresh from source',
          hint: 'Re-scrape metadata and the chapter list',
          icon: ICONS.refresh,
          onPick: () => { clear(scroll).append(spinnerRow('Refreshing from source…')); load({ force: true }); },
        },
      ],
    }));
  }

  /* ── paint ───────────────────────────────────────────────────────────── */

  function paint() {
    if (!manga) return;
    for (const d of disposers) d();
    disposers = [];

    const sorted = [...(chapters || [])].sort((a, b) =>
      prefs.sortDesc ? b.sourceOrder - a.sourceOrder : a.sourceOrder - b.sourceOrder);
    const visible = prefs.unreadOnly ? sorted.filter((c) => !c.isRead) : sorted;

    // Resume target: the earliest unread chapter, else the last one read.
    const ascending = [...(chapters || [])].sort((a, b) => a.sourceOrder - b.sourceOrder);
    const resumeCh =
      ascending.find((c) => !c.isRead) ||
      ascending.find((c) => c.id === manga.lastReadChapter?.id) ||
      ascending[0] ||
      null;

    const unread = (chapters || []).filter((c) => !c.isRead).length;
    const genres = Array.isArray(manga.genre) ? manga.genre : (manga.genre ? [manga.genre] : []);

    const hero = el('div', { class: 'detail-hero' },
      el('div', { class: 'detail-topbar' },
        el('button', {
          class: 'icon-btn',
          style: { marginLeft: '-10px' },
          'aria-label': 'Back',
          onClick: () => goBack('#/library'),
        }, icon(ICONS.back, { size: 21 })),
        el('button', {
          class: 'icon-btn',
          'aria-label': 'More actions',
          onClick: openTitleMenu,
        }, icon(ICONS.more, { size: 20, width: 2 })),
      ),

      el('div', { class: 'detail-top', style: { marginTop: 'var(--space-4)' } },
        el('div', { class: 'cover detail-cover' },
          manga.thumbnailUrl ? img(manga.thumbnailUrl, '') : null,
        ),
        el('div', { class: 'detail-info' },
          el('h1', { class: 'detail-title' }, manga.title),
          el('div', { class: 'detail-author' },
            [manga.author, manga.artist].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · ') || 'Unknown author'),
          el('div', { class: 'detail-meta' },
            [
              statusLabel(manga.status),
              manga.source?.displayName || manga.source?.name,
              `${(chapters || []).length} chapters`,
            ].filter(Boolean).join(' · ')),
          genres.length
            ? el('div', { class: 'tags' }, genres.slice(0, 4).map((g) => el('span', { class: 'tag' }, g)))
            : null,
        ),
      ),

      el('div', { style: { display: 'flex', gap: '8px', marginTop: 'var(--space-4)' } },
        el('button', {
          class: manga.inLibrary ? 'btn btn-accent' : 'btn',
          style: { flex: '1' },
          onClick: toggleLibrary,
        },
          icon(ICONS.bookmark, { size: 15 }),
          manga.inLibrary ? 'In library' : 'Add to library',
        ),
        el('button', {
          class: 'btn',
          style: { flex: '1' },
          onClick: () => { clear(scroll).append(spinnerRow('Refreshing from source…')); load({ force: true }); },
        }, icon(ICONS.refresh, { size: 15 }), 'Refresh'),
      ),

      manga.description ? synopsis(manga.description) : null,
    );

    if (heroTint) hero.style.setProperty('--hero', heroTint);

    const bar = el('div', { class: 'chapters-bar' },
      el('div', { class: 'count' },
        `${(chapters || []).length} chapter${(chapters || []).length === 1 ? '' : 's'} · ${unread} unread`),
      el('div', { style: { display: 'flex', gap: '2px', alignItems: 'center' } },
        el('button', {
          class: prefs.unreadOnly ? 'btn btn-sm btn-accent' : 'btn btn-sm',
          onClick: () => { setPref('unreadOnly', !prefs.unreadOnly); paint(); },
        }, 'Unread only'),
        el('button', {
          class: 'icon-btn',
          'aria-label': prefs.sortDesc ? 'Sort oldest first' : 'Sort newest first',
          onClick: () => { setPref('sortDesc', !prefs.sortDesc); paint(); },
        }, icon(ICONS.sort, { size: 17 })),
      ),
    );

    const list = el('div', { style: { display: 'flex', flexDirection: 'column', paddingTop: '8px' } });

    if (!visible.length) {
      list.append(el('div', { class: 'fine', style: { padding: 'var(--space-6)' } },
        prefs.unreadOnly ? 'Every chapter here is read.' : 'No chapters found for this title.'));
    }

    for (const ch of visible) {
      const isCurrent = resumeCh && ch.id === resumeCh.id && !ch.isRead;
      const partial = !ch.isRead && ch.lastPageRead > 0 && ch.pageCount > 0;

      const row = el('div', {
          class: `chapter${ch.isRead ? ' is-read' : ''}${isCurrent ? ' is-current' : ''}`,
          role: 'button',
          tabindex: '0',
          onClick: () => navigate(`#/reader/${ch.id}`),
          onKeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`#/reader/${ch.id}`); }
          },
        },
          el('div', { class: 'chapter-mark' }),
          el('div', { class: 'chapter-main' },
            el('div', { class: 'chapter-name' }, chapterLabel(ch)),
            el('div', { class: 'chapter-sub' },
              el('span', {}, relativeTime(ch.uploadDate) || '—'),
              ch.scanlator ? el('span', {}, ch.scanlator) : null,
              partial
                ? el('span', { class: 'prog' }, `page ${ch.lastPageRead + 1}/${ch.pageCount}`)
                : null,
            ),
          ),
          // Stops propagation so the toggle doesn't also open the reader.
          readToggle(ch),
          !ch.isRead ? el('span', { class: 'chapter-dot' }) : null,
      );

      // Hold a row to open its actions. The helper suppresses the click that
      // would otherwise open the reader on release.
      disposers.push(onLongPress(row, () => openChapterMenu(ch, row)));
      list.append(row);
    }

    clear(scroll).append(hero, bar, list);

    clear(dock);
    if (resumeCh) {
      const label = resumeCh.isRead
        ? `Reread ${chapterLabel(resumeCh)}`
        : (unread === (chapters || []).length ? `Start ${chapterLabel(resumeCh)}` : `Resume ${chapterLabel(resumeCh)}`);
      dock.append(
        el('button', {
          class: 'btn btn-accent btn-block',
          onClick: () => navigate(`#/reader/${resumeCh.id}`),
        }, icon(ICONS.play, { size: 16, fill: true }), label),
      );
    }
  }

  /**
   * Tap toggles this chapter's read state. Holding anywhere on the row (handled
   * by onLongPress in paint) opens the fuller menu instead.
   */
  function readToggle(ch) {
    return el('button', {
      class: `icon-btn${ch.isRead ? ' is-on' : ''}`,
      style: { width: '40px', height: '40px' },
      'aria-label': ch.isRead ? 'Mark unread' : 'Mark read',
      title: 'Tap to toggle · hold the row for more',
      onClick: (e) => { e.stopPropagation(); toggleRead(ch); },
      onContextmenu: (e) => e.preventDefault(),   // suppress the iOS callout
    }, icon(ICONS.check, { size: 16, width: 2 }));
  }

  function synopsis(text) {
    const p = el('p', { class: 'synopsis is-clamped', style: { marginTop: 'var(--space-4)' } }, text);
    const toggle = el('button', { class: 'synopsis-toggle' }, 'More');
    toggle.addEventListener('click', () => {
      const clamped = p.classList.toggle('is-clamped');
      toggle.textContent = clamped ? 'More' : 'Less';
    });
    return el('div', { style: { display: 'flex', flexDirection: 'column' } }, p, toggle);
  }

  if (manga && chapters) paint();
  await load();

  return () => {
    disposed = true;
    for (const d of disposers) d();
    disposers = [];
  };
}
