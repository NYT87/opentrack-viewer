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

### TD-028: Unavailable Charts Are Omitted

Decision: The chart panel should render only available charts. Chart kinds that do not apply to the current sport or lack usable data should be skipped entirely rather than shown as title-plus-message placeholders.

Reason: A long list of unavailable chart messages creates visual noise and makes the activity look broken. The availability function still owns the decision, but the viewer should spend vertical space only on charts the user can inspect.

**Implemented by `AV-516`.** `ChartPanel` draws only available charts; the `UnavailableChart` placeholder is gone, with no title, message or reserved space in its place, and no single summary line either, since the task forbids a message per absence and the x-axis and metric switches already say what they cannot offer. When nothing at all is chartable, the viewer omits the charts section and its sidebar link (`hasAnyChart`). The test matrix covers a run, a ride, elevation only, no optional sensors and nothing chartable. The parser's own warning for a file with no elevation still says so in the overview's warning list, which is where a reader learns what the file lacks. A file with no coordinates follows the same rule for the map: no map box held open to say there is no map, one sentence in the overview instead.

### TD-029: Homepage Surfaces GoPro as a Separate Tool

Decision: Once the dedicated GoPro/video telemetry page exists, the homepage should include concise information and a route action for that page. The copy must present it as a separate browser-only tool, not as a capability of the generic file viewer.

Reason: GoPro telemetry extraction is useful enough to advertise from the homepage, but it has a different workflow and privacy/performance model from GPX/FIT/TCX file viewing. Clear homepage copy should route users to the right tool without weakening the no-upload promise.

### TD-030: GoPro Video Defaults to Speed With Pace as a Display Mode

Decision: GoPro/video activities should derive speed from GPS point distance and time when no reliable source speed is present. Because video telemetry may come from running, walking, cycling, driving, or another movement type, the viewer should default to speed and let users switch between speed and pace when both can be derived.

Reason: GoPro videos do not always carry a trustworthy sport classification. Speed is the safest neutral default across many movement types, while pace is useful for human-powered activities. A display-mode switch preserves both without forcing the parser to guess the sport.

### TD-031: Route Builder Edits Draft Tracks, Not Activities

Decision: Route Builder should operate on a separate draft planned-track model. A viewed activity can seed the draft through a `Create Custom Track` action, but the original normalized `Activity` remains immutable. Additional imported tracks are parsed through the normal parser registry, normalized, and appended to the draft rather than merged through format-specific shortcuts.

Reason: Recorded activities and planned routes have different meanings. A recorded activity contains what happened; a planned track is instructions or intent for a device. Keeping a separate draft model protects the viewer, lets route editing drop activity-only fields intentionally, and keeps export behavior testable through the existing browser-side exporter registry.

### TD-032: Static Activity Overlays Reuse the Normalized Activity Model

Decision: Standalone activity overlays should consume the format-independent `Activity` model through viewer handoff or normal local-file parsing. The minimum route export should draw normalized route geometry directly to a transparent image surface instead of capturing the interactive map or compositing external basemap tiles.

Reason: GPX, FIT, TCX, and future sources should produce the same overlay output once normalized. Direct geometry rendering gives deterministic dimensions and transparency, avoids tile-provider attribution/licensing ambiguity in exported assets, and keeps the feature independent from video decoding and map-network availability.

### TD-033: KML Is an Input Adapter, Not a Pairwise Converter

Decision: KML import should map activity-relevant KML geometry into the normalized `Activity` model, then use the existing exporter registry for downloads. The initial scope supports route `LineString` and timed `gx:Track` data, preserves multiple supported geometries as segments, and requires an explicit waypoint decision for standalone `Point` placemarks. It does not fetch or render external KML resources. The field mapping, the point-placemark policy and the conversion matrix are TD-037.

Reason: KML is a broad geographic-visualization language, while GPX, FIT, and TCX have different activity-data constraints. A normalized adapter avoids a separate KML-to-GPX, KML-to-FIT, and KML-to-TCX implementation, keeps conversion behavior consistent, and lets exporter validation explain why an untimed or otherwise incomplete KML route cannot be represented by a target without fabricated data.

### TD-034: Non-GPS Camera Streams Are Point-Aligned Named Streams, Mostly Declared Rather Than Charted

Decision (`AV-905`): the streams a GoPro records beside its GPS track become `ActivitySensorStream`s on the normalized `Activity` — a key, a label, a unit, a sample rate, and one value per activity point. They are **aligned to the activity's own points** by the camera's composition timestamp, not carried on a timeline of their own. Three are charted: acceleration, rotation rate and camera temperature. Every other recognized stream is **declared and not carried**; anything unrecognized is named in an `info` warning. None of it is exported.

**Why align rather than keep a second timeline.** A HERO8 writes acceleration at ~200 Hz and positions at ~18 Hz. Keeping the fast streams at their own rate would mean a second chart stack with its own axis, its own hover model and no point index to give the map — a source-specific branch through the whole viewer, which `TD-002` exists to prevent. Reduced to one value per point, a stream is indistinguishable downstream from elevation: same axis, same focused range, same downsampler, same map synchronization. That reduction *is* the windowing `AV-905` asks for; 3,369 accelerometer samples become 308 chart points before any chart code runs.

The reduction is the **mean of the magnitude** over each point's interval. Magnitude because a HERO7 labels its accelerometer `(z,x,y)` and a HERO11 does not, and a measurement should not change when the camera relabels its axes. Mean rather than peak because a peak turns every chart into isolated spikes, while the mean of a second of 200 Hz acceleration is a number a reader can compare with the second before it.

**What is parsed, and what is only listed.** Interpretation runs in three passes rather than one. The first uses `streamList`, which stops as soon as it has each stream's key and name — all that declaring one requires. The second reads the GPS track. The third reads only the streams that earn a chart, with `timeOut: 'cts'`, because they are aligned by the camera clock and a `Date` per sample is an object built for nothing. `gopro-telemetry` filters at the KLV level, so everything unlisted is skipped *while parsing* rather than built and discarded: on the HERO11 fixture that is 3 streams read instead of 20. Each pass re-reads the payload already in memory, so the cost is CPU that the filtering more than returns.

The third pass also asks the library to **group while interpreting**, at half the interval the activity's own points run at, with interpolation disabled so empty slots stay empty rather than being filled with invented samples. That hands back roughly what the reduction would have produced anyway: on the HERO11 fixture, 2,192 accelerometer samples become 106, and the sticky temperature statements all survive. So the native rate is never what this app holds.

It is still what the library builds, because `groupTimes` runs after the samples exist. That leaves a transient cost that rises with the length of the video, on the main thread, so there is a **limit**: past twenty minutes the IMU streams are not read at all. They are declared like any other uncharted stream, with a warning saying why, and the route and every chart derived from the GPS pass are untouched. The limit can rise when extraction moves into an app-owned worker (`TD-025`).

The length is the **longer of two spans**: what the GPS points cover, and what the container says the video runs for. The points alone are not enough, because a fix comes and goes — a two-hour ride that held satellites for five minutes has a five-minute point span and two hours of accelerometer behind it. The container alone is not enough either, since it may state nothing useful. A missing camera clock is not a short recording but a different situation, so it takes its own path and its own warning rather than being reported as a zero-minute video.

**Temperature converts like any other.** A reader who has chosen imperial gets Fahrenheit from the camera-temperature chart too. `ActivityChart` decides that from the series' recorded unit rather than from a list of known keys, because a list is a thing to forget to add to.

**Why so few charts.** A stream earns one by saying something about the *activity*. White balance, predominant hue and scene classification describe the picture; a per-frame orientation quaternion is an input to a renderer (`E10`), not a line. Charting them would bury the ride under the camera. Dropping them silently would be worse — a reader would have no way to know their file held them — so they are listed by name, unit and rate, and left at that. `FACE` is hidden for a stronger reason than uninterestingness: it locates people in frame, and nothing here has any business plotting that.

**Highlight tags are recognized but unproven.** `HLMT` is a catalog entry, so a video carrying highlights is declared rather than reported as unrecognized. The library lifts it from the MP4 header rather than from the GPMF payload, and none of the three fixtures has one — so unlike every other stream here, nothing tests it against real bytes. Turning highlights into `ActivityEvent` markers, where they would genuinely belong, waits for a fixture that has some.

**Nothing is export-only.** `AV-905` asks which streams are exposed only through export; the honest answer is none. GPX, TCX and FIT have nowhere to put a camera quaternion, and inventing extensions no other tool would read is what `TD-019` refuses.

**Camera temperature is not the weather.** This is the one stream whose *meaning* could be misread. A GoPro measures its own sensor board, sealed in a black body in the sun: the HERO11 fixture reads 52 °C on a September afternoon. It is therefore never written to `ActivityPoint.temperatureCelsius`, which the viewer labels "Temperature" and a reader takes for air temperature. It is a named stream with the caveat attached to it. From the HERO8 on it arrives as a **sticky** value on the IMU streams — stated once and implied thereafter, the same trap the GPS fix set in `AV-904` — so it is carried forward. Read per sample instead, a HERO11 would show a temperature for 11 points out of 110; a test pins exactly that.

### TD-035: Every Activity Can Override Its Presentation Type

Decision (`AV-517`, generalizing `AV-908`): `activity.metadata.sport` supplies the default presentation but never locks the viewer. Every loaded activity gets a `View as` selector with Auto/source sport and every supported presentation type. The effective type drives overview defaults and chart recommendations without mutating the normalized activity or exported sport metadata.

**Why the sport and not the format.** A GoPro video is the case this came from: a camera records a moving track and cannot know whether it was strapped to a runner, a bicycle or a car, so `parseGopro` says `sport: 'unknown'` rather than guessing. But the rule is written against the normalized activity, not against the source format (`TD-002`): a GPX file with no `<type>` is in exactly the same position and now gets exactly the same treatment. A branch on "is this a video" would have been a format-aware decision in a layer that has none.

**Why explicit sports can still be overridden.** Files are often mislabeled, reused as route recordings, or produced by devices that apply a coarse sport category. Presentation is a reader preference, not a correction to source history. A run can therefore be viewed with cycling defaults and a ride with running defaults while the original sport remains intact.

**The override belongs to the loaded activity.** It resets to Auto when that activity is closed or replaced, because carrying “View as cycling” into the next unrelated file is surprising. Nothing is written to the `Activity` (`TD-006`), and changing it never reparses a file or video.

**The switch is offered only where both readings exist.** Pace needs ground actually covered, not merely a distance that could be computed: a recording made standing still has coordinates, timestamps and a total of zero, and pace's only possible answer for it is "no distance covered". Speed's answer, 0 km/h, is a real one. So a stationary activity is shown speed and not asked the question.

**Derived speed needed no new code.** `deriveSpeed` already trusts a plausible recorded speed and otherwise derives one over a rolling window, skipping invalid coordinates, zero-duration intervals and implausible jumps (`AV-513`). A GoPro's `GPS5` does record a ground speed, so the derivation is the fallback rather than the rule; a test strips the recorded speed from a real HERO7 activity and confirms the chart still draws.

**A rolling window never reaches across a recording gap.** `computeDistance` deliberately does not accumulate the jump between two segments — that is ground covered while the recording was stopped — so the cumulative distance is flat across the boundary. Dividing by a duration that *does* include the pause reported roughly a third of the real speed at the point after a ten-second gap, and exactly zero at the first point of the new segment. The trailing edge now resets at the boundary. The walk is shared between pace and speed rather than written twice, which is how the same bug came to exist in both.

**Exports carry none of this.** `AV-908` asks that export consumers respect the selected mode. They already do by carrying neither: GPX, TCX and FIT record speed values, not a reading convention, and a file that encoded "show this as pace" would be describing this app's UI rather than the activity.

### TD-036: Sport Recommends Charts; Data Enables Them; the User Chooses Them

Decision (`AV-518`): chart capability, default visibility, and selected visibility are separate concepts. Capability comes only from normalized data. The effective activity type recommends an initial set. The user's checkbox/toggle choices decide which capable charts render.

Reason: pace and speed are two views of compatible time/distance data, not measurements owned by running and cycling. A cyclist may train by pace and a runner may want speed; neither request should require changing the file. Running cadence and pedal cadence remain separate because their units and normalized fields differ, but either may be shown under any presentation type when its actual stream exists.

The selector may explain an incapable option, but the chart area stays quiet: no title, no placeholder and no reserved space. Visibility customization is per loaded activity and resets on replacement. Changing `View as` reapplies recommendations only before the user customizes the chart set, so a deliberate selection is not silently overwritten.

### TD-037: KML Scope, Field Mapping and Conversion Matrix

Decision (`AV-760`): KML is read in the browser with `DOMParser` and string lookups by local name, exactly as GPX and TCX are — no new dependency, no KML writer. It implements TD-033: the parser maps the two KML geometries that *are* a route into `Activity`, and every export goes through the registry.

**Namespaces.** Elements are matched by local name, so KML 2.2 (`http://www.opengis.net/kml/2.2`), 2.3, the legacy `earth.google.com/kml/2.x` namespaces and an undeclared namespace all read the same way; the root must still be `<kml>`. The Google extension (`http://www.google.com/kml/ext/2.2`) is what carries a timed track, so `gx:Track`, `gx:MultiTrack`, `gx:coord`, `gx:SimpleArrayData` and `gx:value` are read whether the prefix is `gx:` or anything else. A root in an unrecognized namespace is read as 2.2 with an `info` warning. Detection needs a `<kml` root in the first 512 bytes or a `.kml` extension; the MIME type is never consulted (`AV-761`).

**Import — KML to `Activity`**

| KML | `Activity` |
| --- | --- |
| `Document/name` | `metadata.name` when several placemarks contribute geometry — the file's title, not the first leg's |
| `Placemark/name` | `metadata.name` when it is the only route placemark, as a GPX `<trk>` names its activity |
| `Placemark/description` | `metadata.description`, **as plain text**: `<script>` and `<style>` blocks removed with their bodies, every other tag stripped, whitespace collapsed, cut to 500 characters. Read from `textContent`, so a CDATA balloon is never a DOM node; `<script>` and `<style>` written as XML elements are removed from a copy before the text is collected |
| `LineString/coordinates` | One segment of points. Tuples are `lon,lat[,alt]` — longitude **first** — separated by whitespace |
| `gx:Track` | One segment: `<when>` *i* pairs with `<gx:coord>` *i* (`lon lat [alt]`, space-separated). An empty `<gx:coord>` keeps its time with no position; a file in which no sample has a position is refused with `no_route_points` |
| `gx:MultiTrack` | One segment per child `gx:Track`; `gx:interpolate` is ignored because a gap is never drawn across |
| `MultiGeometry` | Each `LineString` or `gx:Track` member is a segment, in document order |
| `Folder`, `Document` | Transparent containers, walked in order to a depth of 32. A container nested deeper is not entered; it and the placemarks inside it are counted into one `warning` (`kml_nesting_too_deep`) that says the route may be incomplete, and the `no_route_points` message names them when nothing shallower was a route |
| Third tuple value | `point.elevationMeters`. `altitudeMode` is **not** consulted: it tells a globe how to drape the line, not what was measured, and a device export states its altitudes whichever mode it then chose |
| `gx:SimpleArrayData[@name]` under `ExtendedData/SchemaData` | Matched by position to the track's samples. `heartrate`/`heart_rate`/`hr` → `heartRateBpm`; `cadence` → `runningCadenceSpm` (KML states no sport, so the untyped-GPX rule applies: foot cadence); `power`/`watts` → `powerWatts`; `speed` → `speedMetersPerSecond` when plausible; `temperature`/`temp` → `temperatureCelsius`. Other names are left where they are |
| Sport | `unknown`, always. KML describes a place, not a workout; the viewer asks whether to show speed or pace (`AV-908`) |

**Standalone `Point` placemarks are declined, not modelled.** A placemark whose only geometry is a `Point` — and a `Point` inside a `MultiGeometry` — is counted and reported in one `warning` (`kml_points_not_read`); nothing is drawn. The domain has no waypoint: GPX `<wpt>` is not read either, and a waypoint model invented for KML alone would be the format-specific branch TD-002 exists to prevent. When a format-independent waypoint model is designed, KML points map onto it; until then the warning says what the file held.

**Deterministic behaviour for the awkward cases**

- *Several placemarks or tracks:* each becomes a segment in document order, as GPX `<trkseg>`s do. Distance is not accumulated across a boundary and no line is drawn over it; `multiple_segments` is reported.
- *Mismatched `<when>` and `<gx:coord>` counts:* the pairs that line up are kept, the surplus is counted among the unreadable coordinates, and `kml_track_count_mismatch` says so. Nothing is interpolated.
- *A `gx:SimpleArrayData` with the wrong sample count:* matched by position, surplus dropped, `kml_sensor_count_mismatch` reported.
- *Missing altitude or time:* absent from the point, like every other format. A route with no `<when>` at all gets `no_time_data`, and the warning says this limits conversion.
- *A `TimeStamp` or `TimeSpan` on the placemark:* ignored for the points. One date cannot time a track, and applying it to every vertex would invent a clock; `kml_placemark_time_ignored` is reported as `info`.
- *Invalid coordinates:* `toValidCoordinate` decides, as everywhere else — non-numeric, non-finite, out of range and Null Island are skipped and counted in one `kml_invalid_coordinates` warning. A non-finite third value drops the altitude and keeps the position. A geometry with no valid vertex is not a segment.
- *Antimeridian crossings:* kept as recorded. Distance is great-circle and correct; the map draws the segment as the file states it, which on a Mercator basemap may run the long way round. No splitting, because splitting is a fabricated boundary.
- *A file with no route:* `no_route_points`, with a message naming what the file *did* hold (points, polygons, overlays, unreadable coordinates).

**Refused or reported, never read**

| Feature | Behaviour |
| --- | --- |
| `<!DOCTYPE`, `<!ENTITY` | **Refused** before parsing with `invalid_kml_xml`. KML never needs a DTD, and an internal subset is where entity expansion lives — `DOMParser` honours it, so the check is on the text, not on `document.doctype` |
| `Polygon`, `LinearRing` outside one, `Model`, `GroundOverlay`, `ScreenOverlay`, `PhotoOverlay`, `gx:Tour`, `NetworkLink` | Counted and named in one `warning` (`kml_unsupported_features`) |
| `Style`, `StyleMap`, `Schema`, `styleUrl` | Counted; one `info` warning that styling is presentation, not data |
| Every non-empty `<href>` anywhere — network links, icons, overlay images, model links | Counted into one `info` warning that says none were requested. The parser touches no network API; a unit test and a browser test assert no request leaves the tab, and the URLs themselves are never repeated into a warning |
| `.kmz` and any archive | **Out of scope.** Not detected, not accepted. Archive ingestion needs its own size, entry-count, compression-ratio and external-asset limits before a compressed file is opened in a tab |
| `ExtendedData/Data`, `Region`, `LookAt`, `Camera`, `visibility`, `open` | Ignored silently: nothing an activity could carry is in them |

**Conversion matrix — normalized KML data against each registered exporter**

| Target | Requires | Untimed `LineString` | Timed `gx:Track` | Expected loss on write |
| --- | --- | --- | --- | --- |
| GPX | A point with coordinates | ✅ Offered | ✅ Offered | Styles, description HTML, points, polygons, overlays; `sport` stays untyped |
| FIT | A point with a timestamp | ❌ Disabled: *FIT needs timestamps* | ✅ Offered | As above, plus the description; sport exports as generic |
| TCX | A point with a timestamp | ❌ Disabled: *TCX needs timestamps* | ✅ Offered | As above; one lap covering the track is stated because the schema demands it; temperature dropped |
| KML | — | — | — | **Not offered.** There is no KML exporter; the format appears as an output only once one is written and registered |

The matrix is not a second rule. Each exporter's `requires` predicate is the one consulted, so a KML activity is judged exactly as a GPX, FIT or TCX one would be — and the converter never invents time, sensor, lap or sport data to satisfy a target (`AV-762`). The export panel shows **Convert to …** rather than **Rewrite as …** for a KML source, since there is nothing to rewrite it as.

### TD-038: The Telemetry Track Is Read From the Index, Not Streamed Past

Decision (`AV-906`): the browser no longer streams a GoPro video through `gpmf-extract`. `extractGpmf` walks the file's top-level box headers — sixteen bytes each, stepping over the `mdat` by its declared size — hands **`mp4box`** the `moov` alone (plus the `ftyp` and each `mdat` header, which it needs to seek), asks it for the `gpmd` sample table, and reads exactly those byte ranges with `File.slice`. `gpmf-extract` is removed as a dependency; `mp4box` is depended on directly and still loaded on demand. `gopro-telemetry` is unchanged.

**What the large-video simulation found.** TD-025 recorded that streaming kept peak memory proportional to the payload. That is true only of a file whose `moov` comes first, and a camera writes it **last**. `mp4box` cannot know which bytes are telemetry until the index arrives, so it holds every chunk until then: fed a simulated recording, it held 129 two-megabyte buffers for a 256 MB file and two gigabytes for a two-gigabyte one, measured with `process.memoryUsage().arrayBuffers` after a forced GC. The earlier figure — 86 KB out of 4.2 MB — was the payload's size, not the reader's peak; the clip was too small for the difference to show.

**What the new reader costs.** `src/test/helpers/virtualVideo.ts` stands in an eight-gigabyte recording — past the 4 GB that forces the 64-bit `mdat` size — with a real HERO7 payload spread through it at a quarter-megabyte spacing, generating bytes only for the ranges read. Extraction reads under 200 KB of it: the headers, the `moov`, and seventeen sample reads totalling exactly the payload. Nothing lands in the picture. Memory grows by the payload, and the read takes milliseconds.

**Behaviour that changed with it**

- A file that is not a container fails on its first box header with `gopro_extract_failed` ("not an MP4 or MOV container"), where before it read to the end and relied on a grace timer to give up. A container with no `moov` — a recording the camera never finished — is `no_video_index`, naming the missing index: its own code since `AV-1002`, because a page that keeps a telemetry-less video as a video to draw over must be able to tell "no telemetry track" from "nothing can be read from this at all" without matching on prose.
- The sample table is checked against the file before any read: an index pointing past the end is refused rather than read short.
- Cancellation is checked before every read, so a stop lands within one sample rather than one two-megabyte chunk.
- The track's creation time is passed as the container states it. `gpmf-extract` shifted it by the *viewer's* time-zone offset, so the same file read differently in different places.
- Bounds: a `moov` over 256 MB, a non-`mdat` box over 16 MB before the index, more than 4,096 top-level boxes, or a sample table totalling more than 512 MB is refused with a typed error, since each is a file lying about itself and honouring it would recreate the memory problem.

**Defects that no longer apply.** Of the four `gpmf-extract` defects TD-025 lists, the never-stopped reader, the hang on an unparseable file and the untyped failures were all in the streaming path and are gone with it; the broken inline worker was never used. The library's own Web Worker is no longer a consideration, because nothing streams: moving extraction into an app-owned worker remains possible and remains unneeded.

**Fixture.** `hero7-synthetic.mp4` is the HERO7 payload inside a generated container, built by `src/test/helpers/goproMp4.mjs` from `make-video-fixtures.mjs`: a `gpmd` track whose samples are the payload's `DEVC` chunks, a video track of 510 zero-byte frames for the duration and frame rate, and a `moov` at the end. It is the first video fixture with a satellite fix, which is what lets a browser test open a video and see a route — GoPro ships no outdoor sample small enough to commit. Like the FIT fixtures, the container is written by hand rather than by the library that reads it, so the two cannot share a mistake.

### TD-039: Overlay Export Uses the Browser's Own Media APIs — Transparent WebM and PNG First, Burned-In H.264 Second

Decision (`AV-1001`): overlay export is built on the browser's own media APIs and nothing heavier. The first export (`AV-1006`) is a **transparent VP9 WebM recorded with `MediaRecorder`** from a canvas, offered only where a probe proves the alpha survives, beside a **PNG image sequence** that every browser can produce and every editor can read. Burned-in video (`AV-1007`) follows as a second phase, through **WebCodecs** — `VideoDecoder` on the source, canvas compositing, a hardware `VideoEncoder` to H.264, the source audio copied through untouched — muxed into MP4 by **Mediabunny**. **ffmpeg.wasm is rejected. Chroma-key video is not offered.** `TD-026`'s ordering stands, now with measurements behind it rather than a hunch.

**How it was measured.** A probe page (`scripts/overlay-export-probe/`) draws a representative overlay — HUD text with shadows, a gauge arc, a 2,000-point route inset, a progress bar — over a moving textured background, and asks each engine what it supports and how fast. It was run headless through Playwright on an Apple Silicon Mac in **Chromium 156**, **Brave 155** (a Chromium with the proprietary codecs a shipped Chrome has) and **WebKit 26.4** (the engine under Safari 26). Firefox was started and stopped before it finished, so **nothing below is claimed for Firefox**; neither is anything claimed for a phone, since none was measured. The decode tests use `hero8.mp4`, the one real camera file in the tree: H.264 at 848×480, 30 fps, with an AAC track.

**What every engine agrees on**

| Question | Chromium, Brave, WebKit |
| --- | --- |
| WebCodecs — `VideoEncoder`, `VideoDecoder`, `AudioEncoder`, `AudioDecoder` | All present |
| `OffscreenCanvas` with a 2D context, `requestVideoFrameCallback`, `MediaRecorder`, `canvas.captureStream` | All present |
| **Can `VideoEncoder` keep alpha?** `alpha: 'keep'` with VP8 or VP9 | **No, in all three.** `isConfigSupported` echoes the option back and reports the config unsupported. There is no transparent video through WebCodecs. |
| H.264 encode at 1080p and 4K, hardware | Yes, in all three |
| HEVC encode, hardware | Yes, in all three — and Chromium's *software* HEVC encoder, which also reports supported, ran at **1.7 fps**, so "supported" is not "usable" and the app must prefer hardware explicitly |
| H.264 decode at 480p, 1080p and 4K | Yes, in all three |
| HEVC 4K decode | Yes, in all three. Chromium: hardware only (`prefer-software` is refused). WebKit: both. |
| `crossOriginIsolated`, `SharedArrayBuffer` | **False and absent in all three.** The app is a static site, GitHub Pages sets no COOP/COEP headers, and so no multi-threaded WebAssembly can ever run here. |
| `navigator.storage.getDirectory()` — the origin-private file system | Present in all three. This is where an export larger than memory goes. |
| `showSaveFilePicker` — streaming straight to a file the user chose | Chromium only. **Brave disables it**, WebKit has never had it. It is an optimisation where present, never the plan. |

**Where they differ, and why it decides the format**

| Measurement | Chromium 156 | Brave 155 | WebKit 26.4 |
| --- | --- | --- | --- |
| **Does `MediaRecorder` keep alpha in VP9 WebM?** A transparent canvas recorded, played back over magenta, the transparent corner read | **Yes** — `(255, 0, 255)` | **Yes** — `(254, 0, 254)` | **No** — `(0, 0, 0)`: the file is opaque black where it should be clear |
| `MediaRecorder` containers | WebM (VP8, VP9, AV1, H.264), MP4 (H.264, VP9), Matroska | Same | WebM (VP8, VP9), MP4 (H.264) |
| Duration header in the recorded WebM | **Missing** — `video.duration` is `Infinity` | Missing | Missing — `NaN` |
| WebP from a canvas, with alpha | Yes | Yes | **No** — silently returns PNG |
| AV1 encode | Software, 46 fps at 1080p | Software, 50 fps | Not supported |
| `video.captureStream()` for audio | 1 audio + 1 video track | Same | **Not present** |
| WebGPU | Yes | Yes | No |

So there is exactly one way to produce a transparent video in a browser today — `MediaRecorder` with VP9 — and it works in the Chromium family and not in WebKit. That, not preference, is why the transparent WebM is offered behind a runtime probe and the PNG sequence is offered everywhere.

**Encode throughput**, frames per second, 150 frames at 1080p and 45 at 4K, draw cost included (it is 0.1–0.5 ms a frame at 1080p and under 4 ms at 4K, so the canvas is never the bottleneck):

| Encoder | Chromium hw | Chromium sw | Brave hw | Brave sw | WebKit hw | WebKit sw |
| --- | --- | --- | --- | --- | --- | --- |
| H.264 1080p | **181** | 41 | **188** | 43 | **128** | 155 |
| HEVC 1080p | 172 | 1.7 | 174 | 1.8 | 149 | 154 |
| VP9 1080p | — | 66 | — | 62 | 68 | 71 |
| VP8 1080p | — | 58 | — | 91 | 74 | 85 |
| AV1 1080p | — | 46 | — | 50 | — | — |
| H.264 4K | **49** | 10 | **50** | 9 | **38** | 35 |
| HEVC 4K | 47 | 0.5 | 47 | 0.5 | 37 | 42 |
| VP9 4K | — | 19 | — | 22 | 17 | 22 |

A dash is "refused by `isConfigSupported`". WebKit reports every encoder as both hardware and software and runs them at the same speed, so the preference means nothing there; in Chromium it is the difference between 181 fps and 41. **Hardware H.264 is the burned-in codec**: the fastest everywhere, the only one every editor and phone reads, and 4K at 38–50 fps is still faster than real time. Memory stayed flat throughout — the JS heap moved by under 2 MB over every run — because encoded chunks were counted and dropped: an encoder streams, and so must whatever receives it.

**The source clip, decoded and burned.** `hero8.mp4` through `VideoDecoder`, demuxed by the `mp4box` already in the tree: 379 frames in 379 outputs at **732 fps** (Chromium), **1,167** (Brave), **1,215** (WebKit). The full burned-in chain — decode, draw the frame, draw the overlay over it, encode — at the clip's own size:

| Chain | Chromium | Brave | WebKit |
| --- | --- | --- | --- |
| Decode → composite → H.264 hardware | 319 fps, **10.6× real time** | 321 fps, 10.7× | 210 fps, 7× |
| Decode → composite → VP9 software | 119 fps, 4× | 101 fps, 3.4× | 106 fps, 3.5× |

Burned-in export is therefore feasible without a server, and `AV-1007` can be scheduled. The projection to larger sources comes from the encoder ceilings above rather than a measured chain, and is stated as such: at 1080p the H.264 encoder bounds the chain at roughly 4–6× real time, so a ten-minute clip renders in two to three minutes; at 4K the bound is **1.2–1.7× real time**, so the same ten minutes takes six to eight. Those are the figures the progress estimate should be built from, and the ones to re-measure on the first real 4K file.

**The real-time path, for comparison.** Playing the clip in a `<video>` element and copying each `requestVideoFrameCallback` frame to a canvas presented 379 of 379 frames in Chromium (377 in Brave, 2 dropped) at exactly real time, with `captureStream()` offering the audio track beside the video. It is the universal fallback — no demuxer, no codec negotiation — at the price of taking as long as the clip and dropping frames whenever the tab is starved. In headless WebKit `play()` is refused by the autoplay policy, so that path is unmeasured there. It is kept as the fallback for a source `VideoDecoder` refuses, not as the plan.

**Image sequence.** PNG at 1080p: **17 ms and 125 KB a frame** in Chromium, 32 ms and 112 KB in WebKit — 2× real time and 1× respectively, and **3.7 MB per second of video** at 30 fps, so a ten-minute clip is 2.2 GB and must be streamed into the archive as it is drawn, never accumulated. WebP, where it exists, was *slower and larger* for this content — 71–78 ms and 288–384 KB a frame — because a mostly-transparent frame of flat colour and text is what PNG was made for. PNG only. The archive is store-only ZIP, written by hand: PNG is already compressed, and a zip writer that compresses nothing is a hundred lines with no dependency. It is capped at the 4 GB the plain ZIP format allows — about eighteen minutes at 1080p30 — and the page offers a lower frame rate rather than ZIP64: a HUD whose values change at telemetry rate does not need thirty frames a second, and an editor holds a frame for as long as it is told to.

**Transparent WebM is real time.** `MediaRecorder` timestamps by the wall clock, so a ten-minute overlay takes ten minutes to record, and `captureStream(0)` with manual `requestFrame()` does not escape that — frames pushed faster are stamped closer together and the timeline shrinks. That is the price of alpha, and it is stated in the UI as an estimate before the user starts. The recorded file also lacks its duration header in every engine, which editors notice; the EBML `Duration` element is patched into the first cluster's header after recording, and a test asserts that the result has a finite `duration` when loaded.

**Rejected: ffmpeg.wasm.** Not measured, and deliberately so, because it fails before performance is reached: `@ffmpeg/core` 0.12.10 is **GPL-2.0-or-later** — it bundles x264 — which this app's permissive terms cannot carry; it is **65 MB unpacked, a 32 MB download** for a page whose entire GoPro path is 62 KB; its multi-threaded build needs `crossOriginIsolated`, which the table above shows is false and, on a static host, unfixable; and single-threaded WebAssembly cannot beat the hardware encoders the browser already exposes — Chromium's own *software* HEVC encoder ran at 1.7 fps, and a wasm build would be slower still. Its one capability nothing else has — libvpx encoding VP9 *with* alpha — would give WebKit a transparent WebM that WebKit cannot then play. There is no case for it.

**Rejected: chroma-key video.** It exists to serve editors that cannot read alpha, and a PNG sequence serves them without the fringing that keying anti-aliased text and translucent panels leaves behind. Adding it would be a third export path to test for a problem the second already solves.

**Muxer: Mediabunny, for phase two only.** Phase one needs no new dependency: `MediaRecorder` writes its own container and the ZIP is written by hand. Phase two needs an MP4 writer for WebCodecs chunks. The two small MIT muxers — `webm-muxer` 5.1.4 and `mp4-muxer` 5.2.2, 12 and 14 KB gzipped — are both **deprecated by their author** in favour of Mediabunny 1.61, which is **MPL-2.0** (file-level copyleft: it obliges sharing changes to *its* files, which this app does not make, and is compatible with a permissive app) and tree-shakes to **43 KB gzipped** for MP4 output with a streaming target, measured with Vite from the modules it actually imports; the full library with its demuxers is 155 KB and is not needed, because `mp4box` already demuxes the source for telemetry and will demux it for frames. Loaded on demand, like FIT and the GoPro path.

**Memory and output.** Nothing above holds a video in memory: frames are drawn, encoded and released, and the encoder's output is written as it arrives. Where it is written is the one browser-specific choice: Chromium can stream into a file the user picked (`showSaveFilePicker`); everywhere else the chunks go to a file in the origin-private file system and the download is served from that `File` at the end. At 8 Mbps a ten-minute 1080p render is 600 MB, which is why it must never be a `Blob` of parts in a tab.

**Audio.** Burned-in export copies the source's AAC packets into the output unchanged — no decode, no re-encode, no drift — which `mp4box` supplies and Mediabunny accepts. Overlay-only exports carry no audio: the editor has the original.

**What the probe did not cover, recorded so `AV-1007` does not assume it**

- **10-bit HEVC.** HERO11 and later record 10-bit HEVC in nearly every mode, and only 1080p at 60 fps or below can be forced to H.264. The probe tested HEVC Main (8-bit) only. Whether `VideoDecoder` accepts `hvc1.2.4.L153.B0` must be checked on the first HERO11 file before the page claims to burn one in; a source the decoder refuses falls back to the `<video>` path above.
- **Phones.** iOS runs the WebKit measured here with far less memory and the same `MediaRecorder` alpha gap, so transparent WebM is unavailable there by construction and burned-in export is declared **desktop-only** until measured.
- **Firefox.** Unmeasured. It is not in the Playwright project either, so nothing in CI depends on it; the capability probes at export time are what keep an unmeasured browser from being promised something it cannot do.
- **The headless shell.** Playwright's full Chromium (`channel: 'chromium'`) was used and found to carry H.264 and HEVC, which is what lets `AV-1008`'s browser tests exercise a real burned-in render in CI. The headless *shell* build was not measured and may lack them.

**Phased recommendation**, as the task asked for one:

1. **`AV-1006`, overlay-only.** PNG sequence in a store-only ZIP, everywhere; transparent VP9 WebM via `MediaRecorder`, offered only after a sub-second probe at export time records a transparent frame and reads a pixel back — never by sniffing the browser's name. Both run on an `OffscreenCanvas` in a worker, with progress and a stop button. No new dependency.
2. **`AV-1007`, burned-in.** WebCodecs decode through `mp4box`'s sample table (the reader `TD-038` built, extended from one track to two), composite on canvas, hardware H.264 through `VideoEncoder` with `prefer-hardware` and a refusal if only software answers, audio copied through, Mediabunny writing MP4 to the origin-private file system. Desktop only; 4K accepted with the slower estimate shown first.
3. **Template JSON** is not an export mode but a serialisation `AV-1003` needs for its own tests, so it ships with the model and costs nothing further.

### TD-040: The Overlay Page Has a Store of Its Own, and Never Overrules a Chosen Activity

Decision (`AV-1002`): the overlay page reads from `useOverlayStore`, a second in-memory store beside the viewer's, holding a local video (`File` plus the container's clock) and a normalized `Activity`. The extraction page writes the video with **Create overlays**, and the activity only if that slot is empty; the overlay page writes either when a file is chosen by hand. Nothing is persisted, and the page's empty state says that a reload loses the handoff and asks for the files again. Leaving either page aborts a read in progress, so no result lands in the store minutes after the reader moved on.

**Why not the activity store.** The viewer's store means "the activity being viewed", and `Close activity` in the header acts on it. An overlay in progress is a different thing — it has a video the viewer has no use for, and closing the viewer's activity should not discard it. Two stores keep the two handoffs from treading on each other; the test that hands a video to the overlay page asserts the viewer stays empty.

**What travels.** The `Activity` already carries the camera's other streams (`sensorStreams`, TD-034) and its warnings, so "auxiliary telemetry and safe warnings" cost no second channel. The clock — duration, frame interval and the first frame's wall-clock time where the container states one — is what `AV-1003` will need to put video time against point time.

**Two rules at intake.** The store records where its activity came from — a file the reader chose, or the video beside it — and that provenance decides what a video's telemetry may replace: a reader's choice, never; the previous video's track, always, since it belonged to that video and goes with it when the video is swapped. Presence alone could not tell the two apart, and would have left a second video sitting beside the first one's track as if they matched. This holds whether the video arrives by hand or by handoff. A video whose track yields no activity is not an error here, as it is on the extraction page: one with no telemetry track at all, and one whose track has no GPS stream or no sample with a satellite fix — the committed HERO8 clip, recorded indoors — are both kept as a video that still needs an activity, the second with its clock, and the reason is shown beside the file. Only a file that could never be drawn over is refused: not a container, no index (`no_video_index`), or a read that failed. A stop is a stop, not a failure to explain.

**Not here.** No map, no charts, no export panel: the viewer's regions are asserted absent before and after files arrive. Templates, the timeline, the preview and export are `AV-1003` to `AV-1007`.

### TD-041: The Overlay Timeline Never Invents a Value, and a Template Is Plain Data

Decision (`AV-1003`): `src/overlay/timeline.ts` turns an `Activity` and a video's clock into `sampleAt(videoTime)`; `src/overlay/template.ts` holds the template model, its JSON round-trip and the resolution of a component against a sample. Both are pure and know nothing of any file format.

**Offset.** Video time `t` is the video's wall-clock start plus `t`, or the activity's first point when the container states no clock. A positive `offsetSeconds` delays the telemetry — the activity shown at `t` is the one from `t - offset` — so the reader nudges it later when the watch ran ahead of the camera.

**Distance and speed are read as the viewer's charts read them** — from the file where it states them, derived from positions and time where it does not (a decreasing odometer is ignored, as there). Found by the browser check of `AV-1005` on a real GPX: reading only the raw fields drew no distance, speed or pace for a file that has none recorded, which is most of them.

**Missing data is missing.** A value is interpolated only between two points that both carry it, in the same recorded segment, no more than 10 s apart; across a pause, a dropout or a segment boundary it is absent, and outside the recording there is no sample at all rather than the nearest one. Pace is derived from the interpolated speed and absent when standing still. Longitude interpolates along the short arc across the antimeridian. Charted camera streams (TD-034) interpolate like any metric; `hidden` ones carry no values and are not offered.

**Template.** Five component types — `text`, `gauge`, `routeInset`, `progress`, `sensorChart` — each with visibility, a rectangle in frame fractions (so one template fits any resolution), a unit mode (`auto` follows Settings), style tokens merged over the template's, and a data source: a built-in metric or a named sensor stream. `parseOverlayTemplate` rejects a malformed file or unknown version but drops a single bad component with a warning, keeping the rest. A component whose data does not exist is `hidden`, never drawn with a dash, and `unavailableBindings` names it so the page can warn once.

**Not here.** No rendering, no preview, no preset templates (`AV-1004`, `AV-1005`).

### TD-042: The Video Element Is the Only Clock, and the Overlay Is Drawn From a Sample

Decision (`AV-1004`): the overlay page previews the local video with the overlay as DOM over it (`OverlayPreview`, `OverlayLayer`). The `<video>` element's `currentTime` is the one clock. It is read on `timeupdate`, `seeking`, `seeked`, `loadedmetadata` and `durationchange`, and, while playing, on every presented frame — `requestVideoFrameCallback` where the browser has it, `requestAnimationFrame` where it does not. Scrubbing writes the new time to the element and to state together, so the overlay does not wait for a seek to finish. `OverlayLayer` takes a sample, not a video, so play, pause, seek and scrub reach one drawing path, and a component with no data for the moment renders nothing (TD-041).

**Offset.** `offsetSeconds` lives in `useOverlayStore` beside the files and is forgotten whenever either is replaced, since it records how *those two* disagree. The control nudges by 1 s or 0.1 s, takes a typed value without rewriting a half-typed one, and says which way is which: positive delays the telemetry.

**Why DOM, not canvas.** A handful of absolutely positioned boxes and one SVG, sized in container units, scale with the video and cost one binary search per frame. The export path (`AV-1006`) draws the same template on a canvas from the same samples; the preview does not have to be that renderer to agree with it.

**Template.** The preview draws whatever template the controls build (TD-043). **Missing data** is said once, beside the preview: no activity, no timestamps, a moment the activity does not cover, and each component bound to data the activity lacks.

### TD-043: A Template Preset Is a Rule for Placing Components, Not a Stored Layout

Decision (`AV-1005`): `src/overlay/presets.ts` offers three templates — Compact HUD, Route inset, Metric strip — as *defaults plus a placement rule*. `buildOverlay(controls, timeline, frameAspect)` turns the reader's controls and what the activity has into an ordinary `OverlayTemplate` (TD-041), which is all the preview and any export will see.

**Why not fixed rectangles.** With fixed positions, turning a component off leaves a hole and a component the activity lacks leaves a dash-shaped gap. Placing only what is on *and* supported closes the gap by construction. Rectangles are frame fractions but type is sized in frame widths, so tile height takes the frame's aspect ratio as an input; every preset, edge, size and aspect keeps every rectangle inside the frame and clear of every other (tested over the cross-product). A figure keeps the width a value like "100.0 km/h" needs: a long list wraps onto further rows, or columns in the HUD, and tiles get shorter only if the frame's height runs out, in which case their type shrinks with them (a tile needs 3.2 ems of height; `fitScale` settles it from the aspect ratio) — squeezing them into one row, or cutting their height alone, would clip the text. **Width is an em budget too** (`TILE_WIDTH_EMS`, 8.2): the app names no font of its own, so the widest figure has to fit in the widest sans a system falls back to — DejaVu Sans Bold, Ubuntu's default, with 0.70 em digits, where "100.1 km/h" is about 6.6 em against 5.5 in Helvetica or Liberation. The first budget, 7.3 em, was tuned on a Mac and found out by the CI runner: the value wrapped onto a second line and spilled out of the tile's *height*, which is why figures now also never wrap (`white-space: nowrap`) — a font that still does not fit clips at the side, where the layout test sees it for what it is. Reproduced and proved fixed in the Playwright Linux image with DejaVu Sans forced as the default. `e2e/overlay-layout.spec.ts` measures it in Chromium: the real HERO8 clip and an activity with the widest values, all ten figures on in each template at the largest size, in 3:1, 16:9 and 9:16 frames on a desktop and a phone, asserting nothing overflows its own tile (it fails with the type shrink removed).

**Controls.** A checkbox per component — speed, pace, distance, time, elevation, heart rate, either cadence, power, each charted camera stream, the route inset and a progress bar — plus template, top/bottom, size, accent colour, background opacity and units. Camera streams are gauges over the range their own values span, since the source states no bounds. Not a design editor: no dragging, no per-component style.

**Unsupported is disabled and said once.** A component with no data is a disabled checkbox marked "not in this activity", never drawn; if the reader has it *on* (heart rate is on in two templates) a warning names it. Nothing is drawn empty (TD-041).

**Session, not storage.** The choices live in `useOverlayStore` (TD-040): they survive switching templates and replacing files, are lost on reload, and **Start over** resets them. A component the reader switched is remembered by key across templates; nothing is written to `localStorage`, which still holds only the theme.

### TD-044: The Overlay Is Exported as a Transparent PNG Sequence in a Worker; Transparent WebM Is Not Built Yet

Decision (`AV-1006`): the overlay-only export is **a store-only ZIP of transparent PNG frames plus a metadata file**, drawn on an `OffscreenCanvas` in a worker and written to the origin-private file system as it goes (TD-039). It is the "at least one editor-friendly output path" the task asks for, and the one TD-039 says works everywhere. **Transparent VP9 WebM is not part of this task**, and TD-039's phase one is therefore only half delivered; see below for why it is a separate piece of work rather than an afterthought.

**Why WebM waits.** TD-039 says both formats "run on an `OffscreenCanvas` in a worker". The PNG sequence does; `MediaRecorder` cannot — `captureStream()` exists on `HTMLCanvasElement`, not on `OffscreenCanvas` — so the WebM recorder runs on the main thread with a real canvas, in real time (a ten-minute overlay takes ten minutes), behind a capability probe, and needs the EBML `Duration` patch TD-039 describes, which only a browser test can check. That is a second export engine with its own failure modes, and shipping it half-tested would be worse than shipping it later. It remains the follow-up TD-039 names.

**One drawing, two renderers.** `drawOverlay.ts` paints a built template on a canvas from the same resolved components (`resolveOverlayComponent`) and the same type size (`BASE_FONT_CQW`, 2.2% of the frame width) as the DOM preview, and draws nothing for a component with no data. It is not pixel-identical to the preview — canvas and DOM lay out text differently — and does not claim to be; `AV-1008` owns deterministic render tests. Every frame starts with `clearRect`, and nothing paints a backdrop, so what is not overlay is transparent; the browser test reads the first frame's alpha at the corners and the centre.

**Archive.** Plain ZIP, no ZIP64: 4 GB and 65,535 files, one of which is the metadata. `ZipWriter` refuses an entry that would break either, and the panel offers the highest frame rate (10–60) at which the export fits instead — TD-039's "a lower frame rate rather than ZIP64". Frames are named `frame_000001.png`; the picture size defaults to the video's own and can be 720p, 1080p or 2160p of the same aspect, with even dimensions. The frame at index *i* is drawn at video time *i* / fps, and the count rounds up, so the sequence is never shorter than the video.

**Storage and stopping.** The plan is checked against where the worker can *really* store the export, before any frame is drawn: the page asks the worker, which tries exactly what an export does — a file in the origin-private file system and its synchronous access handle, the one thing only a worker is given — and removes it. A file is limited by the ZIP format (4 GB), memory by 1 GB. The answer is asked once per page load; until it is known no plan or button is shown, and a worker that cannot be started at all is reported there rather than waiting on. A job that is started can still fail to *start* — a blocked worker, a request that cannot be cloned — and that rejects the job and is shown in the panel, which is left ready to try again. A finished download whose template, units, offset, size, frame rate, activity or video has since changed is marked as made with earlier settings, and stays available. The worker writes through a synchronous access handle to a file the *page* named, so the page can delete it however the worker ends; without the file-system API the chunks are held in memory up to 1 GB and the export is refused beyond that, with a message to choose less. A stop is a message the worker honours between frames, and a worker that has not answered after two seconds is terminated; either way the partial archive is removed, and leftovers from a closed tab are removed at the next start. The finished archive is removed when it is replaced, when the page is left, or on **Start over**.

**Privacy.** The only requests the page makes are for its own files; the archive reaches the reader through a `blob:` URL. The metadata file records dimensions, rate, counts, offset and template name — no file name, no coordinates, no telemetry. The browser test asserts that nothing but same-origin and `blob:` requests are made and that none is anything but a `GET`.

**Capability, not browser name.** The export needs a `Worker` and an `OffscreenCanvas` that can `convertToBlob`; a browser without them is told what is missing and offered no export, while the preview and controls carry on.

### TD-045: Burned-In Video Is Rendered by Mediabunny's Conversion, Asking for a Hardware H.264 Encoder, With the Sound Copied Through

Decision (`AV-1007`): the video is rendered in the export worker by **Mediabunny's `Conversion`** — demux, `VideoDecoder`, a per-frame hook where the overlay is drawn over the picture on an `OffscreenCanvas`, a **hardware H.264 `VideoEncoder`**, the source's **AAC copied packet for packet**, and an **MP4 written to a file in the origin-private file system**. The original file is only read; the render is a new file the reader downloads.

**Where this departs from TD-039.** TD-039 sketched "WebCodecs decode through `mp4box`'s sample table … composite … `VideoEncoder` … Mediabunny writing MP4". Mediabunny's conversion does the demux, decode, timestamp, B-frame and audio-copy work as one tested pipeline with a frame hook, so writing that chain by hand would have been more code for less assurance. `mp4box` stays where it is, reading telemetry. The cost is size: the chunk is **395 KB** (minified, before compression) rather than the 43 KB gzipped TD-039 estimated for an MP4 *writer*, because a conversion also pulls in the reader and the codec registry. It is loaded by name from the worker only when a render or a look at a video is asked for — an image-sequence export never fetches it — and the service worker precaches it like any chunk. **Licence:** MPL-2.0, read from its `LICENSE` file; it is file-level copyleft, this app does not modify its files, and it is pinned to 1.61.5.

**Hardware, honestly.** In Chromium, `isConfigSupported` answers `true` for `prefer-hardware`, `prefer-software` and `no-preference` alike (probed, headless, full Chromium): the preference is not a requirement, and a browser cannot be asked *which* encoder it will use. What the page can do is ask for hardware (`prefer-hardware` on the conversion, and on `canEncodeVideo` at the exact size and rate), refuse where H.264 cannot be encoded at that size, and say so: the answer is reported as *support for encoding*, never as a hardware encoder, and the panel states that its time assumes a hardware encoder it asked for and cannot confirm. A machine that says yes and then encodes in software is slow, possibly much slower than estimated, and the page does not pretend otherwise. The headless-shell build Playwright uses by default has **no H.264 encoder at all** and is refused correctly — which is what TD-039 warned of.

**The sound.** Copied unchanged where it is AAC, which every GoPro writes. Anything else is left to the conversion's own rules: copied if an MP4 can hold it as it is, otherwise converted to a codec this browser can encode and an MP4 can hold, otherwise left out — and which of those happens is known only once the render starts, so the panel says exactly that beforehand, without promising a codec, and reports a dropped track afterwards. Nothing is decoded and re-encoded when it can be copied, so there is no drift.

**Constraints, said before starting.** The panel looks at the video first, in the worker, reading only the container's index: no picture, a format this browser cannot decode (naming it and its size — HEVC 10-bit from a HERO11 is the case TD-039 left unchecked, and this is where it would be refused), H.264 cannot be encoded at the size, a picture beyond 4K (held to 4096 on the long side and 2304 on the short side as well as to a pixel budget, so a 5000 × 1000 strip does not slip through and a portrait 4K phone video does not fail), no file to write to (an MP4 goes back to patch its header, and a video does not belong in memory), or less free space than the render needs (`StorageManager.estimate`; an unknown amount is not a reason to refuse). Phones and tablets are declared desktop-only, by capability and user agent together, until measured. Size and time come from TD-039's figures: 10.6× real time at 480p, bounded by the encoder at 1080p (taken as 4.5×) and 4K (1.2×), each shown as "roughly".

**Output.** The video's own size by default, or 720p, 1080p or 2160p of the same aspect; bitrate from the picture area and frame rate (about 7.5 Mbps at 1080p30). Same stop, same clean-up, same stale-download warning as the image sequence (TD-044): a stop cancels the conversion and removes the file, and a finished render is marked as made with earlier settings when the template, units, offset, size, activity or video changes.

**Testing.** The loop and its refusals are unit-tested against a stand-in Mediabunny. The real thing runs in `e2e/overlay-burn.spec.ts`, in a **second Playwright project** (`chromium-codecs`, the full Chromium rather than the headless shell): it renders the HERO8 clip, reads the output's tracks with `mp4box` — H.264 at the source size, the AAC track with the same sample count — and decodes frame 3 s of both videos with WebCodecs to show the bottom strip, where the figures are, differs from the source far more than the untouched top. (`<video>` cannot be used for that: Chromium has no H.264 playback, though its decoder is fine.) It fails with the overlay draw removed. It also covers a stop mid-render at 2160p, a browser without WebCodecs, and a phone user agent, and asserts no request but same-origin and `blob:`. It skips, saying so, on a machine that cannot encode H.264 at that size.

### TD-046: Overlay Tests Use a Formula Ride and a Playable Synthetic Clip; Renders Are Compared as Display Lists

Decision (`AV-1008`): the overlay is tested against **two small synthetic fixtures whose every value is a formula**, goldens of the drawing that are **display lists, not pixels**, performance checks that use **telemetry made on the spot**, and a privacy test that **plants a canary** and watches the whole page for it.

**Fixtures.** `overlay-ride.gpx` (17 KB) is a minute of cycling with every channel the overlay can show, each a stated function of the second (speed `4 + 0.2t` m/s, heart rate `100 + t`, power `150 + 2t`…), and `overlay-test-clip.mp4` (60 KB) is a six-second 256×144 VP9 video. VP9 because the Chromium Playwright ships has no H.264 *playback* (TD-045), and this is the one fixture that lets a browser test play, pause and seek a real video. Both come from `make-overlay-fixtures.mjs`; the browser tests state their expected numbers from the formulae, and `overlayFixtures.test.ts` checks the files against them so the two cannot drift. The real HERO8 clip stays for what only a real camera file can do (telemetry extraction, the burned-in render).

**Goldens are display lists.** Pixels depend on the platform's fonts and anti-aliasing and would differ between a Mac and a CI runner. The canvas drawing is compared as the list of calls it makes, with the colour, font and alpha in force; the preview as its markup, numbers rounded. Both are pure functions of template, data and time, so they are the same everywhere. What pixels *can* safely say — transparent here, drawn there — is read from real pixels in the browser. Intended changes regenerate with `vitest -u`.

**Performance without a long video.** `syntheticTelemetry.ts` makes a deterministic activity of any length in memory; nothing long is committed. The checks are of two kinds, because absolute times belong to a machine: **budgets** generous enough for a slow runner, and **scaling** ratios between a long and a short recording in the same run, where the machine cancels out (sampling must not cost more per call on a six-hour ride; building must grow no faster than the recording; a frame must not cost more because the ride is longer). **The scaling check found a real problem**: a frame cost 29× more for a six-hour ride than for a ten-minute one, because the route inset stroked every point of the route on every frame, and the preview's SVG held all of them. `projectRoute` now draws the route *once*: the picture is a grid of cells, and the question asked of each **leg** — the straight run between two consecutive recorded points — is whether every cell it passes through has already been entered by a leg that was drawn. If so, it is ground the picture already has (the second lap of a loop, the way back along the road out) and costs nothing; if not, it is drawn and its cells are marked. Where drawing resumes after skipped ground the new piece of line starts on that ground, unless it is within a cell and a half of the last piece (a run of legs inside one cell, thinned away, not a retrace), so a retrace is neither drawn twice nor bridged by a chord. The cell starts at about a pixel and coarsens only if the line would exceed 3,000 points. Up to 0.012 of the box's height (about 8 px on the largest inset, under 1 px on the preview's) that is a *visible* error bound that does not grow with the recording, and a route that is long without being detailed — laps, an out-and-back — fits inside it. **The 3,000 points is the hard bound, though, not the error:** a route that covers so many distinct cells that it does not fit even there (a serpentine over a 70 × 70 grid kept all 4,900 points in an earlier version, found by a reviewer) cannot be both that faithful and that cheap, so the budget wins — the cell keeps growing past the error bound, to a quarter of the box, and as a last resort what remains is cut to fit — because the budget is what bounds the cost of a frame. The last resort has two policies, because every piece of line needs its two ends: if the ends fit, the points between them are thinned evenly and every piece survives; if even the ends do not (two thousand two-point recorded segments are four thousand points however they are drawn, found by a reviewer), the pieces themselves are reduced — **the shortest, by length of line, are given up first**, the rest are cut to their ends, and they stay in the order they were recorded. Either way the total is within the budget. Coarsening stops early only at the *recorded* floor — two points for each recorded segment, since no cell bridges a gap in the recording — and not when the line's *pieces* are down to their ends: a hub ridden out and back along two thousand spokes in one recorded run is two thousand two-point pieces at a fine cell, and a coarser cell merges them (a reviewer found that stopping at the pieces gave the spokes up instead; a test with one recorded segment of 2,500 spokes fails if it does). **Two earlier versions were wrong, each found by a reviewer.** A step proportional to the route's total length collapsed a small loop ridden a thousand times to its first and last points. Judging a *point* by whether its cell had been visited dropped the leg that arrives there — the side that closes a square back to its first corner, the diagonal back to an earlier corner — on any sparse route, whose legs are long and whose every end is a visited corner. The tests now check the middle of every recorded leg against the line drawn, not only the recorded points, which could never have noticed a dropped leg between two that were kept: a closed square, three sides and a diagonal back, a figure of eight, a square ridden fifty times (one square, closed), a loop ridden a thousand times, an out-and-back road, noisy fixes; judging a leg by its end cell alone fails five of them. A six-hour ride at 10 Hz draws about 3,000 points instead of 216,000, short routes are unchanged, and the end of every recorded segment is kept. A four-hour GPX in the browser confirms the preview's polyline stays within the budget and that scrubbing and playback stay responsive.

**Privacy, watched twice.** `e2e/overlay-privacy.spec.ts` feeds in files named for, and telemetry carrying, a canary token found nowhere else, drives the whole flow — scrub, play, template, units, export — and then looks for it, and for the video's and the GPX's file names, the activity's name and coordinates, `frame_0`, `overlay-export.json`, the export metadata's field names, an MP4's `ftyp` and a PNG's `IHDR`, in every request's URL, headers and body, and in every call the page made to `fetch`, XHR, `sendBeacon`, `WebSocket` and `EventSource` (recorded from inside it). It also requires that every request is a GET to this app's own origin with no query string — *parsed and compared exactly*, never by prefix, because `http://localhost:41730/` and `http://localhost:4173@evil.example/` begin like the origin and are not it — and shows the canary *did* reach the page, since a canary found nowhere proves little otherwise. The telemetry needles are read back from the file the page is given (its first point's coordinates as written, and without their trailing zeros), not typed beside it. The checks are tested by leaking on purpose: a coordinate in a URL, a body and a header, and a real request to a look-alike port, must each be found. Deliberately leaking a file name in a request makes the main test fail. `src/overlay/privacy.test.ts` is the same guard at the source, in every unit run: the files that handle the video, telemetry and frames may not contain `fetch`, XHR, beacons, sockets, a remote URL, or a way to persist anything (`localStorage`, `indexedDB`, cookies, the Cache API); the origin-private file system is allowed, because the export writes its archive there and deletes it.

### TD-047: The Route Image Is a Still of the Geometry, Drawn Without a Video, and Padding Is Measured Outside the Stroke

Decision (`AV-1009`): an activity with **no video** becomes a **transparent PNG of its route**, drawn from the geometry alone, from a file chosen on the overlay page or handed over from the viewer. It is a **still, not a template over time**: there is no timeline to sample, so it does not go through `OverlayTemplate`/`buildOverlay`. What it shares with the telemetry overlays is the **style token** (the default route colour is `DEFAULT_OVERLAY_STYLE.accentColor`), the **canvas context type** (`OverlayContext2D`), the **intake** (`parseActivityFile`: GPX, FIT, TCX, KML) and the **page**; the video overlays are unchanged. The panel is offered when there is an activity and no video — with a video the page offers the video overlays, as before.

**Geometry, then layout.** `extractRoute` reads the fixes once: unusable coordinates (out of range, not a number) are **left out and counted**, and a recorded segment boundary or an unusable fix **ends a run**, so no line is drawn across a gap the recording does not contain. Longitude is **unwrapped step by step** from the previous fix, so a route that crosses the antimeridian is one line however far it runs, and runs are shifted by whole turns into the copy of the world nearest the one before. `planRouteImage` fits the runs into the size asked for — equirectangular, longitude scaled by the cosine of the middle latitude, aspect kept, centred — and returns a plan in pixels. An empty activity, one with no locations, and one whose every coordinate is invalid are **three explicit refusals**; one place (or a route that never moves) is a **centred dot**, and the start/end markers are not drawn for it.

**Never clipped.** The padding the reader sets is the margin around **what is drawn**, so it is measured from the outside of the stroke and of the markers (and their white outline), not from the line they are centred on; a padding of nothing therefore still leaves half a stroke. A size, stroke or padding that leaves no room is **refused** (`no_room`) rather than clipped; so are sizes outside 16–8192 px, more than 2^25 pixels (the largest a browser will reliably allocate a canvas for), non-integer sizes, colours that are not `#rgb`/`#rrggbb` (a canvas silently ignores anything else and would draw black), and widths and paddings out of range. Points within half a pixel of the one before are not drawn.

**Transparent by construction.** `drawRouteImage` clears the canvas and draws only the line, one-fix dots and the markers; there is no `fillRect`, no image, no text and no alpha-changing blend, so every other pixel keeps alpha zero, and no basemap or attribution exists to bake in. The unit tests assert the call list; the browser test **decodes the downloaded PNG** and checks colour type 6, the corners and edge midpoints at alpha 0, that less than a tenth of the pixels are visible, the route and marker colours, that nothing touches an edge, and that a route across the antimeridian draws to the same box as the same route elsewhere.

**Handoff and the focused section.** The viewer's **Create route overlay** hands over the **whole** activity unless the reader ticks *Use only the selected section*, which is offered only when a selection with a located fix exists: a selection made for looking is not a choice about what to export. The slice is `sliceActivity`'s (a new `Activity` sharing the points; the viewer's own is untouched), the overlay store records `focusedSection`, and the page says so beside the activity and in the panel. A section that was asked for and cannot be made is not replaced by the whole activity. The hand-off is **standalone**: a video held on the overlay page from before is let go (with its offset and measurements), because the page would otherwise open the video workflow, not the route image asked for. If the section was asked for and is no longer there — the selection moved to a stretch with no locations, or was cleared — the button is disabled with the reason until the box is unticked, which is the explicit way back to the whole activity. The handoff is memory only, like every other (§5).

**Download.** The PNG is encoded in this tab (`OffscreenCanvas.convertToBlob` where there is one, else a canvas's `toBlob`) and handed to the browser's download at once, as the viewer's export does, so there is no stored link to go stale when a control changes; a null, empty or non-PNG result is a `render_failed` with the reason, never an empty file. The file is named for its size, never the activity's name. The preview is the same plan scaled down onto a canvas over a checkerboard.

Not done, and not claimed: only Chromium was driven; a 7680 × 4320 image was planned and validated in unit tests but not rendered in a browser; the encoder runs on the main thread (a worker would add cancellation, which a still of this cost has not needed).

### TD-048: A Route Draft Is Its Own Type, Keeps Place and Order Only, and Never Joins What Was Not Joined

Decision (`AV-1101`): a planned track is a **`RouteDraft`** (`src/domain/routeDraft.ts`), separate from the immutable `Activity` (TD-006). Every operation is a **pure function** returning a new draft (and a `DraftResult`, never a throw); no operation changes its arguments or any activity it reads, and no draft shares a point or a `Date` with an activity. Points that did not change are shared between successive drafts, so keeping many (for undo, later) is cheap.

**Shape.** An ordered list of `DraftPoint`s — `id`, `lat`, `lon`, optional `elevationMeters`, `time`, `distanceMeters`, `segmentIndex` — each with an **`origin`** (`manual`, copied from an `activity`, or an `import`, with the source point's index) and an optional **`edit`** (`added`, or `moved` with the position it moved from; nothing sets either yet, AV-1104 will). `sources` says what the draft was built from and how much of it was usable. **Ids are counters held in the draft** (`p0`, `p1`…, `s0`…), not clock or random values, so the same inputs make the same draft and ids survive edits; only the draft's own id is generated, and can be given.

**The policy for activity-only data: dropped.** A planned track is not a recording of anyone, so heart rate, power, cadence, temperature, speed, grade, accuracy, laps, events, camera streams, device metadata, format extensions and the file's warnings are not carried, and the lists are exported (`DRAFT_RETAINED_FIELDS`, `DRAFT_DROPPED_FIELDS`) and tested against a recording that has all of them, by looking for each in the serialized draft. The device's serial number and the file's name therefore never reach a draft's points. **The recorded distance is kept on the point, as a reading of the source, but is not carried into a generated activity**: an odometer goes stale at the first edit, and `computeDistance` prefers a recorded stream to the geometry, so passing it on would make the totals say what the track no longer is. Points with no usable location are not part of a route; they are left out and counted (`dropped`), and a generated activity says so in an `info` warning.

**Segments are kept, and imports start their own.** A copied recording's pauses survive as `segmentIndex`, renumbered from zero for what was taken (so a section starts at 0). An appended route begins a segment after the last one in the draft: the end of one route and the start of the next are **not joined by a line nobody drew, and no distance is counted across the jump** — three 222 m routes a hundred kilometres apart are 666 m, not 300 km. Joining them is a repair, which AV-1105 owns. **A dropped point is a break too** (found by a reviewer): the fixes either side of a stretch with no usable location start separate segments, so a ride with fixes at (10, 20) and (11, 20) and an unlocated point between them is two segments and no distance, not 111 km. **Elevation obeys the same rule** (found by a reviewer): `computeElevation` restarts its climb anchor at a recorded segment boundary, as `computeDistance` already did, so two flat routes at 100 m and 1,000 m appended to each other report 0 m of gain and loss, not 900 m, while the overall minimum and maximum stand. That is a change to the shared stats engine, so it applies to any recording split into segments — a multi-segment GPX no longer counts the height difference between the end of one segment and the start of the next as climb — which is the same reasoning as for distance.

**To an activity.** `draftToActivity` makes a normalized, route-oriented `Activity` — `source.format` `unknown`, parser `route-draft-1`, points numbered from zero in draft order carrying place, elevation, time and segment, streams computed, totals derived (`withDerivedStats`) — for the exporters and the viewer's route code. An empty draft is refused (`empty_draft`); so are a reversed or fractional range (`invalid_range`) and a range or activity with nothing located (`no_route_points`), each with a reason and with the draft it was given left as it was. No UI, store or route exists for drafts yet (AV-1102).

### TD-049: Route Builder Is a Page of Its Own, Holding One In-Memory Draft

Decision (`AV-1102`): planned tracks are made on **`/route-builder`** (**Tools → Route Builder**), never inside the viewer, which shows what was recorded. The page holds **one `RouteDraft`** (TD-048) in a store of its own, `routeDraftStore`, **in memory only**: nothing is written to storage, so a reload or a direct visit leaves it empty, and the empty state says so (as the overlay page does, TD-040) rather than showing a stale track or failing. The name is *Route Builder*, the one the task names; a route *planner* would promise routing, which this does not do.

**Three ways a draft arrives, all through the store.** *Handoff*: `setDraft(draft)` replaces what is held — this is what the viewer's "Create Custom Track" will call (AV-1103), and the page already renders whatever it is given. *Blank*: **Start a blank track**. *Import*: a GPX, FIT, TCX or KML file through the viewer's own intake (`parseActivityFile`), which becomes the first points of a new draft (`draftFromActivity`) or, when one is held, is **appended** as a separate stretch (`appendImportedRoute`) — so the end of one track and the start of the next are never joined by a line nobody drew. A track with nothing usable is refused with the model's reason and **the held draft is untouched**; a file that cannot be read says why and offers another go. Importing replaces nothing: **Start over** is the only thing that discards a draft.

**What the page does and does not do yet.** It takes drafts in and says what it holds — name, how it started, points, stretches, distance (derived from the geometry through `draftToActivity`, in the reader's units), each source with how many of its points were used, and the model's warnings. It has no map and no editing; those are AV-1104, and the page says a blank track has no points yet rather than implying tools it lacks. It uses the app's shell: global header, Settings modal (which opens over the page without leaving it), theme, responsive layout (a 360 px viewport has no sideways scroll, tested), and route metadata in `seo.ts` that is constant and never names a track or file. The page's regions are named so that none contains another's name (*Nothing planned yet*, *Planned track*): Playwright's role-name match is by substring, which is how a region called "No planned track yet" once matched a query for "Planned track".

### TD-050: The Viewer's "Create custom track" Copies the Route Into Route Builder, and the Model Decides Whether It Can

Decision (`AV-1103`): the loaded viewer offers **Create custom track** beside the export panel and the route overlay action. It hands Route Builder a **copy** of the open activity's route — `draftFromActivity`, which reads the activity and leaves it alone (TD-048) — through `routeDraftStore.setDraft`, replacing whatever draft was held, and navigates there. In memory only, like every handoff (§5); the activity the viewer shows is unchanged and still open on the way back, and a test asserts both the serialized activity and the store's reference are what they were.

**The label.** *Create custom track*, the phrase the task and the roadmap use, in sentence case like every other button here. Not *Plan route from activity*: a planner promises routing, which this does not do (the same reasoning that named the page Route Builder, TD-049). This answers the §17 question.

**Whether the button can be pressed is the model's answer, not a second guess.** The draft is built up front from the activity (and, when there is a chart selection, from the selected range) rather than on the click. If `draftFromActivity` refuses — no point with a usable location — the button is disabled and the refusal's own message is shown under it, so the reason the viewer gives is the reason the model has, and the two cannot drift. A copy of an activity's points is cheap enough to make on render, and shares nothing with the activity.

**The selected section**, as for the route overlay (TD-047): the whole route goes unless the reader ticks *Copy only the selected section* — worded apart from the overlay action's box, since the two sit in the same panel — offered only when the selection yields a draft. A section that was asked for and is no longer there — the selection moved to an unlocated stretch, or was cleared — disables the button with the reason until the box is unticked, which is the explicit way back to the whole activity.

### TD-051: Route Points Are Edited by Hand, in Straight Lines, by Pressing or Typing — Never by Dragging

Decision (`AV-1104`): Route Builder draws the draft on the viewer's own map component and edits it through three pure operations on the model — `addPoint`, `removePoint`, `movePoint` (TD-048's rules: a new draft each time, nothing shared with an activity, a refusal changes nothing) — and nothing else. **Editing is manual and straight-line**: a point goes where the reader put it and the line runs straight to the next; no road snapping and no routing provider, now or by this design. That answers the §17 question: snapping would need a network routing service, which the privacy model (§5) has no room for, and a planned track for a device is a sequence of places, not a navigation.

**Two ways to say where, and both have a keyboard form.** A press on the map adds a point at the end of the track (or, in *move* mode, moves the selected point there), and the same place can be typed as coordinates. Points are selected by pressing them on the map or by stepping through them with *Previous point* and *Next point*. **Points are not dragged**, and the page says so: there is no drag handle and nothing suggests one. A drag has no keyboard equivalent and no way to refuse a bad place mid-gesture, whereas a deliberate press-to-move or a typed coordinate has both. Drag-to-move is left out of this milestone by design, not deferred; adding it later would be a convenience over the same operation.

**Where the point lands in the track's stretches.** An added point continues the stretch it joins — at the end, the last stretch; after a chosen point, that point's — so it is drawn joined to its neighbours, which is why it was added. A removed point leaves its neighbours in their stretches. A moved point keeps its origin, elevation and time, and records where the source had it **once**: the first move remembers the original place, and later moves keep that record rather than the last stop, so what was changed from the recording can always be told; a point the reader added has no original and stays *added*.

**A bad place is refused with a word, never a block.** Latitude outside ±90, longitude outside ±180, or anything that is not a finite number is refused by `validatePlace` with a message naming the part (`invalid_point`); an id that is not in the track is `unknown_point`. The page shows the reason in a `role="status"` line and nothing else changes — the next press goes straight through. Every edit is reported to the page as a `DraftResult`, so the reason the page gives is the model's own.

**The map does not fight the editor.** The map component gained optional editing props — a layer of draft points (the selected one larger and amber), a press-on-point and a press-on-map callback (a press on a point is not also a press on the map), and a `fitKey`: with one, the camera is fitted only when the key changes (a new draft), not on every change to the route, so adding a point does not pull the camera back to the whole track. Without the key the viewer's behaviour is unchanged and tested so. The preview is the draft through `draftToActivity` and the same GeoJSON builder the viewer uses, recomputed on each committed edit — never on pointer movement — which is the §14 rule for large drafts.

### TD-052: A Section Is Shown Before It Is Cut, the Cut Is Joined Unless a Gap Is Asked For, and Every Edit Can Be Undone

Decision (`AV-1105`): a section of the draft is marked from the selected point — *Section starts here*, *Section ends here*, in either order — and is drawn on the map in the lap layer's colour, without moving the camera, before anything happens to it. *Discard section* takes it out through `discardSection`, one more pure operation on the model: the points either side of the cut are **joined into one stretch**, because a reader removing a detour means the road to run on, unless *keep a gap where the section was* is ticked, in which case what follows the cut begins a stretch of its own and no distance is counted across it. A section at the start or the end has nothing to join; discarding the whole track leaves an empty draft, a track with no points rather than an error; a one-point track is the same case.

**Undo, not confirmation.** The task allows either for a destructive edit that is easy to trigger by accident. Undo is the better answer: a confirmation dialog interrupts every discard to ask about the one in a hundred that was a slip, and is answered by reflex; an undo costs nothing until it is needed. The store keeps the draft before each edit — add, remove, move, discard, join, split, append — up to fifty deep (`UNDO_DEPTH`), which is cheap because successive drafts share the points an edit did not touch (TD-048), and *Undo last edit* takes the newest back; the status line names what a discard did and that Undo takes it back. The history is cleared when a different draft arrives, since there is nothing of it to return to. **No redo**, by this design: a redo stack has to be invalidated on every new edit and explained in the UI, for a gain nobody has asked for; this answers the §17 question about undo/redo in the first milestone.

**Stretches are the reader's to join.** An appended track starts a stretch of its own (TD-048); whether the end of one track and the start of the next are really one road is not something the geometry can say, so the page does not draw a line across the jump and does not ask on import. Instead the selected point offers *Join to the point before* when it begins a stretch, and *Start a new stretch here* when it does not — the two repairs, `joinBefore` and `splitBefore`, which the discard's join and gap are made of. That answers the §17 question about far-apart appended tracks: kept separate, joined on request, never a straight line nobody drew. A stretch is identified by its run, not its number alone, so splitting one run does not split a later run that reused the number — and joining one does not swallow the run after it: stretches are numbered in order of appearance and a cut can bring two with the same number together, so when the run following a join already carries the number being joined to, it takes a number of its own and keeps its boundary (found by a reviewer; runs `0,0,1,1,0,0` joined at the third point are `0,0,0,0,2,2`, not one stretch).

**Marks are derived like the selection.** Both marks belong to the draft they were made on and to points that still exist; a discard, an undo or a new draft that removes them clears them by construction, so a *Discard section* button is never offered for a section that is not there. Two things a reviewer found keep that honest: the store's counters never rewind on an undo, so a point added afterwards can never take the id of one an undo took away (which a stale mark would otherwise name); and an undo rebuilds the selection, its mode and the marks from what was *live* before it — a selection that a removal had already ended does not come back with its point, or the next press would move a point nobody picked. A section is drawn as a line in the lap layer and as a colour on its handles, since a line needs two points and a one-point section is still a section.

### TD-053: Appending a Track Measures the Jump and Says It, but Never Joins It

Decision (`AV-1106`): another track is appended from the Route Builder page through the app's own intake — `parseActivityFile`, the format detector and parser registry the viewer uses — so GPX, FIT, TCX and KML all append, with no route-builder parser. The points go after the draft's in their original order (`appendImportedRoute`, TD-048), as a stretch of their own; appending never replaces the draft (only *Start over* does) and is one undoable edit (TD-052).

**The jump is measured and said, not drawn.** `appendJump` measures the straight-line distance from the draft's last point to the first appended one. After every append the page says how many points came from which file and how far the first of them is from the point before it, read from the draft as it is now — so after a join it says the jump is drawn and counted, and after a move or an undo the distance follows (found by a reviewer: a remembered distance went stale); beyond `FAR_APPEND_METERS` (1 km) it says they are far apart, so nothing is drawn or counted across the jump, and that a reader who knows it is one road should join them. *Select the join* selects that first point, which is the visible marker on the map (the selected handle) and the place where *Join to the point before* is offered. That is the task's optional join/gap marker, made a choice the reader takes rather than a line the app draws: a straight connector across eleven kilometres would be a road nobody rode, and an automatic join would count it.

**A refusal says what kind it is.** A track the model cannot take (`no_route_points` — a treadmill FIT with no GPS) is reported as having no route to add, with the model's reason; a file the intake cannot read keeps the intake's own typed error; a file of a type the app does not read is turned away by the drop zone before it is read. In each case the page says the planned track is as it was, and it is — the same draft object.

**Privacy.** The file is read in the tab and dropped once parsed; its name is used only in the page's own text and the draft's source list. A browser test records every request through a GPX-then-TCX append, a join and a refused FIT, and asserts none leaves the origin, none carries a file name, the title names no file, and nothing is written to storage.

### TD-054: A Planned Track Is Exported as a GPX of Places, Without Times, Named as a Plan

Decision (`AV-1107`): Route Builder writes the draft through the same exporter registry as a recorded activity — `draftToActivity` into `exportActivity` — so there is one GPX writer, not two. Export controls appear only once the draft is a route, meaning some stretch has two points; before that the section says what is missing and offers nothing to press.

**GPX only, and FIT and TCX shown disabled with why.** The registry's FIT and TCX writers produce *activity* files: sessions, laps and records keyed by time. A plan written that way would need invented times and would appear on a watch as a workout already done, which is not representing the planned track correctly, so they are listed as unavailable with that reason rather than hidden. A FIT *course* writer would be the way to offer FIT, and is a separate piece of work.

**No timestamps.** A planned track says where to go, not when. The times a copied recording carried are left out, a draft drawn by hand never had any, and a file mixing the two would be stranger than either. This answers the §17 question about timestamps in planned-track exports. Elevation, name and one `<trkseg>` per stretch are written; nothing of heart rate, cadence, power, temperature, speed, laps or the device is, because the draft never held them (TD-048).

**Warnings say what was left out.** After a download the page says only the route was written and why (when the draft came from a recording), that the file has no timestamps and why, and — when there are several stretches — that they are separate segments that some devices show only the first of or join, with the advice to join them first if it is one road. Points the draft dropped for having no location are reported too.

**Naming.** `<draft name>-planned-track.gpx`, through the same allowlist the viewer's exports use (`safeFileStem`, now shared), so a download is never taken for a recording and a name with path separators cannot escape the downloads folder. A blank name becomes `route-planned-track.gpx`.

**Privacy and round trip.** The file is a `Blob` handed to the browser's download through an object URL, the same helper the viewer's export uses. A browser test downloads the planned GPX, reads it back through the viewer's own intake as a route with the same number of points and no times, and asserts every request on the way was a same-origin GET with no body; a unit test parses it back with `parseActivityFile` and compares every coordinate and elevation in order.

### TD-055: Route Builder Is Covered as a Journey, by Keyboard, on Two Screens, at Scale, and Request by Request

Decision (`AV-1108`): the Route Builder milestone closes with `e2e/route-builder-coverage.spec.ts`, which tests the tool as one journey rather than as parts. A ride opened in the viewer is copied with *Create custom track*, edited by typed add and move, has a three-point section discarded, gets a TCX appended and joined, and is exported as a planned GPX. That file is read back in the viewer as a route with the same number of points and no times.

**Keyboard alone.** From the homepage, *Tools* is opened and walked with the arrow keys to *Route Builder*. A blank track is started, three points are typed and submitted with Enter, and then select, remove, undo, mark and discard are each done as a key press on a focused button. Every core edit has that form by design (TD-051); this test is what keeps it so.

**Accessibility, as checks rather than a dependency.** Every button, input, select and link in the header and the page has an accessible name. Every enabled control in the editor and the export section shows a visible focus ring when reached by keyboard. Settings opens over the page as a dialog, closes on Escape and gives focus back. These are written as Playwright assertions rather than by adding an audit library, which keeps the dependency list as it is; an automated audit can be added later without changing them.

**Two screens.** At 1280 px and 360 px the page has no section sidebar (that belongs to the viewer), no sideways scroll in the document or the scrolling container, a visible map, and every editing and export control inside the viewport's width.

**At scale, which found a real cost.** A two-hour ride at one point a second is imported and appended to itself (14,402 points), then edited, discarded from, undone and exported, with each step timed. An edit took about 1.2 s. The draft was turned into an activity twice per edit, once for the map and once for the summary, and every one of the 14,400 handles was sent to the map again. Now the preview is computed once and shared, and above `ALL_HANDLES_LIMIT` (2,000) handles are drawn only for the selected point, the ends of every stretch and a section's ends. The rest are still a press away: on a long track a press on the drawn line selects the nearest point instead of adding one (a press in *move* mode still moves the selected point, as asked), and *Previous* and *Next* step from there, as from the keyboard. The nearest point is looked for in the run as given to the map, not in the feature MapLibre reports under the pointer, whose geometry is the tile's clipped and simplified copy and whose indices are therefore not the track's. A browser test presses the drawn line of the 14,402-point ride and checks the selected point's coordinates against the place pressed. An edit now takes 150–400 ms here, and the browser bounds are wide enough for a busy parallel CI run and catch only a catastrophic slowdown, while unit tests pin the two causes deterministically (the handle limit; one preview per edit). A unit test runs eight operations and a preview on a 30,000-point draft under a linear-work ceiling.

**Privacy, over every flow.** Each test records every request and asserts the same rule: the exact same origin, `GET`, no body, no file name in any URL, no file name in the title, and nothing in local or session storage but the theme. The basemap is switched off first, so the audit sees only the app; map tiles are the one documented exception (§5), and route-only mode is how a reader avoids them.

### TD-056: The Viewer's Charts Are One Instrument, Read by Pointer or Keyboard, and Focus Follows the File

Decision: the chart panel behaves as one instrument rather than a stack of separate pictures, every part of it is operable from the keyboard, and opening or closing a file moves focus and says so. Found by a design critique of the viewer, which scored it 25/40 with three major issues in these areas.

**One x extent.** Each chart used to span its own series, so a pace that needs a few points of distance before it has a value was stretched to the left edge, and the shared hover cursor sat at a different horizontal position in each chart. The panel now computes one extent from every drawn series and every chart is drawn over it.

**A readout at the cursor.** DESIGN.md's north star is a bike computer's readout, yet hovering showed a line and a dot with no number. A sticky row above the charts now shows, as captions over figures, the x value and every drawn chart's value at the shared cursor, whether that cursor came from a chart, the route or the keyboard. A chart with no reading at that exact point shows the missing dash rather than a neighbour's value. It is deliberately not a live region: it changes on every pointer move.

**Keyboard.** Each plot is a `role="slider"` with a tab stop: the arrows, Home, End and Page keys move the shared cursor by rendered sample, so the map marker and the other charts follow; Shift extends a section from where it started, Enter keeps it (or selects the point), Escape drops a section being marked and otherwise releases the kept section or the selected point. The slider's value text is the value at the cursor, which is how a screen reader hears it. Range selection, point selection and map synchronisation were previously mouse-only, against the WCAG 2.2 AA target in PRODUCT.md.

**Focus follows the file.** Opening a file unmounts the drop zone and closing one unmounts *Close activity*, and focus used to fall to the page body with nothing said. Focus now moves to the activity's title on open and back to the drop zone on close, both announced through a polite region that stays mounted across the two layouts. The section sidebar moves focus into the section it scrolls to. Reduced motion turns off smooth scrolling, CSS transitions and the map's camera glide.

**Honest states.** Disabled buttons, the primary one included, look disabled. The lap a reader can press has a resting border, and the reason a lap cannot be highlighted is a visible note rather than a tooltip. The map palette follows DESIGN.md's Fixed Map Rule (lap amber, selection violet); it had the two swapped, with an amber hover marker vanishing on the amber section. The marker is now neutral, and the basemap is dimmed hard enough for the route to stay the brightest line on light tiles.

**Second pass, after a second critique (27/40).** The cursor line was one line in value but not in pixels: each chart sized its left gutter from its own labels, so plots started a few pixels apart. The panel now gives every chart the widest gutter any of them needs. Selecting a section used to insert a focus bar and a summary panel above the charts, pushing the chart just used down the page, and Reset View scrolled away once the reader moved into the charts. The section now lives in the readout's sticky scope row: its figures (AV-605's distance, duration, gain, start and end, with seconds when both fall in one minute), "Your file is unchanged" and Reset View. At rest the row says "Whole activity" and how to select, so its height never changes. A hidden status line announces a section kept or let go. A chart's value is read as a sentence, "at 142 ft, elevation 358 ft", and the readout's position caption is "At" rather than a second "Distance". Export opens on a format it can write rather than an unavailable source format. A file dropped on an open activity replaces it, and the section links run as a row at narrow widths instead of disappearing.

**Third pass, after a third critique (25/40).** Two of its major issues came from the second pass, and both are fixed. A file dropped on an open activity used to go through `loadFile`, which clears the activity before parsing, so a corrupt drop destroyed what was open. It now goes through `replaceFile`, which parses aside and swaps only on success. A failure keeps the activity and shows the error, naming the file, as a dismissible notice above it; a refused file type is shown on the page as well as announced. Reset View, which lives in the row it clears, used to drop focus to the page body when it unmounted. Focus now returns to the chart the section was kept from, and "Showing the whole activity." is announced. Also: the readout's position and the slider's value are written in the axis's unit; the readout has one instruction line, naming Enter and Escape; the shared x axis is labelled once, under the last chart, with ticks on every chart; a greyed x-axis option shows its reason; a file with no route gets no route tools and no hint about a route; the map marks the route's start and finish, has a scale, a spoken description on its canvas, the app's focus ring and controls themed to its night frame; the lap toggle keeps one name, with the state in `aria-pressed` alone.

### TD-057: The Overview Leads With Three Primary Fields

Decision: the activity summary sets distance, duration and the sport's primary metric (pace or speed, per AV-908) apart as larger figures in a row of their own, and the rest of the figures follow in the existing grid. The point count leaves the grid for the source line ("TCX · run.tcx · 5 points").

Reason: eleven figures of equal weight gave the overview no answer to a reader's first question. A bike computer shows two or three primary fields large and the rest small; these three are what a reader of any of PRODUCT.md's audiences checks first, and the primary metric already follows the sport. The point count describes the file, not the effort, and sat between average pace and heart rate. The Caption-Over-Figure Rule still holds: the lead row is the same caption over a figure, only larger. A file that cannot answer one of the three (an indoor session has no distance, and so no pace) leads with the next figure it can, in a fixed order of preference (moving time, elevation gain, heart rate, power), rather than with large dashes; the missing figure still explains itself in the grid.

### TD-058: The Average Pace or Speed Is Over Moving Time, and Says So

Decision: the overview's primary metric is averaged over **moving** time wherever moving time can be worked out, and is captioned "Avg pace (moving)" or "Avg speed (moving)". The elapsed average stays, captioned "(elapsed)", in the grid beneath. Neither replaces the other in the derived stats: `averageSpeedMetersPerSecond` and `averagePaceSecondsPerKm` keep their elapsed meaning, and `averageMovingSpeedMetersPerSecond` and `averageMovingPaceSecondsPerKm` are added beside them.

Reason: once the metric led the overview (TD-057), an elapsed average read as a contradiction. On `run-with-laps.tcx` it said 60:19 /mi above a pace chart reading 8:02 /mi, because the five-minute file includes a four-and-a-half-minute stop. A watch or a training log shows the moving average, and a reader compares the headline against the chart beneath it. Labelling both is what keeps each honest.

Why the chart still differs on that fixture: the pace chart is a 15-second trailing window over recorded intervals, never across a recording gap (AV-505), so it shows 67 m in 20 s, 8:02 /mi. The moving average divides the whole distance by the moving seconds, and on a five-point file whose lap straddles a pause the two bases diverge. On a real recording, with points every second or few, they agree closely; the fixture is a degenerate case, not a formula error.

### TD-059: The Overlay Page Is a Workspace, Says How It Synced, and Never Loses Its Place

Decision: with a video, the overlay page is a workspace, not a document. At 1100px and wider the preview, its transport, the sync line and the offset sit in one sticky column, and the files, the overlay controls and the exports scroll beside them; narrower, the picture alone sticks to the top. Found by the page's first design critique (23/40), whose largest finding was that the preview scrolled away while the controls that change it were used.

**Sync is said and shown.** The timeline reports how the video was laid against the activity (`alignment`): by the camera's own clock, or at the activity's first point when the video states no clock. The page says which, says where the video falls in the activity, and warns when the two do not overlap at all (a run from another day "worked" in silence before). A thin bar draws the activity's span, the video's span within it and the playhead. The offset field takes seconds or clock time (`-23:00`, `1:02:03`), with steps of 0.1 s, 1 s, 10 s and a minute; a clip from minute 23 of a ride no longer needs "-1380" typed. "This frame is at m:ss of the activity" sets the offset that puts that moment under the current frame, which is how alignment is actually done.

**Transport.** On the focused picture, Space or K plays and pauses, J and L skip five seconds, comma and full stop step one frame; the scrubber's arrows step one frame too, rather than 1% of the clip.

**Nothing is lost to a file.** Each file slot has its own reading and error state, shown in the slot through the shared error panel with the file named. The preview and the exports stay mounted while a file is read or fails: a running export is not cancelled and a finished download stays. "Choose another" opens a picker and keeps the current file until its replacement has parsed, as the viewer's drop-to-replace does. Focus returns to the slot after a remove, a dismissal or Start over. Start over lets go of both files and keeps the overlay settings, the rule TD-043 set for replaced files, and offers Undo.

**Frame rates.** Export offers 23.976, 29.97 and 59.94 fps as the exact fractions 24000/1001, 30000/1001 and 60000/1001, written by their names, and starts at the clip's own rate. An overlay exported at a flat 30 against a 29.97 GoPro clip drifts by about 0.6 s every ten minutes once an editor conforms it. A finished export says to set the editor's sequence to the same rate.

**Controls on the system.** Selects use `.select`, text and number fields `.input` (defined now; the route panel used it undefined), and native checkboxes, radios and sliders take `accent-color` and the 2px focus ring. Template radios are named by the template and described by their sentence. The PNG export is the page's one primary action; the burned-in render is secondary, states its blocker before its plan, and hides the plan when blocked. Progress is announced at each quarter, not each frame.

**Second pass, after a second critique (25/40).** Two of its major issues were the first pass's own layout. The sticky stage held the offset and its hints, was capped at the screen's height and scrolled inside itself, so aligning scrolled the picture out of its own column; and below 1100px the picture was sticky only within the stage, a grid row, so it let go as soon as the controls began. The stage now holds only the picture, its transport and a one-line summary ("Lined up by the camera's clock."), and the sync panel (the full line, the bar, the offset) is drawn in the side column through a portal, keeping the preview's own clock. Narrower than 1100px the workspace is a flex column, so the stage sticks across the controls. Exports wait when the activity covers none of the video, as they do when nothing is switched on: an empty MP4 had been rendered. Clocks more than a day apart are told as two dates rather than a five-digit hour count, with "Line up at the activity's start" as one press, and the bar is not drawn at a scale it cannot show. The bar carries a trace of the activity's speed (else its elevation) across its span, to line a sprint or a climb up by eye. Text that is not an offset stays, marked invalid and explained, rather than reverting silently. Undo after Start over sits beside the drop zone that takes focus; Start over asks first when a finished export would be lost, since Undo does not bring that back. Field labels are their own elements, so a select's name is not its options; sliders show their values; the offset's reset is "Reset offset"; the keys the picture answers to are shown while it has keyboard focus; the burned-in render is not offered on a phone.

**Third pass, after a third critique (26/40).** Sync was right in what it did and wrong in how it was put.

- **Where the video starts, not an offset.** The main field is "Video starts at m:ss of the activity", the way a creator says it ("the clip starts 1:30 into the ride"). The signed offset the timeline takes becomes `anchorSeconds − start` inside the preview. Against a camera's clock, the difference is said in words ("2 s earlier than the camera's clock puts it"), with a way back. Four steps, −1 s to +1 s, are named "earlier" and "later". The field steps by key: a second, ten with Shift, a tenth with Alt, a minute with Page Up and Page Down. The minute and ten-second buttons are gone, so the steps are four stops, not eight.
- **The bar is under the picture, and is a control.** The bar, its trace and the playhead moved into the sticky stage, under the transport; the sync line and the start field stay in the side column. The bar is a slider: dragging slides the video along the activity, a click inside the video shows that moment, and the arrow keys move the start. Its value is said as "Video at 0:25 to 0:31 of 1:00".
- **The transport keys answer anywhere in the stage.** That includes the scrubber and the bar, except where a key belongs to a field or Space to a button. The scrubber's arrows are held to one frame, a second with Shift. The keys are written in one quiet line that is always shown, so a mouse reader learns them and nothing shifts.
- **"This frame is at" refuses a slip.** It refuses "9:99" (the clock form now refuses sixty or more after a colon), a moment before the activity, and a moment past its end, each with the reason.
- **The metric strip stays one row.** Its tiles share the edge, and the type shrinks with a narrower tile, rather than a second row covering half the frame. Every template's tiles stand a hair apart (`TILE_GAP`), so rounded corners no longer meet in notches of video. Below 30% background, figures carry a thin dark halo, drawn the same in the preview (`text-shadow`) and the export (`shadowBlur`), from one rule (`needsHalo`).
- **One primary per export.** Each export panel shows one primary: Export until a file is ready, then its Download, and "Export again" once that file no longer matches the preview. A stale download stays, as a secondary.
- **The PNG estimate below 1080p scales with the frame's side, not its area.** A 720p frame measured about twice its share by area.
- **Focus.** The Start over confirm puts focus on "Keep it", and "Keep it" returns focus to Start over. A slot with an error focuses the error's button, not the slot's heading. "Skip to export" passes the files, sync and settings. "Reset overlay settings" offers "Undo reset".
- **Copy.** "Drop an MP4": the article follows how the format is read aloud. The error panel labels its code "Code for a bug report". A video with no telemetry beside a chosen activity is a note, not a problem.

**Fourth pass, after a fourth critique (27/40).** Three of its P1s came from the third pass itself.

- **A refused time no longer outlives the start it was typed against.** It is kept with that start, so moving the bar, a step or Line up replaces it.
- **The bar and the steps are held to where the video still touches the activity** (from minus its length to the activity's end), so the slider's value stays within its range. A typed time is taken as typed and answered by the no-overlap notice, because changing it while it is typed would rewrite the field under the reader.
- **Focus.** "Reset overlay settings" and "Undo reset" are one button that changes its word, so focus stays on it. Below 1100px, the page measures the sticky stage and makes its height the scroll padding (`--overlay-stage-height`), so a control reached by Tab is never under the stage.
- **The metric strip shrinks its type only to a floor** (`MIN_STRIP_TYPE`, 60% of the base). Past what one row holds at that size (`metricStripCapacity`), the figures wrap, and the controls say how many it holds and what to do. Its route is a square as tall as the figures, docked at the end of the row, no longer a third of the strip.
- **The PNG estimate is area-scaled with a floor of 4.5 KB a frame.** The third pass scaled it by the frame's side, and it came out 4× high for a 256 × 144 clip, which measured 781 KB for 180 frames.
- **Wording and spacing.** The export panels say "Change where the video starts" instead of naming the offset. The stale burned-in button says "Render again". The two export panels stand 24px apart.
- **Sync comes first.** With a video, the side column opens with Sync, after Skip to export. The file slots follow, a line each (name, size or distance, duration, and the section scope), with what else was read folded under "Details". The slots keep their place in the tree, so a file dropped while another is read is not lost.
- **Off the activity is said in the stage, at every width.** An amber line under the bar says nothing is drawn, with "Line up at the activity's start" beside it. The Sync panel keeps the longer reason (two dates, where the video falls) and is the one that announces it.
- **The page is never wider than the screen.** `.page` is a flex item of the shell's scroll area and grew to its widest unbreakable line: the always-on key hint made the overlay page 404px wide on a 390px screen, scrolling sideways and leaving a 6px right gutter against 20px on the left. It now has `min-width: 0`, which fixes this on every page, and the key hint wraps below 520px.

### TD-060: Recorded Tracks Are Merged by Their Own Clocks, With the Gaps as Pauses, and Overlap Refused

Decision (`AV-1109`): Route Builder has a *Merge recorded tracks* section that makes one timed activity from two or more recorded track files. It sits beside the planned track, not inside it, because it is the other thing. A planned track is places without times (TD-054); a merge is a recording, every time kept. The rules live in `src/domain/mergeTracks.ts`:

- **Order is the files' own clocks**, oldest first by first timestamp, then last, then file name. The order the files were chosen in plays no part, and neither do their names, unless the clocks tie.
- **A file with no timestamps is refused** from the merge, with the reason. It is never placed by guess. A file's untimed points are left out with a note, and its out-of-order points are put right, the way the stats already read them.
- **Overlap is refused**, naming both files, the times, and how long they overlap. Two recordings that claim the same minutes cannot both be the ride. Interleaving them would draw a zigzag between two devices, and trimming one would silently drop a stretch the reader may want. Two files covering exactly the same time are said to look like the same recording. A file that starts the second the last one ends is a zero-length pause, not an overlap.
- **The gap is a pause.** Each file keeps its own segments, renumbered after the files before it. Distance, climb and the map's line all restart at a segment, so nothing is counted or drawn across the jump, and no point is invented in it. The pause counts in elapsed time. It is not moving time: the step across it covers no distance. A pause whose ends are more than 1 km apart (`FAR_PAUSE_JUMP_METERS`, the same line Route Builder draws for an appended track) is warned about and still not joined. The merge records the pause as `pause` and `resume` events.
- **Totals are the sum of the parts.** Each file's distance is worked out the way the viewer works it out for that file alone: its own odometer if it has a sane one, GPS otherwise. The next file's distance continues from where the last ended. Without that, two devices' odometers, both starting at zero, would make the merged stream go backwards, and the stats would throw it away.
- **What the merge is called.** It is the files' shared name, or the oldest file's, with "(merged)" added. Files are written as `<name>-merged.<ext>`. The sport is kept when every file agrees, and the warning says when they differ. Laps are carried and renumbered. A video's camera streams are not carried, and the warning says so.

Formats. GPX and FIT carry a pause correctly. GPX writes one segment per recorded stretch, and the pause is the gap between two segments. FIT stops the timer at the end of each stretch and starts it at the next. TCX is listed but disabled, with the reason.

Two writer changes came out of the review, and both apply to every export, not only merges:

- **GPX now carries a recorded distance.** Each point's distance from the start goes in Cluetrust's GPXDATA extension (`<gpxdata:distance>`), and the GPX parser reads it back as the distance stream. GPX has no field for distance, so before this, a merge of two wheel-sensor recordings read back with distance measured from the positions, which is a different figure.
- **FIT timer time is now the sum of the recorded stretches.** Each stretch counts from start to end, and the gaps between stretches, where the timer events stop it, are left out. It was moving time, and when no moving time could be worked out, elapsed time. So a merge of two recordings that never moved counted its pause as timer time.
- **FIT is refused for stretches that meet within one second.** FIT stores time in whole seconds. Once decoded, its records and timer events are separate lists, so a reader can only place a record in a stretch by its time. Where one recording ends in the same whole second the next begins (a zero-length pause, or a sub-second gap), the stretches cannot be told apart in the file. They would read back joined, with the climb and distance between them counted. For such a merge FIT is offered as unavailable, with that reason (`hasStretchesTouchingInFit`), and GPX, which keeps millisecond times and explicit segments, keeps them apart. Rules for assigning records to stretches by event order were tried during review. Each one broke a different case: several records in the shared second, or several stretches meeting in it. So the FIT importer is unchanged.

Reason: a ride saved in two parts is one ride, and a training log should show it as one: one distance, one moving time, and a pause where the rider stopped. The rules above are the ones that keep the totals equal to the sum of the parts, and that never show anything the files did not record.

Fixture. The task names two Garmin Connect rides from 2026-09-24 near Imabari. They are a person's location history, so they are not committed. `src/test/helpers/mergeFixtures.ts` synthesizes copies with the same file names, point counts (5,817 and 10,465), first and last timestamps, single segments, and a stop inside each. The route is an invented curve. The unit tests build the activities directly, because jsdom reads 16,000 points of XML in minutes. The browser test hands the same GPX to the page. The merge is 16,282 points with a 74 min 29 s pause, whichever file is chosen first. Merged on 2026-10-24, the originals gave the same counts and pause. Elapsed time was 7:40:45, and the moving time and distance equal the two rides' own figures, summed.

### TD-061: The Still Image Is an Overlay Template, Laid Out by the Reader, and Says What It Cannot Draw

Decision (`AV-1010`): the overlay page's still image (AV-1009's route image) becomes a layout the reader makes. They can add figures from the activity's summary, its date and free text beside the route, and place each one. The layout is the overlay template of AV-1003, version 2, so the still image and the video overlays share one model, and AV-1011 can open a layout made here (`src/overlay/staticImage.ts`).

- **One model.** The template gains three component types that describe the whole activity rather than a moment of it: `label` (free text), `summary` (distance, average speed or pace, elapsed or moving time) and `date`. A video hides them, with the reason `still_image_only`, because a frame shows a moment. The route is the existing `routeInset`, with an optional `route` setting: line width and padding as shares of the image's shorter side, and markers. Version 1 templates still read; a version 1 reader refuses version 2 rather than half-reading it.
- **One placement model.** Every element is a rectangle in fractions of the frame, as every video component is. A route's rectangle is the box it is fitted into; a text's is the box its words take at the chosen size, measured by the canvas. Moving, nudging (1 % of the frame; 10 % with Shift on the preview) and snapping to the nine edges, corners and centre, 4 % in, are the same arithmetic for every kind. All of them keep the element inside the frame. Type size uses the video figures' base, a share of the frame's width, so a layout scales with the image.
- **Placing needs no pointer.** On the preview, pressing an element selects it, dragging moves it, and pressing elsewhere moves the selected element there. The same can be done from the position fields in percent, the four nudges, the nine snaps and the arrow keys on the focused preview.
- **Figures.** Speed and pace are over moving time where there is one, as the overview leads with (TD-058), and over elapsed time otherwise, captioned "(elapsed)". All are in the reader's units. What the activity lacks is offered in the Add list as disabled, with the reason beside it. An element in a layout opened later that the activity lacks is listed as not drawn, with why. Nothing is ever drawn blank or as `NaN`.
- **Dates.** There are four formats: `2026-09-24`, `24 Sep 2026`, `24/09/2026` and `Thursday 24 September 2026`, each with or without a 24-hour time. Month and weekday names are fixed, not the locale's, so a browser preferring "Sept" does not change the image. The time zone is the reader's, named on the control, or the activity's own. The activity's own is known only when the file states it: an ISO time with an offset in GPX or TCX, or a FIT activity's local time (`metadata.utcOffsetMinutes`, read by the parsers and kept through a merge when the files agree). It is never guessed from the coordinates. When the file states none, the choice is disabled with that reason.
- **Text.** Free text is drawn with the canvas's `fillText`, so markup in it is shown as characters and never read. Control characters other than a line break are removed, and it is kept to four lines and 200 characters. Text is set in the system font; no font is fetched. A text larger than the frame is set smaller to fit, with a note; anything smaller is only moved back inside.
- **Unchanged for a route alone.** The default layout is the route alone, filling the frame, drawn exactly as AV-1009 drew it, and still named `route-overlay-WxH.png`. A test pins the plans as equal. With other elements, the file is `overlay-image-WxH.png`. The route's width stays in pixels while editing, as before, and is saved as a share of the image.
- **Rects stay inside the frame through a save.** Every rect is normalised when it is placed, saved and read (`normalizeRect`): sizes at most the frame, position plus size at most 1, six decimals. The template parser tolerates a millionth of rounding past the edge, and still refuses a rect really outside. A route box under 16 pixels on a side is refused as having no room. It is not drawn larger than its box, and its edges are rounded rather than its size, so a box ending at the frame's edge ends there in pixels.
- **The layout file.** `overlay-layout.json` (kind `opentrack-overlay-layout`, version 1) holds the image size and the template: where each element is, how it is set, and the text typed. It holds nothing of the activity: no place, no time, no figure. Opening one checks the kind, the version, the size and every component, refuses files over 256 KB, and leaves out a video's components and a second route with a warning each.

Reason: the criteria ask for placement that does not depend on dragging, figures and dates that say when they are missing, and one configuration shared with the video overlays. Making the still image a template, instead of a second model, is what lets AV-1011 put these elements on a video's canvas without converting anything.

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
- The library's own inline Web Worker is **disabled** (`useWorker: false`): current Chromium misreads a valid GoPro file through that path (defect 4 below). Extraction therefore streams with backpressure on the main thread — released between chunks — until it can move into an app-owned worker.
- It reports **progress** by byte offset, and accepts a **cancellation token** checked on every chunk.
- `mp4box.onReady` finds the track whose codec is `gpmd`; when there is none it terminates early rather than reading on.
- Only the metadata samples are retained. **Peak memory is proportional to the GPMF payload — a few MB for a long recording — not to the video.**

  **Superseded by TD-038.** The claim above held only for a file whose `moov` precedes its `mdat`. A camera writes the `moov` last, and the large-video simulation `AV-906` asked for showed `mp4box` holding the whole file until it arrived. `gpmf-extract` has been removed; the metadata track is now read from the index with `File.slice`, and the bullets above describe the path that was replaced.

**Four defects in `gpmf-extract`.** The first was found by reading its source, the next two by running it in tests, and the last only by running it in a real browser. Each is summarized below; [`docs/upstream/gpmf-extract-issues.md`](../upstream/gpmf-extract-issues.md) writes them up as a self-contained report, with reproductions and suggested fixes, for anyone who wants to take them upstream:

1. **It never stops reading.** The promise resolves once the samples are collected, but `terminate()` is never called, so a multi-gigabyte file keeps streaming afterwards. Handled by passing a `cancellationToken` and cancelling it in a `finally` — on the success path too, because settling is not what ends the read.
2. **A file it cannot parse hangs forever.** Given bytes that are not an MP4 it neither resolves nor rejects: it reads to the end, recognizes no container, and stops. In a UI that is a progress bar that fills and then waits. Handled by treating the read reaching 100% as the end of what can arrive, and rejecting `no_telemetry_track` after a short grace period. A test proves it: with the guard removed, that case runs until the 60-second timeout.
3. **Its failures are untyped and undocumented.** A container without a `gpmd` track throws `TypeError: Cannot read properties of undefined (reading 'duration')`, not the documented `'Track not found'`. Everything it throws is mapped to an `ActivityError` — `no_telemetry_track`, `extraction_cancelled` or `gopro_extract_failed` — so a caller never matches on prose.
4. **Its Web Worker is broken in current Chromium.** With `useWorker: true` a valid HERO8 clip reports `'Track not found'`; with it off, the same file reads correctly. The library's README hedges that the worker "seems to crash on some recent browsers", and a browser test caught it doing so — jsdom could never have, since it has no `Worker` and silently took the other path. The worker is therefore **disabled**. The read is still chunked through a stream, so the main thread is released between chunks, and `AV-903`'s API is async precisely so the whole extraction can move into a worker of our own later.

**Bundle.** ~81 KB gzipped for the whole path — `mp4box` 54 KB, `gopro-telemetry` 18 KB, `gpmf-extract` and `binary-parser` the rest. Comparable to the FIT parser's 61 KB, and loaded on demand behind the tool page, so nobody who never opens a video pays for it.

**First supported scope.** MP4/MOV carrying a `gpmd` track from HERO5 onward: `GPS5` or `GPS9` into `lat`, `lon`, `elevationMeters`, `time` and `speedMetersPerSecond`. A file with no `gpmd` track is reported as unsupported with a typed error, never half-parsed. The streams beside the route — the IMU, the orientation quaternions, the exposure and colour metadata — are `AV-905`'s, and `TD-034` records what became of them.

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
| Do standalone KML `Point` placemarks become waypoints? | No, not yet. They are counted and reported in one warning; a waypoint model invented for KML alone would be a format-specific branch. See TD-037. |
| Which KML features are lost on conversion, and how is the reader told? | Polygons, overlays, models, tours and network links in one `warning`; styles and external links in `info` notes; points in a warning of their own. Each exporter's own requirement decides what can be written (TD-037). |
| Which overlay-only export format ships first? | A PNG sequence everywhere, and a transparent VP9 WebM where a probe shows `MediaRecorder` keeps alpha — the Chromium family does, WebKit does not, and WebCodecs never does. No chroma-key video (TD-039). |
| Is burned-in browser-side video export viable? | Yes, measured: WebCodecs decodes the HERO8 clip at over 700 fps and the decode-composite-encode chain runs at 7–11× real time with hardware H.264, in Chromium, Brave and WebKit alike. Second phase, desktop only, audio copied through, 10-bit HEVC still to be checked (TD-039). |
| Should overlay configuration be exported as project JSON? | Yes — it is the serialisation `AV-1003` needs for its own tests, so it ships with the template model rather than as an export mode (TD-039). |
| Which label for the viewer action that opens Route Builder? | **Create custom track**, the task's own phrase in the app's sentence case. Not *Plan route from activity*: a planner promises routing, which this does not do (TD-050). |
| Manual straight-line editing only, or road snapping through a routing provider? | Manual and straight-line, by design rather than deferral: snapping needs a network routing service the privacy model has no room for, and a planned track for a device is a sequence of places. Points are pressed or typed, never dragged (TD-051). |
| Undo/redo in the first milestone, or only confirmation for a section discard? | Undo, for every edit, fifty deep; no confirmation dialogs and no redo. A dialog interrupts every discard to catch the rare slip and is answered by reflex; an undo costs nothing until it is needed, and a redo stack buys little for what it costs to explain (TD-052). |
| Timestamps in planned-track exports: keep, synthesize, or omit? | Omit. A plan says where to go, not when; kept times would make a device read it as a ride already done, and synthesized ones would be invented. FIT and TCX, which need times, are listed as unavailable with that reason (TD-054). |
| Far-apart appended tracks: a visible straight join, separate segments, or a confirmed join? | Separate stretches, joined on request: an appended track starts its own, the map draws no line nobody drew, and the selected point offers *Join to the point before* or *Start a new stretch here* (TD-052). |
| Overlapping recordings in a merge: interleave, trim, or refuse? | Refuse, naming both files and the overlap. Two recordings cannot both be the ride at the same moment; interleaving draws a zigzag between devices and trimming drops a stretch silently. A file starting the second the last one ends is a zero-length pause (TD-060). |

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
- What first overlay templates are most useful for activity videos: compact HUD, route/map inset, metric strip, gauge dashboard, or sport-specific presets?
