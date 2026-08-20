# Suwayomi GraphQL — verified operations

Introspected live against `http://your-server:4567/api/graphql`.
Server: **Suwayomi-Server v2.3.2243** (r2243, Stable).

Everything below was executed against the live server, not just read off the schema.

## Server state at time of introspection

| Thing | Value |
|---|---|
| Library manga | 0 (empty) |
| Categories | 1 — `{id: 0, name: "Default", default: true}` |
| Sources | 2 — Local source (`0`), Asura Scans (`6247824327199706550`) |
| Extensions installed | 1 — `eu.kanade.tachiyomi.extension.en.asurascans` v1.6.67 |
| Extensions available | 1369 |

## Queries

```graphql
# Library — MangaConditionInput.inLibrary, optional categoryIds
mangas(condition: {inLibrary: true, categoryIds: 0}) {
  totalCount
  nodes { id title thumbnailUrl unreadCount inLibrary lastReadChapter { id sourceOrder } }
}

categories { nodes { id name order default } }
category(id: Int) { id name mangas { nodes { ... } } }   # also works for per-category library

manga(id: Int) {
  id title author artist description genre status inLibrary thumbnailUrl unreadCount
  categories { nodes { id name } }
  lastReadChapter { id sourceOrder }
  firstUnreadChapter { id sourceOrder chapterNumber }
}

chapters(condition: {mangaId: Int}, order: {by: SOURCE_ORDER, byType: DESC}) {
  totalCount
  nodes { id name chapterNumber sourceOrder isRead lastPageRead pageCount uploadDate scanlator isBookmarked isDownloaded }
}

sources { nodes { id name displayName lang iconUrl supportsLatest } }

extensions(condition: {isInstalled: true}) {
  nodes { pkgName name lang versionName isInstalled hasUpdate isObsolete iconUrl }
}
extensions(filter: {name: {includesInsensitive: "asura"}}, first: 3) { ... }
```

Every list type is a `*NodeList` — `{ nodes, edges, pageInfo, totalCount }`. Pagination
args are `first / last / offset / before / after` (Relay-style `Cursor`).

## Mutations

```graphql
# Source search — this is a MUTATION, not a query
fetchSourceManga(input: {source: LongString, type: SEARCH, query: String, page: Int}) {
  hasNextPage
  mangas { id title thumbnailUrl inLibrary url }
}
# FetchSourceMangaType: SEARCH | POPULAR | LATEST

# Manga detail + chapter list refresh from source
fetchMangaAndChapters(input: {id: Int, fetchManga: true, fetchChapters: true}) {
  manga { ... }
  chapters { ... }
}

# Chapter pages — also a mutation. Returns relative image URLs.
fetchChapterPages(input: {chapterId: Int}) {
  pages                       # ["/api/v1/manga/73/chapter/1/page/0", ...]
  chapter { id pageCount lastPageRead }
}

# Reading progress
updateChapter(input: {id: Int, patch: {isRead: Boolean, lastPageRead: Int, isBookmarked: Boolean}}) {
  chapter { id isRead lastPageRead }
}
updateChapters(input: {ids: [Int], patch: {...}})   # bulk

# Library membership
updateManga(input: {id: Int, patch: {inLibrary: Boolean}}) { manga { id inLibrary } }
updateMangaCategories(input: {id: Int, patch: {addToCategories: [Int], removeFromCategories: [Int], clearCategories: Boolean}})

# Extensions — `id` is the pkgName string
updateExtension(input: {id: String, patch: {install: Boolean, uninstall: Boolean, update: Boolean}}) {
  extension { pkgName isInstalled hasUpdate versionName }
}
fetchExtensions(input: {}) { extensions { ... } }    # refresh the available list from repos
```

## Gotchas found by testing

1. **`pageCount` is `-1`** on a chapter until `fetchChapterPages` has run for it. Don't
   render a page count from the chapter list; call the mutation first.
2. **Page image URLs key off `sourceOrder`, not chapter `id`** —
   `/api/v1/manga/{mangaId}/chapter/{sourceOrder}/page/{n}`. Chapter 1 is `id: 84` but
   `sourceOrder: 1`. Use the `pages` array the mutation returns rather than building URLs.
3. **`genre` is `[String]`**, not a comma-joined `String`.
4. **Search is a mutation** (`fetchSourceManga`), because it hits the source's site. It
   also persists the results as manga rows server-side, which is why results already
   carry a real `id` and `inLibrary`.
5. **All image URLs are relative** (`/api/v1/...`) — they slot straight into the
   reverse proxy with no rewriting.
6. `uploadDate` / `inLibraryAt` / etc. are `LongString` — epoch millis **as a string**.
   `Number()` them before `new Date()`.
7. Extension icons live at `/api/v1/extension/icon/{apkName-ish}` — served under the
   same `/api` prefix, so they proxy identically.

## Follow-up findings (source browsing)

8. **`fetchSourceManga` with `type: POPULAR` / `LATEST`** drives a source's
   catalog — 20 titles a page with `hasNextPage`. Same mutation as search, so
   one code path covers all three listings.
9. **A manga discovered through a catalog has no chapters stored locally.**
   `chapters(condition:{mangaId})` returns 0 until `fetchMangaAndChapters` runs
   for it. The detail view calls it automatically when it finds an empty list.
10. **`updateExtension` returns `extension: null`, with no `errors` array, when
    the `pkgName` doesn't exist.** A silent null is the only signal that the
    package name was wrong.
11. Cover thumbnails take **2.5–5.6s** on first request while the server fetches
    them from the source, then are cached and fast.

## UI notes (not schema, but hard-won)

12. **A full-bleed overlay for tap detection breaks touch scrolling.** An
    `inset: 0` sibling above the scroller swallows every gesture — the page
    looks frozen. Detect taps on the scrolling element itself instead, and
    distinguish tap from drag by movement + scroll delta + duration.
13. **Setting `scrollTop` in a test does not prove a page is scrollable** — it
    bypasses hit-testing entirely. Only a synthesized *touch* gesture
    (`Input.synthesizeScrollGesture`) catches an overlay blocking input.
14. **A range input fights its own handler** if the scroll listener writes the
    slider value back while the user is dragging. Mute the writeback between
    pointerdown and pointerup.

## Reader prefetch (measured against Reimei)

Page images here run **234KB–1.1MB each**, so concurrency, not request count,
is what a server feels. Measured with the Resource Timing API and CDP network
events, cache disabled:

| | before | after |
|---|---|---|
| Peak concurrent image requests | 3–4 (browser-chosen) | **3** (hard cap) |
| Pages ready ahead while reading | ~1, sometimes 0 | **5.0** |
| Stalls (page not decoded on arrival) | — | **0 / 16** |
| Requests for a 40-page column | — | 22 (windowed, not the whole chapter) |

The cap holds at 3 through 25 rapid scroll jumps and a chapter boundary.
Refill is immediate, not scroll-driven: with zero scrolling, pages 0–2 start
together and page 3 begins 59ms later, as soon as a slot frees.
