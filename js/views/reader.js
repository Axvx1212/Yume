// Reader — vertical webtoon with continuous chapter loading, plus paged
// LTR / RTL modes. Chrome toggles on tap; progress is written back to the
// server as you read, and the chapter auto-marks read on finishing.

import * as api from '../api.js';
import { prefs, setPref, cache, chapterLabel, READER_MODES, isIncognito } from '../state.js';
import { el, icon, ICONS, clear, toast, errorBox } from '../dom.js';
import { navigate, goBack, mount } from '../app.js';

export async function renderReader(startChapterId) {
  const scroll = el('div', { class: 'reader-scroll' });
  const chromeHost = el('div');
  const sheetHost = el('div');
  const dim = el('div', { class: 'dim' });
  const pagedHost = el('div');

  const root = el('div', { class: 'reader' }, scroll, pagedHost, chromeHost, sheetHost, dim);
  mount(root);

  /* ── state ───────────────────────────────────────────────────────────── */

  let mangaId = null;
  let mangaTitle = '';
  let allChapters = [];        // ascending by sourceOrder
  let blocks = [];             // [{chapter, pages, node}] in display order
  let activeId = startChapterId;
  let chromeOn = true;
  let settingsOn = false;
  let pageIndex = 0;           // paged mode: index within the active chapter
  let loadingMore = false;
  let disposed = false;
  // Bumped whenever the column is rebuilt. An appendChapter() that was
  // awaiting a page fetch when that happened must not write into the new
  // column — it would leave the chrome and the visible chapter disagreeing.
  let columnGen = 0;

  /** Re-render this route from scratch, disposing the current instance. */
  const reload = () => navigate(`#/reader/${startChapterId}`, { reload: true });

  const mode = () => prefs.readerMode || 'webtoon';
  const isPaged = () => mode() !== 'webtoon';

  const blockOf = (id) => blocks.find((b) => b.chapter.id === id) || null;
  const chapterIndex = (id) => allChapters.findIndex((c) => c.id === id);

  /* ── progress write-back (throttled) ─────────────────────────────────── */

  const savedPage = new Map();     // chapterId -> last page persisted
  // Where the reader actually is, recorded locally even in incognito. Mode
  // switches are a UI action, not history, so they must not lose your place.
  const seenPage = new Map();
  const markedRead = new Set();
  // One timer per chapter. A single shared timer meant moving between chapters
  // cancelled the previous chapter's pending write — and since savedPage was
  // already updated, that write was never retried and the position was lost.
  const saveTimers = new Map();

  function queueProgress(chapterId, page, { immediate = false } = {}) {
    seenPage.set(chapterId, page);  // local only; never leaves the browser
    if (isIncognito()) return;      // reading position is history — don't record it
    if (savedPage.get(chapterId) === page) return;
    savedPage.set(chapterId, page);
    clearTimeout(saveTimers.get(chapterId));
    const send = () => {
      saveTimers.delete(chapterId);
      api.updateChapter(chapterId, { lastPageRead: page }).catch(() => {
        /* progress is best-effort; a failed write shouldn't interrupt reading */
      });
    };
    // The detail screen paints lastPageRead from cache; without this it shows
    // a stale "page X/Y" and resume target after reading part of a chapter.
    if (mangaId != null) cache.invalidateManga(mangaId);

    if (immediate) send();
    else saveTimers.set(chapterId, setTimeout(send, 900));
  }

  async function markRead(chapterId) {
    if (isIncognito()) return;      // finishing a chapter shouldn't mark it read
    if (markedRead.has(chapterId)) return;
    markedRead.add(chapterId);
    const b = blockOf(chapterId);
    const total = b?.pages.length || 0;
    try {
      await api.updateChapter(chapterId, {
        isRead: true,
        ...(total ? { lastPageRead: Math.max(0, total - 1) } : {}),
      });
      const ch = allChapters.find((c) => c.id === chapterId);
      if (ch) ch.isRead = true;
      if (mangaId != null) cache.invalidateManga(mangaId);   // detail must refetch
    } catch {
      markedRead.delete(chapterId);
    }
  }

  /* ── page prefetch queue ─────────────────────────────────────────────── */

  // Keep three page requests in flight at all times, refilling the moment one
  // finishes. Total bytes are the same either way — you read the chapter
  // regardless — so the cap only controls how much of the pipe is busy at
  // once. Three keeps the buffer ahead of a fast scroll; the window below
  // still bounds it, so it never fetches the whole chapter at once.
  const PREFETCH_AHEAD = 5;
  const MAX_IN_FLIGHT = 3;

  let inFlight = 0;
  let anchorPage = 0;      // index (within the whole column) being read

  // Rebuilding this on every observer callback and every pump() was O(n) on a
  // hot path; it only changes when a chapter is added or the column is reset.
  let pageNodeCache = null;
  const invalidatePageNodes = () => { pageNodeCache = null; };

  /** Every page holder across all loaded chapters, in reading order. */
  function allPageNodes() {
    if (!pageNodeCache) pageNodeCache = blocks.flatMap((b) => b.pageNodes);
    return pageNodeCache;
  }

  /**
   * Assign the next pending src, if the window allows it. Re-entrant: called
   * again from every load/error, which is what makes the queue sequential.
   */
  function pump() {
    // In paged mode the webtoon column is hidden (display:none); loading it
    // would download pages the reader never shows. Paged mode does its own
    // current + next-page warming instead.
    if (disposed || isPaged()) return;

    const nodes = allPageNodes();
    if (!nodes.length) return;

    // Fill every free slot, so a finished request is replaced immediately
    // rather than waiting for the next scroll event.
    while (inFlight < MAX_IN_FLIGHT) {
      const from = Math.max(anchorPage, 0);
      const to = Math.min(from + PREFETCH_AHEAD, nodes.length - 1);

      let taken = false;
      for (let i = from; i <= to; i++) {
        if (assign(nodes[i])) { taken = true; break; }
      }
      // Then the page just behind, so scrolling back up isn't blank.
      if (!taken && from > 0) taken = assign(nodes[from - 1]);

      if (!taken) return;      // nothing pending in the window
    }
  }

  function assign(holder) {
    const image = holder?.querySelector('img');
    if (!image || !image.dataset.src) return false;
    image.src = image.dataset.src;
    delete image.dataset.src;      // claimed — never re-assigned
    inFlight += 1;
    return true;
  }

  /* ── loading ─────────────────────────────────────────────────────────── */

  async function loadChapterPages(chapterId) {
    const cached = cache.pages.get(chapterId);
    if (cached) return cached;
    const result = await api.getChapterPages(chapterId);
    cache.pages.set(chapterId, result);
    return result;
  }

  async function boot() {
    try {
      const ch = await api.getChapter(startChapterId);
      if (disposed) return;

      mangaId = ch.mangaId ?? ch.manga?.id ?? null;
      mangaTitle = ch.manga?.title || '';

      const list = cache.chapters.get(mangaId)?.nodes || (await api.getChapters(mangaId)).nodes;
      if (disposed) return;

      allChapters = [...list].sort((a, b) => a.sourceOrder - b.sourceOrder);
      cache.chapters.set(mangaId, { nodes: list });

      await appendChapter(startChapterId, { resume: true });
    } catch (err) {
      // Re-enter through the router so the existing instance is disposed
      // first. Calling renderReader() directly would leave this reader's
      // listeners, observer, and wake lock live alongside the new one.
      clear(scroll).append(errorBox(err, () => reload()));
    }
  }

  /** Append one chapter's pages to the webtoon column. */
  async function appendChapter(chapterId, { resume = false } = {}) {
    if (blockOf(chapterId)) return;

    const gen = columnGen;
    const stale = () => disposed || gen !== columnGen;

    const chapter = allChapters.find((c) => c.id === chapterId)
      || (await api.getChapter(chapterId));
    if (stale()) return;

    const node = el('div', {},
      el('div', { class: 'chapter-sep' },
        el('div', { class: 'line l' }),
        el('div', { class: 'label' }, chapterLabel(chapter)),
        el('div', { class: 'line r' }),
      ),
    );

    const loadingNode = el('div', { class: 'reader-end' },
      el('div', {}, 'Loading pages…'), el('div', { class: 'spinner' }));
    node.append(loadingNode);
    scroll.append(node);

    let result;
    try {
      result = await loadChapterPages(chapterId);
    } catch (err) {
      if (stale()) { node.remove(); return; }
      loadingNode.replaceWith(errorBox(err, () => {
        node.remove();
        blocks = blocks.filter((b) => b.chapter.id !== chapterId);
        invalidatePageNodes();
        appendChapter(chapterId, { resume });
      }));
      return;
    }
    // The column may have been rebuilt while the pages were loading.
    if (stale()) { node.remove(); return; }

    loadingNode.remove();

    const pages = result.pages || [];
    const block = { chapter, pages, node, pageNodes: [] };
    blocks.push(block);

    pages.forEach((src, i) => {
      const holder = el('div', { class: 'page' });

      // Webtoon strips run many thousands of pixels tall, so a fixed
      // placeholder height makes the scrollbar lurch as each one resolves.
      // Reserve the previous page's measured ratio and correct on load.
      const ph = el('div', {
        class: 'page-ph',
        style: { height: `${Math.round(estimatedPageHeight())}px` },
      }, `PAGE ${i + 1}`);
      holder.append(ph);

      // No src yet, and deliberately not loading="lazy": the browser's lazy
      // heuristic triggers on a fixed pixel distance (~1250px), which on a
      // 6000px webtoon strip is a fifth of one page — the buffer collapses to
      // nothing. The queue below drives loading instead, in reading order.
      const image = el('img', { alt: '', decoding: 'async' });
      image.dataset.src = src;
      image.addEventListener('load', () => {
        if (image.dataset.orphaned) return;   // belongs to a discarded column
        if (image.naturalWidth > 0) {
          rememberRatio(image.naturalHeight / image.naturalWidth);
        }
        ph.remove();
        inFlight = Math.max(0, inFlight - 1);
        pump();
      });
      image.addEventListener('error', () => {
        if (image.dataset.orphaned) return;
        ph.textContent = `PAGE ${i + 1} — failed`;
        ph.style.animation = 'none';
        ph.style.height = '220px';
        inFlight = Math.max(0, inFlight - 1);
        pump();
      });
      holder.append(image);

      holder.dataset.chapterId = String(chapterId);
      holder.dataset.page = String(i);
      block.pageNodes.push(holder);
      node.append(holder);
      pageObserver.observe(holder);
    });

    invalidatePageNodes();
    // Only claim focus if this is the chapter the reader actually opened.
    // A chapter appended by the scroll-ahead loader must not retitle the
    // chrome or re-scope the seek bar while you're still reading the one above.
    if (!blocks.length || blocks[0].chapter.id === chapterId || resume) {
      activeId = chapterId;
    }
    ensureEndCap();
    paintChrome();
    pump();      // begin loading this chapter's first pages

    // A chapter shorter than the viewport fires no scroll event, so the
    // scroll-driven loader would never reach the next one and the end cap
    // would spin forever. Check directly once the column has settled.
    requestAnimationFrame(() => {
      if (!disposed && !isPaged() && scroll.scrollHeight <= scroll.clientHeight + 40) {
        loadNextIfAny();
      }
    });

    if (isPaged()) {
      pageIndex = resume ? clampResume(chapter, pages.length) : 0;
      paintPaged();
    } else if (resume) {
      const start = clampResume(chapter, pages.length);
      // Point the prefetch window at the resume position first, or all three
      // slots go to pages 1-3 that the reader is about to scroll straight past.
      if (start > 0) {
        anchorPage = allPageNodes().indexOf(block.pageNodes[start]);
        if (anchorPage < 0) anchorPage = 0;
      }
      if (start > 0) {
        requestAnimationFrame(() => {
          const target = block.pageNodes[start];
          if (target) target.scrollIntoView({ block: 'start' });
        });
      }
    }
  }

  // Rolling average of height/width across pages seen so far, used to size
  // placeholders before their image loads.
  let ratioSum = 0;
  let ratioCount = 0;

  function rememberRatio(r) {
    if (!Number.isFinite(r) || r <= 0) return;
    ratioSum += r;
    ratioCount += 1;
    // After a handful of pages the average is stable; continuing to re-flow
    // the column for every subsequent load buys nothing.
    if (ratioCount <= 8) resizePlaceholders();
  }

  /**
   * Re-size not-yet-loaded placeholders once real page proportions are known.
   * The first guess (2:3) is wildly short for a 6000px webtoon strip, so
   * without this the column keeps growing as you read — which drags the scrub
   * bar's mapping around under you.
   *
   * Only placeholders *below* the viewport are touched: resizing something
   * above would shift the page you're reading.
   */
  let resizeQueued = false;

  function resizePlaceholders() {
    // Coalesce to one pass per frame. Running per image load meant reading
    // offsetTop on every holder and writing styles in the same loop — a forced
    // reflow per iteration, growing with every chapter kept in the column.
    if (resizeQueued) return;
    resizeQueued = true;

    requestAnimationFrame(() => {
      resizeQueued = false;
      if (disposed) return;

      const h = `${Math.round(estimatedPageHeight())}px`;
      const cutoff = scroll.scrollTop + scroll.clientHeight;

      // Read every offset first, then write — never interleave the two.
      const pending = [];
      for (const holder of allPageNodes()) {
        const ph = holder.querySelector('.page-ph');
        if (!ph || !ph.style.height || ph.style.height === h) continue;
        if (holder.offsetTop < cutoff) continue;   // above the fold: leave alone
        pending.push(ph);
      }
      for (const ph of pending) ph.style.height = h;
    });
  }

  function estimatedPageHeight() {
    const width = scroll.clientWidth || window.innerWidth || 402;
    const ratio = ratioCount ? ratioSum / ratioCount : 1.5;   // 2:3 until we know better
    return Math.min(width * ratio, 4000);                     // cap so one strip can't blow out the column
  }

  function clampResume(chapter, total) {
    const last = chapter.lastPageRead || 0;
    if (chapter.isRead) return 0;                 // reread starts at the top
    return Math.min(Math.max(last, 0), Math.max(total - 1, 0));
  }

  /** Trailing element: a loader for the next chapter, or an end-of-series note. */
  function ensureEndCap() {
    scroll.querySelector('.reader-end.is-cap')?.remove();
    const lastBlock = blocks[blocks.length - 1];
    if (!lastBlock) return;

    const idx = chapterIndex(lastBlock.chapter.id);
    const hasNext = idx >= 0 && idx + 1 < allChapters.length;

    const cap = hasNext
      ? el('div', { class: 'reader-end is-cap' },
          el('div', {}, 'Loading next chapter…'),
          el('div', { class: 'spinner' }))
      : el('div', { class: 'reader-end is-cap' },
          el('div', {}, "That's the last chapter available."),
          el('button', {
            class: 'btn btn-sm',
            onClick: () => navigate(mangaId ? `#/manga/${mangaId}` : '#/library'),
          }, 'Back to details'));

    scroll.append(cap);
  }

  /* ── webtoon: track which page is on screen ──────────────────────────── */

  const pageObserver = new IntersectionObserver((entries) => {
    if (isPaged()) return;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const holder = entry.target;
      const chapterId = Number(holder.dataset.chapterId);
      const page = Number(holder.dataset.page);

      if (chapterId !== activeId) { activeId = chapterId; paintChrome(); }
      queueProgress(chapterId, page);
      updateSeek();

      // Move the prefetch window to wherever you actually are.
      const idx = allPageNodes().indexOf(holder);
      if (idx >= 0) { anchorPage = idx; pump(); }

      const block = blockOf(chapterId);
      if (block && page >= block.pages.length - 1) markRead(chapterId);
    }
  }, { rootMargin: '-45% 0px -45% 0px' });

  scroll.addEventListener('scroll', () => {
    if (isPaged()) return;
    updateSeek();

    const nearBottom = scroll.scrollTop > scroll.scrollHeight - scroll.clientHeight - 900;
    if (nearBottom) loadNextIfAny();
  }, { passive: true });

  async function loadNextIfAny() {
    if (loadingMore) return;
    const lastBlock = blocks[blocks.length - 1];
    if (!lastBlock) return;
    const idx = chapterIndex(lastBlock.chapter.id);
    if (idx < 0 || idx + 1 >= allChapters.length) return;

    loadingMore = true;
    try {
      await appendChapter(allChapters[idx + 1].id);
    } finally {
      loadingMore = false;
    }
  }

  /* ── paged mode ──────────────────────────────────────────────────────── */

  function paintPaged() {
    clear(pagedHost);
    if (!isPaged()) { scroll.style.display = ''; return; }

    scroll.style.display = 'none';
    const block = blockOf(activeId);
    if (!block) return;

    const total = block.pages.length;
    pageIndex = Math.min(Math.max(pageIndex, 0), Math.max(total - 1, 0));
    const src = block.pages[pageIndex];

    const stage = el('div', { class: 'paged-stage' });
    if (src) {
      const ph = el('div', { class: 'page-ph paged-ph' }, `PAGE ${pageIndex + 1}`);
      const image = el('img', { alt: '', decoding: 'async' });
      image.addEventListener('load', () => ph.remove());
      image.addEventListener('error', () => { ph.textContent = 'Page failed to load'; });
      image.src = src;
      stage.append(ph, image);

      // Warm the next page only, and only after this one is done, so paged
      // mode never has two image requests hitting the server at once.
      const nextSrc = block.pages[pageIndex + 1];
      if (nextSrc) {
        const warm = () => { new Image().src = nextSrc; };
        if (image.complete) warm();
        else image.addEventListener('load', warm, { once: true });
      }
    }

    // In RTL the visual left edge advances; the handlers swap, not the layout.
    const rtl = mode() === 'rtl';
    stage.append(
      el('div', { class: 'tapzone prev', onClick: () => (rtl ? nextPage() : prevPage()) }),
      el('div', { class: 'tapzone mid', onClick: toggleChrome }),
      el('div', { class: 'tapzone next', onClick: () => (rtl ? prevPage() : nextPage()) }),
    );

    pagedHost.append(el('div', { class: 'paged' }, stage));

    // `total` of 0 means the source returned no pages: nothing was read, so
    // marking it read (0 >= -1) would be wrong.
    if (total > 0) {
      queueProgress(activeId, pageIndex);
      if (pageIndex >= total - 1) markRead(activeId);
    }
    updateSeek();
  }

  function nextPage() {
    const block = blockOf(activeId);
    if (!block) return;
    if (pageIndex < block.pages.length - 1) {
      pageIndex += 1;
      paintPaged();
    } else {
      goChapter(+1);
    }
  }

  function prevPage() {
    if (pageIndex > 0) {
      pageIndex -= 1;
      paintPaged();
    } else {
      goChapter(-1, { toEnd: true });
    }
  }

  /* ── chapter navigation ──────────────────────────────────────────────── */

  async function goChapter(delta, { toEnd = false } = {}) {
    const idx = chapterIndex(activeId);
    const target = allChapters[idx + delta];
    if (!target) {
      toast(delta > 0 ? 'No next chapter.' : 'No previous chapter.');
      return;
    }

    // Reset to a single-chapter column; continuous scroll re-grows from here.
    // Detaching an <img> does NOT abort its fetch, and its load/error handler
    // still fires on the detached element — so the outgoing images have to be
    // disowned explicitly, or their late handlers would decrement inFlight
    // below zero and let pump() exceed the concurrency cap.
    for (const holder of allPageNodes()) {
      const image = holder.querySelector('img');
      if (!image) continue;
      image.dataset.orphaned = '1';
      // Marking it isn't enough: detaching does not abort the fetch, so the
      // old request would still occupy a connection alongside the new
      // column's. Clearing src is the only way to actually cancel it.
      if (image.getAttribute('src')) image.removeAttribute('src');
    }
    columnGen += 1;
    blocks = [];
    invalidatePageNodes();
    clear(scroll);
    anchorPage = 0;
    inFlight = 0;
    activeId = target.id;
    pageIndex = 0;
    await appendChapter(target.id);

    if (toEnd) {
      const block = blockOf(target.id);
      if (block) {
        if (isPaged()) { pageIndex = Math.max(block.pages.length - 1, 0); paintPaged(); }
        else requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
      }
    } else {
      scroll.scrollTop = 0;
    }
    paintChrome();
  }

  /* ── chrome ──────────────────────────────────────────────────────────── */

  function toggleChrome() {
    chromeOn = !chromeOn;
    paintChrome();
  }

  // Chrome toggles on a *tap*, detected directly on the scrolling element.
  // An overlay would intercept touches and make the page unscrollable, so the
  // tap is separated from a drag by distance and by whether the view scrolled.
  let tapStart = null;

  scroll.addEventListener('pointerdown', (e) => {
    if (isPaged()) return;
    tapStart = { x: e.clientX, y: e.clientY, top: scroll.scrollTop, t: Date.now() };
  }, { passive: true });

  scroll.addEventListener('pointercancel', () => { tapStart = null; }, { passive: true });

  scroll.addEventListener('pointerup', (e) => {
    if (isPaged() || !tapStart) return;
    const moved = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y);
    const scrolled = Math.abs(scroll.scrollTop - tapStart.top);
    const quick = Date.now() - tapStart.t < 500;
    tapStart = null;
    // A finger never lands perfectly still; 10px absorbs that without
    // swallowing a real drag.
    if (moved < 10 && scrolled < 4 && quick) toggleChrome();
  }, { passive: true });

  let seekEl = null;
  let seekLeft = null;
  let seekRight = null;
  let seeking = false;      // true while the slider is being dragged
  let pagedSeekTimer = null;

  function updateSeek() {
    if (!seekEl || seeking) return;   // never fight the user's drag
    const block = blockOf(activeId);
    if (!block) return;

    if (isPaged()) {
      const total = block.pages.length || 1;
      seekEl.value = String(Math.round(((pageIndex + 1) / total) * 100));
      seekLeft.textContent = `Page ${pageIndex + 1}`;
      seekRight.textContent = `${total} pages`;
    } else {
      // Position within the current chapter, matching what the slider drags.
      const span = chapterSpan(block);
      const pct = span
        ? Math.min(Math.max(Math.round(((scroll.scrollTop - span.top) / span.height) * 100), 0), 100)
        : 0;
      seekEl.value = String(pct);
      seekLeft.textContent = `${pct}%`;
      seekRight.textContent = chapterLabel(block.chapter);
    }
  }

  function paintChrome() {
    clear(chromeHost);
    if (!chromeOn) return;

    const block = blockOf(activeId);
    const label = block ? chapterLabel(block.chapter) : '';
    const modeLabel = mode() === 'webtoon' ? 'vertical' : mode() === 'ltr' ? 'paged L→R' : 'paged R→L';

    seekEl = el('input', {
      type: 'range', min: '0', max: '100', value: '0',
      'aria-label': 'Reading position',
    });
    seekEl.addEventListener('input', onSeek);
    // Touch and mouse both need an explicit start/end so the scroll handler
    // knows to stay out of the way for the duration of the drag.
    for (const ev of ['pointerdown', 'touchstart']) {
      seekEl.addEventListener(ev, () => { seeking = true; }, { passive: true });
    }
    for (const ev of ['pointerup', 'pointercancel', 'touchend', 'touchcancel', 'change']) {
      seekEl.addEventListener(ev, () => {
        seeking = false;
        if (isPaged()) { clearTimeout(pagedSeekTimer); paintPaged(); }
        updateSeek();
      }, { passive: true });
    }

    seekLeft = el('span', {}, '0%');
    seekRight = el('span', {}, label);

    chromeHost.append(
      el('div', { class: 'chrome' },
        el('div', { class: 'chrome-top' },
          el('button', {
            class: 'icon-btn',
            'aria-label': 'Back',
            onClick: () => goBack(mangaId ? `#/manga/${mangaId}` : '#/library'),
          }, icon(ICONS.back, { size: 21 })),
          el('div', { class: 'chrome-title' },
            el('div', { class: 't' }, mangaTitle || 'Reading'),
            el('div', { class: 's', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              el('span', {}, `${label}${label ? ' · ' : ''}${modeLabel}`),
              isIncognito() ? el('span', { class: 'incognito-tag' }, 'Incognito') : null,
            ),
          ),
          el('button', {
            class: 'icon-btn',
            'aria-label': 'Reader settings',
            onClick: () => { settingsOn = true; paintSheet(); },
          }, icon(ICONS.settings, { size: 20, width: 1.7 })),
        ),
        el('div', { class: 'chrome-bottom' },
          el('button', { class: 'btn btn-sm', onClick: () => goChapter(-1) },
            icon(ICONS.back, { size: 14, width: 2 }), 'Prev'),
          el('div', { class: 'seek' },
            seekEl,
            el('div', { class: 'seek-labels' }, seekLeft, seekRight),
          ),
          el('button', { class: 'btn btn-sm', onClick: () => goChapter(+1) },
            'Next', icon(ICONS.forward, { size: 14, width: 2 })),
        ),
      ),
    );

    updateSeek();
  }

  /**
   * Drag the slider to move through the *current chapter*. Scoping it to the
   * chapter (rather than the whole loaded column) keeps the mapping stable as
   * more chapters load underneath.
   */
  function onSeek(e) {
    const v = Number(e.target.value);
    const block = blockOf(activeId);
    if (!block) return;

    if (isPaged()) {
      const total = block.pages.length || 1;
      pageIndex = Math.min(Math.max(Math.round((v / 100) * total) - 1, 0), total - 1);
      // Repainting on every input event would fire a full-size image request
      // per intermediate slider value — dozens per drag. Update the label now
      // and render the page the drag settles on.
      if (seekLeft) seekLeft.textContent = `Page ${pageIndex + 1}`;
      clearTimeout(pagedSeekTimer);
      pagedSeekTimer = setTimeout(paintPaged, 140);
      return;
    }

    const span = chapterSpan(block);
    if (!span) return;
    scroll.scrollTop = span.top + (span.height * v) / 100;
    // Reflect the drag immediately; the scroll handler is muted while seeking.
    if (seekLeft) seekLeft.textContent = `${Math.round(v)}%`;
  }

  /** Scroll offset and height of one chapter's slice of the column. */
  function chapterSpan(block) {
    const first = block.pageNodes[0] || block.node;
    if (!first) return null;
    const top = first.offsetTop;
    const last = block.pageNodes[block.pageNodes.length - 1];
    const bottom = last ? last.offsetTop + last.offsetHeight : top + scroll.clientHeight;
    // Subtract a viewport so dragging to 100% lands on the chapter's last
    // screen rather than scrolling past it into the next chapter.
    const height = Math.max(bottom - top - scroll.clientHeight, 1);
    return { top, height };
  }

  /* ── settings sheet ──────────────────────────────────────────────────── */

  function paintSheet() {
    clear(sheetHost);
    if (!settingsOn) return;

    const close = () => { settingsOn = false; paintSheet(); };

    const brightness = el('input', {
      type: 'range', min: '20', max: '100', value: String(prefs.brightness),
      'aria-label': 'Brightness',
    });
    brightness.addEventListener('input', () => {
      setPref('brightness', Number(brightness.value));
      applyDim();
    });

    sheetHost.append(
      el('div', { class: 'sheet-wrap' },
        el('button', { class: 'sheet-backdrop', 'aria-label': 'Close settings', onClick: close }),
        el('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Reader settings' },
          el('div', { class: 'sheet-grip' }),
          el('div', { class: 'sheet-group' },
            el('div', { class: 'section-label' }, 'Reading mode'),
            READER_MODES.map((m) => el('button', {
              class: 'opt',
              role: 'radio',
              'aria-checked': String(mode() === m.id),
              onClick: () => switchMode(m.id),
            },
              el('span', { class: 'opt-dot' }),
              el('span', { class: 'opt-text' },
                el('span', { class: 'l' }, m.label),
                el('span', { class: 'h' }, m.hint),
              ),
            )),
          ),
          el('div', { class: 'sheet-group' },
            el('div', { class: 'section-label' }, 'Brightness'),
            brightness,
          ),
          el('button', { class: 'btn btn-accent btn-block', onClick: close }, 'Done'),
        ),
      ),
    );
  }

  function switchMode(id) {
    if (mode() === id) return;
    const wasPaged = isPaged();
    setPref('readerMode', id);

    // Carry the reading position across the mode change.
    const block = blockOf(activeId);
    if (block) {
      if (!wasPaged && isPaged()) {
        const seen = seenPage.get(activeId);
        pageIndex = Number.isFinite(seen) ? seen : 0;
      }
    }

    settingsOn = false;
    paintSheet();

    if (isPaged()) {
      paintPaged();
    } else {
      clear(pagedHost);
      scroll.style.display = '';
      const target = block?.pageNodes?.[pageIndex];
      if (target) requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
    }
    paintChrome();
  }

  function applyDim() {
    dim.style.opacity = String((100 - prefs.brightness) / 220);
  }

  /* ── wake lock — keep the screen on while reading ────────────────────── */

  let wakeLock = null;

  async function acquireWakeLock() {
    if (!prefs.keepScreenOn || !('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => { wakeLock = null; });
    } catch {
      /* denied, or the tab isn't visible — reading still works without it */
    }
  }

  function releaseWakeLock() {
    try { wakeLock?.release(); } catch { /* already gone */ }
    wakeLock = null;
  }

  // iOS drops the lock whenever the tab is backgrounded; re-take it on return.
  function onVisibility() {
    if (document.visibilityState === 'visible' && !wakeLock) acquireWakeLock();
    else if (document.visibilityState === 'hidden') flushProgress();
  }
  document.addEventListener('visibilitychange', onVisibility);

  // Backgrounding or closing the PWA is the usual way to leave a reader on
  // iOS, and it can happen inside the 900ms debounce — without this the last
  // position is simply lost. pagehide is the one event iOS fires reliably.
  function onPageHide() { flushProgress(); }
  window.addEventListener('pagehide', onPageHide);

  /** Send every pending position write immediately. Safe to call repeatedly. */
  function flushProgress() {
    for (const [chapterId, timer] of saveTimers) {
      clearTimeout(timer);
      const page = savedPage.get(chapterId);
      if (Number.isFinite(page)) {
        api.updateChapter(chapterId, { lastPageRead: page }).catch(() => {});
      }
    }
    saveTimers.clear();
  }

  /* ── keyboard (desktop convenience) ──────────────────────────────────── */

  function onKey(e) {
    if (e.key === 'Escape') {
      if (settingsOn) { settingsOn = false; paintSheet(); }
      else goBack(mangaId ? `#/manga/${mangaId}` : '#/library');
    } else if (isPaged() && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      const forward = mode() === 'rtl' ? e.key === 'ArrowLeft' : e.key === 'ArrowRight';
      forward ? nextPage() : prevPage();
    }
  }
  window.addEventListener('keydown', onKey);

  applyDim();
  paintChrome();
  acquireWakeLock();
  await boot();

  return () => {
    disposed = true;
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVisibility);
    releaseWakeLock();
    pageObserver.disconnect();

    window.removeEventListener('pagehide', onPageHide);
    // Flush every chapter with a pending write, not just the active one, so
    // leaving mid-session never drops a position. Nothing is queued while
    // incognito, so this is naturally a no-op then.
    flushProgress();
  };
}
