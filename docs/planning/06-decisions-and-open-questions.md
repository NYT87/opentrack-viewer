# Decisions and Open Questions

## 16. Technical Decisions

### TD-001: Client-Side Only

Decision: Activity files are processed locally in the browser.

Reason: This is the product's core trust and privacy boundary.

### TD-002: Format-Independent Domain Model

Decision: the GPX, FIT and TCX parsers must all output the same `Activity` model.

Reason: The UI, stats, map, and chart layers should not depend on source file format.

### TD-003: MapLibre GL JS

Decision: Use MapLibre GL JS for map rendering.

Reason: It is open-source, flexible, and can support custom tile sources and future offline-oriented strategies.

### TD-004: GPX Before FIT

Decision: Build GPX first.

Reason: GPX is XML-based, simpler to inspect, and validates the route rendering pipeline before binary FIT complexity.

### TD-005: Offline Maps Are Separate

Decision: Treat offline map support as a later project.

Reason: Offline tiles introduce storage, licensing, packaging, and UX decisions that should not block the initial viewer.

### TD-006: Focused Activity Slices Are Derived Views

Decision: Chart range selection creates a derived focused view from the original normalized activity.

Reason: Users need to inspect a segment without changing or losing the full activity. Keeping the original immutable also makes clear/reset behavior, tests, and future export decisions safer.

### TD-007: Export Is Client-Side Serialization

Decision: GPX, FIT, and TCX export must serialize normalized activity data in the browser and download via browser APIs.

Reason: Export should preserve the product's privacy boundary. No backend is needed to convert files.

### TD-008: Settings Are Modal State

Decision: Settings should be a modal opened from the global header on every page instead of a routed page.

Reason: Users should be able to adjust units, basemap behavior, and future viewer settings without navigating away from the loaded activity or resetting in-memory file state.

### TD-009: Terms and Conditions Is a Routed Page

Decision: Terms and Conditions should be a routed informational page, not a modal.

Reason: Legal and usage terms need a stable URL that can be linked from the homepage, footer, repository, and future release materials.

### TD-010: Theme Defaults to System

Decision: The theme preference has three modes: system, dark, and light. The default is system, which resolves from OS/browser color-scheme preference. If system preference cannot be detected, light is the fallback.

Reason: System default respects user device preferences, while light fallback keeps the app readable in environments without reliable color-scheme detection.

### TD-011: Header Brand Is the Home Link

Decision: The global header should use the `OpenTrack Viewer` brand/title as the homepage link, omit the descriptive subtitle, avoid a duplicate Home button, and always expose Settings through an icon-only control.

Reason: This keeps the app chrome compact after an activity is loaded, reduces redundant navigation, and preserves a clear settings entry without taking unnecessary horizontal space.

### TD-012: Running Cadence Uses Strides Per Minute

Decision: Running cadence should be modeled and displayed as strides per minute, using a running-specific field such as `runningCadenceSpm`. RPM should be reserved for cycling or other rotational cadence sources.

Reason: Runners expect cadence to describe stride rhythm, while RPM implies rotational cycling sensor data. Separate fields avoid chart-label ambiguity and parser mapping mistakes.

### TD-013: Loaded Viewer Uses Max-Width Content and Section Navigation

Decision: The loaded viewer should use a centered max-width content area with a compact left section sidebar on large screens. The main content order should be overview first, map second, and charts later.

Reason: Activity pages need scan-friendly structure without stretching content across very wide screens. A small section sidebar improves navigation on large screens while staying out of the way on smaller screens.

### TD-014: Laps Sit Beside the Map on Large Screens

Decision: When lap data exists, laps should display beside the map on large screens and after the map on medium/small/mobile screens.

Reason: Laps are most useful when read alongside the route, but the map should keep priority on constrained screens.

### TD-015: Viewer Entry Lives Under Tools

Decision: The header should place a `Tools` dropdown beside the `OpenTrack Viewer` title, and the current viewer/process route should be exposed as `File viewer` inside that dropdown instead of a standalone top-level `Viewer` button.

Reason: The project may gain more browser-only tools later. Grouping tool entry points early keeps the header compact while preserving a clear path to the file viewer.

### TD-016: SEO Is Static and Privacy-Safe

Decision: SEO metadata should describe OpenTrack Viewer, public routes, and browser-only capabilities. It must never include loaded activity data or file-specific metadata.

Reason: SEO helps users discover the app, but activity files are private local data. Search metadata must stay outside the activity-processing privacy boundary.

### TD-017: Overview Primary Metric Is Sport-Specific

Decision: Running activities should display average pace as the primary overview performance metric, while cycling activities should display average speed.

Reason: Pace is the expected primary metric for running, and speed is the expected primary metric for cycling. Using sport-specific defaults makes the overview easier to scan and avoids showing a less useful metric first.

### TD-018: FIT Parsing Uses `fit-file-parser`, Not Garmin's SDK

Decision: FIT files are decoded with `fit-file-parser` (MIT). Garmin's official `@garmin/fitsdk` is rejected on licensing grounds, not technical ones.

Reason: `@garmin/fitsdk` ships under the FIT Protocol License Agreement, which states that the SDK "is Confidential Information of Garmin" (§4) and forbids the licensee to "distribute, publish, transfer or otherwise make available the Licensed Technology... to any third party for any reason" (§2c). OpenTrack Viewer is an open-source repository deployed as a public static site, so its dependencies are published as readable source and served to anyone who opens the page. That is incompatible with both clauses. §2d, which forbids placing the technology under a license requiring source disclosure, points the same way.

`fit-file-parser` is MIT, ESM, ships its own TypeScript declarations, uses no Node-only APIs, and exposes `parseAsync(ArrayBuffer)`. Verified by parsing hand-encoded fixtures in Node and in real Chromium: coordinates decode from semicircles, altitude and speed descale correctly, and sport and manufacturer enums resolve to names. It bundles to **59.4 KB gzipped**, minified, including the `buffer` polyfill it depends on; no `Buffer` global is required at runtime. That cost is code-split into its own chunk, so it is absent from the initial page load and the main bundle grows by 0.26 KB. It is *not* absent from the device: `AV-802` precaches every emitted asset, so the service worker fetches the FIT chunk in the background after the first visit — deliberately, because a reader offline with a `.fit` file should still be able to open it, exactly as the lazily loaded map chunk is precached for offline route drawing. The lazy import buys a faster first paint and a smaller critical path, not fewer bytes over the lifetime of an installed app.

Residual risk, accepted and recorded: the library's `garmin_profile.generated.js` encodes the FIT profile's message and field numbering, which originates in Garmin's published SDK documentation. The library is MIT on its author's authority. This is the same position every open-source FIT reader occupies, and the alternative — reimplementing the profile ourselves — would not improve it.

### TD-019: Selected-Range Export Preserves Original Timestamps

Decision: exporting a selected section writes the points' original timestamps, unshifted.

Reason: §17 asked whether to normalize them to the section's start. A track point's time is a record of when the athlete was at that place; rewriting it would make the exported file disagree with every other copy of the same activity, and with the athlete's own memory of when they went out. A section is a shorter recording, not a different one. The file name gains a `-section` suffix so it cannot be mistaken for the whole activity.

### TD-020: GPX Export Writes Garmin Extensions, and Never the Serial Number

Decision: `AV-551` writes sensor data using Garmin's `TrackPointExtension` and `PowerExtension` namespaces, and never writes the recording device's serial number.

Reason: GPX defines no element for heart rate, cadence, power, temperature or speed, so an exporter either drops them or uses the extension vocabulary every device and tool already writes. Power in particular is spelled `gpxpx:PowerInWatts` by Garmin, which is what other applications read; the GPX parser now accepts that spelling too, so an exported file re-imports with its power intact.

The serial number is excluded on privacy grounds, not technical ones. §5 permits showing a stable identifier only where there is a clear reason to, and the viewer has none — `DISPLAYABLE_DEVICE_FIELDS` already excludes it. An exported file is more shareable than a screen, so writing it there would make the export the single place the identifier escapes. The export reports the omission as a warning rather than performing it silently.

### TD-021: FIT Export Is Viable, Using the Encoder Already in the Tree

Decision (`AV-552`): FIT export will be implemented with `FitEncoder`, which ships inside `fit-file-parser` — the dependency FIT *import* already added. It is neither a new library nor an internal encoder written from scratch, and it is not deferred.

**Licence.** Unchanged: same MIT package, already assessed in TD-018. No new dependency and no new licence review.

**Bundle size.** Measured, not estimated: adding the encoder to a bundle that already contains the parser costs **1.7 KB gzipped** (58,442 → 60,200 bytes), and nothing FIT-related reaches the main bundle.

Stated precisely, because the marginal figure is easy to over-read: the built app splits FIT into a shared 61 KB gzipped chunk (the library, whose `exports` map publishes only its entry point, so the encoder cannot be imported apart from the parser) plus thin per-use chunks — `buildFit` at 1.9 KB and `parseFit` at 2.2 KB. So 1.7 KB is what export costs *someone who has already loaded FIT import*; a reader who only ever exports FIT downloads the shared chunk as well. Either way it is loaded on demand, and a GPX-only user downloads none of it on first paint.

**Browser compatibility.** Same package, same build, already verified running in Chromium with no Node built-ins and no `Buffer` global.

**Correctness risk, and where it actually sits.** `FitEncoder` is deliberately low-level: it owns the binary container — header, definition records, base-type sizes, endianness, range validation and the CRC — but the caller supplies profile field numbers and *already-scaled* values. So the library carries the fiddly binary plumbing, and the risk we take on is the profile mapping: wrong field numbers, wrong scale or offset (altitude is ×5 with a −500 m offset, distance ×100, speed ×1000, coordinates in semicircles), the FIT epoch of 1989-12-31, and omitting messages other tools expect.

That risk is testable rather than theoretical, and a spike confirmed it before this decision was recorded: a four-point activity encoded to 135 bytes, its trailing CRC matched an **independent** CRC-16 implementation (the one in `make-fit-fixtures.mjs`, not the library's), its header still read `.FIT`, and `parseFit` read it back with coordinates, elevation, timestamps, sport and distance all intact. The hand-written fixture encoder remains a second independent implementation to cross-check field numbers against.

**Minimal supported export profile**, defined before implementation:

| Message | Global | Fields |
| --- | --- | --- |
| `file_id` | 0 | `type` = activity, `manufacturer` = development, `time_created`. **No `serial_number`** — TD-020 applies to every format we write. |
| `sport` | 12 | `sport`, `sub_sport` when known |
| `event` | 21 | `timer` start/stop pairs, reproducing segment boundaries |
| `record` | 20 | `timestamp`, `position_lat`, `position_long`, `altitude`, `distance`, `speed`, `heart_rate`, `cadence`, `power`, `temperature` — each written only when the point has it |
| `lap` | 19 | `start_time`, `timestamp`, `total_elapsed_time`, `total_distance`, when the activity has laps |
| `session` | 18 | `start_time`, `timestamp`, `sport`, `total_elapsed_time`, `total_timer_time`, `total_distance` |
| `activity` | 34 | `timestamp`, `num_sessions`, `type`, `event`, `event_type` |

**Known loss, to be reported as export warnings.** FIT keys records by timestamp, so a point without one cannot be written — where GPX tolerates it. An activity with no timestamps at all must therefore be refused rather than written empty, mirroring the way GPX export refuses an activity with no coordinates. Sub-second times are lost to FIT's whole-second resolution. Cadence occupies a single field, so strides and pedal revolutions are told apart only by the declared sport — the same ambiguity GPX has. The source device's identity is not reproduced: the file declares this app as its creator.

**Scope.** GPX export shipped first and does not depend on any of this (`AV-550`, `AV-551`, `AV-554` are complete), so FIT export can be built, delayed or dropped without touching it.

### TD-022: Focused-Range Stats Live in Their Own Panel

Decision (`AV-605`): the selected section's figures are shown in a separate, labelled **Selected section** panel beside the chart focus controls. The activity summary always describes the whole activity, whatever is selected.

Reason: §17 asked whether focused stats belong in the main summary panel, a secondary panel, or both. The main panel is the wrong home — a `Distance` that changes when the reader drags across a chart is ambiguous at a glance, because nothing on the row says which of the two things it is measuring. Splitting them means each panel answers one question and says which. It also matches how the map behaves: the map focuses on the selection while the summary does not, because one is a view and the other is a description of the file.

Both panels are rendered from the same `buildSummaryStats`, so a figure is formatted, and a missing figure explained, identically in each — the acceptance criterion about missing-value conventions is satisfied by construction rather than by remembering to match.

The section panel sits next to the focus bar rather than up in the overview: that is where the selection was made and where the reader is looking, and it puts `Reset View` next to the figures it clears.

### TD-023: TCX Scope and Field Mapping

Decision (`AV-750`): TCX is read and written in the browser with `DOMParser` and string serialization, exactly as GPX is — no new dependency. The mapping below is shared by the importer and the exporter.

**Import — TCX to `Activity`**

| TCX | `Activity` |
| --- | --- |
| `Activity@Sport` | `metadata.sport` |
| `Activity/Id` | `metadata.name` fallback (TCX has no name field) |
| `Lap@StartTime`, `TotalTimeSeconds`, `DistanceMeters`, `Calories` | `laps[].startTime`, `durationSeconds`, `distanceMeters`, `caloriesKcal` |
| A *second* `Track` inside one `Lap` | `point.segmentIndex` — a new `Track` within a lap is where the recording stopped. A **lap boundary is not** a segment break: a lap is a split marker and the recording usually runs straight through it, so breaking there would drop the ground covered between the last point of one lap and the first of the next |
| `Trackpoint/Time` | `point.time` |
| `Trackpoint/Position/{Latitude,Longitude}Degrees` | `point.lat`, `point.lon` |
| `Trackpoint/AltitudeMeters` | `point.elevationMeters` |
| `Trackpoint/DistanceMeters` | `point.distanceMeters` |
| `Trackpoint/HeartRateBpm/Value` | `point.heartRateBpm` |
| `Trackpoint/Cadence` | `point.cyclingCadenceRpm` — the schema's `Cadence` on a trackpoint is bike cadence |
| `Trackpoint/Extensions/TPX/RunCadence` | `point.runningCadenceSpm` |
| `Trackpoint/Extensions/TPX/Speed`, `Watts` | `point.speedMetersPerSecond`, `point.powerWatts` |
| `Activity/Creator/{Name,ProductID,Version}` | `metadata.device` |
| `Activity/Creator/UnitId` | `device.serialNumber` — parsed, never displayed (TD-020) |

TCX is the first format that states cadence units *itself*: `Cadence` is cycling and the `RunCadence` extension is running, so unlike GPX and FIT the sport does not have to decide. Where a file states both, the explicit one wins.

**Known limits and loss**

- **Sport vocabulary.** TCX has three values: `Running`, `Biking`, `Other`. Hiking, walking, swimming, rowing and skiing all export as `Other`, and a re-import cannot recover which they were. Warned on export.
- **Temperature.** TCX defines no temperature field, standard or extension, so it is dropped on export. Warned.
- **Laps are structural and mandatory.** A `Track` exists only inside a `Lap`, and the schema requires at least one. An activity with no laps therefore exports as a single lap covering the whole track. `Calories` is a required element, so it is written as `0` when unknown rather than omitted — a file that omits it does not parse.
- **A section export writes one lap covering the section.** This resolves the §17 question about laps that partly overlap a selected range. A lap cut in half is no longer the lap the athlete ran: its distance and time would describe something that never happened, and its name would imply otherwise. Dropping the original laps and stating a single lap for exactly the exported section is the only version that is true. This is already what `sliceActivity` does with laps, so import, focus and export agree.

### TD-024: SEO Is Static, Route-Aware, and Bounded by the Hash Router

Decision (`AV-013`): every route sets its own title and description from a hand-written table in `src/app/seo.ts`, `index.html` carries the same values statically, and the canonical URL is the site root for every route.

**Nothing is derived from a loaded activity.** `useRouteMetadata` takes no arguments and reads no store, so there is no path by which a file name, a coordinate, a device or a derived stat could reach a `<meta>` tag. That matters more here than elsewhere in the app: a tag outlives the tab, and travels in a shared link or a browser history. Two tests load a real file — one with a device serial — and assert the whole of `document.head` still says nothing about it.

**The canonical URL is the site root, for every route.** The app uses `HashRouter`, so `#/viewer` is a fragment of one page rather than a resource a crawler can fetch. Giving each route its own `#` canonical would claim distinct pages that no search engine treats as distinct. This resolves the §17 question about whether the viewer route should be indexed: it cannot be, structurally, and `sitemap.xml` therefore lists one URL. Per-route titles still earn their place — they name the browser tab, the bookmark and the history entry, and a shared link keeps its hash.

**The deployment URL is confirmed:** `https://nyt87.github.io/opentrack-viewer/`. `base-path.ts` holds it as `DEFAULT_SITE_URL`, `resolveSiteUrl()` exposes it, and `VITE_SITE_URL` overrides it for a deployment elsewhere. A test asserts the app's own fallback copy still agrees with it, since the build injects the value and the literal would otherwise drift unnoticed. `robots.txt` and `sitemap.xml` are **generated at build time** from that one value rather than committed, and `index.html`'s canonical, `og:url` and image tags are substituted from it through a `__SITE_URL__` placeholder. Every URL a crawler can see therefore comes from a single definition: a deployment elsewhere cannot end up with a canonical tag naming one site and a sitemap naming another.

**Still open:** the preview image is the 512×512 app icon, because there is no purpose-made one. A 1200×630 image would render better in link previews, and §17 still asks which image that should be.

### TD-025: GoPro Extraction Is a Separate Tool Page

Decision: GoPro MP4/MOV telemetry extraction should live on a dedicated extraction page, reachable from the header `Tools` dropdown. After extraction succeeds, that page should show a button that opens the existing viewer with the normalized activity loaded through client-side state.

Reason: Video extraction has different UX, progress, cancellation, error states, and performance risks than ordinary activity-file parsing. Keeping it as its own tool avoids overloading the generic viewer empty state while still reusing the viewer for maps, charts, stats, focus ranges, reset view, and exports after data exists.

### TD-026: Overlay-Only Export Before Burned-In Video Export

Decision: Telemetry overlay work should first support overlay preview and overlay-only export for external video editors. Burned-in video export should follow only after a browser-side encoding feasibility task validates the implementation path.

Reason: Overlay-only export is useful, smaller in scope, and avoids source video transcoding. Burned-in video export requires heavier browser APIs, memory management, codec/container decisions, audio handling, and longer-running local processing, so it needs measured evidence before becoming committed delivery scope.

### TD-027: Device Metadata Uses a Separate Card

Decision: Device information should render in its own viewer card when safe display fields are available, not inside the summary/activity overview card.

Reason: Summary metrics and recording-device metadata answer different questions. Splitting them keeps the overview focused on activity performance while giving device metadata a clear place with its own privacy/redaction behavior.

### TD-025: GoPro Telemetry Is Read With `gpmf-extract` and `gopro-telemetry`

Decision (`AV-901`): the browser locates the GoPro metadata track with **`gpmf-extract`** (over **`mp4box`**) and interprets the raw payload with **`gopro-telemetry`**. GoPro's own `gpmf-parser` is kept as the *specification reference*, not compiled; `telemetrik` is kept as a *fixture oracle*, not a dependency.

**Licences, read from the licence files rather than the manifests.** Every one is permissive and none conflicts with publishing this app as open source — but two of them do not say what `package.json` says, which matters because that field is what a licence scanner reads:

| Package | `package.json` | `LICENSE` file | Governs |
| --- | --- | --- | --- |
| `gopro-telemetry` | `ISC` | MIT — "MIT License, Copyright (c) 2019 Juan Irache Duesca" | **MIT.** The manifest is wrong. |
| `gpmf-extract` | `ISC` | MIT, same author, same wording | **MIT.** The same mistake, in the same hand. |
| `mp4box` | `BSD-3-Clause` | BSD ("Redistribution and use…") | BSD-3-Clause, agreed |
| `binary-parser` | `MIT` | MIT ("Permission is hereby granted…") | MIT, agreed |

ISC and MIT are both permissive and near-identical in effect, so nothing turns on the discrepancy legally. It is recorded because an automated audit of this project will report ISC for two dependencies whose actual terms are MIT, and someone will otherwise have to rediscover why.

**The three candidates, assessed**

| Project | Licence | Verdict |
| --- | --- | --- |
| [`gopro/gpmf-parser`](https://github.com/gopro/gpmf-parser) | **Apache-2.0 *or* MIT**, at our choice — its `LICENSE.txt` opens "Apache License 2.0 or MIT" and the README says "licensed under either". C, actively pushed | The authoritative definition of GPMF, and worth reading as the spec. **Not compiled to WebAssembly:** that would add an Emscripten toolchain to the build and ship a `.wasm` asset, to duplicate what a maintained pure-JS path already does. WASM would earn its place only if the JS proved wrong or too slow — neither is in evidence. |
| [`JuanIrache/gopro-telemetry`](https://github.com/JuanIrache/gopro-telemetry) | MIT by its licence file, pure JS, published 2025-10 | **Chosen** for interpretation. Handles `GPS5` (HERO5–HERO10) and `GPS9` (HERO11 onward), plus `ACCL`, `GYRO`, `GRAV`, `CORI`, `MAGN`, `TMPC`, `SHUT`. 18 KB gzipped. |
| [`kmatzen/telemetrik`](https://github.com/kmatzen/telemetrik) | MIT, Python | Not a browser dependency, as the task notes. Kept as an **independent oracle** for fixtures — the same role the hand-written FIT encoder plays against `fit-file-parser`: two implementations agreeing is worth more than one agreeing with itself. |

**Reading the metadata track without loading the video.** This was the criterion that decided the approach, and `gpmf-extract` already answers it — verified by reading its source, not its README:

- It reads with `file.stream().pipeTo(new WritableStream(…))`, applying backpressure at a 2 MB chunk size. The video is never held in memory; it flows past.
- It streams the read in chunks with backpressure. The library's own inline Web Worker is intentionally disabled for now; current Chromium can misread a valid GoPro file through that worker path, so extraction stays on the main thread until it can move into an app-owned worker.
- It reports **progress** by byte offset, and accepts a **cancellation token** checked on every chunk.
- `mp4box.onReady` finds the track whose codec is `gpmd`; when there is none it terminates early rather than reading on.
- Only the metadata samples are retained. **Peak memory is proportional to the GPMF payload — a few MB for a long recording — not to the video.**

**Four defects in `gpmf-extract`.** The first was found by reading its source, the next two by running it in tests, and the last only by running it in a real browser. Each is summarized below; [`docs/upstream/gpmf-extract-issues.md`](../upstream/gpmf-extract-issues.md) writes them up as a self-contained report, with reproductions and suggested fixes, for anyone who wants to take them upstream:

1. **It never stops reading.** The promise resolves once the samples are collected, but `terminate()` is never called, so a multi-gigabyte file keeps streaming afterwards. Handled by passing a `cancellationToken` and cancelling it in a `finally` — on the success path too, because settling is not what ends the read.
2. **A file it cannot parse hangs forever.** Given bytes that are not an MP4 it neither resolves nor rejects: it reads to the end, recognizes no container, and stops. In a UI that is a progress bar that fills and then waits. Handled by treating the read reaching 100% as the end of what can arrive, and rejecting `no_telemetry_track` after a short grace period. A test proves it: with the guard removed, that case runs until the 60-second timeout.
3. **Its failures are untyped and undocumented.** A container without a `gpmd` track throws `TypeError: Cannot read properties of undefined (reading 'duration')`, not the documented `'Track not found'`. Everything it throws is mapped to an `ActivityError` — `no_telemetry_track`, `extraction_cancelled` or `gopro_extract_failed` — so a caller never matches on prose.
4. **Its Web Worker is broken in current Chromium.** With `useWorker: true` a valid HERO8 clip reports `'Track not found'`; with it off, the same file reads correctly. The library's README hedges that the worker "seems to crash on some recent browsers", and a browser test caught it doing so — jsdom could never have, since it has no `Worker` and silently took the other path. The worker is therefore **disabled**. The read is still chunked through a stream, so the main thread is released between chunks, and `AV-903`'s API is async precisely so the whole extraction can move into a worker of our own later.

**Bundle.** ~81 KB gzipped for the whole path — `mp4box` 54 KB, `gopro-telemetry` 18 KB, `gpmf-extract` and `binary-parser` the rest. Comparable to the FIT parser's 61 KB, and loaded on demand behind the tool page, so nobody who never opens a video pays for it.

**First supported scope.** MP4/MOV carrying a `gpmd` track from HERO5 onward: `GPS5` or `GPS9` into `lat`, `lon`, `elevationMeters`, `time` and `speedMetersPerSecond`. A file with no `gpmd` track is reported as unsupported with a typed error, never half-parsed. The IMU streams (`ACCL`, `GYRO`, `GRAV`, `CORI`, `MAGN`) have no home in `Activity` today and belong to `AV-905`.

**One semantic trap, recorded before it bites.** `TMPC` is the *camera's* temperature, not the air's. It must not become `temperatureCelsius` unremarked — that field means ambient temperature everywhere else in this app, and a camera in the sun reads far above it. The same class of mistake as GPX cadence with no unit.

## 17. Open Questions

### Answered by what was built

Each of these was recorded as an open question and has since been settled by a
decision above or by the shipped code. The answer is kept rather than the
question deleted, so the reasoning stays findable.

| Question | Answer |
| --- | --- |
| Which map tile provider, and its attribution? | OpenStreetMap raster tiles, with `© OpenStreetMap contributors` rendered on the map. Route-only mode fetches none (TD-005). |
| Path routes or hash equivalents? | Hash. `HashRouter`, so a static host needs no rewrite rules and a deep link survives a refresh. |
| `/terms`, `/terms-and-conditions`, or a hash equivalent? | `/terms`, as a routed page rather than a modal, so a legal document has a stable link (`AV-008`). |
| What homepage sections before the viewer action? | The privacy statement, a table of supported formats with their status, and the action itself. |
| Homepage header navigation beyond the name and viewer action? | No. The brand is the link home, and `Tools` carries navigation (`AV-010`, `AV-012`). |
| Which settings icon, and how does its tooltip behave? | A gear button with `aria-label` and `title`, so it is named for assistive technology and shows a tooltip on hover and focus. |
| Does the `Tools` dropdown appear on the homepage? | Yes, in the header on every page. Settings also appears in the header on every page. |
| Metric, imperial, or locale-based units by default? | The browser's locale decides, and Settings overrides it for the session. See the built answer below. |
| Should map style follow the app theme? | No — the basemap is independently controlled, because a dark basemap is a cartographic choice rather than a UI one. |
| File-provided distance stream or derived GPS distance? | The file's, when it is present and non-decreasing; otherwise derived from positions. A recorded stream is an odometer, so it is read relative to its first value. |
| Does the chart x-axis preference persist? | For the session, across loaded files — like the unit system. `reset()` clears the hover and range state a new file invalidates, not the user's preferences. |
| Imperial tick intervals: miles or converted kilometres? | Whole miles. A label should mean the same thing in either system (`AV-514`). |
| At what width are tick labels thinned? | Not a width: labels are dropped when they would fall closer than the minimum spacing, keeping every tick mark. |
| Does a selected range survive an x-axis switch? | Yes. The selection is stored as point indices, not as a span of whichever axis was showing (`AV-509`). |
| Selected-range map behaviour: hide, dim, or section only? | The full route is dimmed and the section drawn over it, so the selection is legible without losing where it sits (`AV-604`). |
| Minimum drag before a range is accepted? | 8 pixels. Below that the gesture is treated as a click, so a click never becomes an accidental one-point selection. |
| Pace from instantaneous speed or derived? | Derived, over a rolling window — see the pace decision above. |
| Average pace/speed over moving or elapsed time? | Elapsed, so the figure agrees with the `Duration` beside it. Moving time is reported separately. |
| What pace smoothing window? | 15 seconds, enough that GPS jitter between samples does not dominate. |
| `strides/min`, `spm`, or the full phrase for cadence? | `spm` on the axis, with the chart stating "Strides per minute: one foot, as watches and foot pods report it." |
| Cycling speed: recorded, derived, or hybrid? | Recorded when plausible, derived otherwise — a wheel sensor knows better than GPS, but a faulty reading is worse than none. |
| What elevation-gain noise threshold? | 3 m, so barometric jitter on flat ground does not accumulate into a climb. |
| Which device fields are shown, and do sensitive ones need a reveal? | Manufacturer, model, name and software version. There is no reveal control: the serial number is never displayable (TD-020). |
| Is GPX `creator` device or app information? | Neither is claimed. It is shown as "Recorded with", because the same field holds "Garmin Edge 530" and "StravaGPX Android". |
| What stays on the upload-only page? | The privacy statement and the formats accepted; everything about an activity appears only once one is open. |
| Where does a change-file action live in the ready viewer? | Nowhere. The drop zone is removed while an activity is open, and `Close activity` is the way back — so a file cannot be swapped out from under a loaded map and charts. |
| What maximum content width? | 1120 px. |
| At what breakpoint does the section sidebar appear? | 1100 px. |
| Scrollspy or static anchors first? | Static buttons — not `#id` anchors, which `HashRouter` would read as a route. |
| Which lap fields beyond distance and duration? | Calories, and only for formats that state them, rather than a column of dashes for every GPX. |
| Charts below the map on all screens, or mobile chart navigation first? | Below on all screens, with the section list serving as navigation where there is room for it. |
| Moving-time threshold without explicit pause data? | 0.5 m/s. |
| Move parsing to Web Workers immediately or after a measured problem? | After. Measured instead: main-thread parsing stays under the plan's "if UI stalls" bar for realistic files, and `DOMParser` does not exist in a worker. |
| How much metadata to display, given privacy? | Only what a person reads: human-readable device fields, never stable identifiers, and never in SEO tags (TD-016, TD-020). |
| Preserve or merge GPX route segments? | Preserve. Merging is a fabrication: it adds distance the athlete did not cover and draws a line down a road they never took. |
| Skip malformed points or fail the file? | Skip with a warning, and fail only when nothing usable remains. |
| App-shell offline only, or route-only mode too? | Both shipped (`AV-802`, `AV-803`). |

### Answered, needing no work

- **Who approves the Terms and Conditions copy before release?** The repository owner.
- **Once GoPro extraction is available, how should `Tools` entries be ordered?** Prefer `File viewer` first, then `Video telemetry`, unless usage data or product copy suggests another order.

### Answered, and built

- **Units follow the browser locale.** Through `Intl.Locale`'s `measurementSystem` where the browser exposes it, and a small region list where it does not. The UK is deliberately metric: it measures road distance in miles but runs and rides in kilometres. It is a default only — the Settings control overrides it for the session.
- **The theme preference persists**, under `opentrack-viewer:theme`, and is the only thing this app writes to `localStorage`. The pre-paint script in `index.html` reads it before React boots, so a remembered dark theme does not flash light. The settings modal previously said "Nothing is saved to your device"; it now says which one thing is, and that no activity data ever is. The Terms page's narrower claim — nothing about your *activity* is stored — was already true and is unchanged. Persisting happens without a consent step, as answered.
- **Pedal cadence is a chart of its own**, offered to rides that record it, in `rpm`. It is labelled **Pedal cadence** rather than Cadence: a ride lists both entries — the running one explaining why it is empty, this one carrying the data — and two charts with the same name would be a puzzle rather than a pair.
- **A lap row highlights its stretch of the route**, in a colour of its own, and does not move the map. That is the whole difference from a chart range selection, which does move the camera: a lap says which part of the ride this is, not take me there. A unit test asserts no `fitBounds` follows a lap selection.

### Still open

- What image should be used for Open Graph and Twitter/X previews? The 512×512 app icon stands in; a purpose-made 1200×630 image would render properly in link previews.
- For GoPro video telemetry, should the first implementation use a WebAssembly build of GoPro's `gpmf-parser`, a JavaScript stack such as `gopro-telemetry` plus raw GPMF extraction, or an internal minimal MP4/GPMF reader?
- What GoPro models and telemetry streams are in the first supported scope: GPS only, GPS plus speed/altitude, or GPS plus IMU/camera streams?
- How should GoPro high-frequency IMU streams be represented in the domain without bloating `ActivityPoint`?
- What small redistributable GoPro/GPMF fixtures can be committed for automated tests?
- Which overlay-only export format should ship first: transparent WebM, chroma-key video, PNG/WebP image sequence, or a combination?
- Is burned-in browser-side video export viable for realistic GoPro clips with acceptable quality, memory usage, duration limits, browser support, and audio handling?
- What first overlay templates are most useful for activity videos: compact HUD, route/map inset, metric strip, gauge dashboard, or sport-specific presets?
- Should overlay configuration be exported as project JSON so users can reuse templates between videos?
