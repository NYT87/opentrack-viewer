# OpenTrack Viewer

**This app opens activity files locally in your browser. GPX parsing and all
calculations happen on your device. The app does not upload your activity file
to a backend.**

There is no server, no account, and no activity database. Drop a `.gpx` file in
and you get the route, the summary stats and an elevation profile — all computed
in the tab you are looking at.

> **Map tile caveat.** No map is created until you open an activity, so nothing
> is requested from a tile provider before then. Once a route is on screen and
> the basemap is enabled, the map requests tiles, which reveals the approximate
> area you are viewing.
> That is separate from uploading your file, but it is still privacy-relevant.
> Turn **Basemap tiles** off in Settings to draw the route on a plain
> background with no external requests at all. Offline map packs are a separate,
> later project.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173/opentrack-viewer/ (root redirects there)
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server, served under the deployment sub-path. |
| `npm run build` | Type-check, then produce a production build in `dist/`. |
| `npm run preview` | Serve the production build locally. |
| `npm test` | Unit and component tests (Vitest + Testing Library). |
| `npm run test:watch` | The same suite in watch mode. |
| `npm run typecheck` | TypeScript with `strict` and `noUncheckedIndexedAccess`. |
| `npm run lint` | ESLint over `src/` and `e2e/`. |
| `npm run test:e2e` | Playwright browser tests. Run `npx playwright install chromium` once first. |

CI runs all of these on every push and pull request — see
[`.github/workflows/ci-deploy.yml`](.github/workflows/ci-deploy.yml). Node
version comes from `.nvmrc`.

## Deploying

The app is deployed to **https://nyt87.github.io/opentrack-viewer/** by
[`.github/workflows/ci-deploy.yml`](.github/workflows/ci-deploy.yml).

| Event | What runs |
| --- | --- |
| Any push or pull request | `verify`: lint, typecheck, unit tests, browser tests |
| Push to `main` | `verify`, then `build` and `deploy` to GitHub Pages |
| Manual (`workflow_dispatch`) | Same as a push to `main` |

Deployment uses GitHub's OIDC-based Pages actions — no deploy key or token to
manage. **One-time repository setup: Settings → Pages → Source → GitHub
Actions.** Without that, the `deploy` job fails.

A failed run uploads the Playwright HTML report as an artifact, which is
usually the fastest way to see what a browser test actually saw.

### How the sub-path works

A repository Pages site is served from `/<repo>/`, not the domain root. Three
things make that work, and all three are covered by tests:

- **Base path.** `vite.config.ts` prefixes every emitted URL — including the
  lazily loaded map chunk and MapLibre's worker. Those two matter most: a worker
  fetched from the wrong path 404s, and a dead worker draws basemap tiles
  perfectly while silently never rendering the route. The base applies in dev
  too, so the dev server exercises the same paths as the deployment.
- **Hash routing.** `#/viewer` is resolved by the browser against the current
  document, so deep links work on static hosting with no rewrite rules. A
  `BrowserRouter` path like `/opentrack-viewer/viewer` would 404 on GitHub Pages.
  The workflow also copies `index.html` to `404.html` so a stray non-hash path
  loads the app instead of the Pages error page.
- **Relative manifest URLs.** `start_url`, `scope` and the icon paths in
  `public/manifest.webmanifest` are `./`-relative, so they resolve against the
  manifest's own location and follow the sub-path without hardcoding it.

### Changing the base path

`base-path.ts` is the single source of truth, read by the Vite build, the
Playwright config and the browser tests — so the build and the tests cannot
disagree. Override it with one environment variable:

```bash
VITE_BASE_PATH=/ npm run build              # a domain root or a user/org Pages site
VITE_BASE_PATH=/other-repo/ npm run build
VITE_BASE_PATH=/other-repo/ npm run test:e2e   # the whole suite, at that base
```

CI derives it from the repository name (`/${{ github.event.repository.name }}/`)
for both the browser tests and the build, so **renaming the repository needs no
code change** — only `DEFAULT_BASE_PATH` in `base-path.ts` if you want local
runs to match too.

`e2e/viewer.spec.ts` asserts that no request escapes the sub-path, that the map
chunk and worker are among those requests, that the manifest is scoped to it,
and that `#/viewer` deep-links correctly. Navigate with `page.goto('./')` in
those tests, not `'/'`, which resolves to the origin root.

## Architecture

```text
Local File → File Intake → Format Detection → Parser Registry
                                                    ↓
                                     Normalized `Activity` domain model
                                                    ↓
                       ┌────────────────┬───────────┴──────────┐
                   Stats Engine   GeoJSON Adapter      Chart Series Adapter
                       └────────────────┴───────────┬──────────┘
                                                 React UI
                                  (drop zone · summary · map · chart)
```

The rule that keeps this maintainable: **the UI depends on the normalized domain
model, never on parser output.** A new format is a new parser producing the same
`Activity`; nothing downstream changes.

| Directory | Contains |
| --- | --- |
| `src/domain/` | Format-independent logic: types, stats, GeoJSON, chart series, units, validation, errors. |
| `src/parsers/` | Format-specific logic and the parser registry. Nothing here imports from `components/`. |
| `src/components/` | Rendering of normalized data only. |
| `src/app/` | Router, shared layout chrome (header nav + footer) and the routed pages. |
| `.github/workflows/` | CI (lint, typecheck, unit and browser tests) and the GitHub Pages deployment. |
| `src/state/` | Session interaction state (hover/selection, basemap and unit preferences). No parsing rules. |
| `src/test/` | Fixtures (all synthetic — see `src/test/fixtures/README.md`) and helpers. |
| `e2e/` | Playwright specs, including the privacy regression tests. |

## Privacy model

Enforced, not just documented:

- Parsing uses `File`, `Blob`, `ArrayBuffer` and `DOMParser` only. No `fetch` is
  reachable from the intake or parsing path.
- The map is not constructed until an activity with a route is open, so simply
  loading the app makes no external request at all — a tile provider is not told
  that anyone is using it until there is something to show.
- Nothing is written to `localStorage`, `sessionStorage` or IndexedDB. Closing
  the tab discards the activity.
- Raw file contents are never logged; error messages carry a code and a hint,
  not file data.
- `e2e/viewer.spec.ts` asserts that loading a file issues **no** POST/PUT/PATCH,
  that no request body contains coordinates or the file name, that no tile is
  requested before an activity is opened, and that route-only mode makes no
  external request at all.
- `src/parsers/index.test.ts` fails if the parse path touches `fetch`.

There is no analytics or error-reporting integration. If one is ever added, it
must be opt-in and scrubbed of activity data.

## Decisions taken from the plan's open questions

| Question | Decision | Why |
| --- | --- | --- |
| Tile provider | OpenStreetMap raster tiles, declared inline, with a route-only mode | No API key and real street detail at route zooms. Swap `DEFAULT_BASEMAP_STYLE` in `src/components/ActivityMap.tsx` for your own provider before deploying, and honour that provider's usage policy. |
| Units | Metric by default, switchable per session | A control in the settings modal writes to `interactionStore`; the choice persists across files but is not stored on disk. |
| Chart x-axis | `distance` \| `time`, persisted for the session | §17 asked whether the preference persists or resets per activity. It persists, like units. A preference an activity cannot support is *not* discarded: that chart falls back and explains why, and the preference applies again to the next file. |
| Point-index x-axis | Internal fallback only, never user-selectable | The plan's `ChartXAxisMode` is `distance \| time`. An activity with neither still needs *some* axis, so `index` remains as a rendering fallback — but it is not offered in the switch, because it is not a meaningful thing to choose. |
| Pace derivation | Distance and time over a rolling 15 s window | §17 asked whether to use instantaneous speed or derive from intervals. Derived: `speedMetersPerSecond` is often absent from GPX and already device-smoothed when present, so deriving keeps GPX and FIT consistent (TD-002). Point-to-point pace is unusable — a metre of GPS jitter between 1 s samples swings it by minutes per km — hence the window. Stationary and implausibly fast (>10 m/s) intervals are dropped rather than plotted. |
| Cadence units | Shown as recorded, with the ambiguity stated | §17 asked whether run cadence should be modelled separately from cycling cadence. One field is kept, and the chart says plainly that some devices report strides per minute rather than steps per minute. Silently doubling a value to "fix" it would be a guess presented as fact. |
| Page layout | Fixed header, one scroll region below it, footer at the end of the content | The footer is not pinned: it appears when the reader reaches the bottom. When the content is shorter than the viewport the body grows so the footer still lands on the bottom edge. `.shell__scroll` owns the scrolling, which is what keeps the header fixed without `position: fixed`. |
| Changing files | Close the activity first | The drop zone is only present before an activity is open. This is the **one** `AV-004` criterion deliberately not met ("select another file from both upload/error and ready states"): a change-file control sitting beside a loaded map invites swapping the file out from under the view. §17 asks where a ready-state change-file action belongs; the answer taken here is "nowhere — close first". Every other `AV-004` criterion is implemented. |
| Device serial numbers | Parsed, never rendered | §17 asks which device fields show by default and whether sensitive ones need a reveal action. There is no reveal: a serial identifies a person's hardware across every file they own, and §5 permits showing identifiers only where there is "a clear user-facing reason", which this viewer does not have. It stays in the domain model so a parser can capture what a file contains, and both a component test and a browser test fail if it ever reaches the page. |
| GPX `creator` | Shown as "Recorded with", not as a model | §17 asks whether `creator` is device or app information. It can be either — "Garmin Edge 530" or "StravaGPX Android" — and nothing distinguishes them reliably, so it is shown verbatim under a label that claims neither. `manufacturer`/`model` are populated only when a file states them explicitly. |
| Chart selection lifetime | Survives an x-axis switch; cleared on a new activity | §17 asks whether a selection persists when the x-axis changes. It does, because it is stored as **activity point indices** rather than a span of whichever axis was showing (`AV-509`): switching axes re-projects the same points onto the new axis. Points missing a value on an axis resolve to the nearest point that has one, so a selection over a GPS dropout stays meaningful instead of collapsing. |
| Chart axis ticks | Fixed real-world intervals: every 1 km (1 mile in imperial), every 5 minutes | A label then means the same thing on a 3 km run and a 200 km ride, rather than shifting with the range. Marks are always generated at the interval; only the *labels* thin on a narrow axis, and endpoint labels appear when no interval label crowds them. |
| Chart sizing | Measured width, `viewBox` 1:1 with pixels | The chart previously used a fixed `viewBox` with `preserveAspectRatio="none"`, which stretched the axis text horizontally. It now measures its container with a `ResizeObserver`, so text renders at natural proportions and tick thinning can be decided against real pixels. The y gutter is computed from the widest rendered label. |
| Theme | Three modes — system (default), dark, light — resolved to a `data-theme` attribute | System follows `prefers-color-scheme` and keeps following it live. Where the browser cannot report a preference it resolves to **light**, which is also the base palette in CSS, so a document with no `data-theme` yet still renders correctly. An inline script in `index.html` resolves it before first paint so a dark-mode device never flashes light; it duplicates a few lines of `domain/theme.ts` deliberately, because React has not booted at that point. Session-scoped like the other settings. |
| Map vs app theme | Independent | §17 leaves this open. The basemap keeps its own styling rather than following the app theme, so route-only mode and the tile treatment stay predictable. |
| Routing | React Router, `HashRouter`; `/` homepage and `/viewer`, with settings as modal state rather than a route (`AV-006`, `AV-007`) | The plan defers routing until "multiple views become useful" (§4); the Settings page is that point, and §9 already reserved `src/app/routes.ts`. Hash routing because this is a static, backend-free app: on static hosting such as GitHub Pages a deep link to `/settings` would 404 without server rewrites. |
| Distance source | File distance stream when present *and* monotonic, otherwise haversine | Devices integrate wheel/footpod data more accurately than sparse GPS fixes; a decreasing stream signals corruption and is discarded. |
| Elevation noise threshold | 3 m (`ELEVATION_NOISE_THRESHOLD_METERS`) | Consumer altimeter noise is ±2–5 m; raw delta summing inflates gain on flat routes. Covered by the flat-route test. |
| Malformed points | Skipped with a warning; only an unreadable document fails | One bad `trkpt` should not cost the user the whole route. |
| GPX segments | Preserved, never merged | §17 asked whether to merge or preserve. Merging is not a simplification, it is a fabrication: a `<trkseg>` boundary is where the recording stopped, so joining segments both adds distance the athlete did not cover and draws a straight line down a road they never took. `ActivityPoint.segmentIndex` carries the boundary; distance breaks at it and the route renders one LineString per segment. |
| Web Workers | Deferred until FIT (AV-702) | Measured, not guessed: main-thread GPX parsing blocks the UI for ~0.07 s at 5,000 points, ~0.5 s at 50,000 and ~0.8 s at 100,000 — below the plan's "if UI stalls" bar (§14) for realistic files. Moving *GPX* to a worker is not a relocation: `DOMParser` does not exist in a worker (verified), so it would mean adding a DOM-free XML parser as the first non-essential runtime dependency. FIT is binary and needs no DOM, so it can go straight into a worker for free. |

## Status against the plan

The plan lives in [`docs/planning/`](docs/planning/README.md).

Implemented: **M0–M4** and **M3.5** — project foundation, the GPX route vertical
slice, summary stats, the chart panel with the x-axis switch and run-specific
charts, and map/chart synchronization (`AV-001`…`003`, `AV-101`…`103`,
`AV-201`…`203`, `AV-301`…`304`, `AV-401`…`404`, `AV-501`…`507`,
`AV-601`…`603`, `AV-004`…`007`, `AV-009`, `AV-010`, `AV-405`, `AV-508`, `AV-509`, `AV-514`, `AV-011`, `AV-406`, plus `AV-801`
and `AV-803`).

Not implemented, and **not** yet reconciled with the code:

| Task | Adds | Conflicts with what is built |
| --- | --- | --- |
| `AV-510`–`AV-512`, `AV-604`–`AV-605` | Focused activity slices, Reset View, map focus, focused-range stats | The gesture and the point-range mapping are in place; the selection is shown but does not yet focus anything |
| `AV-513` | Speed chart for cycling activities | `domain/charts.ts` offers elevation/pace/cadence only |
| `AV-550`–`AV-554` | Export: registry, GPX, FIT, controls | Export is listed as a non-goal in the older scope |
| `AV-701`–`AV-704` | FIT import | — |
| `AV-750`–`AV-753` | TCX import/export and round-trip tests | — |
| `AV-802` | Service worker / offline app shell | Manifest ships; nothing is cached |

## MapLibre integration notes

Two non-obvious things about MapLibre 6.6 are load-bearing here. Both fail
silently — the map looks correct in every inspectable way and simply draws no
route — so they are pinned by tests.

**The worker must be bundled and registered explicitly.** MapLibre derives its
worker URL at runtime from `import.meta.url`, which no bundler can follow, so
the worker file is never emitted and the request 404s. A dead worker still draws
raster tiles (they decode on the main thread) but never tiles a GeoJSON source:
sources, layers, data and camera all look right and nothing renders. The worker
entry also imports `./maplibre-gl-shared.mjs`, so it must be imported with
`?worker&url` (which bundles its dependencies) rather than `?url` (which copies
one file), with `worker.format: 'es'` set in `vite.config.ts`.

**`setStyle` is never used.** In MapLibre 6.6 it terminated the worker without
respawning one, permanently breaking every GeoJSON source on the map — the
route silently stopped rendering. **That defect is fixed in 6.7.0** (verified:
after a `setStyle`, a freshly added GeoJSON source loads and renders again), but
the basemap toggle still switches layer `visibility` rather than swapping
styles, because that is the better design regardless: the route stays on screen
across a toggle, sources are never torn down and re-installed, already-fetched
tiles are not re-requested, and MapLibre asks for no tiles at all when a
source's only layers are hidden — which is what keeps route-only mode free of
external requests, asserted in `e2e/viewer.spec.ts`.

## Known limitations

- MapLibre's lazily loaded chunk is ~951 kB minified. It is fetched only once an
  activity with a route is open, so it never affects first paint, but it is the
  one part of the bundle worth a budget.
- The pace chart *filters* stationary and implausible intervals (per AV-505) but
  the line still connects across the resulting hole rather than breaking. True
  gap rendering interacts with downsampling and the area fill, so it was left
  out deliberately.
- Parsing runs on the main thread. A 100,000-point GPX blocks the UI for ~0.8 s
  (50,000 points: ~0.5 s; 5,000: ~0.07 s). Every parser sits behind an async API
  so moving one to a Web Worker is a registry change — but `DOMParser` does not
  exist in a worker, so moving *GPX* there also means replacing it with a
  DOM-free XML parser.
- Map hover uses a linear nearest-coordinate scan. Fine for typical tracks;
  a very dense track would benefit from spatial indexing.
