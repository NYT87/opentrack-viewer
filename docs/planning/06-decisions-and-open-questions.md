# Decisions and Open Questions

## 16. Technical Decisions

### TD-001: Client-Side Only

Decision: Activity files are processed locally in the browser.

Reason: This is the product's core trust and privacy boundary.

### TD-002: Format-Independent Domain Model

Decision: GPX and FIT parsers must output the same `Activity` model.

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
- Should focused range stats appear in the main summary panel, a secondary comparison panel, or both?
- Should selected range map behavior hide the rest of the route, dim the rest of the route, or display only the selected segment?
- What is the minimum drag distance or minimum selected duration/distance before a chart range selection is accepted?
- Should pace be calculated from instantaneous speed when present, or derived from distance/time intervals by default?
- Should average pace/speed use moving time, elapsed time, or the summary's primary `Time` value when all are available?
- What smoothing/window should pace charts use so GPS jitter does not dominate the view?
- What exact label should the running cadence chart use: `strides/min`, `spm`, or full `strides per minute`?
- Should cycling speed prefer source instantaneous speed, derived distance/time, or a smoothed hybrid?
- Should cycling cadence be added later as an optional sensor chart separate from the initial cycling speed chart?
- For Stage 3, is FIT export required as a shipped feature, or is a documented technical feasibility task acceptable before committing to binary FIT encoding?
- What minimal FIT export profile is acceptable for interoperability?
- Should selected-range export preserve original timestamps or normalize timestamps relative to the selected segment start?
- For TCX export, how should selected-range exports handle laps that partially overlap the selected range?
- What smoothing/noise threshold should elevation gain use?
- Which device metadata fields should be shown by default, and should advanced/sensitive fields require an explicit reveal action?
- Should GPX `creator` be displayed as device information, app information, or both when the file does not provide a cleaner device model?
- Which FIT parser library has the best browser compatibility, maintenance state, license, and bundle profile?
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
