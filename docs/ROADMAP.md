# Roadmap — theming

Scope for the next session. Written after auditing the current CSS, so the work
below is grounded in what is actually in the file rather than a guess.

## Goal

Let the reader pick a theme (and have the app follow the system light/dark
setting), without abandoning Nocturne — it becomes *a* theme rather than *the*
theme.

## Where the codebase already helps

`css/style.css` defines **42 design tokens** in `:root` and has **zero
hardcoded hex values outside that block**. Every component already reads
`var(--color-*)`, `var(--space-*)`, `var(--radius-*)`. Swapping a palette is
therefore mostly a matter of redefining `:root`, not touching components.

## What actually blocks it

Three things, all small and all identified:

### 1. Thirteen `rgba()` literals outside `:root`

These bypass the token system. They fall into three groups:

| Literal | Where | Should become |
|---|---|---|
| `rgba(11, 12, 20, …)` × 6 | cover scrims, reader chrome gradients, sheet backdrop | a `--color-scrim-*` token derived from the ground |
| `rgba(145, 132, 217, …)` × 4 | badge / progress-rail / dot / dock glows | a `--glow-accent` token derived from the accent |
| `rgba(233, 233, 237, 0.028)` | the page placeholder weave | a `--color-weave` token |
| `rgba(0, 0, 0, 0.65)` | sheet shadow | already conceptually `--shadow-*`; fold it in |

Do this **first** — it is a pure refactor with no visible change, and it is
what makes a second palette possible at all. Verify with
`node tests/run.cjs visual`: the screenshots must come out identical.

### 2. `theme-color` is fixed in two places

`index.html` (`<meta name="theme-color" content="#161826">`) and
`manifest.json` (`theme_color` / `background_color`). These paint the iOS status
bar area and the splash screen, so a theme that does not update them will look
wrong at the edges — the same class of problem as the status-bar band already
fixed once.

The meta tag can be updated at runtime from JS. `manifest.json` cannot (it is
read at install time), so the manifest keeps the default theme's colour and
only the meta tag follows the active theme.

### 3. Nothing persists a theme choice yet

`js/state.js` holds prefs; add `theme` alongside `readerMode`. It already has
the pattern — `READER_MODES` plus a `setPref` call — so mirror it exactly rather
than inventing a second mechanism.

## Suggested shape

```
css/
  style.css          tokens + components (unchanged structure)
  themes.css         one [data-theme="…"] block per theme, tokens only
js/
  state.js           + THEMES export, + prefs.theme
  views/more.js      + a Theme section, mirroring Reading defaults
```

Apply by setting `document.documentElement.dataset.theme`, so a theme is a
token swap and nothing re-renders.

```css
:root                      { /* Nocturne — the default, stays as-is */ }
[data-theme="dawn"]        { /* light */ }
[data-theme="midnight"]    { /* darker, lower contrast for night reading */ }
[data-theme="auto"]        { /* follows prefers-color-scheme */ }
```

### Themes worth having

- **Nocturne** (default) — the current dark blue-grey.
- **Dawn** — a light theme. This is the one that will surface bugs, because
  every assumption baked in as "dark ground, light text" gets inverted. Expect
  the reader chrome gradients and the cover scrims to need real attention.
- **Midnight** — near-black, dimmer accent, for reading in the dark. Cheap to
  add once Dawn works.
- **Auto** — follow `prefers-color-scheme`, pairing Dawn and Nocturne.

## The reader is a special case

The reader deliberately uses its own darker ground (`--color-ink`, `#0b0c14`)
regardless of screen. **A light theme should probably not make the reader
light** — manga and webtoon pages are themselves mostly white, and a light
chrome around them removes the contrast that makes the page readable. Options
worth deciding before building:

1. Reader always stays dark (simplest, matches how most readers behave).
2. Reader follows the theme, with a separate "keep reader dark" toggle.
3. Reader gets its own independent theme setting.

Note the existing brightness dimmer (`.dim` overlay in `js/views/reader.js`)
already does part of this job and should not fight whatever is chosen.

## Testing

The existing suite covers this better than it might seem:

- `tests/03-visual.test.js` asserts on **decoded pixels** — extend it to loop
  over themes and check contrast at the same points, rather than writing a new
  file.
- The reader-ground assertion (`bottom row is the reader ground, not app
  background`) hardcodes a dark expectation. It will need to become
  theme-aware, and it is the single most likely test to break.
- `node tests/run.cjs` must stay green before deploying, per CLAUDE.md.

## Rough order

1. Tokenize the 13 `rgba()` literals. No visual change; tests prove it.
2. Add `prefs.theme` + `THEMES` in `state.js`, and the More screen section.
3. Add `themes.css` with Dawn. Fix what breaks — expect the reader chrome,
   cover scrims, and the `.lighten`-style blending to need work.
4. Runtime `theme-color` meta update.
5. Midnight and Auto, which should be nearly free by then.
6. Extend the visual test to cover each theme.

---

## Deferred: novel reading

Not being built. Recording one finding so the question does not have to be
re-researched:

Suwayomi has **no novel/manga distinction** — everything is `MangaType` and the
schema exposes no content-type field. However, `fetchChapterPages` accepts an
undocumented `format` argument, and passing `format: "text"` returns page URLs
suffixed `?format=text`. Novel extensions do exist in the repos (NovelCool,
J-Novel, WebNovel and others). `MangaMetaType` is a per-title key/value store
that could hold a "this is a novel" flag client-side.

So it is likely feasible, but it needs real investigation against an installed
novel source before committing to a design.
