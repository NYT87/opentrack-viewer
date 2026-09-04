# Testing, Performance, and Error Handling

## 13. Testing Strategy

### Unit Tests

Cover:
- Format detection.
- GPX parser success/failure.
- TCX parser success/failure once TCX support begins.
- Domain validation.
- GeoJSON conversion.
- Distance calculation.
- Duration calculation.
- Elevation gain/loss.
- Unit formatting.
- Device information normalization and redaction/default hiding behavior.
- Chart x-axis series generation for distance and time.
- Pace derivation, including missing and invalid intervals.
- Running cadence normalization as strides per minute.
- Running cadence chart availability rules.
- Cycling speed derivation and chart availability rules.
- Chart range selection domain-to-point mapping.
- Focused activity slice derivation without mutating the original activity.
- GPX export serialization and GPX re-import round trip.
- FIT export strategy and FIT export validation when implemented.
- TCX import/export mapping and round-trip behavior once TCX support begins.

### Component Tests

Cover:
- Homepage content and primary action to open the viewer/process page.
- Terms and Conditions page content and navigation links.
- Header brand/title links to the homepage.
- Header does not render a duplicate Home button/nav item when the brand/title link is present.
- Header does not render a subtitle/tagline below the brand/title.
- Header renders a `Tools` dropdown beside the title.
- `Tools` dropdown contains `File viewer` and routes to the viewer/process page.
- Header does not render a standalone top-level `Viewer` button when `File viewer` is in the `Tools` dropdown.
- Tools dropdown has accessible button/menu behavior, keyboard support, Escape close, outside-click close, and visible focus state.
- Header hides Settings on the homepage and shows an icon-only Settings control on non-home pages.
- Settings icon has accessible name, tooltip/title or equivalent affordance, keyboard support, and visible focus state.
- Settings modal open/close behavior without route changes.
- Route-specific SEO title and description for homepage, viewer/process, and Terms and Conditions.
- Privacy-safe SEO behavior that excludes loaded activity data from metadata.
- Theme setting renders system, dark, and light options.
- Theme defaults to system and falls back to light if system color-scheme detection is unavailable.
- Theme changes apply globally without clearing loaded activity state.
- File drop/select states.
- Parser error display.
- Empty layout hides map, chart, summary, and metadata regions.
- Processing/error states keep viewer regions hidden.
- Ready state displays viewer regions after successful parsing.
- Ready viewer uses a readable max-width content container.
- Ready viewer large-screen layout displays the left section sidebar.
- Ready viewer medium/small/mobile layout hides the left section sidebar.
- Ready viewer main content renders overview first, map second, and charts later.
- Section sidebar links scroll or jump to viewer sections without clearing loaded activity state.
- Summary panel missing values.
- Summary panel displays Distance, Time, Moving Time, and Elapsed Time as separate fields.
- Summary/overview displays Average Pace for running activities.
- Summary/overview displays Average Speed for cycling activities.
- Summary/overview does not foreground Average Speed for running when Average Pace is available.
- Summary/overview does not foreground Average Pace for cycling when Average Speed is available.
- Device information present/missing states.
- Laps panel present/missing states.
- Laps panel large-screen placement beside the map.
- Laps panel medium/small/mobile placement after the map.
- Chart empty and populated states.
- Chart x-axis switch enabled/disabled states.
- Chart Y-axis label gutter and clipping regression.
- Chart distance x-axis tick marks at 1 km intervals.
- Chart time x-axis tick marks at 5 minute intervals.
- Run-specific chart visibility for pace and cadence.
- Running cadence labels and Y-axis units display strides per minute, not RPM.
- Cycling-specific chart visibility for speed.
- Running activities hiding or disabling cycling-specific speed charts.
- Non-run and non-cycling activities hiding or disabling sport-specific charts.
- Chart drag selection overlay and clear-selection controls.
- Reset View button visibility and behavior.
- Focused range chart redraw behavior.
- Focused range summary stats state.
- Export controls visibility only in ready state.
- Export full activity versus selected range behavior.

### Browser/E2E Tests

Cover:
- Load the homepage first and navigate to the viewer/process page.
- Open Terms and Conditions from the homepage/footer and confirm the page renders.
- Confirm the header brand/title navigates to the homepage.
- Confirm there is no separate Home button when the brand/title link is present.
- Confirm the header does not show a subtitle/description line.
- Confirm `Tools` dropdown appears beside the title.
- Confirm `Tools > File viewer` navigates to the viewer/process page.
- Confirm no standalone top-level `Viewer` button is rendered when `File viewer` is in the `Tools` dropdown.
- Confirm `Tools` dropdown supports keyboard open/close and Escape close.
- Confirm Settings is not shown on the homepage header.
- Confirm Settings opens as a modal from the icon-only header control on the viewer/process page.
- Confirm opening and closing Settings does not clear a loaded activity or selected chart/view state.
- Confirm each public route sets the expected title and description.
- Confirm loading an activity does not write file name, coordinates, timestamps, device identifiers, sensor values, or derived stats into meta tags.
- Confirm theme can switch between system, dark, and light from Settings.
- Confirm changing theme does not clear a loaded activity.
- Load sample GPX through file input.
- Confirm initial page shows only upload-focused content and no map area.
- Confirm desktop ready layout shows overview first, then the map/laps section, then charts.
- Confirm mobile ready layout shows the overview first, then the map, then laps when available, then charts.
- Confirm route layer appears.
- Confirm summary stats render.
- Confirm running fixture displays Average Pace in the overview.
- Confirm running fixture does not use Average Speed as the primary overview performance metric.
- Confirm cycling fixture displays Average Speed in the overview.
- Confirm cycling fixture does not use Average Pace as the primary overview performance metric.
- Confirm ready viewer content is constrained to a readable maximum width.
- Confirm large-screen viewer shows the left section sidebar with section links.
- Confirm medium/small/mobile viewer hides the left section sidebar.
- Confirm content order is overview, map, then charts.
- Confirm lap fixture displays laps on the left side of the map on large screens.
- Confirm lap fixture displays laps after the map on medium/small/mobile screens.
- Confirm fixture without laps does not render an empty laps panel.
- Confirm device information renders when a fixture contains supported metadata.
- Confirm chart x-axis can switch between distance and time for a fixture with both.
- Confirm chart Y-axis labels are not clipped or cramped in the reference-width layout.
- Confirm distance x-axis shows 1 km interval tick marks where space permits.
- Confirm time x-axis shows 5 minute interval tick marks where space permits.
- Confirm chart click-drag-release focuses the chart to the selected section.
- Confirm selected chart section focuses the map bounds to the matching route section.
- Confirm Reset View restores full chart, full map route, full map bounds, and full summary stats.
- Confirm export controls are hidden before a valid activity is loaded.
- Confirm GPX export downloads a file and exported GPX can be loaded again.
- Confirm selected range export contains only the selected activity section.
- Confirm run fixture shows pace when sufficient time/distance data exists.
- Confirm running cadence chart appears only when `runningCadenceSpm` data exists.
- Confirm running cadence labels and axis units use strides per minute, not RPM.
- Confirm cycling fixture shows speed when sufficient speed or time/distance data exists.
- Confirm cycling fixture does not show running pace/cadence charts by default.
- Confirm malformed GPX produces a useful error.
- Confirm no request is made with the raw file content.

### Privacy Regression Tests

Add browser tests or request interception checks for:
- No POST/PUT requests during local file parsing.
- No analytics request contains coordinates, timestamps, file names, or sensor values.
- No analytics request contains device identifiers, serial numbers, manufacturer/model fields, or raw metadata.
- No SEO metadata contains coordinates, timestamps, file names, device identifiers, serial numbers, manufacturer/model fields, sensor values, or derived activity stats.
- No export operation uploads activity contents or derived activity contents.
- Map tile requests are limited to configured tile provider URLs.

### Fixture Policy

- Use small synthetic fixtures for unit tests.
- Use anonymized real-world-like fixtures only when needed.
- Do not commit personal routes unless intentionally synthetic or scrubbed.
- Include fixture provenance notes.

## 14. Performance Considerations

- Large GPX files can contain tens of thousands of points.
- Initial parser can run on the main thread, but isolate parsing behind an async API so Web Worker migration is easy.
- Consider downsampling for rendering and charts while preserving original data for stats.
- Avoid storing duplicate large arrays where possible.
- Use memoization for GeoJSON and chart series derived from the current activity.
- Cache derived chart series by activity identity and x-axis mode.
- Axis tick generation should be deterministic and cheap; compute ticks from visible domain and x-axis mode rather than sampling rendered pixels on every frame.
- Cache focused chart/map derivations by activity identity, selected range, and x-axis mode when needed.
- Pace calculation over noisy GPS points may need smoothing or interval bucketing to avoid unreadable spikes.
- Speed calculation over noisy GPS points may need smoothing or interval bucketing to avoid unreadable spikes.
- Map hover interaction over dense tracks may require spatial indexing or nearest-point approximation later.
- Range selection over dense charts should avoid per-pointer-move full recomputation; update the visual overlay during drag and derive the focused activity on release.
- FIT parsing may be CPU-heavy; plan to move parser work to a Web Worker if UI stalls.
- FIT export can be correctness-sensitive because FIT is binary and schema-driven; prefer a proven browser-compatible encoder if one satisfies license and bundle constraints.
- XML export for GPX/TCX should use structured serialization instead of string concatenation when practical.

## 15. Error Handling Principles

- Distinguish unsupported file, malformed file, parse warning, and render limitation.
- Errors should explain what the user can do next.
- Parser warnings should not block route display unless core route data is missing.
- Missing sensor streams should be normal, not an error.
- Missing map tiles should not invalidate the loaded activity.
- Parse or validation errors should keep the app in the upload/error layout and should not show an empty map placeholder.
- Settings modal errors should not affect loaded activity data or route state.
- Theme resolution errors should fall back to light and not block the app.
- Terms page rendering errors should not affect activity-processing state.

Example error categories:

- `unsupported_format`
- `invalid_gpx_xml`
- `no_route_points`
- `no_location_stream`
- `map_style_load_failed`
- `fit_parse_failed`
- `large_file_slow_parse`
- `invalid_selected_range`
- `selected_range_has_no_location`
- `activity_processing_failed`
- `chart_axis_layout_failed`
- `settings_modal_failed`
- `theme_resolution_failed`
- `terms_page_failed`
- `unsupported_export_format`
- `export_failed`
- `tcx_parse_failed`
