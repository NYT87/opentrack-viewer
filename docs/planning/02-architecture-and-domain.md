# Architecture and Domain Model

## 4. Proposed Stack

- Language: TypeScript
- UI: React
- Build tool: Vite
- Map: MapLibre GL JS
- Routing: React Router with static-hosting-safe routes. The app should have homepage, viewer/process, GoPro video telemetry extraction, Route Builder, telemetry overlay, and Terms and Conditions routes. Settings should be modal state, not a route.
- State: React state/hooks first; add Zustand only if shared interaction state becomes awkward
- Charts: lightweight SVG/canvas chart component first, or a focused chart library later if interaction requirements justify it
- Testing:
  - Vitest for unit tests
  - React Testing Library for UI behavior
  - Playwright for browser-level file load and map/chart flows
- SEO:
  - Static metadata in `index.html` for default title, description, canonical URL, Open Graph, and Twitter/X cards
  - Route-specific metadata managed by React for homepage, viewer/process, GoPro video telemetry extraction, and Terms and Conditions pages
  - Static `robots.txt` and `sitemap.xml` when deployment URL is known
- PWA:
  - Vite PWA plugin after the first vertical slice
  - Cache app shell only at first
  - Treat offline map tiles separately

## 6. Architecture Overview

```text
Local File
  |
  | Activity file: GPX / FIT / TCX
  | Video file later: GoPro MP4 / MOV with GPMF telemetry
  | Planned route later: new/editable track or appended imported tracks
  |
  | Browser File API
  v
File Intake
  |
  | detect extension/MIME/signature
  v
Parser Registry
  |
  | GPX, FIT and TCX parsers
  | GoPro video telemetry adapter later
  v
Normalized Activity Domain Model
  |
  +--> Stats Engine
  |
  +--> GeoJSON Adapter
  |
  +--> Chart Series Adapter
  |
  +--> Chart Availability/Configuration
  |
  +--> Activity Slice/Focus Adapter
  |
  +--> Exporter Registry
       +--> GPX exporter
       +--> FIT exporter
       +--> TCX exporter
       +--> Direct conversion flow
       +--> Planned route/track export
  |
  v
React UI
  |
  +--> Homepage
       +--> Project description
       +--> Privacy model
       +--> Supported/planned formats
       +--> Open viewer/process page action
       +--> GoPro/video telemetry page information and action when available
       +--> Terms and Conditions link
  |
  +--> Viewer/Process Page
       +--> Empty/Upload Layout
            +--> File Drop Zone
            +--> External/static supporting information
       +--> Viewer Layout after successful processing
            +--> Primary Activity Section
                 +--> Activity Details Panel
                 +--> MapLibre Route Map
            +--> Device Info Card when available
            +--> Chart Panel
                 +--> X-axis switch: distance/time
                 +--> Elevation
                 +--> Pace for runs
                 +--> Cadence for runs when data exists
                 +--> Speed for cycling
                 +--> Range selection overlay
            +--> Reset View button when focused on a selected range
       +--> Export Controls
  |
  +--> GoPro Video Telemetry Extraction Page
       +--> Local MP4/MOV Selection
       +--> Extraction Progress and Cancellation
       +--> Extraction Warnings and Result Summary
       +--> Open in Viewer button after successful extraction
       +--> Client-side handoff of normalized Activity to Viewer/Process Page
  |
  +--> Route Builder Page later
       +--> Create a new planned track
       +--> Receive editable copy from Viewer/Process Page
       +--> Add/remove points and discard sections
       +--> Append another imported track to the editing track
       +--> Export planned track through browser download APIs
  |
  +--> Telemetry Overlay Page later
       +--> Local Video Selection or Handoff from GoPro Extraction
       +--> Overlay Template/Gauge Designer
       +--> Video Preview with Telemetry Sync
       +--> Overlay-only Export
       +--> Burned-in Video Export after feasibility spike
  |
  +--> Terms and Conditions Page
       +--> Browser-only processing terms
       +--> Map tile/provider caveat
       +--> No warranty / no medical or training advice caveat
       +--> User responsibility and acceptable use
  |
  +--> Settings Modal
       +--> Opened from the global header on every page
       +--> Theme: system / dark / light
       +--> Does not navigate away from current page
       +--> Does not clear loaded activity state
```

The UI must depend on normalized domain objects, never on format-specific parser output — GPX, FIT, TCX, or any format added later.

## 7. Core Data Flow

1. User lands on the homepage and can read the product description/privacy model, including a link to Terms and Conditions.
2. User opens the viewer/process page.
3. User selects or drops a local file.
4. File intake reads file metadata and a small signature/header when useful.
5. Format detector identifies candidate parser.
6. Parser converts file content into `Activity`.
7. Validation checks that the normalized activity has at least route points or useful summary data.
8. If parsing or validation fails, the app remains in the upload/error layout and does not render the map area.
9. If parsing and validation succeed, app state transitions to the viewer layout.
10. Stats engine calculates derived values.
11. GeoJSON adapter converts route points to `FeatureCollection`.
12. MapLibre renders the route.
13. Loaded viewer layout renders a max-width content area.
14. Large-screen layout renders a left section sidebar for in-page viewer navigation.
15. Main viewer content renders the activity data overview first.
16. Map section renders in its own content box below the overview.
17. Laps render beside the map on large screens when lap data exists.
18. On medium/small/mobile screens, the section sidebar is hidden and laps render after the map.
19. Device information card displays optional device metadata separately from the summary/activity overview when available.
20. Chart availability logic decides which charts can be shown for the activity.
21. Chart series adapters generate elevation, running pace, running cadence, cycling speed, and future sensor series.
22. Chart panel renders available charts with a user-selected x-axis mode below the map/laps area.
23. User may click-drag-release on the chart to select an x-axis range.
24. Range selection maps the selected chart domain back to start/end point indexes.
25. A focused activity view is derived from the original `Activity` for charts, stats-in-selection, and map route bounds.
26. Reset View clears the selected range and restores full-activity chart data, map route, map bounds, and summary stats.
27. Settings may be opened as a modal from the header without navigating away from the viewer/process page or clearing activity state.
28. Theme settings apply globally without reprocessing or clearing the current activity.
29. Export controls serialize either the full normalized activity or the selected focused range into supported output formats.
30. From the viewer, a `Create Custom Track` action can create an editable copy of the current route and open the Route Builder page without mutating the original activity.
31. In the Route Builder milestone, the user can create a new planned track, edit an existing route copy, remove points, add points, discard sections, and append another imported supported track to the end of the editing track.
32. Route Builder exports the planned track through the exporter registry and local browser download APIs so the file can be copied to external GPS devices.
33. Route metadata updates document title and public meta tags without reading loaded activity data.
34. In the GoPro milestone, the user opens a dedicated video telemetry extraction page from `Tools`, selects a local MP4/MOV file, and extracts telemetry without uploading the video.
35. After successful GoPro extraction, the extraction page shows a button that navigates to the viewer and passes the normalized `Activity` plus safe auxiliary telemetry through client-side app state.
36. The viewer renders the extracted GoPro activity through the same map, overview, charts, range focus, export, and reset-view contracts used for GPX/FIT/TCX activities.
37. After GoPro extraction is stable, a later overlay page can consume the local video plus normalized `Activity`/auxiliary telemetry to render synchronized gauges, maps, and metric overlays.
38. Overlay-only exports serialize the overlay timeline independently from the source video, for use in external editing applications.
39. Burned-in video export composites video frames and overlay frames in the browser only after a feasibility spike confirms acceptable browser support, memory use, duration limits, and export quality.
40. Later slices add synchronized hover/selection state between chart and map.

## 8. Domain Model

The domain model should represent activities independently from their source
format. The shape below is an **excerpt**, showing the layering rather than
every field: `src/domain/activity.ts` is the authoritative definition, and the
chart, export, focus and theme types an earlier draft of this section carried
now live beside the code that uses them — `src/domain/charts.ts`,
`src/exporters/index.ts`, `src/state/interactionStore.ts` and
`src/domain/theme.ts`.

```ts
export interface Activity {
  id: string;
  /** Which file this came from, and which parser read it. */
  source: ActivitySource;
  /** Name, sport, device — everything about the activity but its samples. */
  metadata: ActivityMetadata;
  points: ActivityPoint[];
  laps?: ActivityLap[];
  events?: ActivityEvent[];
  /** Which measurements exist at all, so the UI can ask once, not per point. */
  streams: ActivityStreams;
  /** Computed from the points, never read from the file. */
  derived?: ActivityDerivedStats;
  warnings: ActivityWarning[];
}

export interface ActivityPoint {
  /** The only required field: a point may carry nothing else. */
  index: number;
  lat?: number;
  lon?: number;
  time?: Date;
  elevationMeters?: number;
  distanceMeters?: number;
  heartRateBpm?: number;
  /** Cadence is two fields, because strides and pedal revolutions differ. */
  runningCadenceSpm?: number;
  cyclingCadenceRpm?: number;
  /** Which continuous stretch of recording this is: a pause starts a new one. */
  segmentIndex?: number;
  // ...and the remaining optional sensor fields.
}
```

Every field but `index` is optional by design: a treadmill run has no position,
a planned route has no clock, and most files carry no power. The principles
below say how the rest of the app is expected to behave in the face of that.

### Domain Model Principles

- Optional fields are expected. GPX files may lack HR/power/cadence. FIT files may lack GPS.
- A GoPro video telemetry import should normalize GPS samples into ordinary `ActivityPoint` records, so maps, charts, stats, focused ranges, and export flows continue to use the same contracts.
- Route Builder should work from an editable copy of route-oriented `ActivityPoint` data, whether the starting point is a loaded activity, a new blank planned track, or an appended imported track.
- High-frequency GoPro telemetry that is not an activity point stream, such as accelerometer, gyroscope, gravity vector, camera orientation, ISO, shutter speed, and white balance, should be modeled as optional auxiliary streams instead of forcing everything into `ActivityPoint`.
- Latitude and longitude are optional at the point level so indoor FIT activities can still be represented.
- Derived values should be clearly separated from source values.
- Parser warnings should be preserved and shown in a non-blocking way when possible.
- The UI should gracefully handle partial activities.
- Device information is optional metadata; missing device information is not an error.
- The UI should prefer human-readable device fields such as manufacturer, model, name, and software/firmware version.
- Device information should render in its own card rather than inside the summary/activity overview card.
- Stable identifiers such as serial number should not be displayed by default and should never be sent to telemetry.
- Chart configuration should be derived from normalized `Activity` data, not source file format.
- Chart panels should render only available charts. Unavailable chart kinds should be hidden entirely instead of rendering explanatory placeholders.
- Use explicit non-chart warnings only for file-level problems or data-quality issues that affect the user's trust in the loaded activity.
- Time-based charts require enough timestamped points to build a useful x-axis.
- Distance-based charts require point distances or enough GPS points to derive cumulative distance.
- Chart layout must reserve enough Y-axis label gutter/padding so axis labels do not look squeezed against the plot area.
- Distance x-axis ticks should be generated at 1 km intervals when using metric distance labels.
- Time x-axis ticks should be generated at 5 minute intervals.
- Tick label density may be reduced responsively if labels would overlap, but the underlying target intervals should remain 1 km and 5 minutes.
- Pace should be represented as duration per distance, derived from speed/time-distance data, and only shown when the result is meaningful for the activity.
- The activity overview's primary performance metric should be sport-aware: average pace for running and average speed for cycling.
- Running overview should not foreground average speed when average pace is available.
- Cycling overview should not foreground average pace when average speed is available.
- GoPro/video activities without source speed should derive speed from neighboring GPS points when timestamps and valid coordinates are available.
- GoPro/video activities should expose a user-selectable performance display mode between speed and pace when the activity type is ambiguous or user-overridden.
- Default GoPro/video performance display should be speed in the active unit system; pace remains available when distance/time are sufficient.
- If sport cannot be determined, use a neutral fallback such as distance and duration without inventing a sport-specific primary metric.
- Running cadence should only be offered when running cadence data exists and must be represented as strides per minute.
- Avoid labeling running cadence as RPM; RPM is reserved for cycling cadence or other rotational sensor data.
- Cycling activities should show speed instead of the running-oriented pace/cadence chart set.
- Speed should be represented as distance per time, using source speed when reliable or derived distance/time when needed.
- Derived speed and derived pace should use the same unit-system settings as the rest of the viewer and should not require re-parsing the video.
- Cycling cadence can be reconsidered later as a separate chart, but the initial cycling-specific chart should be speed.
- Range selection should be represented as point indexes after translating from the active chart x-axis domain.
- The original `Activity` should remain immutable; focused views should be derived from it.
- A selected range should preserve point order and include all points between the resolved start and end indexes.
- Focused map and chart views should share the same selected point range to avoid chart/map disagreement.
- Exporters should consume normalized `Activity` or a derived focused activity slice, not parser-specific source data.
- Direct conversion should be modeled as parse-to-`Activity` plus export-from-`Activity`, not as source-format-to-target-format shortcuts.
- Direct conversion should offer only exporter-supported target formats and should normally exclude the source format unless the user is explicitly using export for cleanup/rewrite.
- Route Builder should model edits as operations on a draft planned track, not mutations of the original viewed activity.
- Appending another track in Route Builder should import it through the normal parser registry, normalize it into `Activity`, then append its route points to the draft in order.
- Route Builder export should consume the same exporter registry as activity export where the target format can represent planned route data.
- Planned track exports may omit workout-only streams such as heart rate, power, calories, and device metadata unless explicitly retained by a later product decision.
- GoPro video extraction should be modeled as `local video -> dedicated extraction page -> metadata/GPMF extraction -> normalized Activity plus optional telemetry streams -> viewer handoff`, not as a server conversion job.
- Telemetry overlay generation should be modeled as `local video + normalized Activity/telemetry streams -> synchronized overlay timeline -> preview -> overlay-only export or browser-side video render`, not as a backend render job.
- Exporters may lose unsupported source-specific fields; any loss should be documented through warnings or UI copy.
- Exporting a selected range should not mutate the original activity and should be clearly presented as exporting the selected section.

## 8.1 App Layout States

The viewer/process page should use explicit layout states rather than rendering empty viewer panels.

```ts
export type ActivityViewerState =
  | { status: 'empty' }
  | { status: 'readingFile'; fileName?: string }
  | { status: 'processingFile'; fileName?: string }
  | { status: 'error'; error: ActivityError; fileName?: string }
  | { status: 'ready'; activity: Activity };
```

### Layout State Rules

- `empty`: show only the local file upload button/drop zone and any external/static supporting information currently shown outside the viewer.
- `readingFile` and `processingFile`: keep the upload-focused layout and show progress/status near the upload area.
- `error`: keep the upload-focused layout, show the error near the upload area, and allow another file selection.
- `ready`: render the full activity viewer, including map, summary, charts, a separate device information card when available, and viewer controls.
- Map, chart, summary, and activity metadata areas should not appear in `empty`, `readingFile`, `processingFile`, or `error` states.
- Loading skeletons for the map/chart areas are unnecessary in the initial scope because those areas are not visible until processing succeeds.

## 8.1.1 Page and Modal Structure

The app should separate project description from activity processing:

- `/`: homepage/main page. Describes OpenTrack Viewer, supported/planned formats, privacy model, links to the viewer/process page and Terms and Conditions, and includes GoPro/video telemetry page information when that tool is available or explicitly marked as planned.
- `/viewer`: activity processing page. Owns file selection, parsing, map, details, charts, focused ranges, and export controls.
- `/video-telemetry` or equivalent: GoPro video telemetry extraction page. Owns local MP4/MOV selection, extraction progress, cancellation, extracted telemetry summary, warnings, and the post-success button that opens the viewer with extracted data.
- `/overlays` or equivalent later: telemetry overlay page. Owns overlay template selection/customization, synchronized video preview, overlay-only export, and burned-in video export when feasible.
- `/terms`: Terms and Conditions page. Provides stable legal/usage terms and must be safe to link from footer, homepage, and repository docs.
- Settings: modal state opened from the global header on every page. It should not be a route, should not unmount the current page, and should not clear loaded activity data.

Header rules:

- The header brand/title text, `OpenTrack Viewer`, should be the homepage link.
- Do not render a separate Home button or Home nav item when the brand/title link is present.
- Do not render the privacy/product description as a header subtitle; keep descriptive copy on the homepage or contextual content areas.
- Place a `Tools` dropdown beside the title on the left side of the header.
- The `Tools` dropdown should include `File viewer`, which routes to the current viewer/process page.
- When GoPro video telemetry extraction is implemented, the `Tools` dropdown should also include a `Video telemetry` or `GoPro telemetry` entry that routes to the dedicated extraction page.
- When telemetry overlays are implemented, the `Tools` dropdown should also include an `Overlays` or `Telemetry overlays` entry that routes to the overlay page.
- When Route Builder is implemented, the `Tools` dropdown should also include a `Route Builder`, `Route planner`, or equivalent entry that routes to the dedicated route-building page.
- The viewer/process page should not appear as a standalone top-level `Viewer` button when it is available through `Tools > File viewer`.
- The `Tools` dropdown should use accessible menu/button semantics, keyboard navigation, outside-click/Escape close behavior, and a visible focus state.
- Every page should expose Settings in the header as an icon-only button/control, including the homepage, viewer/process page, Terms and Conditions page, and future tool pages.
- The Settings icon control must have an accessible name, keyboard focus state, and tooltip/title or equivalent affordance for pointer users.
- Terms and Conditions should be reachable through footer/global links and may be linked from the homepage.
- The viewer/process page should keep the global compact action to open settings while activity data remains mounted.
- Closing the settings modal should return focus to the button/control that opened it.

Theme rules:

- Settings modal should offer exactly three theme options: system, dark, and light.
- `system` is the default preference.
- When `system` is selected, resolve the active theme from `prefers-color-scheme`.
- If `prefers-color-scheme` or equivalent detection is unavailable, resolve `system` to light.
- Explicit `dark` and `light` override system preference.
- Theme changes should update the app shell immediately without reloading the page or clearing loaded activity state.

SEO rules:

- SEO metadata must describe OpenTrack Viewer and its public pages, not the user's loaded activity.
- Do not place activity file names, route coordinates, timestamps, device metadata, sensor values, or derived stats into document titles, meta descriptions, Open Graph tags, Twitter/X tags, canonical URLs, robots files, sitemap files, or structured data.
- Homepage metadata should be indexable and describe browser-only activity file viewing.
- Homepage copy may mention local GoPro video telemetry extraction once available, but must not imply videos are uploaded, processed by a server, or handled by the generic file viewer.
- Viewer/process metadata should describe the generic file viewer, not the currently loaded file.
- GoPro video telemetry extraction metadata should describe local browser-side extraction from GoPro video files without claiming uploaded/cloud processing.
- Telemetry overlay metadata should describe local browser-side overlay generation without implying cloud rendering or uploaded videos.
- Terms and Conditions metadata should describe the legal/usage terms page.
- If route-specific metadata is managed client-side, it should update when navigating between homepage, viewer/process, and Terms and Conditions routes.
- Static hosting should include `robots.txt` and `sitemap.xml` once the production URL is known.

## 8.2 Ready Viewer Layout

After an activity is successfully processed, the ready viewer should use a clear top-to-bottom flow:

1. Activity data overview box.
2. Device information card when available.
3. Map box, with laps beside the map on large screens when laps exist.
4. Charts section.
5. Later-stage export and advanced controls.
6. Later-stage `Create Custom Track` action for opening an editable route copy in Route Builder.

### Global Loaded-Activity Layout

Large-screen layout:
- The loaded viewer content should have a readable maximum width and remain centered in the page.
- A compact left sidebar should appear beside the main content and link to major in-page sections such as overview, map, laps when available, and charts.
- The sidebar links should use section anchors or equivalent in-page navigation and should not clear loaded activity state.
- Main content should render the activity data overview as the first content box.
- Device information should render as its own card below or beside the overview according to available layout space; it should not be nested inside the summary/overview card.
- The map should render in a separate content box below the overview.
- Charts should render below the map/laps area, not beside the overview.
- The charts section should include only available chart panels; unavailable chart kinds should not reserve space.
- Content boxes should not be nested inside other boxes.

Medium/small/mobile layout:
- The left section sidebar should not render.
- Main content should remain one column.
- The activity data overview box appears first.
- The device card appears after the overview when device information is available.
- The map box appears after the overview.
- Laps appear after the map when laps exist.
- Charts remain below the map/laps area.
- Text, map controls, laps content, and chart controls must not overlap.

### Map and Laps Section

Large-screen layout:
- If `activity.laps` exists and has useful lap entries, render the laps panel on the left side of the map.
- The map remains the primary visual in the map box and should retain enough width and height for route inspection.
- The laps panel should support scrolling independently if there are many laps, without shrinking the map into an unusable size.

Medium/small/mobile layout:
- The map renders first within the map box.
- The laps panel renders after the map.
- If no laps exist, do not render an empty laps panel.

### First-Stage Activity Details

The first-stage activity details panel should include the values shown in the reference style when available:

- Distance
- Average Pace for running activities
- Average Speed for cycling activities
- Time
- Moving Time
- Elapsed Time

The three timing values are distinct:

- `Time`: the primary user-facing duration for the activity.
- `Moving Time`: duration after excluding stopped/paused periods when this can be calculated or trusted from the source.
- `Elapsed Time`: wall-clock duration from activity start to end.

If moving time cannot be calculated reliably in the first GPX slice, show it as unavailable rather than inventing a value. When only elapsed time is known, `Time` may initially match elapsed time, but the implementation should keep the fields separate so FIT and future formats can provide better values.

Average pace and average speed are derived display metrics:

- `Average Pace`: duration per distance, shown for running activities when distance and usable duration exist.
- `Average Speed`: distance per duration, shown for cycling activities when distance and usable duration exist.
- When both moving and elapsed duration are available, the chosen duration source for these averages should be documented and consistent with the summary's primary `Time` value.

## 9. Proposed Repository Structure

```text
activity-viewer/
  package.json
  vite.config.ts
  tsconfig.json
  index.html
  public/
    manifest.webmanifest
    icons/
  src/
    app/
      App.tsx
      AppShell.tsx
      HomePage.tsx
      ViewerPage.tsx
      RouteBuilderPage.tsx
      TermsPage.tsx
      SettingsModal.tsx
      Seo.tsx
      routes.ts
    components/
      FileDropZone.tsx
      SummaryPanel.tsx
      DeviceInfoPanel.tsx
      ActivityMap.tsx
      ChartPanel.tsx
      ActivityChart.tsx
      ChartXAxisSwitch.tsx
      ChartRangeSelectionOverlay.tsx
      FocusRangeControls.tsx
      RouteEditorMap.tsx
      RouteBuilderToolbar.tsx
      EmptyState.tsx
      ErrorPanel.tsx
    domain/
      activity.ts
      stats.ts
      geojson.ts
      charts.ts
      series.ts
      activitySlice.ts
      routeDraft.ts
      validation.ts
      units.ts
    parsers/
      index.ts
      detectFormat.ts
      gpx/
        parseGpx.ts
        gpxTypes.ts
      fit/
        parseFit.ts
        fitTypes.ts
      tcx/
        parseTcx.ts
        tcxTypes.ts
    exporters/
      index.ts
      exportGpx.ts
      exportFit.ts
      exportTcx.ts
    route-builder/
      draftRoute.ts
      routeOperations.ts
      appendTrack.ts
    state/
      activityStore.ts
      interactionStore.ts
      preferencesStore.ts
    styles/
      global.css
      map.css
    test/
      fixtures/
        simple-route.gpx
        route-with-elevation.gpx
        malformed.gpx
      helpers/
        renderWithProviders.tsx
    main.tsx
```

Keep the first version smaller than this if needed, but preserve these boundaries:

- `domain/` contains format-independent logic.
- `parsers/` contains format-specific logic.
- `components/` renders normalized data.
- `state/` owns app interaction state, not parsing rules.
