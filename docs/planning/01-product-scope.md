# Product Scope

## 1. Purpose

Build a 100% client-side web/PWA activity-file viewer that lets users inspect activity tracking files directly in the browser. The initial product should support GPX route visualization, then grow into FIT support and richer sensor/chart analysis.

The core promise is simple:

> A user can open an activity file from their device, inspect the route and stats in the browser, and trust that the activity file is not uploaded to any backend.

## 2. Product Goals

- Provide a main homepage that describes OpenTrack Viewer, its privacy model, supported/planned formats, and the primary action to open the activity processing page.
- Provide privacy-safe SEO metadata so search and link previews clearly describe the app without exposing user activity data.
- Provide a dedicated viewer/process page where users upload and inspect GPX first, then FIT/TCX and future formats.
- Provide a Terms and Conditions page with stable navigation/linking for legal and usage terms.
- Provide settings as a modal, not a separate page, so opening settings does not navigate away from or clear loaded activity data.
- Provide theme settings with three options: system, dark, and light.
- Default theme mode is system; if system preference cannot be detected, fall back to light.
- Use the header brand/title as the link back to the homepage.
- Do not show a separate Home button/nav item when the header brand already links home.
- Keep global header chrome compact; do not show a descriptive subtitle/tagline in the header.
- Move the viewer navigation entry into a `Tools` dropdown placed beside the title on the left side of the header.
- The `Tools` dropdown should include a `File viewer` option that links to the current viewer/process page.
- Show the settings entry in the header on non-home pages, including the viewer/process page; the main homepage should not show the settings entry.
- Show Settings as an icon-only header control on non-home pages, with an accessible name and visible focus state.
- Load local activity files through file picker and drag/drop.
- Before an activity is loaded, show only the file upload action and any supporting external/static information that belongs outside the viewer.
- Hide the map, charts, summary stats, and activity metadata until a file has been read, parsed, validated, and normalized successfully.
- Parse GPX first.
- Normalize parsed data into a format-independent `Activity` domain model.
- Convert normalized route points into GeoJSON.
- Render the route on a MapLibre GL JS map.
- In the loaded-activity view, constrain the main content to a readable maximum width.
- On large screens, provide a small left sidebar with links to major viewer sections such as overview, map, laps when available, and charts.
- Hide the left sidebar on medium, small, and mobile screens.
- In the main viewer content, render an activity data overview box first.
- Render the map in its own box below the overview.
- Render charts below the map box.
- Display activity laps when the normalized activity includes laps.
- On large screens, display laps on the left side of the map.
- On medium, small, and mobile screens, display laps after the map.
- Calculate and display core summary stats:
  - distance
  - duration
  - moving time
  - elapsed time
  - start time
  - end time
  - elevation gain
- In the activity overview, show average pace as the primary performance metric for running activities.
- In the activity overview, show average speed as the primary performance metric for cycling activities.
- Do not show average speed as the primary running metric when average pace can be calculated.
- Display device information when the file provides it and when it can be shown without exposing sensitive identifiers unnecessarily.
- Add an elevation chart after the map slice is working.
- Let users switch chart x-axis mode between distance and time.
- Render chart axes with readable spacing so Y-axis labels are not cramped and X-axis tick marks provide useful orientation.
- On distance-based charts, show X-axis tick marks every 1 km where layout space permits.
- On time-based charts, show X-axis tick marks every 5 minutes where layout space permits.
- For run activities, add pace and cadence charts when the normalized activity has enough data.
- Running cadence must be displayed as strides per minute, not revolutions per minute.
- For cycling activities, add a speed chart instead of the running-oriented pace/cadence chart set.
- Let users select a range directly on a chart by click-drag-release.
- When a chart range is selected, focus charts and map on only that activity section while preserving the original full activity in memory.
- Provide a Reset View button that clears the selected section and restores the full activity view across charts, map, and summary stats.
- Synchronize map hover/selection with chart hover/selection.
- In Stage 3, export the current activity or selected/focused activity section to GPX and FIT where technically feasible.
- In Stage 4, support TCX files for both import and export.
- Add FIT support after the GPX vertical slice validates the domain model and UI contract.
- Keep all activity-file parsing, normalization, calculations, and privacy-sensitive processing in the browser.
- Make the app installable as a PWA once the first useful viewer experience exists.

## 3. Non-Goals

- No backend upload or server-side activity processing.
- No user accounts.
- No cloud sync.
- No social sharing.
- No activity history database.
- No Strava/Garmin/Apple Health integrations in the initial scope.
- No AI analysis in the initial scope.
- No offline map tile support in the initial scope.
- No editing/exporting activity files in the first vertical slice.
- No export workflow before the viewer has a stable normalized activity model and chart/map focus behavior.
- No attempt to support every activity format before GPX is solid.
- No standalone settings page in the target navigation model.
- No file upload controls on the homepage beyond navigation to the viewer/process page.
- No assumption that draft Terms and Conditions copy is production-legal without review.
- No SEO, analytics, or preview metadata that includes user file names, route coordinates, timestamps, device identifiers, athlete metadata, or activity-derived values.

## 5. Privacy and Security Constraints

### Hard Constraints

- Activity files must never be uploaded to an application backend.
- Parsing must happen locally using browser APIs such as `File`, `Blob`, `FileReader`, `ArrayBuffer`, and `DOMParser`.
- The app must not log raw file contents.
- The app must not send route coordinates, timestamps, device IDs, athlete metadata, or sensor streams to analytics services.
- Device serial numbers, product IDs, and other stable identifiers should be treated as sensitive metadata and hidden by default unless there is a clear user-facing reason to expose them.
- Error reporting, if added later, must be opt-in or scrubbed of activity data.

### External Map Tiles

Initial MapLibre usage may fetch external map tiles. This means tile providers may receive tile requests that imply approximate viewed areas. This is separate from uploading the activity file, but it is still privacy-relevant.

The UI should eventually make this clear and offer privacy-oriented options:

- Use external online map tiles.
- Use no basemap, route-only mode.
- Later: use offline map packs or self-provided tile sources.

### File Handling

- Do not store full file contents in local storage.
- Do not persist activities automatically.
- If recent-file persistence is added later, store only user-approved derived metadata and document what is stored.
- Object URLs should be revoked when no longer needed.
- Large files should be parsed with attention to UI responsiveness.

## 18. Early Scope Guardrails

The early implementation should stay intentionally small:

- One activity loaded at a time.
- Main homepage is descriptive and does not own activity-processing state.
- Viewer/process page owns the activity-file workflow.
- Terms and Conditions is a read-only informational page; it must not own activity-processing state.
- Settings are modal and session-scoped; opening settings must not reset loaded activity data.
- Theme is an app-wide session preference available from Settings; it applies to homepage, viewer/process page, Terms and Conditions, and the settings modal itself.
- The global header should use the OpenTrack Viewer brand/title as the home link, place a `Tools` dropdown beside the title with `File viewer` linking to the viewer/process page, avoid a duplicate Home nav button, omit header subtitles, and use an icon-only Settings control where Settings is available.
- GPX only until route rendering and summary stats are solid.
- One map view.
- One responsive loaded-activity layout: max-width content, optional large-screen section sidebar, overview first, map second, charts later.
- Sport-specific overview metrics should prefer average pace for running and average speed for cycling.
- One chart panel with elevation first, then sport-specific charts: run pace/cadence for running and speed for cycling when the underlying data supports them.
- Laps are displayed only when lap data exists; missing laps should not create empty layout noise.
- No empty map/chart/stat placeholders before a valid activity is loaded.
- One selected chart range at a time.
- Range selection is an inspection/focus tool, not an activity edit or crop operation.
- Export is Stage 3+ work, not part of the first GPX viewer slice.
- No persistence.
- No user settings beyond what is needed for the current session.
- SEO should focus on static public pages and app capabilities, not loaded activity content.
- No backend.
- No account work.
- No cloud import/export.

Any proposal that requires a backend, account, database, queue, cloud object storage, or external activity API should be deferred unless it directly supports the browser-only viewer and does not handle activity-file contents.

## 20. Suggested README Positioning

The README should state the privacy model in the first screen:

> This app opens activity files locally in your browser. GPX/FIT parsing and calculations happen on your device. The app does not upload your activity file to a backend.

Also document the map tile caveat:

> The initial map view may request tiles from the configured map provider. Offline map support is planned separately.

The public SEO description should reinforce the same privacy promise:

> Open GPX, FIT, and TCX activity files locally in your browser. OpenTrack Viewer does not upload your activity file to a backend.
