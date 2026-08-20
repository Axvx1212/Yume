// GraphQL client for Suwayomi-Server.
//
// Every operation here was introspected and executed against the live server
// (v2.3.2243) before being written — see SCHEMA.md for the transcript and the
// gotchas. Requests go to a same-origin /api/graphql, which the dev server and
// nginx both reverse-proxy to Suwayomi, so there is no CORS involved.

const ENDPOINT = '/api/graphql';

export class ApiError extends Error {
  constructor(message, { query, detail } = {}) {
    super(message);
    this.name = 'ApiError';
    this.query = query;
    this.detail = detail;
  }
}

/** Run one GraphQL document. Throws ApiError on transport or GraphQL errors. */
export async function gql(query, variables = {}) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
  } catch (cause) {
    throw new ApiError("Can't reach the server.", { query, detail: String(cause) });
  }

  if (!res.ok) {
    throw new ApiError(`Server returned ${res.status} ${res.statusText}.`, { query });
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new ApiError('Server sent a response that was not JSON.', { query });
  }

  if (body.errors?.length) {
    throw new ApiError(body.errors[0].message, { query, detail: JSON.stringify(body.errors) });
  }
  return body.data;
}

/* ── fragments ─────────────────────────────────────────────────────────── */

const MANGA_CARD = `
  id title thumbnailUrl inLibrary unreadCount
`;

// The library grid also draws a progress rail, which needs the chapter total
// alongside the unread count.
const MANGA_SHELF = `
  id title thumbnailUrl inLibrary unreadCount
  chapters { totalCount }
`;

const MANGA_FULL = `
  id title author artist description genre status inLibrary thumbnailUrl unreadCount
  sourceId realUrl
  source { id name displayName }
  categories { nodes { id name } }
  lastReadChapter { id sourceOrder chapterNumber }
  firstUnreadChapter { id sourceOrder chapterNumber }
`;

const CHAPTER = `
  id name chapterNumber sourceOrder isRead isBookmarked isDownloaded
  lastPageRead pageCount uploadDate scanlator mangaId
`;

/* ── library ───────────────────────────────────────────────────────────── */

export function getCategories() {
  return gql(`{ categories(order:{by:ORDER}) { nodes { id name order default } } }`)
    .then((d) => d.categories.nodes);
}

/**
 * Library contents. `categoryId` of null means "everything in the library",
 * which is what the All tab shows.
 */
export function getLibrary(categoryId = null) {
  const cond = categoryId == null
    ? '{inLibrary: true}'
    : `{inLibrary: true, categoryIds: ${Number(categoryId)}}`;
  return gql(`{
    mangas(condition: ${cond}, order: {by: TITLE, byType: ASC}) {
      totalCount
      nodes { ${MANGA_SHELF} }
    }
  }`).then((d) => d.mangas);
}

/** Per-category counts for the category strip, in one round trip. */
export async function getCategoryCounts(categoryIds) {
  if (!categoryIds.length) return {};
  const parts = categoryIds
    .map((id) => `c${id}: mangas(condition:{inLibrary:true, categoryIds:${Number(id)}}) { totalCount }`)
    .join('\n');
  const data = await gql(`{ all: mangas(condition:{inLibrary:true}) { totalCount }\n${parts} }`);
  const out = { all: data.all.totalCount };
  for (const id of categoryIds) out[id] = data[`c${id}`].totalCount;
  return out;
}

/* ── manga detail ──────────────────────────────────────────────────────── */

export function getManga(id) {
  return gql(`query M($id: Int!) { manga(id: $id) { ${MANGA_FULL} } }`, { id: Number(id) })
    .then((d) => d.manga);
}

export function getChapters(mangaId) {
  return gql(
    `query C($id: Int!) {
      chapters(condition: {mangaId: $id}, order: {by: SOURCE_ORDER, byType: DESC}) {
        totalCount
        nodes { ${CHAPTER} }
      }
    }`,
    { id: Number(mangaId) },
  ).then((d) => d.chapters);
}

/**
 * Pull fresh manga + chapters from the source site. Slow (it's a live scrape),
 * so the UI calls it explicitly on pull-to-refresh rather than on every visit.
 */
export function refreshManga(id) {
  return gql(
    `mutation R($id: Int!) {
      fetchMangaAndChapters(input: {id: $id, fetchManga: true, fetchChapters: true}) {
        manga { ${MANGA_FULL} }
        chapters { ${CHAPTER} }
      }
    }`,
    { id: Number(id) },
  ).then((d) => d.fetchMangaAndChapters);
}

/* ── reader ────────────────────────────────────────────────────────────── */

export function getChapter(id) {
  return gql(`query Ch($id: Int!) { chapter(id: $id) { ${CHAPTER} manga { id title } } }`, {
    id: Number(id),
  }).then((d) => d.chapter);
}

/**
 * Page image URLs for a chapter. Must be called before reading — a chapter's
 * `pageCount` sits at -1 until this runs. Returns server-relative URLs that
 * the proxy serves same-origin.
 */
export function getChapterPages(chapterId) {
  return gql(
    `mutation P($id: Int!) {
      fetchChapterPages(input: {chapterId: $id}) {
        pages
        chapter { id pageCount lastPageRead }
      }
    }`,
    { id: Number(chapterId) },
  ).then((d) => d.fetchChapterPages);
}

/* ── progress ──────────────────────────────────────────────────────────── */

export function updateChapter(id, patch) {
  return gql(
    `mutation U($id: Int!, $patch: UpdateChapterPatchInput!) {
      updateChapter(input: {id: $id, patch: $patch}) {
        chapter { id isRead lastPageRead isBookmarked }
      }
    }`,
    { id: Number(id), patch },
  ).then((d) => d.updateChapter.chapter);
}

export function updateChapters(ids, patch) {
  if (!ids.length) return Promise.resolve([]);
  return gql(
    `mutation UM($ids: [Int!]!, $patch: UpdateChapterPatchInput!) {
      updateChapters(input: {ids: $ids, patch: $patch}) {
        chapters { id isRead lastPageRead }
      }
    }`,
    { ids: ids.map(Number), patch },
  ).then((d) => d.updateChapters.chapters);
}

/* ── library membership ────────────────────────────────────────────────── */

export function setInLibrary(mangaId, inLibrary) {
  return gql(
    `mutation L($id: Int!, $v: Boolean!) {
      updateManga(input: {id: $id, patch: {inLibrary: $v}}) {
        manga { id inLibrary }
      }
    }`,
    { id: Number(mangaId), v: !!inLibrary },
  ).then((d) => d.updateManga.manga);
}

export function setMangaCategories(mangaId, addIds, removeIds) {
  return gql(
    `mutation MC($id: Int!, $add: [Int!], $rm: [Int!]) {
      updateMangaCategories(input: {id: $id, patch: {addToCategories: $add, removeFromCategories: $rm}}) {
        manga { id categories { nodes { id name } } }
      }
    }`,
    { id: Number(mangaId), add: addIds.map(Number), rm: removeIds.map(Number) },
  ).then((d) => d.updateMangaCategories.manga);
}

/* ── sources & search ──────────────────────────────────────────────────── */

export function getSources() {
  return gql(`{
    sources { nodes { id name displayName lang iconUrl supportsLatest isConfigurable } }
  }`).then((d) => d.sources.nodes);
}

/**
 * Search one source. This is a mutation because it scrapes the source live;
 * results are persisted server-side, so each carries a real manga id.
 */
export function searchSource(sourceId, query, page = 1) {
  return gql(
    `mutation S($src: LongString!, $q: String!, $page: Int!) {
      fetchSourceManga(input: {source: $src, type: SEARCH, query: $q, page: $page}) {
        hasNextPage
        mangas { ${MANGA_CARD} }
      }
    }`,
    { src: String(sourceId), q: query, page: Number(page) },
  ).then((d) => d.fetchSourceManga);
}

/** POPULAR / LATEST browse for one source. */
export function browseSource(sourceId, type = 'POPULAR', page = 1) {
  return gql(
    `mutation B($src: LongString!, $type: FetchSourceMangaType!, $page: Int!) {
      fetchSourceManga(input: {source: $src, type: $type, page: $page}) {
        hasNextPage
        mangas { ${MANGA_CARD} }
      }
    }`,
    { src: String(sourceId), type, page: Number(page) },
  ).then((d) => d.fetchSourceManga);
}

/* ── extensions ────────────────────────────────────────────────────────── */

const EXTENSION = `
  pkgName name lang versionName isInstalled hasUpdate isObsolete iconUrl
`;

export function getInstalledExtensions() {
  return gql(`{
    extensions(condition: {isInstalled: true}, order: {by: NAME, byType: ASC}) {
      totalCount
      nodes { ${EXTENSION} }
    }
  }`).then((d) => d.extensions);
}

/**
 * Available (not installed) extensions. There are ~1400 of them, so this is
 * always filtered — by name when the user is searching, by language otherwise —
 * and hard-capped by `limit`.
 */
export function getAvailableExtensions({ search = '', langs = [], limit = 60 } = {}) {
  const clauses = [`isInstalled: {equalTo: false}`];
  if (search.trim()) {
    clauses.push(`name: {includesInsensitive: ${JSON.stringify(search.trim())}}`);
  }
  if (langs.length) {
    clauses.push(`lang: {in: ${JSON.stringify(langs)}}`);
  }
  return gql(`{
    extensions(filter: {${clauses.join(', ')}}, order: {by: NAME, byType: ASC}, first: ${Number(limit)}) {
      totalCount
      nodes { ${EXTENSION} }
    }
  }`).then((d) => d.extensions);
}

/** install / update / uninstall — `id` is the package name. */
export function setExtension(pkgName, patch) {
  return gql(
    `mutation E($id: String!, $patch: UpdateExtensionPatchInput!) {
      updateExtension(input: {id: $id, patch: $patch}) {
        extension { ${EXTENSION} }
      }
    }`,
    { id: pkgName, patch },
  ).then((d) => d.updateExtension.extension);
}

export const installExtension = (pkg) => setExtension(pkg, { install: true });
export const uninstallExtension = (pkg) => setExtension(pkg, { uninstall: true });
export const upgradeExtension = (pkg) => setExtension(pkg, { update: true });

/** Re-pull the extension index from the configured repos. */
export function refreshExtensions() {
  return gql(`mutation { fetchExtensions(input: {}) { extensions { pkgName } } }`)
    .then((d) => d.fetchExtensions.extensions.length);
}

/* ── server ────────────────────────────────────────────────────────────── */

export function aboutServer() {
  return gql(`{ aboutServer { name version revision buildType buildTime } }`)
    .then((d) => d.aboutServer);
}
