# Architecture and Domain Model

## 4. Proposed Stack

- Language: TypeScript
- UI: React
- Build tool: Vite
- Map: MapLibre GL JS
- Routing: React Router with static-hosting-safe routes. The app should have homepage, viewer/process, and Terms and Conditions routes. Settings should be modal state, not a route.
- State: React state/hooks first; add Zustand only if shared interaction state becomes awkward
- Charts: lightweight SVG/canvas chart component first, or a focused chart library later if interaction requirements justify it
- Testing:
  - Vitest for unit tests
  - React Testing Library for UI behavior
  - Playwright for browser-level file load and map/chart flows
- PWA:
  - Vite PWA plugin after the first vertical slice
  - Cache app shell only at first
  - Treat offline map tiles separately

## 6. Architecture Overview

```text
Local File
  |
  | Browser File API
  v
File Intake
  |
  | detect extension/MIME/signature
  v
Parser Registry
  |
  | GPX parser first, FIT parser later
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
       +--> TCX exporter later
  |
  v
React UI
  |
  +--> Homepage
       +--> Project description
       +--> Privacy model
       +--> Supported/planned formats
       +--> Open viewer/process page action
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
            +--> Device Info Panel when available
            +--> Chart Panel
                 +--> X-axis switch: distance/time
                 +--> Elevation
                 +--> Pace for runs
                 +--> Cadence for runs when data exists
                 +--> Speed for cycling
                 +--> Range selection overlay
            +--> Reset View button when focused on a selected range
       +--> Export Controls in later stages
  |
  +--> Terms and Conditions Page
       +--> Browser-only processing terms
       +--> Map tile/provider caveat
       +--> No warranty / no medical or training advice caveat
       +--> User responsibility and acceptable use
  |
  +--> Settings Modal
       +--> Opened from header on non-home pages
       +--> Theme: system / dark / light
       +--> Does not navigate away from current page
       +--> Does not clear loaded activity state
```

The UI must depend on normalized domain objects, not on GPX/FIT-specific parser output.

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
19. Device information panel displays optional device metadata when available.
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
30. Later slices add synchronized hover/selection state between chart and map.

## 8. Domain Model

The domain model should represent activities independently from their source format.

```ts
export type ActivitySourceFormat =
  | 'gpx'
  | 'fit'
  | 'tcx'
  | 'kml'
  | 'geojson'
  | 'csv'
  | 'unknown';

export type ActivitySport =
  | 'running'
  | 'cycling'
  | 'hiking'
  | 'walking'
  | 'swimming'
  | 'skiing'
  | 'rowing'
  | 'other'
  | 'unknown';

export interface Activity {
  id: string;
  source: ActivitySource;
  metadata: ActivityMetadata;
  points: ActivityPoint[];
  laps?: ActivityLap[];
  events?: ActivityEvent[];
  streams: ActivityStreams;
  derived?: ActivityDerivedStats;
  warnings: ActivityWarning[];
}

export interface ActivitySource {
  format: ActivitySourceFormat;
  fileName?: string;
  fileSizeBytes?: number;
  parserVersion: string;
}

export interface ActivityMetadata {
  name?: string;
  description?: string;
  sport?: ActivitySport;
  startTime?: Date;
  endTime?: Date;
  creator?: string;
  deviceName?: string;
  device?: ActivityDeviceInfo;
}

export interface ActivityDeviceInfo {
  name?: string;
  manufacturer?: string;
  model?: string;
  product?: string;
  softwareVersion?: string;
  firmwareVersion?: string;
  serialNumber?: string;
  source?: 'gpx_creator' | 'gpx_extension' | 'fit_device_info' | 'fit_file_id' | 'unknown';
}

export interface ActivityPoint {
  index: number;
  time?: Date;
  lat?: number;
  lon?: number;
  elevationMeters?: number;
  distanceMeters?: number;
  heartRateBpm?: number;
  runningCadenceSpm?: number;
  cyclingCadenceRpm?: number;
  powerWatts?: number;
  temperatureCelsius?: number;
  speedMetersPerSecond?: number;
  gradePercent?: number;
  accuracyMeters?: number;
  extensions?: Record<string, unknown>;
}

export interface ActivityLap {
  index: number;
  startTime?: Date;
  endTime?: Date;
  distanceMeters?: number;
  durationSeconds?: number;
}

export interface ActivityEvent {
  type: 'start' | 'stop' | 'pause' | 'resume' | 'lap' | 'marker' | 'unknown';
  time?: Date;
  pointIndex?: number;
  label?: string;
}

export interface ActivityStreams {
  hasLocation: boolean;
  hasElevation: boolean;
  hasTime: boolean;
  hasDistance: boolean;
  hasHeartRate: boolean;
  hasCadence: boolean;
  hasPower: boolean;
  hasTemperature: boolean;
}

export interface ActivityDerivedStats {
  pointCount: number;
  startTime?: Date;
  endTime?: Date;
  durationSeconds?: number;
  movingDurationSeconds?: number;
  distanceMeters?: number;
  elevationGainMeters?: number;
  elevationLossMeters?: number;
  minElevationMeters?: number;
  maxElevationMeters?: number;
  averageHeartRateBpm?: number;
  maxHeartRateBpm?: number;
  averagePowerWatts?: number;
  maxPowerWatts?: number;
}

export interface ActivityWarning {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  pointIndex?: number;
}

export type ChartXAxisMode = 'distance' | 'time';

export type ActivityChartKind =
  | 'elevation'
  | 'pace'
  | 'cadence'
  | 'speed'
  | 'heartRate'
  | 'power'
  | 'temperature';

export interface ActivityChartDefinition {
  kind: ActivityChartKind;
  label: string;
  available: boolean;
  unavailableReason?: string;
  defaultXAxisMode: ChartXAxisMode;
  supportedXAxisModes: ChartXAxisMode[];
}

export interface ActivityPointRange {
  startIndex: number;
  endIndex: number;
}

export interface ActivityFocusState {
  selectedRange?: ActivityPointRange;
  mode: 'fullActivity' | 'selectedRange';
}

export type ActivityExportFormat = 'gpx' | 'fit' | 'tcx';

export interface ActivityExportRequest {
  activity: Activity;
  format: ActivityExportFormat;
  range?: ActivityPointRange;
  fileName?: string;
}

export interface ActivityExportResult {
  blob: Blob;
  fileName: string;
  mimeType: string;
  warnings: ActivityWarning[];
}

export type ThemeMode = 'system' | 'dark' | 'light';

export interface UserPreferences {
  themeMode: ThemeMode;
  resolvedTheme: 'dark' | 'light';
}
```

### Domain Model Principles

- Optional fields are expected. GPX files may lack HR/power/cadence. FIT files may lack GPS.
- Latitude and longitude are optional at the point level so indoor FIT activities can still be represented.
- Derived values should be clearly separated from source values.
- Parser warnings should be preserved and shown in a non-blocking way when possible.
- The UI should gracefully handle partial activities.
- Device information is optional metadata; missing device information is not an error.
- The UI should prefer human-readable device fields such as manufacturer, model, name, and software/firmware version.
- Stable identifiers such as serial number should not be displayed by default and should never be sent to telemetry.
- Chart configuration should be derived from normalized `Activity` data, not source file format.
- A chart may be hidden, disabled, or shown with an empty state based on data availability and activity sport.
- Time-based charts require enough timestamped points to build a useful x-axis.
- Distance-based charts require point distances or enough GPS points to derive cumulative distance.
- Chart layout must reserve enough Y-axis label gutter/padding so axis labels do not look squeezed against the plot area.
- Distance x-axis ticks should be generated at 1 km intervals when using metric distance labels.
- Time x-axis ticks should be generated at 5 minute intervals.
- Tick label density may be reduced responsively if labels would overlap, but the underlying target intervals should remain 1 km and 5 minutes.
- Pace should be represented as duration per distance, derived from speed/time-distance data, and only shown when the result is meaningful for the activity.
- Running cadence should only be offered when running cadence data exists and must be represented as strides per minute.
- Avoid labeling running cadence as RPM; RPM is reserved for cycling cadence or other rotational sensor data.
- Cycling activities should show speed instead of the running-oriented pace/cadence chart set.
- Speed should be represented as distance per time, using source speed when reliable or derived distance/time when needed.
- Cycling cadence can be reconsidered later as a separate chart, but the initial cycling-specific chart should be speed.
- Range selection should be represented as point indexes after translating from the active chart x-axis domain.
- The original `Activity` should remain immutable; focused views should be derived from it.
- A selected range should preserve point order and include all points between the resolved start and end indexes.
- Focused map and chart views should share the same selected point range to avoid chart/map disagreement.
- Exporters should consume normalized `Activity` or a derived focused activity slice, not parser-specific source data.
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
- `ready`: render the full activity viewer, including map, summary, charts, device information when available, and viewer controls.
- Map, chart, summary, and activity metadata areas should not appear in `empty`, `readingFile`, `processingFile`, or `error` states.
- Loading skeletons for the map/chart areas are unnecessary in the initial scope because those areas are not visible until processing succeeds.

## 8.1.1 Page and Modal Structure

The app should separate project description from activity processing:

- `/`: homepage/main page. Describes OpenTrack Viewer, supported/planned formats, privacy model, and links to the viewer/process page and Terms and Conditions.
- `/viewer`: activity processing page. Owns file selection, parsing, map, details, charts, focused ranges, and later export controls.
- `/terms`: Terms and Conditions page. Provides stable legal/usage terms and must be safe to link from footer, homepage, and repository docs.
- Settings: modal state opened from the header on non-home pages. It should not be a route, should not unmount the viewer/process page, and should not clear loaded activity data.

Header rules:

- The header brand/title text, `OpenTrack Viewer`, should be the homepage link.
- Do not render a separate Home button or Home nav item when the brand/title link is present.
- Do not render the privacy/product description as a header subtitle; keep descriptive copy on the homepage or contextual content areas.
- Homepage header should not show Settings.
- Non-home pages should expose Settings in the header as an icon-only button/control.
- The Settings icon control must have an accessible name, keyboard focus state, and tooltip/title or equivalent affordance for pointer users.
- Terms and Conditions should be reachable through footer/global links and may be linked from the homepage.
- The viewer/process page should keep a compact action to open settings while activity data remains mounted.
- Closing the settings modal should return focus to the button/control that opened it.

Theme rules:

- Settings modal should offer exactly three theme options: system, dark, and light.
- `system` is the default preference.
- When `system` is selected, resolve the active theme from `prefers-color-scheme`.
- If `prefers-color-scheme` or equivalent detection is unavailable, resolve `system` to light.
- Explicit `dark` and `light` override system preference.
- Theme changes should update the app shell immediately without reloading the page or clearing loaded activity state.

## 8.2 Ready Viewer Layout

After an activity is successfully processed, the ready viewer should use a clear top-to-bottom flow:

1. Activity data overview box.
2. Map box, with laps beside the map on large screens when laps exist.
3. Charts section.
4. Later-stage export and advanced controls.

### Global Loaded-Activity Layout

Large-screen layout:
- The loaded viewer content should have a readable maximum width and remain centered in the page.
- A compact left sidebar should appear beside the main content and link to major in-page sections such as overview, map, laps when available, and charts.
- The sidebar links should use section anchors or equivalent in-page navigation and should not clear loaded activity state.
- Main content should render the activity data overview as the first content box.
- The map should render in a separate content box below the overview.
- Charts should render below the map/laps area, not beside the overview.
- Content boxes should not be nested inside other boxes.

Medium/small/mobile layout:
- The left section sidebar should not render.
- Main content should remain one column.
- The activity data overview box appears first.
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
- Time
- Moving Time
- Elapsed Time

The three timing values are distinct:

- `Time`: the primary user-facing duration for the activity.
- `Moving Time`: duration after excluding stopped/paused periods when this can be calculated or trusted from the source.
- `Elapsed Time`: wall-clock duration from activity start to end.

If moving time cannot be calculated reliably in the first GPX slice, show it as unavailable rather than inventing a value. When only elapsed time is known, `Time` may initially match elapsed time, but the implementation should keep the fields separate so FIT and future formats can provide better values.

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
      TermsPage.tsx
      SettingsModal.tsx
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
      EmptyState.tsx
      ErrorPanel.tsx
    domain/
      activity.ts
      stats.ts
      geojson.ts
      charts.ts
      series.ts
      activitySlice.ts
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
