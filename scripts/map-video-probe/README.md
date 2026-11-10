# Map video rendering probe (`AV-1201`)

The measurements behind TD-064: whether a MapLibre map can be driven frame by
frame, deterministically, and encoded to video in the browser, and at what
cost. Kept so the numbers can be re-measured when a browser or MapLibre
changes rather than re-remembered.

`probe.js` renders a synthetic 28 km loop (5,001 points with GPS noise; no real
ride is used) as a flyover: a 1.5 s intro from the overview, the follow camera
with a heading smoothed over ±400 m, a 1.5 s outro back to the overview. For
every frame it sets the revealed line and the marker, calls `jumpTo`, waits
until nothing is loading, captures the canvas as a `VideoFrame`, hashes its
pixels, and encodes it with Mediabunny. `?run=<config>` renders one
configuration into `window.__result`; `?run=caps` reports WebGL2 limits and
which encoders `canEncodeVideo` accepts.

| Config | What it isolates |
| --- | --- |
| `2d` | 1080p30, 10 s, pitch 0, generated raster tiles, waits for `idle` |
| `2d-lag` | every tile delayed 0–600 ms; must draw the same frames as `2d` |
| `2d-lag-fade` | the same with MapLibre's default fades left on |
| `2d-redraw` | `2d-lag` driven by `map.redraw()`, without the animation loop or `preserveDrawingBuffer` |
| `2d-cold` | after the run, every fifteenth frame drawn again, each on its own fresh map with slow tiles, compared pixel by pixel |
| `3d`, `3d-again`, `3d-lag` | pitch 55° over generated Terrarium elevation tiles, ×1.5, centre height clamped to the ground |
| `3d-clamped-cold`, `3d-pure-cold` | the cold re-draw in 3D, with the centre height from the ground or from the route |
| `2d-vp9` | VP9 in WebM instead of H.264 in MP4 |
| `3d-4k` | 3840×2160, 4 s |
| `2d-export`, `3d-export` | 20 s without pixel hashing: the time a real export takes |
| `2d-noenc` | rendering alone, no encoder |
| `2d-webgl-frame`, `2d-webgl-frame-hash` | `VideoFrame` taken straight from the WebGL canvas rather than a 2D copy (crashes WebKit) |
| `2d-webgl-noenc`, `2d-bitmap` | the crash's controls: direct frames without the encoder, and an `ImageBitmap` copy |
| `2d-fail` | one tile in seven answers 500: `idle` still fires, and the frames that settled after an error are counted |
| `2d-60`, `3d-60` | 60 s without hashing: time, and whether memory grows with length |
| `live-2d`, `live-2d-again`, `live-3d` | OpenFreeMap `liberty`, plus AWS Terrain Tiles for 3D: real request counts. Run only when named |

`server.mjs` generates the tiles per request — a textured raster basemap whose
shading follows the same synthetic hills as the elevation tiles — so no tile
set is committed and no provider is asked. `?lag=<ms>` delays a tile by an
amount seeded from its coordinates, so the slow run is itself repeatable.

## Running it

```sh
node scripts/map-video-probe/server.mjs                 # serves on :8091
node scripts/map-video-probe/run.mjs chromium           # every local config
node scripts/map-video-probe/run.mjs chromium live-2d live-2d-again live-3d
node scripts/map-video-probe/summarize.mjs              # prints results/*.json
```

WebKit on macOS 14 needs the frozen build's own client (see the overlay probe's
README): `npm i playwright-core@1.59.0` in a scratch directory, then
`PLAYWRIGHT_MODULE=<that dir>/node_modules/playwright-core node scripts/map-video-probe/run.mjs webkit`.

Results in `results/` are from an Apple M1 on 2026-11-10. `chromium.json` and
`webkit.json` are the full suite. Their `*-cold` entries come from an earlier
version that drew five frames again on one shared fresh map. `*-review.json`
re-ran the cold checks one fresh map per frame, and added the failure, 60 s
and crash-control runs. `chromium-live.json` holds the live runs.

Peak memory is the summed resident size of the browser's processes, sampled by
the runner with `ps`, because GPU memory is invisible to the page.

## Caveats

- Keep live runs few. OpenFreeMap's terms limit automated collection to
  3,000 tiles or 50 MB at a time and four parallel requests.
- The output is kept in memory (`BufferTarget`), unlike the app, which streams
  it to the origin-private file system.
- Fresh 3D maps created one after another hang WebKit, so `3d-*-cold` is
  Chromium-only.
- Generated raster tiles are noisy, about 115 KB each, so a render over them
  moves more bytes than one over a real basemap.
