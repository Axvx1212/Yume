# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Yume — a PWA client for a self-hosted Suwayomi manga server, installed on iOS via
Add to Home Screen. Plain HTML/CSS/JS: **no framework, no build step, no bundler,
no test framework, and no git repo.** Files are served as-authored. Editing a file
and reloading the page is the whole edit-test loop.

Because there is no test suite, changes are verified by driving a real browser
(see *Verifying changes*).

## Configuration

Server addresses live in `.env` (gitignored; `.env.example` is the template) and
are read by `tools/config.js`. **Never hard-code a host in tracked source** —
this repo describes a self-hosted setup and the addresses are per-network. A
real environment variable beats `.env`; both beat the `*.local` placeholders,
which exist to fail loudly rather than silently pointing somewhere wrong.

## Commands

```bash
node dev-server.js                 # 0.0.0.0:8420, static + /api proxy
node dev-server.js --port 9000     # 8420 is the default (8080 is taken by Docker locally)
node dev-server.js --verbose       # also log static file requests
npm run check                      # syntax-check every JS file (no linter here)

node tests/run.cjs                 # full suite, against the deployment
node tests/run.cjs visual touch    # only files matching those names
YUME_BASE=http://localhost:8420 node tests/run.cjs    # against a local dev server

tools/gql.sh '{ aboutServer { version } }'   # one-off GraphQL
tools/schema.sh UpdateChapterPatchInput      # introspect a type (REFRESH=1 to re-fetch)
```

**Run the full suite before every deployment.** The tests drive a real browser
at real device dimensions and assert on rendered pixels, which is the only thing
that has reliably caught the bugs this project actually shipped. They take about
six minutes. `node tests/run.cjs` must be green before `docker compose up -d
--build`.

The suite writes to the **real** server: test 05 adds a manga to the library and
marks chapters read, then restores everything in a `finally`. If it is
interrupted, check `tools/gql.sh '{ chapters(condition:{isRead:true}) { nodes { id mangaId } } }'`
and reset anything it left behind.

Every `/api` call is logged with its GraphQL operation name, status, and timing.
That log is the first place to look when something misbehaves on the phone.

Deployment lives on Reimei at `~/docker/yume`:

```bash
ssh you@your-server
cd ~/docker/yume && docker compose up -d --build
```

## Architecture

### Same-origin by construction

The browser only ever talks to Yume's own origin. Both `dev-server.js` and
`nginx.conf` reverse-proxy `/api/*` to Suwayomi, so GraphQL and every image are
same-origin and CORS never applies. Suwayomi returns image URLs already relative
(`/api/v1/...`), so nothing needs rewriting. **Never add a cross-origin fetch or
an absolute upstream URL to client code** — it would break the phone and the
container while still working on a Mac.

### Router (`js/app.js`)

Hash routes over a real `pushState` stack, with an index in `history.state`.
Hash strings alone can't distinguish a forward push from a back pop.

- `navigate(path)` pushes; `navigate(path, {replace:true})` swaps (tab switches use
  this, so Back doesn't walk through a trail of tab taps); `goBack(fallback)` pops
  or falls back for deep links.
- **A view may return a cleanup function.** The router disposes the previous view
  before rendering the next and guards against a navigation that starts while an
  earlier async render is still in flight. Any view that arms a timer, adds a
  window/document listener, or starts an async job that touches the DOM must
  return a disposer — otherwise it leaks for the rest of the session.

### Reader (`js/views/reader.js`)

By far the most intricate file; several parts are load-bearing and look removable
but aren't:

- **No tap overlay.** Chrome toggles from a tap detected *on the scrolling element*
  (< 10px movement, no scroll, < 500ms). An `inset: 0` sibling above the scroller
  swallows every touch and makes the reader completely unscrollable on a phone.
  This shipped once and was not caught by tests — see *Verifying changes*.
- **Explicit prefetch queue**, not `loading="lazy"`. Lazy's fixed ~1250px trigger
  distance is a fifth of one 6000px webtoon strip, which collapses the buffer to
  ~1 page. `MAX_IN_FLIGHT` / `PREFETCH_AHEAD` at the top of the file are the tuning
  knobs (currently 3 in flight, 5-page window) — lower them for a weaker server.
- **Detaching an `<img>` does not abort its fetch**, and its `load`/`error` handler
  still fires. Rebuilding the column therefore marks outgoing images `orphaned`
  *and* clears `src`; without both, `inFlight` goes negative and the concurrency
  cap silently doubles.
- **`columnGen` generation counter.** `appendChapter` awaits a network fetch; if
  the column was rebuilt meanwhile, its continuation must be inert or the chrome
  and the visible chapter disagree.
- Progress writes are throttled **per chapter** (one shared timer meant switching
  chapters cancelled the previous chapter's pending write, losing it) and flushed
  on `pagehide` + visibility-hidden, which is how iOS actually leaves a PWA.

### Incognito (`isIncognito()` in `js/state.js`)

Suppresses writes the *act of reading* performs — position and auto mark-read.
Deliberately does **not** block explicit user actions (adding to library, tapping
a chapter's read toggle): those are choices, not history. Position is still
tracked locally in `seenPage` so mode switches don't lose your place.

### Everything else

`api.js` holds every GraphQL operation; `state.js` holds prefs (localStorage),
a session-only cache, and shared constants (`READER_MODES`, `nextGridCols`) that
exist because reader/more/library previously duplicated them. `dom.js`'s `el()`
makes string children text nodes, so server-supplied titles and descriptions can
never be parsed as HTML.

## Suwayomi GraphQL

`SCHEMA.md` records the introspected schema for **v2.3.2243** with every
operation verified against the live server. Field names vary by server version —
re-introspect rather than trusting memory. The traps that cost the most time:

- **Search and page-fetch are mutations**, not queries (`fetchSourceManga`,
  `fetchChapterPages`) — they scrape the source live.
- **`pageCount` is `-1`** until `fetchChapterPages` has run for that chapter.
- **Page image URLs key off `sourceOrder`, not chapter `id`.** Use the returned
  `pages` array rather than building URLs.
- **A manga discovered via a source catalog has zero chapters stored locally**
  until `fetchMangaAndChapters` runs. Manga Detail auto-fetches when it finds none.
- `LongString` timestamps are epoch millis **as strings**; `genre` is a list.
- `updateExtension` returns `extension: null` with no `errors` array when the
  `pkgName` doesn't exist — a silent null is the only signal.

## Design system

Nocturne, from the Claude Design handoff in `yumeyomi-personal-manga-reader/`
(reference only — excluded from the image). Tokens live at the top of
`css/style.css`. Take every color, space, and radius from `var(--*)`; don't
hard-code a hex the tokens already carry. The accent (`#9184d9`) is used as a
line or a glow, never as a flood. Spacing is a deliberate 0.70× density scale.
Touch targets are 44px minimum, and inputs are 16px — anything smaller makes iOS
zoom on focus.

## Deployment topology (non-obvious)

Suwayomi on Reimei runs with `network_mode: container:gluetun` — it shares the
VPN container's network namespace and has **no network or DNS name of its own**.
Port 4567 is published by gluetun. Yume reaches it via `host.docker.internal`
(`extra_hosts: host-gateway`), so its stack never touches the VPN container.
`YUME_UPSTREAM` in `docker-compose.yml` is the single knob.

Two footguns already paid for:

- **nginx's `resolver` does not read `/etc/hosts`**, so a variable `proxy_pass`
  cannot resolve a `host-gateway` entry. `proxy_pass` uses the envsubst-substituted
  literal instead. `NGINX_ENVSUBST_FILTER=YUME_` keeps substitution off nginx's own
  `$host` / `$connection_upgrade`.
- **`localhost` resolves to `::1` in `nginx:alpine`** while nginx listens on IPv4
  only — the healthcheck must use `127.0.0.1`.

## iOS standalone quirks

The app is used installed to the Home Screen, which behaves differently from a
Safari tab in ways a Mac browser never shows:

- **`apple-mobile-web-app-status-bar-style` must stay `black`, not
  `black-translucent`.** Translucent makes iOS draw the web view full-screen
  while reporting a viewport short by the status-bar height, so a dead strip is
  stranded at the bottom — 59px on an iPhone 14 Pro, and it looked like a
  layout bug in the tab bar and the reader rather than a meta-tag problem.
  **Changing this tag requires deleting and re-adding the Home Screen icon**; it
  is read at install time, so a reload won't pick it up.
- `.app` is `position: fixed; inset: 0` and the tab bar is `absolute` inside it,
  so neither can inherit a mis-resolved percentage height.
- Headless Chrome does **not** reproduce any of this — it reported a zero-pixel
  gap on the broken build. Layout bugs of this kind can only be confirmed from
  a real device screenshot; measuring one (decode the PNG, find the last row
  with UI content, compare against `height / DPR`) is far more reliable than
  eyeballing it.

## Visual correctness is a separate axis from behaviour

Two defects shipped past a full behavioural suite, because nothing was broken by
any assertion's definition:

1. the bottom band (the status-bar meta above), and
2. a 1px `border-top` on `.page` that drew a hairline through webtoon artwork —
   inherited from the prototype, where pages were placeholder tiles and a
   divider made sense.

The reader's real requirement is that **artwork reads as continuous**, which no
DOM assertion covers. The check that catches it: render a chapter at device
size, find a page boundary where both sides are near-white (sample the last row
of image A and the first row of image B via canvas), screenshot it, and read
every pixel row across the join. A seam shows up immediately against white; it
is invisible to the eye at webtoon scale and invisible to `getBoundingClientRect`
maths alone. Re-run this whenever reader layout changes.

## Protected files

A `PreToolUse` hook (`.claude/hooks/protect-paths.sh`) **blocks** edits to
`index.html`, `nginx.conf`, `Dockerfile`, and `docker-compose.yml`, and prints a
warning for `js/views/reader.js` and `css/style.css`. Each guards a constraint
that caused a real user-visible bug and that looks removable when read fresh.
If a change to one is genuinely needed, say what and why and let the user make
it — don't route around the hook.

## Verifying changes

The suite lives in `tests/` (`tests/lib/` holds a dependency-free CDP driver, a
PNG decoder, and the assertion harness). It drives headless Chrome at iPhone 14
Pro dimensions (393×852 @3x) and asserts on console errors, network events,
rendered DOM, and decoded pixels.

**Setting `scrollTop` in JS does not prove a page is scrollable** — it bypasses
hit-testing entirely and reported success on a reader a finger could not move.
Use `Input.synthesizeScrollGesture` / `Input.dispatchTouchEvent` for anything
touch-related.

Note that the app writes to a **real server holding the user's library**. Tests
that mutate state (marking read, adding to library, installing extensions) must
revert what they changed and leave the user's own data alone.

## Other agent configs

An OpenAI Codex config exists at `~/.codex/config.toml`. To import anything from
it, reply `/import` to see what's importable, then `/import --yes=<digest>`.
