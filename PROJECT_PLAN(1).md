# Yumeyomi (Yume)

A personal PWA client for a self-hosted Suwayomi-Server instance, built for iOS via Add to Home Screen.

## Why

No existing iOS client for Suwayomi covers what's wanted well enough — the closest option (Tachidesk-Sorayomi) requires sideloading an unsigned `.ipa`. A lightweight PWA against Suwayomi's GraphQL API avoids that entirely and installs straight from Safari.

## Server context

- Suwayomi-Server running in Docker on Reimei (`your-server:4567`)
- GraphQL API at `/api/graphql`, browsable via GraphiQL at the same URL
- REST API also exists but is deprecated — GraphQL only
- No auth currently enabled, LAN-only access

## Scope decisions (v1)

| Decision | Choice |
|---|---|
| Reading progress | Tracked — read/unread state written back to server via mutations |
| Chapter caching | Always fetch live, no offline caching |
| Extension management | In-app — install/update/uninstall sources from Yume, not just search |
| Framework | None — plain HTML/CSS/JS |
| Service worker | Skipped for v1 (iOS Add to Home Screen doesn't require one; manifest.json alone is enough) |

## Screens

1. **Library** — grid of manga in the library, unread-count badge per title
2. **Browse** — search installed sources; install/update/uninstall extensions
3. **Manga Detail** — chapter list for a selected title, per-chapter read/unread state
4. **Reader** — page viewer, next/prev chapter navigation, marks chapters read (manual toggle + auto-mark on finishing last page)

## GraphQL operations needed

To be confirmed against the live schema via GraphiQL introspection before coding (field names may differ by server version):

**Queries**
- Library / manga list
- Manga detail + chapter list
- Chapter pages
- Installed sources
- Available + installed extensions

**Mutations**
- Update chapter (read/unread, last page read)
- Install / update / uninstall extension

## Architecture

- Hash-based routing (`#/library`, `#/manga/:id`, `#/reader/:chapterId`) in a single `app.js`
- Thin `api.js` wrapping fetch POSTs to `/api/graphql`
- `state.js` for in-memory state + localStorage for small UI convenience (last-viewed tab, etc.) — not full offline caching
- **CORS / same-origin:** Yume runs as its own container on its own port, separate from Suwayomi. Rather than relying on Suwayomi's CORS config, Yume's nginx container reverse-proxies `/api/graphql` (and image requests) through to Suwayomi internally over the Docker network, so the browser sees everything as same-origin.

## File structure

```
yumeyomi/
  index.html
  manifest.json
  icons/
  css/style.css
  js/
    app.js          (router)
    api.js           (GraphQL client)
    state.js
    views/
      library.js
      browse.js
      manga-detail.js
      reader.js
```

## Deployment

- `nginx:alpine` container serving static files + reverse-proxy config
- Added as a new service in the existing Reimei docker-compose file
- Own port, same Docker network as the Suwayomi container

## Next steps

1. Introspect the live GraphQL schema via GraphiQL to confirm exact field/mutation names
2. Build and test locally against the real server (dev server, browser preview)
3. Optional: mock up Library + Reader screens visually before styling, for a more distinctive look than framework defaults
4. Containerize and add to Reimei's compose file
5. Add to iPhone Home Screen and test end to end
