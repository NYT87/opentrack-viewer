# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Three audiences share the product equally; none leads, and the home page must speak to all three.

- **Privacy-minded athletes.** Runners and riders who want to look at a workout file from their watch or bike computer (GPX, FIT, TCX, KML) without handing it to Strava, Garmin Connect or any account. They open one file, read the route, the summary numbers, laps and charts, and close the tab.
- **Tinkerers and converters.** People who need to inspect, convert or repair activity files between devices and apps. For them the viewer is a utility: open a file, check what is in it, download it as another format, with loss stated honestly.
- **Video creators.** GoPro users who extract telemetry from their own footage, build telemetry overlays or burned-in gauges, and export overlay assets for an external editor. File viewing is their on-ramp to the overlay tools.

Route Builder serves the first two: planning a track by hand from a viewed activity or from scratch, appending saved sections, and exporting a plan for an external device.

## Product Purpose

OpenTrack Viewer is a 100% client-side web app and installable PWA for opening activity files. A visitor opens a file from their device, inspects route, stats, laps and charts in the browser, converts it to another supported format, extracts GoPro telemetry from a video, builds overlays, or edits a planned track, and trusts that nothing was uploaded.

Success is a visitor who gets what they came for from one file in one tab, with no account, no server and no activity database, and who leaves with the privacy promise intact.

## Positioning

**Verified local-only.** Parsing, normalization, stats, conversion, GoPro telemetry extraction, route editing and overlay rendering all run in the browser tab. The claim is enforced, not just promised: browser tests fail if any request escapes the deployment sub-path, if a POST/PUT/PATCH is issued when a file loads, if a request body carries coordinates or the file name, or if a tile is requested before an activity is open. A unit test fails if the parse path can reach `fetch`.

Neighbouring products (Strava, Garmin Connect, gpx.studio, desktop overlay tools) cannot truthfully say this, because they are accounts, backends or installed software.

## Operating Context

- **Deployment.** A static site on GitHub Pages at `https://nyt87.github.io/opentrack-viewer/`, served from a repository sub-path. Hash routing (`#/viewer`) keeps deep links working without rewrite rules. `base-path.ts` is the single source of truth for the sub-path, shared by the Vite build, Playwright and the browser tests.
- **Pages.** Home (descriptive, owns no activity state), Viewer (file intake, overview, device card, map, laps, charts, export), Tools → Video telemetry (GoPro MP4/MOV extraction with progress and cancel), Tools → Overlays (video plus activity, timeline, synchronized preview, overlay-only and burned-in export), Tools → Route Builder (one in-memory planned-track draft), Terms and Conditions (routed, read-only), and a Settings modal that never navigates away from loaded data.
- **Session model.** One activity loaded at a time. Closing the tab discards it. Settings are session-scoped except the theme, which is the only value written to `localStorage` (`opentrack-viewer:theme`), read before first paint to avoid a flash.
- **Map.** MapLibre GL JS with OpenStreetMap raster tiles, created only once an activity with a route is open. A route-only mode (basemap off) makes no external request at all. Offline map packs are a separate, later project.
- **Files the visitor brings.** Watch and bike-computer recordings (GPX, FIT, TCX), Google Earth KML, and GoPro video containers. Large files are real: a 100,000-point GPX, multi-gigabyte MP4s read by byte range.
- **Engineering ritual.** Work is organised as epics and task IDs (`AV-xxxx`) with acceptance criteria in `docs/planning/04-engineering-tasks.md`, and technical decisions numbered `TD-xxx` in `docs/planning/06-decisions-and-open-questions.md`. CI runs lint, typecheck, unit tests and Playwright on every push; a push to `main` deploys.

## Capabilities and Constraints

Confirmed functionality:

- Import GPX, FIT, TCX and KML into one format-independent `Activity` model; the UI never depends on parser output.
- Export and direct conversion to GPX, FIT and TCX in the browser. KML is read, not written. `.kmz` is not accepted. Conversion loss is reported, never hidden.
- Summary stats (distance, duration, moving and elapsed time, start and end, elevation gain), a sport-aware primary metric (average pace for running, average speed otherwise), and a non-destructive `View as` override that never rewrites the parsed activity.
- Charts whose availability comes from normalized data, not sport; sport only recommends the initial set. Running cadence is strides per minute and distinct from pedal cadence. Chart range selection is a focus tool, not an edit, with Reset View.
- Map and chart hover and selection are synchronized.
- GoPro telemetry: GPS, acceleration, rotation rate and camera temperature charted; other streams listed by name rather than silently dropped.
- Overlays: templates as placement rules, transparent PNG-sequence export from a worker, burned-in video via a hardware H.264 encoder where available, and standalone transparent route-map stills from any GPX-backed activity.
- Route Builder: points edited by pressing or typing, never dragging; straight-line joins; sections cut with undo for every edit; appended tracks measured and announced but never auto-joined; export as a GPX of places without times.

Hard constraints future work must preserve:

- No backend, account, cloud sync, social sharing, activity history, analytics or error reporting. If error reporting is ever added it must be opt-in and scrubbed of activity data.
- No persistence of activity data in any browser storage. Theme is the only stored value.
- Device serial numbers and stable identifiers are parsed but never rendered by default.
- KML external resources (`NetworkLink`, icons, overlays, models) are counted into a warning and never fetched.
- No road snapping, routing API or navigation engine in Route Builder until a separate privacy decision is made.
- SEO and link-preview metadata describe the app only, never a loaded file.
- Parsing runs on the main thread today; moving a parser to a Web Worker is a registry change, but XML formats would need a DOM-free parser first.

Terminology: *activity* (a normalized file), *planned track* or *route draft* (Route Builder output), *overlay* (telemetry graphics for video), *basemap* (map tiles), *route-only mode* (basemap off), *View as* (presentation override), *focused section* (chart range selection).

Explicitly undecided:

- Which image to use for Open Graph and Twitter/X link previews. The 512×512 icon stands in; a 1200×630 image would render properly.
- Which open-source licence the project will carry (see Brand Commitments).
- Which overlay templates are most useful first: compact HUD, route inset, metric strip, gauge dashboard or sport presets.

## Brand Commitments

- **Name and icons are binding.** The product is "OpenTrack Viewer" (short name "OpenTrack"). The existing app icons at `public/icons/icon-192.png` and `icon-512.png` stay. No rename or re-mark without an explicit decision.
- **Voice.** The written voice already in the README, home page and decision records is plain, specific and candid about limits: it states what is not done and why, and prefers "nothing leaves your device" over marketing abstraction. Future copy keeps that register.
- **Open-source licence to be added.** The project will carry a public licence; which one is undecided until chosen. There is no `LICENSE` file yet, so no page may claim a specific licence.
- **Organisation.** Published under the NYT87 GitHub organisation; the footer links the repository, its issues and `https://nyt87.github.io/`.
- Nothing else beyond the repository is binding.

## Evidence on Hand

- A deployed, working product at `https://nyt87.github.io/opentrack-viewer/`.
- Enforced privacy tests: `e2e/viewer.spec.ts` (no escaping requests, no coordinates in bodies, no tile before an activity) and `src/parsers/index.test.ts` (parse path cannot reach `fetch`).
- Synthetic test fixtures under `src/test/fixtures/` (documented in its README), plus three third-party GoPro samples: `hero7.raw` and `hero11.raw` (MIT, Juan Irache Duesca) and `hero8.mp4` (GoPro, Inc., Apache-2.0 or MIT).
- Full planning record in `docs/planning/` and a long README with every product decision and known limitation.
- Absent, and not to be fabricated: testimonials, user counts, customer logos, press, benchmarks against other tools, pricing, and a licence statement.

## Product Principles

1. **The promise is tested, not asserted.** Every feature that touches a file, a video or a route keeps the local-only boundary, and a browser test guards it. A convenience that needs a request leaving the tab is not a convenience here.
2. **Three audiences, one front door.** Athletes, converters and video creators arrive at the same home page and header; each must find their path without the others' path being hidden.
3. **Show what the data supports, hide what it does not.** Charts, laps, device cards and placeholders appear only when normalized data earns them. No empty boxes, no wrong-sport messages.
4. **Say what was lost.** Conversion, export, telemetry extraction and route appending report loss, gaps and jumps explicitly rather than smoothing them over.
5. **Inspect, never mutate by accident.** Range selection, `View as` and Route Builder edits are derived or copied views; the parsed activity stays immutable, and destructive edits have undo.

## Accessibility & Inclusion

Target is **WCAG 2.2 AA**. Keyboard operability, sufficient contrast in both themes, and respect for `prefers-reduced-motion` are requirements, not extras. Existing commitments already in code: an accessible name and visible focus state on the icon-only Settings control, keyboard-operable Route Builder editing (points entered by pressing or typing, never dragging), and a system/dark/light theme that follows the OS by default.
