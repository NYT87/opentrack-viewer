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

Decision: Settings should be a modal opened from non-home pages instead of a routed page.

Reason: Users should be able to adjust units, basemap behavior, and future viewer settings without navigating away from the loaded activity or resetting in-memory file state.

### TD-009: Terms and Conditions Is a Routed Page

Decision: Terms and Conditions should be a routed informational page, not a modal.

Reason: Legal and usage terms need a stable URL that can be linked from the homepage, footer, repository, and future release materials.

### TD-010: Theme Defaults to System

Decision: The theme preference has three modes: system, dark, and light. The default is system, which resolves from OS/browser color-scheme preference. If system preference cannot be detected, light is the fallback.

Reason: System default respects user device preferences, while light fallback keeps the app readable in environments without reliable color-scheme detection.

### TD-011: Header Brand Is the Home Link

Decision: The global header should use the `OpenTrack Viewer` brand/title as the homepage link, omit the descriptive subtitle, avoid a duplicate Home button, and expose Settings on non-home pages through an icon-only control.

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

## 17. Open Questions

- Which map tile provider should be used initially, and what are its attribution and usage requirements?
- Should routes be `/` and `/viewer`, or hash equivalents for static hosting?
- Should the Terms and Conditions route be `/terms`, `/terms-and-conditions`, or a hash equivalent for static hosting?
- Who will review and approve the final Terms and Conditions copy before production release?
- What exact homepage sections should be present before the viewer action?
- Should the homepage have any header navigation beyond the project name and viewer action?
- Which settings icon should be used in the header, and should the tooltip appear on hover only or also support long-press/touch affordances?
- Should the `Tools` dropdown appear on the homepage header, or only after the user leaves the homepage?
- If more tools are added later, what ordering should the `Tools` dropdown use?
- What is the production canonical URL for OpenTrack Viewer?
- What image should be used for Open Graph and Twitter/X previews?
- Should the viewer/process route be indexed, or should SEO focus primarily on homepage and legal pages?
- Should the app default to metric units, imperial units, or locale-based units?
- Should theme preference remain session-only like other settings, or eventually persist locally after explicit user approval?
- Should map style/theme change with app theme, or should basemap style remain independently controlled?
- Should distance prefer file-provided distance streams or derived GPS distance when both exist?
- Should chart x-axis preference persist for the session, or reset per loaded activity?
- Should imperial distance mode use 1 mile tick intervals, or should the 1 km interval remain the base requirement with converted labels?
- At what chart width should interval tick labels be thinned to avoid overlap?
- Should a selected chart range persist when switching x-axis mode, or should switching x-axis clear the selected range?
- Should selected range map behavior hide the rest of the route, dim the rest of the route, or display only the selected segment?
- What is the minimum drag distance or minimum selected duration/distance before a chart range selection is accepted?
- Should pace be calculated from instantaneous speed when present, or derived from distance/time intervals by default?
- Should average pace/speed use moving time, elapsed time, or the summary's primary `Time` value when all are available?
- What smoothing/window should pace charts use so GPS jitter does not dominate the view?
- What exact label should the running cadence chart use: `strides/min`, `spm`, or full `strides per minute`?
- Should cycling speed prefer source instantaneous speed, derived distance/time, or a smoothed hybrid?
- Should cycling cadence be added later as an optional sensor chart separate from the initial cycling speed chart?
- What smoothing/noise threshold should elevation gain use?
- Which device metadata fields should be shown by default, and should advanced/sensitive fields require an explicit reveal action?
- Should GPX `creator` be displayed as device information, app information, or both when the file does not provide a cleaner device model?
- What external/static information should remain visible on the initial upload-only page, and what should move into the ready viewer layout?
- Should the ready viewer keep a compact upload/change-file action in the header, side panel, or file area?
- What maximum content width should the loaded viewer use?
- What viewport breakpoint should show or hide the loaded viewer section sidebar?
- Should the section sidebar use active scrollspy state in the first version or only static anchor links?
- Which lap fields should appear in the first laps table/list beyond distance and duration?
- Should clicking a lap later focus the map/chart range, or should lap selection stay display-only initially?
- Should charts begin immediately below the map/laps section on all screens, or should mobile show a compact chart navigation first?
- For GPX files without explicit pause data, what threshold should define moving time versus elapsed time?
- Should parsing move to Web Workers immediately or after the first performance issue is observed?
- How much metadata should be displayed, given privacy concerns?
- Should GPX route segments be preserved visually or merged into a single route initially?
- Should malformed points be skipped with warnings or fail the entire file?
- Should the first PWA version support only app-shell offline, or include a route-only mode without basemap?
