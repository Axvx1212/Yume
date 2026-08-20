# Yume

A manga reader for a self-hosted [Suwayomi](https://github.com/Suwayomi/Suwayomi-Server)
server — a PWA that installs to the iOS Home Screen from Safari and reads like
a native app.

Plain HTML/CSS/JS: no framework, no build step, no bundler. Files are served
as-authored.

- **Library** with unread badges and per-title reading progress
- **Browse** — search every installed source at once, open a source's catalog,
  install and update extensions
- **Reader** — vertical webtoon with continuous chapter loading, plus paged
  left-to-right and right-to-left
- **Incognito** reading that records nothing back to the server
- Progress syncs to Suwayomi as you read

## Configure

Host addresses are not committed. Copy the example and point it at your server:

```bash
cp .env.example .env
# then edit SUWAYOMI / YUME_BASE
```

`.env` is gitignored. A real environment variable overrides it, so
`SUWAYOMI=http://other:4567 node dev-server.js` works for one-offs. Anything
still reading `*.local` is unconfigured and the tools will say so rather than
failing obscurely.

## Running it

```bash
node dev-server.js                 # binds 0.0.0.0:8420
node dev-server.js --port 9000     # different port
node dev-server.js --upstream http://your-server:4567
node dev-server.js --verbose       # also log static file requests
```

Every `/api` call is logged with its GraphQL operation name, status, and
timing — the first place to look when something misbehaves on the phone.

The dev server prints its LAN address on startup. Open that on the phone —
same WiFi, no other setup.

**Port 8420 by default**, because Docker already holds 8080 on this machine.

## Same-origin, by design

The browser only ever talks to Yume's own origin. Both the dev server and the
nginx container reverse-proxy `/api/*` through to Suwayomi, so:

- `/api/graphql` — the GraphQL endpoint
- `/api/v1/manga/{id}/thumbnail` — covers
- `/api/v1/manga/{id}/chapter/{sourceOrder}/page/{n}` — page images
- `/api/v1/extension/icon/{pkg}` — extension icons

are all same-origin. CORS never enters the picture, and image URLs need no
rewriting since the server returns them relative already.

## Screens

| Route | Screen |
|---|---|
| `#/library` | Cover grid, category strip, unread badge + progress rail per title |
| `#/browse` | Three tabs — **Results** (search every installed source at once), **Sources** (tap one to browse its catalog), **Extensions** (install / update / remove) |
| `#/source/:id` | One source's catalog — Popular / Latest / in-source search, paginated |
| `#/manga/:id` | Hero, metadata, chapter list with read state, resume button |
| `#/reader/:chapterId` | Webtoon continuous scroll + paged LTR/RTL, progress write-back |
| `#/more` | Incognito toggle, server status, reading defaults, cache controls |

## Files

```
index.html          shell + tab bar
manifest.json       PWA manifest (standalone, portrait)
icons/              app icons (SVG + 180/192/512 PNG)
css/style.css       Nocturne tokens + component layer
js/
  app.js            hash router
  api.js            GraphQL client — every operation verified against the live server
  state.js          prefs (localStorage) + per-session cache
  dom.js            el()/icon()/toast() helpers; text nodes only, so no HTML injection
  views/
    library.js  browse.js  source.js  manga-detail.js  reader.js  more.js
dev-server.js       static + /api proxy, binds 0.0.0.0
nginx.conf          same proxy arrangement for the container
Dockerfile          nginx:alpine image
SCHEMA.md           introspection notes — real field names + gotchas
```

## Design

Follows the Nocturne system from the Claude Design handoff: `#161826` ground,
`#9184d9` blurple accent used as line and glow rather than fill, Inter at
weight 500, 8px radii, 0.70× density spacing. Tokens live at the top of
`css/style.css`; nothing hard-codes a hex the tokens already carry.

The bundle detailed Library and Reader; Browse, Detail, and More follow the
same vocabulary — outlined buttons, 44px touch targets, accent reserved for
state rather than decoration.

## Deployed on Reimei

Lives at `~/docker/yume` as its own compose stack, on **port 8420**:

```
http://your-server:8420
```

```bash
cd ~/docker/yume
docker compose up -d --build     # deploy or update
docker compose logs -f           # follow
docker compose down              # stop
```

### Why it reaches Suwayomi through the host gateway

Suwayomi on Reimei runs with `network_mode: container:gluetun` — it shares the
VPN container's network namespace and has **no network or DNS name of its
own**, so a sidecar can't reach it by service name. Port 4567 is published by
gluetun, not by Suwayomi.

Yume therefore talks to `host.docker.internal:4567` via `extra_hosts:
host-gateway`, which means this stack never has to touch the VPN container.
`YUME_UPSTREAM` in `docker-compose.yml` is the single knob — point it at a
compose service name instead if the topology ever changes.

Two things worth knowing, both found by deploying rather than assuming:

- **nginx's `resolver` does not read `/etc/hosts`.** A variable `proxy_pass`
  can't resolve a `host-gateway` entry, so `proxy_pass` uses the substituted
  `${YUME_UPSTREAM}` literal, which the system resolver handles.
- **`localhost` resolves to `::1` in `nginx:alpine`** while nginx listens on
  IPv4 only, so the healthcheck uses `127.0.0.1`.

## Notes

- Reading progress writes back to the server (throttled while scrolling, flushed
  on exit). Chapters auto-mark read on the last page.
- **Incognito** (More → Privacy) stops the reader recording anything: no
  position writes, no auto mark-read. Verified — reading a chapter end to end
  with it on sends zero `updateChapter` calls and leaves the server row
  untouched. Deliberate actions still work: adding to the library or tapping a
  chapter's read toggle are choices, not history. The reader chrome shows an
  INCOGNITO badge whenever it's active, so the state is never a surprise.
- Screen Wake Lock keeps the display on while reading where supported.
- No service worker in v1 — the manifest alone covers Add to Home Screen.
- Chapters are always fetched live; the in-memory cache is per-session only.
- Navigation uses a real history stack (`pushState`), so Back unwinds
  reader → detail → source → browse. Tab switches *replace* the current entry
  rather than stacking, so Back never walks a trail of tab taps.
- The reader has no tap overlay: chrome toggles from a tap detected on the
  scrolling element itself (under 10px of movement, no scroll, under 500ms),
  which leaves touch scrolling completely unobstructed.
- The scrub bar is scoped to the current chapter — it scrolls the column in
  webtoon mode and steps pages in paged mode.
- **Page prefetch:** the reader keeps 3 image requests in flight at all times,
  refilling the instant one finishes, within a 5-page window ahead of where you
  are. `loading="lazy"` is deliberately not used — its fixed ~1250px trigger
  distance is a fifth of one 6000px webtoon strip, which collapsed the buffer
  to about one page. Tune `MAX_IN_FLIGHT` / `PREFETCH_AHEAD` at the top of
  `js/views/reader.js` if the server needs a lighter touch.
- Sources and extensions live on separate tabs on purpose: an installed
  extension usually provides a source of the same name, so a combined list
  showed each one twice. Each tab keeps its own search field.
- Opening a title discovered through a source catalog triggers a chapter fetch
  automatically — Suwayomi only scrapes a series' chapters on demand, so
  without it the list would render empty.
- First load of any cover takes a few seconds while Suwayomi fetches and caches
  it from the source; subsequent loads are fast.
