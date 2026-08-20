// In-memory state plus a small localStorage layer for UI convenience.
// Deliberately not an offline cache — chapters are always fetched live, per
// the project's v1 scope decisions.

const LS_KEY = 'yume.prefs.v1';

const DEFAULTS = {
  lastTab: 'library',       // which tab bar entry to restore
  libraryCategory: null,    // null = All
  gridCols: 3,
  readerMode: 'webtoon',    // webtoon | ltr | rtl
  brightness: 100,
  keepScreenOn: true,
  tapZones: true,
  browseTab: 'search',
  lastQuery: '',              // Results tab: title search
  lastSourcesFilter: '',      // Sources tab: source name filter
  lastExtensionsFilter: '',   // Extensions tab: extension name search
  browseSource: null,
  unreadOnly: false,
  sortDesc: true,
  incognito: false,           // when on, reading writes nothing back to the server
};

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export const prefs = load();

let saveTimer = null;
export function savePrefs() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(prefs));
    } catch {
      /* private mode / quota — preferences just don't persist, no user impact */
    }
  }, 120);
}

export function setPref(key, value) {
  prefs[key] = value;
  savePrefs();
  return value;
}

/**
 * Session cache — survives navigation within a session so going Detail →
 * Reader → back doesn't refetch, but never written to disk.
 */
export const cache = {
  manga: new Map(),      // id -> manga
  chapters: new Map(),   // mangaId -> {totalCount, nodes}
  pages: new Map(),      // chapterId -> {pages, chapter}
  sources: null,
  categories: null,

  invalidateManga(id) {
    this.manga.delete(Number(id));
    this.chapters.delete(Number(id));
  },
  clear() {
    this.manga.clear();
    this.chapters.clear();
    this.pages.clear();
    this.sources = null;
    this.categories = null;
  },
};

/* ── shared helpers ────────────────────────────────────────────────────── */

/** Suwayomi LongString timestamps are epoch millis in a string. */
export function toDate(longString) {
  const n = Number(longString);
  return Number.isFinite(n) && n > 0 ? new Date(n) : null;
}

export function relativeTime(longString) {
  const d = toDate(longString);
  if (!d) return '';
  const secs = (Date.now() - d.getTime()) / 1000;
  if (secs < 60) return 'just now';
  const mins = secs / 60;
  if (mins < 60) return `${Math.floor(mins)}m ago`;
  const hrs = mins / 60;
  if (hrs < 24) return `${Math.floor(hrs)}h ago`;
  const days = hrs / 24;
  if (days < 30) return `${Math.floor(days)}d ago`;
  const months = days / 30;
  if (months < 12) return `${Math.floor(months)}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** Chapter display name — sources are inconsistent, so fall back sensibly. */
export function chapterLabel(ch) {
  if (ch.name && ch.name.trim()) return ch.name.trim();
  const n = ch.chapterNumber;
  if (Number.isFinite(n) && n >= 0) {
    return `Chapter ${Number.isInteger(n) ? n : n.toFixed(1)}`;
  }
  return `Chapter ${ch.sourceOrder}`;
}

/**
 * Incognito: read without leaving a trace on the server. Suppresses every
 * write the act of reading would otherwise perform — progress position and
 * auto mark-read. Deliberately does NOT block writes the user asks for
 * explicitly (adding to the library, tapping a chapter's read toggle): those
 * are intentional actions, not history.
 */
export const isIncognito = () => !!prefs.incognito;

/** Reading modes — consumed by both the reader's sheet and the More screen. */
export const READER_MODES = [
  { id: 'webtoon', label: 'Vertical (webtoon)', hint: 'Continuous scroll, chapters load as you go' },
  { id: 'ltr', label: 'Paged — left to right', hint: 'Tap the right edge to advance' },
  { id: 'rtl', label: 'Paged — right to left', hint: 'Traditional manga direction' },
];

/** Library grid density cycle, shared by the Library header and More. */
export const GRID_COLS = [2, 3, 4];
export function nextGridCols(current) {
  const i = GRID_COLS.indexOf(current);
  return GRID_COLS[(i + 1) % GRID_COLS.length] ?? 3;
}

const STATUS_LABELS = {
  ONGOING: 'Ongoing',
  COMPLETED: 'Completed',
  LICENSED: 'Licensed',
  PUBLISHING_FINISHED: 'Publishing finished',
  CANCELLED: 'Cancelled',
  ON_HIATUS: 'On hiatus',
  UNKNOWN: 'Unknown status',
};
export const statusLabel = (s) => STATUS_LABELS[s] || 'Unknown status';
