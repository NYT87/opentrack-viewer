# App review — 25 October 2026

> Implementation update: fixes and their verification are recorded in [App Review Tasks](planning/07-app-review-tasks.md). The findings below describe the state at review time.

Reviewed checkout: `99acbe7`, including the existing untracked `src/overlay/export/webmDuration.ts`. No application code was changed. Severity below describes practical app impact; dependency advisory severity is reported separately.

The most important findings concern export storage lifetime, cleanup across tabs, stale asynchronous imports, and export rules that differ between screens. I did not establish a remote code execution or activity-upload vulnerability in the shipped application.

## Findings

### 1. Medium — activity-derived exports survive closing the tab

References: `src/overlay/export/archiveSink.ts:65`, `src/overlay/export/client.ts:279`, `src/components/OverlayExportPanel.tsx:186`, `src/components/BurnedInExportPanel.tsx:184`, `src/app/TermsPage.tsx:27`, `src/components/SettingsModal.tsx:111`.

Exports are written to the origin-private file system (OPFS). React cleanup disposes them when the component unmounts during app navigation, but closing a document does not provide that cleanup guarantee. Stale files are swept when another export starts, rather than whenever the app opens. Consequently, rendered video and overlay frames containing routes or other activity details can remain on disk between sessions. Settings says no activity data is ever stored, and Terms says closing the tab discards it.

**Evidence:** a Chromium probe used the actual archive sink to write synthetic output, terminated its worker, closed the page, opened the app in a new page in the same browser context, and successfully read the old output. This directly establishes persistence across tab closure; it does not imply that unrelated websites can read OPFS.

**Suggested fix:** describe temporary export storage accurately, add explicit deletion controls and startup cleanup with ownership protection, and define a crash-recovery retention policy. Do not promise guaranteed deletion on tab close or rely solely on unload callbacks.

### 2. Medium — starting an export can break another tab’s finished download

References: `src/overlay/export/archiveSink.ts:177`, `src/overlay/export/client.ts:279`.

`removeStaleArchives` removes every prefixed archive except the current job’s file. The lock-based protection only covers files still being written. A completed export is unlocked while its page still offers a download backed by that file. Another tab starting an export therefore treats a live download as stale and deletes it.

**Evidence:** a two-page Chromium probe held a completed OPFS `File` in the first page and invoked the actual cleanup helper in the second. The entry disappeared and reading the first page’s held file failed (`exists: false`, `readable: false`).

**Suggested fix:** maintain ownership for the full download lifetime, including completed exports. Coordinate tabs through locks or another ownership protocol, and reclaim only abandoned outputs. Add a browser regression covering two tabs with completed exports.

### 3. Medium — a late import can undo Close activity or overwrite a newer file

References: `src/state/activityStore.ts:51`, `src/state/activityStore.ts:74`, `src/state/activityStore.ts:90`, `src/app/ViewerPage.tsx:197`.

`loadFile` and `replaceFile` unconditionally publish their asynchronous results. Neither checks that it is still the current request. `clear` and `setActivity` do not invalidate pending requests. The ready viewer accepts another dropped file while replacement is in progress and continues to expose Close activity.

An earlier, slower file can therefore replace a later choice. Closing an activity while its replacement is reading can also result in the activity reappearing after the reader explicitly closed it.

**Evidence:** a deferred file-read probe started a load, cleared the store, released the read, and observed `ready late.gpx`. The same unconditional completion exists in replacement, where closing during the read is reachable from the UI.

**Suggested fix:** use a monotonically increasing request identifier. Invalidate it on every new load, clear, and explicit handoff; check it before publishing progress, success, or failure. Add deferred-read regressions for both out-of-order completion and closing during replacement.

### 4. Medium — merged-track export restrictions disappear in the viewer

References: `src/components/TrackMerge.tsx:254`, `src/exporters/mergedTrack.ts:58`, `src/exporters/index.ts:100`, `src/components/ExportPanel.tsx:92`.

Route Builder blocks TCX for merged recordings because the writer cannot carry their pauses as intended. It also blocks FIT when neighboring stretches meet within the same whole second. “Open in the viewer” hands the same activity to the generic exporter, which only checks for timestamps or coordinates and offers those formats again.

**Evidence:** for the same synthesized merged activity, `mergedTrackFormats` returned TCX unavailable while `getExportAvailability` returned TCX available. The handoff and generic export path are present in the UI. FIT has the same separation of policy.

**Impact:** users can produce files with the exact pause or segment ambiguity that the merge feature explicitly promises to prevent.

**Suggested fix:** enforce preservation requirements in a shared export policy and in serialization entry points. Apply the policy to whole activities and selected sections, regardless of which page initiates export.

### 5. Medium — recorded distance across a segment boundary can count a pause as moving time

References: `src/domain/stats.ts:100`, `src/domain/stats.ts:288`.

`computeMovingDuration` compares consecutive usable time/distance samples without checking `segmentIndex`. GPS-derived distance remains flat at a segment boundary, which hides this problem in common cases. A monotonic source odometer can increase across a pause, and the entire gap is then counted as movement if its average speed passes the threshold.

**Evidence:** four points at 0, 10, 110, and 120 seconds, with source distances 0, 100, 200, and 300 metres and segment indices 0, 0, 1, 1, produced 120 seconds of moving time. The two recorded stretches contain only 20 seconds. Moving averages and overlays derived from these values are consequently affected.

**Suggested fix:** reset the previous movement sample at every segment boundary. Separately decide and document whether source odometer increases across recording gaps belong in total recorded distance. Add source-distance pause coverage; GPS-only pause tests do not catch this.

### 6. Medium — generic imports have no resource ceiling before allocation and parsing

References: `src/parsers/index.ts:95`, `src/parsers/index.ts:105`, `src/parsers/index.ts:116`, `src/parsers/gpx/parseGpx.ts:100`, `src/parsers/tcx/parseTcx.ts:113`.

Generic intake reads the entire text or binary file and parses on the main thread. The 15 MiB “large file” warning is added only after parsing finishes. There is no intake byte limit, point budget, or cancellation mechanism, so a mistakenly selected enormous file or an intentionally hostile import can exhaust memory or stall the tab before a warning is visible. Recursive GPX extension traversal also lacks a depth budget.

The custom canvas has a smaller instance of the same problem: `src/components/CustomCanvas.tsx:216` reads the whole layout before its size check inside `parseOverlayLayout`. The still-image layout importer already checks `file.size` first at `src/components/RouteOverlayPanel.tsx:194`.

**Evidence level:** confirmed from control flow; no destructive out-of-memory test was run. Main-thread parsing is already documented as a limitation in README. This is a local-file availability risk, not an unauthenticated network attack.

**Suggested fix:** reject or obtain an explicit large-file choice before reading; bound points, nesting, and layout size; move suitable parsing into cancellable workers. Apply the existing layout preflight check to Custom Canvas.

## Build and dependency observations

- **The current working tree fails type-checking.** `src/overlay/export/webmDuration.ts:110` assigns `Uint8Array<ArrayBufferLike>` to a field inferred as `Uint8Array<ArrayBuffer>`. This file was already untracked when the review began. `npm run build` runs type-checking first, so the local release command is blocked. This is not a confirmed defect in committed HEAD. Make the buffer types agree before including the file in a change.
- **The lockfile audit reports six vulnerable packages:** two high, three moderate, one low. All six are development dependencies: `undici` 7.30.0, `zod` 4.5.4, `fast-uri` 3.1.8, `serialize-javascript` 7.1.2, `vitest` 4.1.11, and `@vitest/mocker` 4.1.11. `npm audit --omit=dev --json` reports zero vulnerabilities. Refresh and review the lockfile rather than treating these as proven production exploits.
- **Vitest has a patch available at 4.1.12.** The maintainer’s [manual mock registration advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8) requires the affected mocker plugin and a reachable development server. The app uses Node/jsdom tests and does not configure that public browser mocker plugin, so this advisory alone does not establish an exploitable path here.
- **Installed dependencies differ from the lockfile.** `npm ls` shows a pnpm-style tree with extraneous entries and some newer transitive versions, including patched `undici` and `zod`. Tests used that existing installation. Verify a fresh `npm ci` in CI before relying on local results to establish clean-install reproducibility.

## Additional hardening and product considerations

- KML rejects DTD and entity declarations before parsing; GPX and TCX do not. Apply a consistent policy across XML formats. Browser XML protections vary; this review did not establish external entity exfiltration or a working entity-expansion denial of service.
- Add a restrictive Content Security Policy after accounting for module workers, blob media, inline theme initialization, and optional map tiles. Its absence is a defense-in-depth gap, not evidence of an existing XSS exploit.
- CI grants Pages and OIDC write permissions at workflow scope. Restrict these permissions to the deployment jobs that need them.
- Basemap-off is a session preference. Returning users who disabled it receive the default enabled basemap on a later visit. The current behavior is documented, but remembering a privacy choice or defaulting to route-only would better suit the app’s privacy positioning.
- The source scan found no application `eval` or `dangerouslySetInnerHTML`; exported XML escapes text. Existing browser tests cover no-upload behavior, offline use, map request suppression, keyboard flows, responsive layouts, and rendered output. Those are meaningful strengths, although passing them does not cover the lifetime and policy gaps above.

## Validation

- ESLint passed.
- Full Vitest run: 1,652 passed, one timeout out of 1,653. The affected `OverlayPage.canvas.test.tsx` file passed all five tests when rerun alone; treat the initial failure as timing sensitivity unless reproduced independently.
- Type-checking failed in the pre-existing untracked file described above.
- Direct production bundling with `npx vite build` passed, including service worker generation. This bypassed the failing type-check and was used only to review runtime behavior.
- Production browser suite: all 153 tests passed, including the configured Chromium codec project. A temporary Playwright configuration served the directly bundled production output with two workers; application code and the repository’s configuration were unchanged.
- Two focused Chromium storage probes passed, confirming persistence and cross-tab download invalidation. Other focused probes confirmed stale load completion, differing merge export availability, and moving time across source-distance segment boundaries.
- The first browser run used the dev server. Its production-only asset, privacy-query, and service worker expectations are not used as evidence of app defects. Production output was tested separately.

Scope: source review and local Chromium testing, including the codec project configured by the repository. No Safari/Firefox/device certification, deployment-header audit, clean dependency reinstall, exhaustive fuzzing, or formal penetration test was performed. No fixes were applied.
