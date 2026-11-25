# Overlay export feasibility probe (`AV-1001`)

The measurements behind TD-039 — which browser media APIs can preview and
export telemetry overlays, and how fast. Kept so the numbers can be
re-measured when a browser changes rather than re-remembered.

`probe.js` runs in a page and records, into `window.__result`:

- which APIs exist (WebCodecs, `OffscreenCanvas`, `MediaRecorder`, WebGPU,
  cross-origin isolation, the origin-private file system, …);
- which encoder and decoder configurations `isConfigSupported` accepts, with
  hardware and software preference, including `alpha: 'keep'`;
- whether alpha survives `MediaRecorder` — a transparent canvas is recorded,
  played back over magenta, and a pixel read;
- encode throughput at 1080p and 4K for H.264, HEVC, VP8, VP9 and AV1;
- PNG and WebP cost per frame for an overlay-only image sequence;
- the real-time `canvas.captureStream` + `MediaRecorder` path;
- decoding of `src/test/fixtures/hero8.mp4` through WebCodecs (demuxed by the
  `mp4box` already in the tree) and through a `<video>` element, plus the full
  decode → composite → encode chain.

## Running it

```sh
node scripts/overlay-export-probe/server.mjs            # serves on :8089
node scripts/overlay-export-probe/run.mjs chromium webkit
node scripts/overlay-export-probe/summarize.mjs         # prints results/*.json
```

Engines: `chromium` (Playwright's full build in new headless mode, which
carries H.264 and HEVC; the headless *shell* may not), `brave` (set
`BRAVE_PATH` if it is elsewhere), `webkit`, `firefox`. Each run takes two to
three minutes; software encoders are capped at 25 seconds per configuration.
`?only=decode` on the page URL runs the decode section alone.

## Caveats found the hard way

- **Port 4190 is a restricted port in WebKit.** The page silently never loads.
  Hence 8089.
- **WebKit's `<video>` needs HTTP Range support** from the server, and headless
  WebKit refuses `play()` under its autoplay policy, so the real-time element
  path is unmeasured there.
- **On macOS 14, Playwright installs a frozen WebKit build** (`2251`) that the
  current client cannot drive (`Unknown setting: PushAPIEnabled`). Drive it
  with `playwright-core@1.59`, the version that pinned that build, pointed at
  the same cache.
- Results in `results/` are from an Apple Silicon Mac on 2026-10-15: Chromium
  156, Brave 155 and WebKit 26.4. Firefox was not measured.
