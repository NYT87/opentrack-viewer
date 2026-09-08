# Engineering Tasks

## 11. Epics and Tasks

Task IDs are intentionally granular so multiple engineers can work independently.

### Epic E0: Project Setup

#### AV-001: Scaffold Vite React TypeScript App

Dependencies: none

Acceptance criteria:
- App starts in development mode.
- Production build succeeds.
- TypeScript strict mode is enabled or explicitly planned.
- Basic app shell renders without sample data.

#### AV-002: Establish Code Quality Baseline

Dependencies: AV-001

Acceptance criteria:
- `npm test` or equivalent runs unit tests.
- `npm run typecheck` validates TypeScript.
- `npm run lint` exists, even if rules are minimal initially.
- CI-ready commands are documented in README.

#### AV-003: Add Minimal App Layout

Dependencies: AV-001

Acceptance criteria:
- App has a homepage/main page for project description.
- App has a viewer/process page for local file upload and activity processing.
- App has a Terms and Conditions page for legal and usage terms.
- Homepage has a clear action to open the viewer/process page.
- Viewer/process initial state has a local file upload button and/or drop/select area.
- Viewer/process initial state may show external/static supporting information that currently belongs outside the loaded viewer.
- Viewer/process initial state does not render the map area.
- Viewer/process initial state does not render summary, chart, or activity metadata panels.
- Empty viewer/process state does not imply file upload or cloud processing.
- Layout has a clear place for processing and error feedback near the upload control.

#### AV-006: Implement Homepage and Viewer Routes

Dependencies: AV-003

Acceptance criteria:
- `/` or equivalent hash route renders the homepage/main page.
- `/viewer` or equivalent hash route renders the activity viewer/process page.
- `/terms` or equivalent hash route renders the Terms and Conditions page.
- Unknown routes fall back to a useful page instead of a blank screen.
- Homepage describes the project, privacy model, and supported/planned formats.
- Homepage links to Terms and Conditions.
- Homepage does not own or display loaded activity state.
- Viewer/process page owns file selection, parsing, map, details, charts, focused ranges, and export controls.
- Header/navigation lets users reach the viewer/process page from the homepage.

#### AV-008: Add Terms and Conditions Page

Dependencies: AV-006

Acceptance criteria:
- Terms and Conditions is implemented as a routed informational page, not a modal.
- Page has a stable route such as `/terms` or static-hosting-safe equivalent.
- Page is reachable from the homepage and footer/global legal links.
- Page does not mount file upload, map, chart, or activity-processing components.
- Page content covers browser-only activity processing, no backend upload, map tile/provider caveat, no warranty, no medical/training advice, user responsibility for files, and supported format limitations.
- Page clearly marks draft/legal-review-needed content until final legal copy is approved.
- Opening Terms and Conditions does not clear in-memory activity state unless the user intentionally leaves/reloads the app.
- Tests cover route rendering and navigation links.

#### AV-004: Implement App Layout State Gating

Dependencies: AV-003, AV-006

Acceptance criteria:
- App has explicit empty, reading/processing, error, and ready states.
- Map, chart, summary, and metadata components mount only in the ready state.
- Failed parsing keeps the user in upload/error layout and does not reveal the viewer layout.
- Successful parsing transitions to the viewer layout.
- Loading/progress feedback appears near the upload control while processing.
- User can select another file from both upload/error and ready states.

#### AV-005: Implement Ready Viewer Responsive Layout

Dependencies: AV-004

Acceptance criteria:
- After successful processing, ready viewer content is constrained to a readable maximum width.
- Main viewer content renders the activity data overview first.
- Main viewer content renders the map in its own section/box below the overview.
- Charts render below the map/laps area, not beside the overview.
- Layout does not render the map in empty, processing, or error states.
- Text and map controls do not overlap at supported viewport sizes.

#### AV-011: Add Loaded Viewer Section Sidebar and Boxed Flow

Dependencies: AV-004, AV-005, AV-010

Acceptance criteria:
- Loaded viewer uses a centered max-width content container.
- Large-screen layout includes a compact left sidebar with in-page links to major sections such as Overview, Map, Laps when available, and Charts.
- Sidebar links scroll or jump within the current viewer page without reloading, navigating away, or clearing loaded activity state.
- Sidebar is hidden on medium, small, and mobile screens.
- Main content order is activity data overview box, map box, then chart section.
- Activity overview is a first-class content box for existing summary/device/activity metadata; it does not copy unrelated content from reference screenshots.
- Map has its own content box and remains large enough to inspect the route.
- Charts remain below the map/laps section.
- Responsive layout avoids overlapping text, sidebar links, map controls, laps content, and chart controls.
- Tests cover large-screen sidebar visibility, small-screen sidebar absence, section-link behavior, max-width content container, and content order.

#### AV-007: Convert Settings Page to Modal

Dependencies: AV-006

Acceptance criteria:
- Settings is opened as a modal dialog, not a routed page.
- Opening settings does not change the current route.
- Opening settings does not unmount the viewer/process page.
- Opening settings does not clear the loaded `Activity`, focused range, chart x-axis choice, basemap setting, or unit setting.
- Settings entry is available from the global header on every page, including the homepage, viewer/process page, Terms and Conditions page, and future tool pages.
- Modal has accessible dialog semantics, keyboard close behavior, focus trapping, and focus return to the opener.
- Existing settings controls continue to be session-scoped and are not written to disk. *(Superseded for the theme alone by the §17 answer in `06-decisions-and-open-questions.md`: the theme is remembered between visits. Every other setting is still session-scoped.)*

#### AV-009: Add Theme Mode Setting

Dependencies: AV-007

Acceptance criteria:
- Settings modal offers exactly three theme options: system, dark, and light.
- Default theme mode is system.
- System mode follows OS/browser `prefers-color-scheme` when available.
- If system preference cannot be detected, system mode resolves to light.
- Explicit dark mode forces dark theme regardless of system preference.
- Explicit light mode forces light theme regardless of system preference.
- Theme applies globally across homepage, viewer/process page, Terms and Conditions page, and Settings modal.
- Theme changes apply immediately without page reload, route change, file reprocessing, or clearing loaded activity state.
- Theme choice is session-scoped unless a later persistence task explicitly changes that behavior. *(The §17 answer did: it now persists under `opentrack-viewer:theme`.)*
- UI exposes the control as a clear single-choice option set, not independent toggles.

#### AV-010: Refactor Header Navigation and Settings Icon

Dependencies: AV-006, AV-007

Acceptance criteria:
- Header left brand/title text displays `OpenTrack Viewer` and links to the homepage route.
- Header no longer renders the descriptive subtitle/tagline under the brand/title.
- Header no longer renders a separate Home button/nav item when the brand/title link is present.
- Viewer/process and Terms and Conditions navigation remains reachable without relying on a duplicate Home button.
- Settings entry is rendered as an icon-only button/control on the right side of the global header on every page.
- Settings icon button has accessible name `Settings`, keyboard support, visible focus state, and tooltip/title or equivalent affordance.
- Settings icon opens the settings modal without route navigation.
- Opening or closing the settings modal from the icon does not clear loaded activity, focused chart range, x-axis mode, unit setting, basemap setting, or theme setting.
- Header layout remains compact and responsive across desktop and mobile widths.
- Tests cover brand-link navigation, absence of duplicate Home button, absence of header subtitle, Settings icon visibility on every route, and settings icon modal behavior.

#### AV-012: Move Viewer Navigation Into Tools Dropdown

Dependencies: AV-006, AV-010

Acceptance criteria:
- Header renders a `Tools` dropdown beside the `OpenTrack Viewer` title on the left side.
- `Tools` dropdown contains a `File viewer` option.
- Selecting `File viewer` routes to the existing viewer/process page.
- Dropdown implementation supports future tool entries without layout churn, including GoPro video telemetry extraction when `AV-907` lands.
- The current top-level `Viewer` button/link is removed when `File viewer` exists in the `Tools` dropdown.
- Dropdown opening and closing does not clear loaded activity state, focused chart range, x-axis mode, unit setting, basemap setting, theme setting, or settings modal state.
- Dropdown has accessible button/menu semantics, keyboard support, Escape close behavior, outside-click close behavior, and visible focus styles.
- Active/current state is clear when the user is already on the viewer/process page.
- Dropdown remains usable on small screens without overlapping the title, settings icon, or page content.
- Tests cover dropdown rendering beside the title, opening/closing behavior, `File viewer` routing, removal of the standalone `Viewer` button, and keyboard accessibility.

#### AV-013: Implement Privacy-Safe SEO Metadata

Dependencies: AV-006, AV-008

Acceptance criteria:
- `index.html` includes a strong default title and meta description for OpenTrack Viewer.
- Homepage sets route-specific title and description for a browser-only GPX/FIT/TCX activity file viewer.
- Viewer/process page sets route-specific title and description for the generic file viewer, not the currently loaded activity.
- Terms and Conditions page sets route-specific title and description for legal and usage terms.
- Open Graph tags include title, description, type, URL, and preview image when available.
- Twitter/X card tags include title, description, card type, and preview image when available.
- Canonical URL handling is documented and implemented once the production deployment URL is known.
- Static `robots.txt` and `sitemap.xml` are added when the public deployment URL is known, or the task explicitly documents the placeholder/deployment dependency.
- SEO metadata never includes user file names, route coordinates, timestamps, device identifiers, athlete metadata, sensor values, or derived activity stats.
- Metadata updates on route changes without page reload.
- Tests verify route titles/descriptions and confirm loaded activity data is not written into SEO tags.

### Epic E1: Domain Model and File Intake

#### AV-101: Define Activity Domain Types

Dependencies: AV-001

Acceptance criteria:
- `Activity`, `ActivityPoint`, metadata, stream flags, warnings, and derived stats types exist.
- Types support GPX route data and future FIT sensor streams.
- UI imports domain types from a stable module.

#### AV-102: Implement File Intake Component

Dependencies: AV-003

Acceptance criteria:
- User can select a local file.
- User can drag/drop a local file.
- Component rejects unsupported files with clear UI feedback.
- Component does not upload files or create network requests.

#### AV-103: Implement Format Detection

Dependencies: AV-101, AV-102

Acceptance criteria:
- `.gpx` files are detected by extension and XML root.
- Unknown files produce a typed error.
- Detection API is async so FIT signature/header checks can be added later.

### Epic E2: GPX Parsing

#### AV-201: Implement Basic GPX Parser

Dependencies: AV-101, AV-103

Acceptance criteria:
- Parses GPX XML in the browser.
- Extracts `trk/trkseg/trkpt` latitude, longitude, elevation, and time.
- Returns normalized `Activity`.
- Emits warnings for missing optional fields.

#### AV-202: Support GPX Metadata

Dependencies: AV-201

Acceptance criteria:
- Extracts activity name when available.
- Extracts creator/device hints where available.
- Sets source format to `gpx`.
- Populates `ActivityMetadata.device` when GPX creator or extensions expose useful device information.
- Does not require device information for successful GPX parsing.

#### AV-203: Add GPX Parser Fixtures

Dependencies: AV-201

Acceptance criteria:
- Includes simple valid GPX fixture.
- Includes GPX with elevation.
- Includes malformed GPX.
- Unit tests cover parser success and failure paths.

### Epic E3: GeoJSON and Map Rendering

#### AV-301: Convert Activity to GeoJSON

Dependencies: AV-101, AV-201

Acceptance criteria:
- Converts points with valid `lat/lon` into a LineString feature.
- Skips invalid points safely.
- Returns useful empty result for activities without location.
- Unit tests cover normal and partial data.

#### AV-302: Add MapLibre Map Component

Dependencies: AV-003

Acceptance criteria:
- MapLibre map initializes in the browser.
- Map style is configurable.
- Component accepts GeoJSON route data.
- Route line renders when data is present.

#### AV-303: Fit Map Bounds to Route

Dependencies: AV-301, AV-302

Acceptance criteria:
- Map fits route bounds after GPX load.
- Single-point or very small routes do not crash.
- Empty/invalid routes show a clear non-blocking state.

#### AV-304: First Vertical Slice Integration

Dependencies: AV-004, AV-005, AV-006, AV-007, AV-102, AV-103, AV-201, AV-301, AV-302, AV-303

Acceptance criteria:
- User can drag/drop a GPX file.
- App parses it locally.
- App normalizes it into `Activity`.
- App converts it to GeoJSON.
- Viewer layout appears only after parsing and validation succeed.
- First viewer section uses the requested details/map layout.
- Route appears on MapLibre without page reload after successful processing.
- Invalid or unsupported files keep the map hidden.
- No activity file upload occurs.

### Epic E4: Summary Stats

#### AV-401: Implement Distance Calculation

Dependencies: AV-101, AV-201

Acceptance criteria:
- Calculates route distance from GPS coordinates using haversine or equivalent geodesic approximation.
- Uses source distance when reliable and documented, otherwise derives it.
- Handles missing/invalid coordinates.
- Unit tests cover known-distance fixtures.

#### AV-402: Implement Duration and Time Bounds

Dependencies: AV-101, AV-201

Acceptance criteria:
- Calculates start time, end time, primary time, moving time when reliable, and elapsed duration from points/source data.
- Handles missing or duplicate timestamps.
- Does not crash on unordered timestamps; emits warning or normalizes intentionally.
- Keeps `Time`, `Moving Time`, and `Elapsed Time` as separate display values even when some values are unavailable or initially equal.

#### AV-403: Implement Elevation Gain/Loss

Dependencies: AV-101, AV-201

Acceptance criteria:
- Calculates elevation gain and loss.
- Ignores missing elevation values.
- Applies a small noise threshold or documents why raw delta is used initially.
- Unit tests cover climbs, descents, and flat routes.

#### AV-404: Render Summary Panel

Dependencies: AV-401, AV-402, AV-403

Acceptance criteria:
- Shows Distance, Time, Moving Time, Elapsed Time, start/end, and elevation gain.
- Clearly indicates missing values.
- Displays units consistently.
- Does not expose raw parser internals.
- Uses the reference-style grouping for first-stage details: Distance section, then Timing section with the three timing values.

#### AV-405: Render Optional Device Information

Dependencies: AV-101, AV-202

Acceptance criteria:
- UI displays device information when `ActivityMetadata.device` has at least one user-friendly field.
- Display prioritizes manufacturer, model/name, and software or firmware version.
- Missing device information does not show an error.
- Sensitive stable identifiers, including serial number, are hidden by default.
- Device information display works independently from source format.

#### AV-406: Render Activity Laps

Dependencies: AV-101, AV-005, AV-011

Acceptance criteria:
- UI displays laps when `Activity.laps` contains useful lap entries.
- Laps panel includes lap index/name when available, distance, duration, and other normalized lap metrics that exist without inventing missing values.
- Laps panel is hidden when no lap data exists.
- On large screens, laps display on the left side of the map within the map section.
- On medium, small, and mobile screens, laps display after the map.
- Long lap lists remain usable through scrolling or compact rows without shrinking the map into an unusable size.
- Selecting or hovering a lap may be deferred, but the display structure must not block future lap-to-map/chart highlighting.
- Tests cover lap-present, lap-missing, large-screen placement, and mobile placement states.

#### AV-407: Render Sport-Specific Primary Overview Metric

Dependencies: AV-401, AV-402, AV-404

Acceptance criteria:
- Running activities display Average Pace in the activity overview when distance and usable duration are available.
- Running activities do not display Average Speed as the primary overview performance metric when Average Pace can be calculated.
- Cycling activities display Average Speed in the activity overview when distance and usable duration are available.
- Cycling activities do not display Average Pace as the primary overview performance metric when Average Speed can be calculated.
- Average Pace uses duration per distance formatting, such as `min/km` or `min/mi`, according to the active unit system.
- Average Speed uses distance per duration formatting, such as `km/h` or `mph`, according to the active unit system.
- The duration source used for Average Pace and Average Speed is documented and consistent with the overview's primary `Time` value.
- Activities with unknown or unsupported sport fall back to neutral overview stats without inventing a sport-specific primary metric.
- Missing distance or duration shows an unavailable state rather than an incorrect average.
- Tests cover running, cycling, unknown sport, missing distance, missing duration, metric units, and imperial units.

### Epic E5: Chart Panel and Activity Metrics

#### AV-501: Build Chart Series Adapter

Dependencies: AV-101, AV-401, AV-403

Acceptance criteria:
- Converts `ActivityPoint[]` to elevation series.
- Supports x-axis by distance when available.
- Supports x-axis by time when timestamp data is available.
- Returns typed availability metadata when the requested x-axis cannot be built.
- Handles partial elevation data.

#### AV-502: Render Elevation Chart

Dependencies: AV-501

Acceptance criteria:
- Chart renders after GPX load.
- Chart has readable axes or labels.
- Y-axis labels have enough gutter and vertical spacing; labels must not appear pressed against the chart edge or plotted line.
- Chart plot area reserves enough left padding for the widest Y-axis tick label and unit formatting.
- Empty/missing elevation state is handled.
- Chart is responsive.

#### AV-503: Add Chart Tests

Dependencies: AV-502

Acceptance criteria:
- Tests verify chart renders with elevation data.
- Tests verify missing elevation fallback.
- Tests cover distance x-axis behavior.
- Tests cover time x-axis behavior.
- Tests cover disabled or unavailable x-axis states.
- Tests cover Y-axis label layout/gutter so labels are not clipped or visually cramped.
- Tests cover distance tick generation at 1 km intervals.
- Tests cover time tick generation at 5 minute intervals.

#### AV-504: Add Chart X-Axis Switch

Dependencies: AV-501, AV-502

Acceptance criteria:
- Chart panel exposes a switch for `distance` and `time`.
- Selected x-axis mode applies consistently to all visible charts.
- Switch disables or explains unavailable x-axis modes for the loaded activity.
- The default x-axis is distance when cumulative distance is available; otherwise time when timestamps are available.
- Switching x-axis mode does not re-parse the source file.

#### AV-514: Correct Chart Axis Spacing and Tick Marks

Dependencies: AV-501, AV-502, AV-504

Acceptance criteria:
- Y-axis labels are readable and not visually pressed against the chart plot area.
- Chart layout computes or reserves a stable Y-axis label gutter based on the widest rendered label.
- Y-axis labels are not clipped at the top, bottom, or left edge of the chart container.
- Distance x-axis mode generates tick marks at every 1 km interval for metric display.
- Time x-axis mode generates tick marks at every 5 minute interval.
- X-axis tick labels can be thinned or hidden responsively if the viewport is too narrow, but tick generation remains based on 1 km and 5 minute intervals.
- Endpoint labels remain visible when they do not conflict with interval tick labels.
- Axis rendering works in light, dark, and system themes.
- Visual/component regression tests cover the cramped Y-axis case shown in the reference screenshot.

#### AV-505: Build Pace Series for Running Activities

Dependencies: AV-101, AV-401, AV-402, AV-501

Acceptance criteria:
- Pace series is available for activities classified as `running` when distance and time data are sufficient.
- Pace is derived from normalized points, not parser-specific GPX or FIT structures.
- Pace units are consistent with the app unit system, such as min/km or min/mi.
- Implausible or zero-duration intervals are filtered or represented as gaps.
- Non-run activities do not show the pace chart by default.

#### AV-506: Build Cadence Series for Running Activities

Dependencies: AV-101, AV-501

Acceptance criteria:
- Cadence chart is available for run activities when `runningCadenceSpm` is present.
- Cadence chart is hidden or shown as unavailable when cadence data is absent.
- Running cadence labels use strides per minute, not RPM.
- FIT-derived running cadence and GPX-extension running cadence can feed the same chart adapter after parser mapping normalizes them to `runningCadenceSpm`.

#### AV-515: Standardize Running Cadence as Strides Per Minute

Dependencies: AV-101, AV-506

Acceptance criteria:
- Domain model uses a running-specific cadence field such as `runningCadenceSpm` instead of `cadenceRpm` for running activities.
- Existing parser mappings that represent running cadence populate `runningCadenceSpm`.
- Running cadence chart label and axis unit display `strides/min`, `spm`, or an agreed equivalent, never `rpm`.
- Code and tests avoid generic `cadenceRpm` naming for running cadence.
- If future cycling cadence is added, it uses a separate cycling-specific field such as `cyclingCadenceRpm`.
- Fixtures or synthetic activities cover running cadence display in strides per minute.
- Documentation and user-facing copy consistently describe running cadence as strides per minute.

#### AV-507: Add Chart Availability Rules

Dependencies: AV-101, AV-501, AV-505, AV-506, AV-513, AV-515

Acceptance criteria:
- A central chart availability function returns which chart kinds are available for the current activity.
- Elevation availability depends on elevation data.
- Pace availability depends on running sport plus usable time/distance data.
- Cadence availability depends on running sport plus `runningCadenceSpm` data.
- Speed availability depends on cycling sport plus usable speed or time/distance data.
- Cycling activities do not show running pace/cadence charts by default.
- The UI does not hard-code source format checks for chart visibility.

#### AV-513: Build Speed Series for Cycling Activities

Dependencies: AV-101, AV-401, AV-402, AV-501

Acceptance criteria:
- Speed series is available for activities classified as `cycling` when speed data or sufficient distance/time data exists.
- Speed is derived from normalized points, not parser-specific GPX or FIT structures.
- Source `speedMetersPerSecond` is used when available and reliable; otherwise speed can be derived from distance/time intervals.
- Speed units are consistent with the app unit system, such as km/h or mph.
- Implausible or zero-duration intervals are filtered or represented as gaps.
- Running activities do not show the cycling speed chart by default.

#### AV-508: Add Chart Range Selection Gesture

Dependencies: AV-502, AV-504

Acceptance criteria:
- User can press on a chart, drag horizontally, and release to select a range.
- Selection works with both distance and time x-axis modes.
- Very small drags are treated as clicks or ignored, not accidental zooms.
- Reverse drags normalize start/end correctly.
- The selected range is visually indicated before release and after selection.
- Touch and pointer events are considered so the interaction can work on tablets and phones later.

#### AV-509: Map Chart Range to Activity Point Range

Dependencies: AV-501, AV-508

Acceptance criteria:
- Selected chart x-axis domain maps to `ActivityPointRange`.
- Mapping works for distance x-axis.
- Mapping works for time x-axis.
- Missing distance/time points are handled through nearest valid point lookup or a documented fallback.
- Unit tests cover normal, reversed, partial-data, and out-of-bounds selections.

#### AV-510: Derive Focused Activity Slice

Dependencies: AV-101, AV-509

Acceptance criteria:
- A focused activity view can be derived from the original `Activity` and selected point range.
- Original activity object is not mutated.
- Focused points are reindexed or retain original indexes according to a documented decision.
- Derived stats for the focused range can be recalculated without overwriting full-activity stats.
- Empty or invalid ranges return a typed error or no-op state.

#### AV-511: Redraw Charts for Selected Range

Dependencies: AV-510, AV-502, AV-504, AV-507

Acceptance criteria:
- When a range is selected, visible charts render only the selected activity section.
- X-axis labels and extents update to the focused range.
- Pace/cadence/speed/elevation availability is recalculated for the focused range.
- User can clear the selected range and restore the full chart through Reset View.
- The UI makes the focused range state clear without implying the original file was edited.

#### AV-512: Add Reset View Control

Dependencies: AV-510, AV-511

Acceptance criteria:
- A Reset View button is visible when the UI is focused on a selected chart range.
- Clicking Reset View clears `ActivityFocusState.selectedRange`.
- Clicking Reset View restores all visible charts to the full activity data.
- Clicking Reset View restores full-activity summary stats.
- The button is hidden or disabled when the app is already showing the full activity.
- The button label is consistent and uses the exact user-facing text `Reset View`.

### Epic E5.5: Stage 3 Client-Side Export

#### AV-550: Define Exporter Registry

Dependencies: AV-101, AV-510

Acceptance criteria:
- Export registry exposes supported output formats from normalized `Activity` data.
- Export API accepts either full activity or selected focused range.
- Export API returns a `Blob`, file name, MIME type, and warnings.
- Exporters do not read from or upload to any backend.
- Unsupported export formats return typed errors.

#### AV-551: Export Activity to GPX

Dependencies: AV-550, AV-201, AV-401, AV-402, AV-403

Acceptance criteria:
- Browser can export a normalized activity to a `.gpx` file.
- Exported GPX includes track points with latitude, longitude, elevation, and time when available.
- Exported GPX includes safe metadata such as name and creator when appropriate.
- Exporting a selected range writes only the selected activity section.
- Exported GPX can be re-imported by the app and render the same route shape.
- Export warnings identify normalized fields that GPX cannot represent cleanly.

#### AV-552: Evaluate FIT Export Strategy

Dependencies: AV-550, AV-701

Acceptance criteria:
- Decision records whether FIT export will be implemented with a browser-compatible library, a small internal encoder, or deferred.
- License, bundle size, browser compatibility, and correctness risks are documented.
- Minimal supported FIT export profile is defined before implementation.
- FIT export scope does not block GPX export.

#### AV-553: Export Activity to FIT

Dependencies: AV-550, AV-552

Acceptance criteria:
- Browser can export a normalized activity to a `.fit` file if AV-552 confirms a viable strategy.
- Exported FIT supports the agreed minimal profile, including records for time, location, distance, elevation, and available core sensors.
- Exporting a selected range writes only the selected activity section.
- Exported FIT can be parsed by the app or a known FIT validator.
- Export warnings identify fields that are omitted or approximated.
- If FIT export is not viable in the chosen stage, the task produces a documented deferral and a UI-disabled state rather than a broken export option.

#### AV-554: Add Export Controls

Dependencies: AV-550, AV-551

Acceptance criteria:
- Ready viewer layout includes export controls only after a valid activity is loaded.
- User can choose supported export format.
- If a chart range is selected, user can choose full activity or selected section export.
- Export controls show warnings before or after download when data loss is expected.
- Export controls are absent from empty, processing, and error layouts.

#### AV-555: Add Direct Format Conversion

Dependencies: AV-550, AV-551, AV-553, AV-554

Acceptance criteria:
- After a user opens any supported input format, the ready viewer offers download/export options for the other supported output formats available in the exporter registry.
- Conversion is implemented as `input file -> parser -> normalized Activity -> selected exporter`; it does not use parser-specific source-to-target shortcuts.
- The source format is not shown as the primary conversion target unless the UI labels it as a same-format rewrite/export.
- Conversion works for full activity export and for selected chart-range export when a selected range is active.
- Conversion warnings identify target-format limitations, omitted fields, approximations, and privacy removals such as device serial numbers.
- Conversion downloads through browser `Blob`/object URL APIs only and never uploads the source file, normalized activity, or converted file.
- Unsupported or unavailable target formats are hidden or disabled with a typed reason, not shown as broken controls.
- Round-trip tests cover at least GPX-to-FIT and FIT-to-GPX once both exporters are available.

### Epic E6: Map and Chart Synchronization

#### AV-601: Define Interaction State

Dependencies: AV-302, AV-502, AV-504, AV-508

Acceptance criteria:
- Shared state can represent hovered point index and selected point index.
- Shared state records the active chart kind and active x-axis mode when needed.
- Shared state can represent selected point range and whether the UI is showing the full activity or selected range.
- State is independent from parser format.
- State reset behavior is defined when a new file is loaded.

#### AV-602: Chart Hover Highlights Map

Dependencies: AV-601

Acceptance criteria:
- Hovering chart updates active point index.
- Map displays active point marker.
- Marker position is stable and performant.

#### AV-603: Map Interaction Highlights Chart

Dependencies: AV-601

Acceptance criteria:
- Hovering or clicking route/point updates active index.
- Chart displays corresponding active point.
- Interaction remains usable for dense tracks.

#### AV-604: Selected Chart Range Focuses Map

Dependencies: AV-303, AV-509, AV-510, AV-511, AV-512

Acceptance criteria:
- Selecting a chart range updates the map route to emphasize or display only that route section.
- Map fits bounds to the selected route section.
- If the selected section has insufficient location data, the map shows a clear non-blocking message.
- Reset View restores the full route and full bounds behavior.
- Selection state stays consistent when switching chart x-axis between distance and time.

#### AV-605: Focused Range Summary Stats

Dependencies: AV-404, AV-510, AV-512

Acceptance criteria:
- Summary stats can indicate whether values describe the full activity or selected range.
- Focused range stats include distance, duration, elevation gain, and start/end for the selected section when available.
- Reset View restores full-activity summary stats.
- Missing values in the selected range use the same display conventions as full-activity missing values.

### Epic E7: FIT Support

#### AV-701: Select FIT Parsing Library or Strategy

Dependencies: AV-101

Acceptance criteria:
- Decision recorded with tradeoffs.
- Browser compatibility verified.
- Bundle-size impact estimated.
- License is acceptable.

#### AV-702: Implement FIT Parser Adapter

Dependencies: AV-701

Acceptance criteria:
- Reads `.fit` files as `ArrayBuffer`.
- Extracts records into normalized `ActivityPoint[]`.
- Supports time, lat/lon, elevation, distance, HR, cadence, and power when available.
- Extracts device information from FIT metadata messages when available.
- Avoids displaying or logging sensitive stable identifiers by default.
- Emits warnings for unsupported FIT messages.

#### AV-703: FIT Fixtures and Tests

Dependencies: AV-702

Acceptance criteria:
- Includes at least one GPS FIT fixture.
- Includes at least one non-GPS FIT fixture if available.
- Unit tests confirm normalized output feeds existing stats/map/chart adapters.

#### AV-704: Sensor Summary and Chart Extensions

Dependencies: AV-702, AV-502, AV-507

Acceptance criteria:
- HR/cadence/power availability is detected.
- UI can show sensor summaries when data exists.
- Chart architecture can add additional series without rewriting GPX logic.
- FIT cadence feeds the same cadence chart used by GPX extensions or future parser inputs.

### Epic E7.5: Stage 4 TCX Import and Export

#### AV-750: Define TCX Scope and Mapping

Dependencies: AV-101, AV-550

Acceptance criteria:
- TCX import/export field mapping is documented against the normalized `Activity` model.
- Mapping covers activity sport, laps, track points, time, position, altitude, distance, heart rate, cadence, and calories when available.
- Known TCX limitations and data-loss cases are documented.
- TCX support remains browser-only.

#### AV-751: Import TCX Files

Dependencies: AV-750, AV-103

Acceptance criteria:
- `.tcx` files are detected by extension and XML root.
- Browser parses TCX without backend processing.
- TCX activities normalize into `Activity`.
- TCX route data feeds existing map, stats, chart, and focus-range flows.
- Parser tests cover valid TCX, missing optional data, and malformed TCX.

#### AV-752: Export Activity to TCX

Dependencies: AV-750, AV-550

Acceptance criteria:
- Browser can export a normalized activity to `.tcx`.
- Exported TCX includes activity, lap, track point, time, position, altitude, distance, and supported sensor data when available.
- Exporting a selected range writes only the selected activity section with coherent lap/time handling.
- Exported TCX can be re-imported by the app.
- Export warnings identify fields that TCX cannot represent cleanly.

#### AV-753: TCX Fixtures and Round-Trip Tests

Dependencies: AV-751, AV-752

Acceptance criteria:
- Includes at least one TCX fixture with GPS route data.
- Includes at least one TCX fixture with HR or cadence when available.
- Round-trip tests cover import TCX, export TCX, and re-import exported TCX.
- Tests confirm TCX data feeds existing summary, chart, and map adapters.

### Epic E8: PWA and Offline App Shell

#### AV-801: Add Web App Manifest

Dependencies: AV-001

Acceptance criteria:
- App has name, icons, theme color, and display mode.
- Install prompt works where supported.

#### AV-802: Cache App Shell

Dependencies: AV-801, AV-304

Acceptance criteria:
- App shell loads offline after first visit.
- Activity files are not cached automatically.
- Map tile offline behavior is explicitly documented as out of scope.

#### AV-803: Route-Only Offline Mode

Dependencies: AV-302, AV-802

Acceptance criteria:
- If map tiles fail, route can still render on a neutral background.
- User sees a clear map tile/network message.
- No activity data is sent to compensate for tile failure.

### Epic E9: GoPro Video Telemetry

#### AV-901: Evaluate GoPro Telemetry Extraction Strategy

Dependencies: AV-101, AV-304

Acceptance criteria:
- Evaluate `https://github.com/gopro/gpmf-parser` as the authoritative GPMF payload parser reference, including whether compiling to WebAssembly is practical for browser use.
- Evaluate `https://github.com/juanirache/gopro-telemetry` and its raw GPMF extraction dependency path for TypeScript/browser compatibility, bundle size, maintenance, and license fit.
- Evaluate `https://github.com/kmatzen/telemetrik` as a reference implementation or fixture oracle, while noting that pure Python is not a direct browser dependency for this app.
- Document how the browser will locate and read the GoPro metadata track from MP4/MOV without uploading or fully loading unnecessary video bytes into memory.
- Decide the first supported GoPro camera/video scope, expected metadata streams, and unsupported-file behavior.
- Record license, bundle-size, Web Worker, memory, and performance tradeoffs before implementation begins.

#### AV-902: Extend Format Detection for GoPro Video Files

Dependencies: AV-103, AV-901

Acceptance criteria:
- File intake recognizes candidate GoPro MP4/MOV files by extension and container/header sniffing.
- Detection distinguishes generic unsupported video from video that appears to contain GoPro/GPMF telemetry when possible.
- Unsupported video files fail with a clear typed error, not a generic parser crash.
- Detection reads only the minimum bytes needed for identification.
- Existing GPX, FIT, and TCX detection behavior is unchanged.

#### AV-903: Extract Raw GPMF Metadata in the Browser

Dependencies: AV-901, AV-902

Acceptance criteria:
- Browser-side code locates the MP4/MOV metadata track and extracts raw GPMF payloads plus timing information.
- Extraction uses `Blob.slice`, `ArrayBuffer`, streaming/ranged reads, or equivalent browser APIs to avoid loading full multi-GB videos into memory.
- Extraction runs behind an async API that can move to a Web Worker or already runs in a Worker.
- UI receives progress and supports cancellation for large files.
- No video bytes, raw telemetry payloads, file names, or extracted coordinates are uploaded.

#### AV-904: Normalize GoPro GPS Telemetry Into Activity

Dependencies: AV-101, AV-903

Acceptance criteria:
- GPS samples such as `GPS5`/`GPS9` normalize into `ActivityPoint[]` with time, latitude, longitude, altitude, speed, and quality metadata where available.
- GPS quality fields such as fix type and dilution/precision are used to drop or warn about unreliable points.
- Normalized GoPro activities feed existing stats, GeoJSON, MapLibre, chart, focus-range, and export flows without GoPro-specific UI branches.
- Missing GPS produces a useful no-route/unsupported-telemetry message while preserving other detected telemetry where useful.
- Device/camera metadata is parsed only into safe display fields; serial numbers and stable identifiers are not rendered.

#### AV-905: Surface Additional GoPro Telemetry Streams

Dependencies: AV-901, AV-903, AV-904

Acceptance criteria:
- Detects available non-GPS streams such as accelerometer, gyroscope, gravity vector, camera orientation, image orientation, temperature, ISO, shutter speed, white balance, audio level, and highlights when present.
- Defines which streams are displayed in the activity viewer, which are hidden initially, and which are exposed only through export/download.
- High-frequency streams use downsampling or windowing so charts remain responsive.
- Stream labels include units and sample rates when available.
- Unsupported streams are summarized in warnings rather than silently ignored.

#### AV-906: GoPro Telemetry Fixtures and Browser Tests

Dependencies: AV-903, AV-904

Acceptance criteria:
- Includes a small synthetic or redistributable GoPro/GPMF fixture with GPS telemetry.
- Includes at least one fixture or generated payload with missing/unreliable GPS to test warnings.
- Unit tests cover MP4/GPMF extraction, GPS normalization, quality filtering, and safe metadata handling.
- Browser tests confirm a local GoPro video fixture can be opened without upload and mapped through the same viewer pipeline.
- Performance tests or benchmarks cover a large-video simulation without requiring a large committed fixture.

#### AV-907: Add GoPro Video Telemetry Tool Page and Viewer Handoff

Dependencies: AV-012, AV-901, AV-903, AV-904

Acceptance criteria:
- Add a dedicated GoPro/video telemetry extraction route such as `/video-telemetry`; extraction does not happen inside the generic file viewer page.
- Add a `Tools` dropdown option named `Video telemetry`, `GoPro telemetry`, or similar that routes to the extraction page.
- The extraction page owns MP4/MOV file selection, drag/drop if used, extraction progress, cancellation, warnings, and extraction result summary.
- Before extraction succeeds, the page does not render the full activity viewer, map, chart panels, or export controls.
- After extraction succeeds, the page displays a clear button such as `Open in viewer` or `View activity`.
- Selecting that button navigates to the viewer and displays the extracted video telemetry as a loaded `Activity` through the existing viewer UI.
- The handoff uses client-side state only. It must not upload the video, extracted GPMF payloads, coordinates, device metadata, or normalized activity to a backend.
- If the user reloads or opens the viewer without handoff state, the viewer falls back to its normal empty upload state with a useful message if appropriate.
- Tests cover `Tools` routing to the extraction page, successful extraction-page state transition, post-success button visibility, viewer navigation with loaded extracted activity, and reload/empty-state fallback.

### Epic E10: Telemetry Video Overlays

#### AV-1001: Evaluate Browser Overlay and Video Export Strategy

Dependencies: AV-907

Acceptance criteria:
- Evaluate browser APIs and libraries for overlay preview and export, including Canvas/OffscreenCanvas, WebCodecs, MediaRecorder, ffmpeg.wasm, WebGL/WebGPU where useful, and plain frame-sequence export.
- Decide the first supported export modes: overlay-only transparent video, chroma-key video, image sequence, project/config JSON, and/or burned-in video.
- Document browser support, memory requirements, expected export duration limits, codec/container constraints, mobile limitations, and fallback behavior.
- Confirm whether burned-in video export is feasible without server-side transcoding for realistic GoPro clips.
- Record a phased recommendation that implements overlay-only export before burned-in video export unless feasibility results justify doing both together.

#### AV-1002: Add Telemetry Overlay Tool Page

Dependencies: AV-012, AV-907, AV-1001

Acceptance criteria:
- Add a dedicated route such as `/overlays`; overlay generation does not happen inside the generic viewer or extraction page.
- Add a `Tools` dropdown option named `Overlays`, `Telemetry overlays`, or similar that routes to the overlay page.
- Overlay page accepts handoff state from GoPro extraction containing the local video reference where still available, normalized `Activity`, auxiliary telemetry streams, timing metadata, and safe warnings.
- Overlay page also supports selecting a local video and compatible activity/telemetry data manually when handoff state is not available.
- Direct entry or reload without required local state shows a clear empty state and asks the user to select the needed local files again.
- Tests cover routing from `Tools`, handoff entry, reload fallback, and no accidental rendering of viewer-only map/chart panels before overlay data exists.

#### AV-1003: Define Overlay Timeline and Template Model

Dependencies: AV-101, AV-905, AV-1001

Acceptance criteria:
- Define a format-independent overlay timeline model that maps video time to normalized activity points and auxiliary telemetry samples.
- Define reusable overlay component types for text metrics, gauges, route/map inset, progress markers, and sensor charts.
- Template configuration includes component visibility, position, size, unit mode, style tokens, and data-source binding.
- The model supports missing data gracefully; unavailable metrics are hidden or warned instead of rendering broken placeholders.
- Unit tests cover time-to-sample interpolation, missing telemetry, activity/video offset handling, and template serialization.

#### AV-1004: Build Overlay Preview and Synchronization

Dependencies: AV-1002, AV-1003

Acceptance criteria:
- Overlay page previews the local video with a synchronized overlay layer.
- Preview supports play, pause, seek, and timeline scrub while keeping overlay values aligned to the current video time.
- User can adjust an activity/video time offset when telemetry and video are not aligned.
- Overlay rendering is responsive and does not block playback for realistic preview sizes.
- Tests cover seek synchronization, offset adjustment, visible overlay updates, and missing-data states.

#### AV-1005: Implement Overlay Template Controls

Dependencies: AV-1003, AV-1004

Acceptance criteria:
- Provide a small initial template set focused on activity videos: compact HUD, route/map inset, and metric strip.
- Let users enable/disable supported components such as speed/pace, distance, time, elevation, route/map inset, heart rate, cadence, power, and selected sensor gauges when data exists.
- Let users adjust basic layout and visual style controls without needing a full design editor.
- Controls use existing app theme/design conventions and remain usable on desktop and mobile.
- Tests cover template switching, component visibility, style persistence for the session, and unsupported metric warnings.

#### AV-1006: Export Overlay-Only Assets

Dependencies: AV-1001, AV-1003, AV-1004, AV-1005

Acceptance criteria:
- Export overlay-only output without modifying the source video.
- Support at least one editor-friendly output path from the feasibility decision, such as transparent WebM, chroma-key video, or PNG/WebP frame sequence.
- Export respects video duration, frame rate selection, resolution, unit settings, template settings, and selected telemetry offset.
- Export runs locally with progress, cancellation, and clear failure messages for unsupported browsers/codecs.
- No video frames, telemetry, generated overlay frames, or output assets are uploaded.
- Tests cover short fixture export, cancellation, unsupported-browser fallback, and generated output dimensions/duration metadata where practical.

#### AV-1007: Implement Burned-In Video Export When Feasible

Dependencies: AV-1001, AV-1004, AV-1006

Acceptance criteria:
- Implement only if `AV-1001` confirms a browser-side encoding path that is acceptable for target browsers and realistic clip sizes.
- Composite source video frames and overlay frames entirely in the browser.
- Export a downloadable video file with the overlay integrated into the image.
- Provide progress, cancellation, estimated constraints, and clear messages when the video is too large or the browser lacks required APIs/codecs.
- Preserve the original source video file; rendering produces a new user-downloaded file only.
- Tests cover a short fixture render, audio handling decision, cancellation, and no-upload privacy behavior.

#### AV-1008: Overlay Export Fixtures and Regression Tests

Dependencies: AV-1003, AV-1004, AV-1006

Acceptance criteria:
- Add small redistributable or synthetic video/telemetry fixtures suitable for automated overlay tests.
- Add deterministic render tests for overlay components at fixed timestamps.
- Add browser tests for opening the overlay page, previewing overlays, and exporting a short overlay-only asset.
- Add performance checks for longer timeline simulation without committing large videos.
- Add privacy regression tests to ensure no network requests contain video bytes, telemetry samples, rendered frames, file names, or output metadata.
