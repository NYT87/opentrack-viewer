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
| `ride-with-speed.gpx` | A cycling activity at ~8 m/s with pedal cadence, for the speed chart and the running/cycling cadence split. |
| `run-with-cadence.gpx` | A running activity with time, distance, cadence, and a stationary stretch that must appear as a pace gap. |
| `simple-route-no-time.gpx` | Coordinates and elevation but no timestamps, so the time x-axis is unavailable. |
| `no-location.gpx` | Track points with elevation and time but no coordinates (an indoor session). |
| `no-points.gpx` | Valid GPX with an empty track segment. |
| `malformed.gpx` | Unclosed tag; must fail as `invalid_gpx_xml`. |
| `not-gpx.txt` | Plain text; must fail as `unsupported_format`. |
| `ride-with-sensors.fit` | A cycling FIT file with GPS, elevation, HR, pedal cadence, power, temperature **and a device serial number**, so tests can prove the serial is never rendered. |
| `treadmill-run.fit` | A running FIT file with **no GPS at all**: timestamps, a recorded distance stream, HR and stride cadence. |
| `run-with-laps.tcx` | Two laps with HR, run cadence and calories. The second lap holds **two `<Track>` elements**, which is how TCX records a pause, and a `UnitId` **serial number** tests can prove is never shown. |
| `ride-minimal.tcx` | The sparse end of TCX: positions and times only, no `Creator`, and a bare `<Cadence>` the schema defines as pedal revolutions. |
| `laps-without-distance.tcx` | Two continuous laps with **no per-point `DistanceMeters`**, so distance must come from the positions — which is what makes an invented break at the lap boundary visible. |
| `impossible-coordinates.fit` | A latitude past the pole and Null Island, on points that still carry a time and a heart rate. FIT cannot express an out-of-range *longitude* at all: 181 degrees overflows its signed semicircle field, so latitude carries that case. |
| `impossible-coordinates.tcx` | A latitude past the pole, a longitude past the antimeridian, and Null Island — each on a point that still carries a time and a heart rate, so the position can be dropped without the point being dropped with it. |
| `hero7.raw` | A raw GPMF payload from a HERO7, 75 KB: **GPS5** with a real 3D fix and DOP around 1.4, recorded outdoors in Galicia. From [`gopro-telemetry/samples`](https://github.com/JuanIrache/gopro-telemetry/tree/master/samples), MIT. Interpretation is tested from the payload rather than a video, which costs kilobytes instead of megabytes. |
| `hero11.raw` | The same, from a HERO11: **GPS9**, whose fix and DOP live inside each sample rather than in `sticky`. The only fixture covering the newer layout, since GoPro ships no HERO9+ video sample. |
| `hero8.mp4` | **A real GoPro HERO8 clip, 4.2 MB.** Taken from [`gopro/gpmf-parser/samples`](https://github.com/gopro/gpmf-parser/tree/main/samples), which is licensed Apache-2.0 or MIT — © GoPro, Inc. The only fixture here that is not generated, because no synthetic file can stand in for a real `moov`, a real `gpmd` track and real GPMF payloads. Its size is the price of testing extraction against something a camera actually wrote. It was also recorded **indoors**: all 231 of its GPS samples report no fix and land in the North Pacific at nine kilometres altitude, which makes it the fixture for rejecting a track that never had a lock. |
| `gopro-with-telemetry.mp4` | An MP4 container whose tail carries GoPro's `gpmd` and `GoPro` markers, where a camera actually writes them. Generated: detection reads boxes, not pictures, so it holds no video. |
| `plain-video.mp4` | The same container with no telemetry track — the "recognized, but not for us" case. |
| `malformed.tcx` | Unclosed elements; must fail as `invalid_tcx_xml`. |

## The `.fit` fixtures are generated

FIT is a binary format, so its fixtures cannot be read or reviewed in a diff the
way the GPX ones can. `make-fit-fixtures.mjs` is the readable source of truth:
run `node src/test/fixtures/make-fit-fixtures.mjs` after changing it, and commit
the regenerated files.

Its encoder — the header, definition and data records, and the FIT protocol's
nibble-wise CRC-16 — is written by hand rather than taken from the parsing
library. That is deliberate: a fixture generated by the same code that reads it
would agree with a bug in that code. Two independent implementations agreeing on
semicircles, scaled altitude and enum names is worth something; one
implementation agreeing with itself is not.

Coordinates are placed near (0.0, 51.5) in open water/neutral areas and are not
derived from anyone's activity history.
