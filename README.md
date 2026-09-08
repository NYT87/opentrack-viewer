# OpenTrack Viewer

**This app opens activity files locally in your browser. GPX, FIT and TCX parsing and all
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
- The **theme preference** is the one thing written to `localStorage`, under
  `opentrack-viewer:theme`. Nothing else is stored: no `sessionStorage`, no
  IndexedDB, and nothing whatsoever about an activity. Closing
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
| Units | Defaulted from the browser locale, switchable per session | §17 asked whether to follow the locale. It does, through `Intl.Locale`'s `measurementSystem` where the browser exposes it and a small region list where it does not. The UK is deliberately metric here: it measures road distance in miles but runs and rides in kilometres. It is only a default — the settings control overrides it, and that override lasts the session without reaching disk. |
| Theme persistence | Remembered on the device; every other setting is session-only | §17 asked whether the theme should persist. It does, and it is the **only** thing this app writes to `localStorage`. A theme is a display choice rather than activity data, and re-picking dark mode on every visit is a poor trade for a purity the reader never asked for. The pre-paint script in `index.html` reads the stored value first, so a remembered dark theme does not flash light on load. |
| Chart x-axis | `distance` \| `time`, persisted for the session | §17 asked whether the preference persists or resets per activity. It persists, like units. A preference an activity cannot support is *not* discarded: that chart falls back and explains why, and the preference applies again to the next file. |
| Point-index x-axis | Internal fallback only, never user-selectable | The plan's `ChartXAxisMode` is `distance \| time`. An activity with neither still needs *some* axis, so `index` remains as a rendering fallback — but it is not offered in the switch, because it is not a meaningful thing to choose. |
| Pace derivation | Distance and time over a rolling 15 s window | §17 asked whether to use instantaneous speed or derive from intervals. Derived: `speedMetersPerSecond` is often absent from GPX and already device-smoothed when present, so deriving keeps GPX, FIT and TCX consistent (TD-002). Point-to-point pace is unusable — a metre of GPS jitter between 1 s samples swings it by minutes per km — hence the window. Stationary and implausibly fast (>10 m/s) intervals are dropped rather than plotted. |
| Cadence units | Running and cycling cadence are separate fields | §17 asked whether run cadence should be modelled separately. It is: `runningCadenceSpm` (strides per minute, one foot) and `cyclingCadenceRpm` (pedal revolutions). They are different measurements that happen to share a name, and one generic `rpm` field made the chart label a guess. GPX states a cadence number but never its unit, so the **declared sport** decides which field it lands in. A swim or a row reports *strokes* per minute, which is neither unit and has no field here, so that number is dropped rather than mislabelled; an undeclared sport keeps foot cadence, since an untyped GPX is the common case and a step count is the overwhelmingly likely meaning. Only running cadence is charted. |
| Near-constant charts | Drawn flat, with a single axis label | A steady ride varies only in the fourth decimal. Stretching that across the plot draws sensor noise as if it were terrain, and prints the same number on every gridline. Below half a percent of the value's magnitude a series is treated as flat: one label, one straight line. |
| Primary overview metric | **Avg pace** for running, **Avg speed** for everything else, over **elapsed** duration | Runners read a workout in minutes per kilometre, riders in kilometres per hour, so the overview follows the sport. Only one is shown: every stat in the grid carries equal visual weight, so showing both would make both primary. An activity that never said what it was gets speed, which is meaningful for any movement. Both use elapsed time because the figure sits beside `Duration` and would otherwise silently disagree with it; moving time is reported separately, and a moving average could be added alongside rather than replacing this. Pace is derived from the same average speed, so the two can never disagree. |
| Speed vs pace | Speed for cycling, pace for running | Derived over the same rolling window as pace, but a recorded `speedMetersPerSecond` is trusted when it is *plausible* — a wheel sensor knows better than GPS positions do, though a faulty reading is worse than none. Recorded speed is range-checked (`isPlausibleSpeed`: 0 to 35 m/s, the cycling ceiling, since the sport is not always known where the value is read) at the parser boundary, in stream detection and in series derivation, so a negative or absurd value is treated as absent and speed falls back to derivation instead of drawing a spike the ride never contained. A stationary stretch plots as **zero speed**, where the pace chart gaps it: standing still is a real speed but not a real pace. |
| Page layout | Fixed header, one scroll region below it, footer at the end of the content | The footer is not pinned: it appears when the reader reaches the bottom. When the content is shorter than the viewport the body grows so the footer still lands on the bottom edge. `.shell__scroll` owns the scrolling, which is what keeps the header fixed without `position: fixed`. |
| Changing files | Close the activity first | The drop zone is only present before an activity is open. This is the **one** `AV-004` criterion deliberately not met ("select another file from both upload/error and ready states"): a change-file control sitting beside a loaded map invites swapping the file out from under the view. §17 asks where a ready-state change-file action belongs; the answer taken here is "nowhere — close first". Every other `AV-004` criterion is implemented. |
| Device serial numbers | Parsed, never rendered | §17 asks which device fields show by default and whether sensitive ones need a reveal action. There is no reveal: a serial identifies a person's hardware across every file they own, and §5 permits showing identifiers only where there is "a clear user-facing reason", which this viewer does not have. It stays in the domain model so a parser can capture what a file contains, and both a component test and a browser test fail if it ever reaches the page. |
| GPX `creator` | Shown as "Recorded with", not as a model | §17 asks whether `creator` is device or app information. It can be either — "Garmin Edge 530" or "StravaGPX Android" — and nothing distinguishes them reliably, so it is shown verbatim under a label that claims neither. `manufacturer`/`model` are populated only when a file states them explicitly. |
| Focused map behaviour | Dim the whole route, draw the section over it, fit once | §17 asks whether a selection should hide, dim, or replace the rest of the route. Dimming keeps the context of where the section sits in the ride. The map fits the section **once**, when the selection changes; after that panning and zooming belong to the reader and nothing re-fits under them. Reset View is the exception: it moves the camera back to the whole activity, because clicking it *is* a request to be shown everything again. |
| Selection stats | A separate labelled panel, never the activity summary | `AV-605` asks for focused-range stats "in the summary". They are shown, but in their own **Selected section** panel beside the chart focus controls, because figures that changed with a drag would leave `Distance` ambiguous at a glance — the reader could no longer tell whether they were looking at the ride or at a hill inside it. Two panels, each saying plainly what it describes, answer the same question without that cost. Both are built by the same `buildSummaryStats`, so a value is formatted, and a missing one explained, identically in each. `Reset View` removes the panel. |
| Focused chart axes | Keep absolute values | A focused section reads "2.0 km – 4.0 km", not "0 – 2.0 km". The series is built against the full activity and then filtered, rather than rebuilt from the slice, so the reader keeps track of where in the activity they are — and a derived series like pace keeps the window that ran into the selection instead of starting cold. |
| Point indexes in a focused slice | Kept, never renumbered | `ActivityPointRange` refers to `point.index`, not to positions in the `points` array, and `sliceActivity` preserves those indexes. An index is the app's identifier for a point — hover state, chart samples and the map's coordinate lookup all speak in them — so renumbering would force a translation at every boundary between the focused and full views, and a missed translation would silently point at the wrong place on the map. |
| Chart selection lifetime | Survives an x-axis switch; cleared on a new activity | §17 asks whether a selection persists when the x-axis changes. It does, because it is stored as **activity point indices** rather than a span of whichever axis was showing (`AV-509`): switching axes re-projects the same points onto the new axis. Points missing a value on an axis resolve to the nearest point that has one, so a selection over a GPS dropout stays meaningful instead of collapsing. |
| Chart axis ticks | Fixed real-world intervals: every 1 km (1 mile in imperial), every 5 minutes | A label then means the same thing on a 3 km run and a 200 km ride, rather than shifting with the range. Marks are always generated at the interval; only the *labels* thin on a narrow axis, and endpoint labels appear when no interval label crowds them. |
| Chart sizing | Measured width, `viewBox` 1:1 with pixels | The chart previously used a fixed `viewBox` with `preserveAspectRatio="none"`, which stretched the axis text horizontally. It now measures its container with a `ResizeObserver`, so text renders at natural proportions and tick thinning can be decided against real pixels. The y gutter is computed from the widest rendered label. |
| Theme | Three modes — system (default), dark, light — resolved to a `data-theme` attribute | System follows `prefers-color-scheme` and keeps following it live. Where the browser cannot report a preference it resolves to **light**, which is also the base palette in CSS, so a document with no `data-theme` yet still renders correctly. An inline script in `index.html` resolves it before first paint so a dark-mode device never flashes light; it duplicates a few lines of `domain/theme.ts` and `domain/preferences.ts` deliberately, because React has not booted at that point. Unlike every other setting, this one is **remembered between visits** — see the theme persistence row. |
| Offline caching | The whole build is precached; nothing else is cached at all | `AV-802` asks for the app shell. The lazily loaded map chunk, its worker and the FIT parser chunk are included too, so route-only mode (`AV-803`) and opening a `.fit` file both still work offline. There is **no runtime caching**: activity files never travel over the network — they are read from a `File` — so there is nothing of the user's to cache, and map tiles are deliberately left out, since caching a provider's responses would store a record of where the reader has been looking (§5). Offline map tiles remain a separate project (TD-005). |
| FIT parser library | `fit-file-parser` (MIT), lazily loaded | Garmin's official `@garmin/fitsdk` is rejected on **licence**, not merit: its agreement calls the SDK "Confidential Information of Garmin" and forbids making it available to third parties, which an open-source repo served as a public static site cannot satisfy. `fit-file-parser` is MIT, ESM, ships its own types, needs no Node built-ins, and verifies correct against hand-encoded fixtures in Node and in Chromium. It costs 61 KB gzipped in its **own chunk**, so it is off the critical path and the main bundle grew by 0.26 KB. The service worker still precaches that chunk in the background (`AV-802`), so a `.fit` file opens offline — the lazy import buys a faster first paint, not fewer bytes for an installed app. Full reasoning, including the residual risk in its generated FIT profile, is TD-018. |
| Sensor charts | Heart rate, power and temperature shown for any format | `AV-704`. They were always modelled in `charts.ts`; FIT support is simply the first format that commonly carries them. No availability rule changed to switch them on, which is the point — a GPX file with the same extensions gets the same charts. Temperature is the only one needing conversion, and it is an interval scale, so imperial uses the affine °C→°F transform rather than a factor. |
| Export privacy | The device serial number is never written | The app refuses to display it (§5), so writing it into a file the user is likely to share would make the export the one place it leaks. The export says so, rather than dropping it silently. Everything else the source file stated — including its `creator` — is preserved, because the user already had it. |
| Export of an activity with no route | Refused, not written empty | GPX has no track point without a position, so an indoor activity would produce a valid file containing nothing. An honest error naming the reason is more use than an empty track the user discovers later. Partial coordinate loss is different: those points are dropped and counted in a warning. |
| Export loss warnings | Named per format, shown after the download | `AV-551`. GPX cannot carry laps, states sensor fields only through Garmin extensions, and gives cadence a number with no unit. Each is reported by code so the list grows with the format registry rather than with the UI. Shown after saving, not before: computing them means serializing the activity, and doing that on every control change would cost a full pass over the points for a message the user has not asked for yet. |
| FIT export | `FitEncoder`, from the package FIT import already added | `AV-552`/`AV-553`. No new dependency and no new licence question. The library owns the binary container (CRC, definition records, base types); what we own is the profile mapping, verified by round-tripping every fixture and by checking the file's CRC against an independent implementation rather than the encoder's own. Loaded on demand: the encoder costs **1.7 KB gzipped** on top of the FIT parser chunk it shares, and nothing FIT-related reaches the main bundle. The minimal profile and the loss cases were specified in TD-021 before any of it was built. |
| FIT export refuses an activity with no timestamps | Mirrors GPX refusing one with no coordinates | Every FIT record is keyed by time, so a file without timestamps would contain no records at all. The two formats fail on opposite data: a treadmill run exports to FIT but not GPX, and a route with no clock exports to GPX but not FIT. Both refuse with a message naming the reason rather than writing an empty file. |
| TCX cadence | The file's own answer wins, not the sport | TCX is the only format that states cadence units itself: the schema's `Cadence` on a trackpoint is pedal revolutions, and running cadence lives in the `RunCadence` extension. GPX and FIT both force the sport to decide (`AV-515`); TCX does not have to, so it does not. A bare `Cadence` falls back to the sport only when the file offered nothing better. |
| TCX laps on a section export | One lap covering exactly the section | §17 asked how a selected-range export should handle a lap that partly overlaps it. A lap cut in half is no longer the lap the athlete ran — its distance and time would describe something that never happened. Dropping the originals and stating one lap for the exported section is the only version that is true, and it matches what `sliceActivity` already does with laps. Pauses inside the section survive as separate `Track` elements, and a lap boundary is not treated as a pause — a lap is a split marker the recording usually runs straight through. |
| What counts as a place | One definition, `toValidCoordinate`, used on the way in and the way out | Finite, in range, and not `(0, 0)` — Null Island is a device artefact, not a location off the coast of Ghana. Parsers use it to decide what enters the model; the map, the stats and the exporters use it through `hasValidLocation` to decide what leaves. All three parsers previously re-derived a weaker version inline, so the model could hold coordinates every reader of it then skipped. It returns the validated pair rather than a type predicate: a predicate narrows only its first argument, so one that checked both would have left every caller casting the longitude it had just been told was fine. Each format fails differently and each has a fixture: GPX and TCX can state a longitude past the antimeridian, while FIT cannot express one at all — 181 degrees overflows its signed semicircle field — so latitude carries that case there. |
| SEO metadata | Static per route, never derived from a loaded activity | `AV-013`. `useRouteMetadata` takes no arguments and reads no store, so a file name, coordinate, device or derived stat has no path into a `<meta>` tag — which matters because a tag outlives the tab and travels in a shared link. The canonical URL is the site root for **every** route: with `HashRouter`, `#/viewer` is a fragment rather than a page a crawler can fetch, so `sitemap.xml` lists one URL and per-route titles serve tabs and bookmarks rather than indexing. `robots.txt`, `sitemap.xml` and `index.html`'s canonical and Open Graph tags all come from one site URL — the files are generated at build time and the HTML is templated through a `__SITE_URL__` placeholder — so a deployment elsewhere cannot end up naming one site in its canonical tag and another in its sitemap. Verified by building with `VITE_SITE_URL` overridden. See TD-024. |
| Rewrite vs conversion | The source format is offered first, and named as a rewrite | `AV-555`. Writing a file back out in the format it arrived in is the least surprising default and is usually what a section export wants, so it leads — but `Rewrite as GPX` and `Convert to TCX` are different claims and the control makes both. Neither is a copy: the panel says so, because a GPX that goes out is serialized from the parsed activity and carries only what the parser could represent. |
| Pedal cadence | Its own chart, named apart from running cadence | §17 asked whether cycling cadence should be a chart of its own. It is, in `rpm`. It is called **Pedal cadence** because a ride lists both cadence entries — the running one explaining why it is empty, this one carrying the data — and two charts called "Cadence" would be a puzzle rather than a pair. |
| Lap highlighting | Recolours the lap's stretch of route; never moves the map | §17 asked whether a lap should focus the view. It does not, deliberately: a lap says *which part of the ride this is*, not *take me there*. That is the whole difference from a chart range selection, which does move the camera, and a unit test asserts no `fitBounds` follows a lap press. A lap with no continuous stretch to draw — its points either side of a recording gap — shows its figures but offers **no control**, because one that silently does nothing is worse than none. `hasDrawableRoute` answers that by counting rather than by building the geometry, and a test pins it against the geometry so the two cannot drift. |
| Unwritable export targets | Disabled with their reason, never offered and then refused | `AV-555`. An indoor run cannot be written to GPX, and a route with no clock cannot be written to FIT or TCX. Each format states its own requirement beside its serializer — the exporter refuses on exactly that condition — so the rule and the writer cannot disagree, and a test asks the writer to confirm every answer. Judged against what is *about to be written*: a section through a tunnel disables GPX even when the whole ride has coordinates. |
| Map vs app theme | Independent | §17 leaves this open. The basemap keeps its own styling rather than following the app theme, so route-only mode and the tile treatment stay predictable. |
| Terms and Conditions | A route, not a modal | A legal document needs a stable, shareable link, and it must be readable without a loaded activity. The copy is marked **draft** in the page itself: it describes how the app actually behaves, but it has not been reviewed by anyone qualified and must be before release. |
| Routing | React Router, `HashRouter`; `/` homepage and `/viewer`, with settings as modal state rather than a route (`AV-006`, `AV-007`) | The plan defers routing until "multiple views become useful" (§4); the Settings page is that point, and §9 already reserved `src/app/routes.ts`. Hash routing because this is a static, backend-free app: on static hosting such as GitHub Pages a deep link to `/settings` would 404 without server rewrites. |
| Distance source | File distance stream when present *and* monotonic, otherwise haversine | Devices integrate wheel/footpod data more accurately than sparse GPS fixes; a decreasing stream signals corruption and is discarded. |
| Elevation noise threshold | 3 m (`ELEVATION_NOISE_THRESHOLD_METERS`) | Consumer altimeter noise is ±2–5 m; raw delta summing inflates gain on flat routes. Covered by the flat-route test. |
| Malformed points | Skipped with a warning; only an unreadable document fails | One bad `trkpt` should not cost the user the whole route. |
| GPX segments | Preserved, never merged | §17 asked whether to merge or preserve. Merging is not a simplification, it is a fabrication: a `<trkseg>` boundary is where the recording stopped, so joining segments both adds distance the athlete did not cover and draws a straight line down a road they never took. `ActivityPoint.segmentIndex` carries the boundary; distance breaks at it and the route renders one LineString per segment. |
| Web Workers | Deferred until FIT (AV-702) | Measured, not guessed: main-thread GPX parsing blocks the UI for ~0.07 s at 5,000 points, ~0.5 s at 50,000 and ~0.8 s at 100,000 — below the plan's "if UI stalls" bar (§14) for realistic files. Moving the *XML* formats to a worker is not a relocation: `DOMParser` does not exist in a worker (verified), so GPX and TCX would both need a DOM-free XML parser — the first non-essential runtime dependency. FIT is binary and needs no DOM, so it can go straight into a worker for free. FIT import has since landed (`AV-702`) still on the main thread: the parse is fast enough on realistic files that the same "if UI stalls" bar has not been met, and the worker move stays available whenever it is. |

## Status against the plan

The plan lives in [`docs/planning/`](docs/planning/README.md).

Implemented: most of **M0–M6**, **M3.5**, **Stage 3** and **Stage 4** — project
foundation, the GPX route vertical slice, summary stats, the chart panel with
the x-axis switch and run-specific charts, map/chart synchronization, FIT and
TCX import, and browser-side GPX, FIT and TCX export (`AV-001`…`003`, `AV-101`…`103`,
`AV-201`…`203`, `AV-301`…`304`, `AV-401`…`404`, `AV-501`…`507`, `AV-513`, `AV-515`,
`AV-601`…`605`, `AV-004`…`007`, `AV-008`, `AV-009`, `AV-010`, `AV-012`, `AV-405`, `AV-508`–`AV-512`, `AV-514`, `AV-011`, `AV-013`, `AV-406`, `AV-407`, `AV-550`–`AV-555`, `AV-701`–`AV-704`, `AV-750`–`AV-753`, plus `AV-801`–`AV-803`).

The plan grew in `f42a152` with two new epics, neither started:

| Epic | Tasks | Adds |
| --- | --- | --- |
| **E9** GoPro video telemetry | `AV-901`–`AV-907` | Read the GPMF metadata track out of an MP4/MOV in the browser and normalize its GPS and sensor streams into `Activity`, behind its own tool page |
| **E10** Telemetry video overlays | `AV-1001`–`AV-1008` | An overlay tool page: a timeline and template model, a synchronized preview, and export of overlay assets or burned-in video where feasible |

Everything before them is implemented — 67 tasks, every acceptance criterion
met.

One §17 question also remains open: which image to use for link previews.

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
  exist in a worker, so moving either XML format there (GPX or TCX) also means
  replacing it with a DOM-free XML parser. FIT is binary and could move on its
  own whenever the cost justifies it.
- Map hover uses a linear nearest-coordinate scan. Fine for typical tracks;
  a very dense track would benefit from spatial indexing.
