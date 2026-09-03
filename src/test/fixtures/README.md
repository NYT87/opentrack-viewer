# Fixture provenance

All fixtures in this directory are **synthetic**, hand-authored for tests. None
originate from a real recorded activity, so no personal route, timestamp, or
device identifier is committed here (plan §13, Fixture Policy).

| File | Purpose |
| --- | --- |
| `simple-route.gpx` | Four points, coordinates + timestamps, no elevation. |
| `route-with-elevation.gpx` | Climb/descent profile plus HR and cadence extensions. |
| `flat-route.gpx` | Elevation jitter under the noise threshold; gain must stay ~0. |
| `device-metadata.gpx` | Device manufacturer, model, software version **and a serial number**, so tests can prove the serial is never rendered. |
| `paused-run.gpx` | Two segments ~5.5 km apart, so distance must not span the gap and no line may be drawn across it. |
| `multi-track.gpx` | Two `<trk>` elements (three segments total), which must all be read into one activity. |
| `run-with-cadence.gpx` | A running activity with time, distance, cadence, and a stationary stretch that must appear as a pace gap. |
| `simple-route-no-time.gpx` | Coordinates and elevation but no timestamps, so the time x-axis is unavailable. |
| `no-location.gpx` | Track points with elevation and time but no coordinates (an indoor session). |
| `no-points.gpx` | Valid GPX with an empty track segment. |
| `malformed.gpx` | Unclosed tag; must fail as `invalid_gpx_xml`. |
| `not-gpx.txt` | Plain text; must fail as `unsupported_format`. |

Coordinates are placed near (0.0, 51.5) in open water/neutral areas and are not
derived from anyone's activity history.
