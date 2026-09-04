# Roadmap and Stages

## 10. Milestones

### M0: Project Foundation

Goal: Create the app shell and engineering baseline.

Outcome:
- Vite React TypeScript app runs locally.
- Core lint/test scripts exist.
- Basic UI shell has homepage and viewer/process routes.
- Terms and Conditions route exists with draft content and stable links.
- Header brand/title links to the homepage, with no duplicate Home button and no header subtitle.
- Header places a `Tools` dropdown beside the title, with `File viewer` linking to the viewer/process page.
- Settings exists as a modal available from non-home pages, not as a standalone page.
- Settings opens from an icon-only header control on non-home pages.
- Settings modal includes theme mode options: system, dark, and light.
- Basic SEO metadata exists for homepage, viewer/process, and Terms and Conditions without exposing activity data.
- Viewer/process page has an upload-focused empty state.
- Map, chart, summary, and metadata regions are not visible before an activity is successfully loaded.
- Loaded viewer content uses a max-width layout with an optional large-screen section sidebar.

### M1: GPX Route Vertical Slice

Goal: Local GPX file selection/drag-drop renders the first activity view with details and route map.

Outcome:
- Browser reads `.gpx`.
- GPX parser extracts track points.
- Parser returns normalized `Activity`.
- GeoJSON adapter returns route `FeatureCollection`.
- MapLibre displays the route and fits bounds.
- Ready viewer renders an activity data overview box first.
- Ready viewer renders the map in a separate box below the overview.
- Large-screen layout includes a compact left sidebar linking to viewer sections.
- Medium/small/mobile layout hides the left sidebar.
- Charts appear below the map area.

### M2: Summary Stats

Goal: Show useful first-stage activity details and optional activity metadata for GPX routes.

Outcome:
- Distance, Time, Moving Time, Elapsed Time, start/end, and elevation gain displayed where available.
- Running activity overview displays average pace instead of average speed as the primary performance metric.
- Cycling activity overview displays average speed as the primary performance metric.
- Laps display when the activity includes lap data.
- On large screens, laps display to the left of the map.
- On medium/small/mobile screens, laps display after the map.
- Device information is displayed when available.
- Missing device information is handled quietly.
- Stats handle missing time/elevation fields.
- Units are consistent and test-covered.

### M3: Chart Panel and Elevation Chart

Goal: Add the chart panel, elevation visualization, and chart x-axis selection.

Outcome:
- Chart shows elevation over distance or time.
- User can switch the chart x-axis between distance and time when both are available.
- Y-axis labels have enough spacing/gutter to render cleanly.
- Distance x-axis renders orientation tick marks every 1 km where space permits.
- Time x-axis renders orientation tick marks every 5 minutes where space permits.
- Chart falls back gracefully when either distance or time is unavailable.
- Chart handles missing/partial elevation.
- Route rendering remains stable.

### M3.5: Sport-Specific Charts

Goal: Add charts that are useful for specific activity types without making them mandatory for every file.

Outcome:
- Run activities can show pace when time and distance data are sufficient.
- Run activities can show cadence when cadence data exists, labeled and modeled as strides per minute.
- Cycling activities can show speed when speed or time/distance data is sufficient.
- Cycling activities do not show the running-oriented pace/cadence chart set by default.
- Non-run and non-cycling activities do not show sport-specific charts by default.
- Chart availability is explained through empty/disabled states rather than parser-specific errors.

### M4: Map/Chart Synchronization

Goal: Hovering chart/map highlights corresponding route point, and selected chart ranges focus both chart and map.

Outcome:
- Shared selected/hovered point index state.
- Shared selected point range state.
- Chart hover highlights map marker.
- Map hover/click highlights chart position.
- Chart click-drag-release can select a range.
- Chart panel redraws as if the selected range is the only visible data.
- Map focuses and fits bounds to the selected route section.
- User can use a visible Reset View button to clear the selection and return to the full activity.

### Stage 3: Client-Side Export

Goal: Export normalized activities from the browser without uploading files.

Outcome:
- Export controls can serialize the full activity to GPX where supported.
- Export controls can serialize the full activity to FIT where technically feasible and appropriately scoped.
- If a focused chart range is active, the user can export either the full activity or selected section.
- Export warnings explain fields that cannot be represented in the selected target format.
- Export happens through local browser download APIs only.

### M5: FIT Support

Goal: FIT files feed the same domain model and UI.

Outcome:
- `.fit` parser supports core records.
- GPS FIT routes render on the same map.
- HR/cadence/power fields are normalized when present.
- Non-GPS FIT files still show stats/charts where possible.

### Stage 4: TCX Import and Export

Goal: Add TCX as a first-class browser-side import and export format.

Outcome:
- TCX files can be imported and normalized into `Activity`.
- Normalized activities can be exported to TCX.
- TCX data feeds existing map, stats, charts, focused range, and export flows.
- TCX support remains entirely browser-side.

### M6: Additional Formats and PWA Hardening

Goal: Expand format support and offline app-shell behavior.

Outcome:
- Evaluate KML/GeoJSON/CSV based on user need after TCX.
- App installability works.
- App shell caches offline.
- Offline maps remain a separate project.

## 12. Start Here: Parallelizable First Tasks

Start with these tasks in parallel:

- Engineer A: AV-001, AV-002, AV-006, AV-007, AV-008, AV-009, AV-010, AV-011, AV-012, and AV-013, project scaffold, quality baseline, homepage/viewer/terms routes, settings modal shell, theme preference controls, compact header refactor, Tools dropdown, SEO, and global viewer layout.
- Engineer A2: AV-406, laps display using synthetic normalized activity data.
- Engineer B: AV-101, domain model types and conventions.
- Engineer C: AV-102 and AV-103, file intake and format detection.
- Engineer D: AV-201 and AV-203, GPX parser plus fixtures.
- Engineer E: AV-302, MapLibre map component with static sample GeoJSON.
- Engineer F: AV-501, AV-504, and AV-513, chart series adapter, x-axis switch contract, and cycling speed series using synthetic normalized activity data.
- Engineer G: AV-508 and AV-509, chart range-selection gesture and domain-to-point-range mapping using synthetic chart data.

Then converge on AV-304, the first vertical slice.

The first meaningful demo should be:

> Open the homepage, navigate to the viewer/process page, drag a GPX file into the browser, see the route on the map, open settings as a modal without losing the loaded activity, and verify no activity file is uploaded.

## 19. Definition of Done for the First Vertical Slice

The first vertical slice is complete when:

- A user can open the app in a browser.
- A user lands on a homepage/main page with project description and privacy positioning.
- A user can navigate to the viewer/process page.
- A user can open Terms and Conditions from a stable link.
- The header brand/title links back to the homepage.
- The header does not show a duplicate Home button when the brand/title link is present.
- The header does not show a subtitle/description line.
- The header shows a `Tools` dropdown beside the title, and `Tools > File viewer` opens the viewer/process page.
- The viewer/process route is not duplicated as a separate top-level `Viewer` button.
- On non-home pages, Settings opens from an accessible icon-only header control.
- Public metadata describes OpenTrack Viewer and the current route without exposing loaded activity data.
- The viewer/process initial state shows the local file upload action and does not show the map area.
- A user can select or drag/drop a GPX file.
- The file is parsed in the browser.
- The parsed data is normalized into `Activity`.
- The route is converted into GeoJSON.
- The viewer layout appears only after successful processing.
- Loaded viewer content is constrained to a readable maximum width.
- Large-screen loaded viewer layout shows a compact left section sidebar.
- Medium/small/mobile loaded viewer layout hides the left section sidebar.
- Main loaded viewer content shows activity data overview first, map second, and charts later.
- Laps display beside the map on large screens when lap data exists.
- Laps display after the map on medium/small/mobile screens when lap data exists.
- Activity details include Distance, Time, Moving Time, and Elapsed Time as separate fields where available.
- Running activity details show Average Pace when it can be calculated.
- Cycling activity details show Average Speed when it can be calculated.
- Charts appear below the map/laps section.
- MapLibre renders the route.
- The map fits the route bounds.
- Invalid or unsupported files show clear errors.
- Unit tests cover parser and GeoJSON conversion.
- A browser test covers loading a GPX fixture and rendering a route.
- Network inspection confirms the activity file is not uploaded.
- Settings opens as a modal from the viewer/process page without navigating away from or clearing the loaded activity.
- Theme defaults to system, resolves to OS/browser preference when possible, and falls back to light when system preference cannot be detected.

## 19.1 Definition of Done for Chart Range Focus

The chart range focus slice is complete when:

- A user can drag across a chart to select a range.
- The selected range is visibly represented on the chart.
- Releasing the pointer focuses chart data to the selected section.
- The map focuses to the matching route section.
- Focused stats can be shown or clearly labeled when implemented.
- The user can clear the selected range and return to the full activity.
- Reset View is visible while focused and restores chart, map, and summary to the full activity.
- The original normalized activity remains unchanged.
- Tests cover distance-axis selection, time-axis selection, reversed drag, tiny drag, no-location selected range, and clear-selection behavior.
