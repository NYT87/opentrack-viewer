# App Review Tasks

Source: [App review — 25 October 2026](../app-review-2026-10-25.md).

All twelve tasks are **Complete** for implementation and local verification. Hosted CI and deployment will exercise the workflow changes when these changes are pushed. Priority describes implementation order: P1 means address first, P2 means follow-up, and P3 means optional improvement. These priorities do not replace the severity assessments in the review. The hardening tasks below are preventive improvements, not confirmed exploits.

## Recommended order

1. Resolve the local build blocker (AR-001).
2. Protect export ownership across tabs (AR-002), then implement retention and cleanup (AR-003).
3. Fix import races, export policy, and moving-time calculations (AR-004–AR-006).
4. Bound imports and reconcile dependencies (AR-007–AR-008).
5. Apply preventive hardening and evaluate the optional privacy preference (AR-009–AR-012).

## AR-001 — Restore the normal production build

Priority: P1. Status: Complete. Dependencies: none.

**Description:** The review found a TypeScript buffer-type mismatch in the pre-existing untracked `webmDuration.ts`. It blocks type-checking and therefore `npm run build`. Confirm whether this file belongs in the current change, and fix the typing if it does. Treat this as a working-tree issue rather than a confirmed defect in committed HEAD.

**Relevant files:** `src/overlay/export/webmDuration.ts`, `tsconfig.json`, `package.json`.

**Acceptance criteria:**

- The cursor buffer and read callback use compatible typed-array buffer types without an unsafe cast hiding the mismatch.
- `npm run typecheck` and the normal `npm run build` pass.
- The existing untracked work is preserved and its inclusion is deliberate.

## AR-002 — Keep finished exports owned until their downloads are released

Priority: P1. Status: Complete. Dependencies: none.

**Description:** Starting an export currently sweeps all other prefixed archives. A completed archive is unlocked even while another tab still offers its download, so cleanup can delete that file and invalidate the download. Introduce ownership that lasts through both rendering and the finished download state.

**Relevant files:** `src/overlay/export/archiveSink.ts`, `src/overlay/export/client.ts`, `src/components/OverlayExportPanel.tsx`, `src/components/BurnedInExportPanel.tsx`.

**Acceptance criteria:**

- Cleanup preserves exports still owned by another tab, including completed outputs.
- Ownership is released when an output is explicitly discarded or its owning page is gone.
- Abandoned files can be reclaimed without deleting unrelated origin storage.
- A two-tab browser regression confirms that starting an export in one tab leaves the other tab’s finished download readable.

## AR-003 — Implement an accurate export retention and deletion policy

Priority: P1. Status: Complete. Dependencies: AR-002.

**Description:** Export files written to the origin-private file system can survive tab closure. The app currently says no activity data is stored and closing the tab discards it. Define how temporary exports are retained and reclaimed, implement that policy, and align the user-facing explanation with actual behavior.

**Relevant files:** `src/overlay/export/archiveSink.ts`, `src/overlay/export/client.ts`, `src/app/AppShell.tsx`, `src/app/TermsPage.tsx`, `src/components/SettingsModal.tsx`, `README.md`.

**Acceptance criteria:**

- A documented policy covers active exports, completed downloads, closed tabs, crashes, and later visits.
- Startup cleanup reclaims abandoned outputs while respecting AR-002’s ownership protection.
- Users can explicitly delete retained exports; the deletion scope is clear.
- Privacy copy describes temporary local disk storage and its deletion behavior accurately.
- The implementation does not depend on guaranteed execution of unload handlers.
- Browser coverage verifies later-visit cleanup and explicit deletion using synthetic data.

## AR-004 — Prevent superseded file reads from changing current activity state

Priority: P1. Status: Complete. Dependencies: none.

**Description:** `loadFile` and `replaceFile` publish results without checking whether the request is still current. A slower earlier import can overwrite a newer file, and a pending replacement can reopen an activity after Close activity. Invalidate pending requests whenever a new load, clear, or explicit activity handoff occurs.

**Relevant files:** `src/state/activityStore.ts`, `src/app/ViewerPage.tsx`.

**Acceptance criteria:**

- Only the current request may publish progress, success, or failure.
- Clearing an activity or handing off a different activity invalidates earlier reads.
- Late completion of a replacement leaves a closed activity closed.
- Deferred-read tests cover out-of-order completions, stale failures, and clear/handoff during a read.
- A failed current replacement continues to preserve the previously open activity.

## AR-005 — Enforce export preservation rules across all entry points

Priority: P1. Status: Complete. Dependencies: none.

**Description:** Route Builder blocks formats that cannot preserve a merged activity’s pauses or segment boundaries, but opening that activity in the viewer bypasses those checks. Centralize export eligibility so screen navigation cannot change which unsafe exports are allowed.

**Relevant files:** `src/exporters/index.ts`, `src/exporters/mergedTrack.ts`, `src/components/ExportPanel.tsx`, `src/components/TrackMerge.tsx`.

**Acceptance criteria:**

- Route Builder and the viewer use the same preservation policy for the same export source.
- Serialization rejects a disallowed format even when called directly.
- TCX remains unavailable when the writer cannot preserve the relevant pauses.
- FIT remains unavailable when neighboring stretches cannot be distinguished at whole-second precision.
- Selected sections are evaluated using the data they actually contain.
- A regression covers merging tracks, opening the result in the viewer, and checking the offered formats and refusal reasons.

## AR-006 — Exclude segment gaps from moving time

Priority: P1. Status: Complete. Dependencies: none.

**Description:** Moving-time calculations compare time and cumulative distance across segment boundaries. When a source odometer increases across a gap, the calculation can count the entire pause as movement. Reset interval tracking at each boundary and document the separate treatment of odometer jumps in total distance.

**Relevant files:** `src/domain/stats.ts`, `src/domain/stats.test.ts`, `src/domain/mergeTracks.test.ts`.

**Acceptance criteria:**

- Moving time never includes the interval between distinct recorded segments.
- Points at 0, 10, 110, and 120 seconds, distances 0, 100, 200, and 300 metres, and segments 0, 0, 1, and 1 yield 20 seconds of moving time.
- Existing continuous-track and GPS-derived calculations retain their intended behavior.
- Moving averages and dependent overlay values reflect the corrected duration.
- The policy for source-distance increases across gaps is documented and covered by a regression.

## AR-007 — Bound import resource use before reading and parsing

Priority: P2. Status: Complete. Dependencies: none.

**Description:** Generic imports read entire files and parse on the main thread before the large-file warning appears. Add preflight byte limits and explicit parsing budgets. Apply the existing layout-size preflight check to Custom Canvas, which currently reads a layout before checking its size. Evaluate cancellable workers where supported; XML parsing requires a worker-compatible parser strategy.

**Relevant files:** `src/parsers/index.ts`, `src/parsers/gpx/parseGpx.ts`, `src/parsers/tcx/parseTcx.ts`, `src/parsers/kml/parseKml.ts`, `src/parsers/fit/parseFit.ts`, `src/components/CustomCanvas.tsx`, `src/components/RouteOverlayPanel.tsx`.

**Acceptance criteria:**

- Intake checks declared file size before calling full-file `text()` or `arrayBuffer()`.
- Limits and any supported large-file override are explicit and communicated before expensive work starts.
- Point and nesting budgets stop excessive inputs with actionable errors.
- Oversized Custom Canvas layouts are refused before their contents are read.
- Refused replacements leave the existing activity intact.
- Boundary tests verify early refusal without allocating huge files or exhausting the test process.
- The supported approach to cancellation and main-thread responsiveness is documented.

## AR-008 — Reconcile the lockfile and patch flagged development dependencies

Priority: P2. Status: Complete. Dependencies: none; final build verification follows AR-001.

**Description:** The review’s lockfile audit flagged six development packages, while the existing installed tree contained different transitive versions and extraneous entries. Update affected dependencies and verify a clean installation using the repository’s documented package manager. The review found zero production dependency advisories; do not present the development advisory counts as confirmed production exploits.

**Relevant files:** `package.json`, `package-lock.json`, `.github/workflows/ci-deploy.yml`.

**Acceptance criteria:**

- Recheck current advisories and update affected packages to compatible patched versions; Vitest 4.1.12 was the available patch identified by the review.
- Lockfile changes are reproducible and reviewed for unintended upgrades.
- A fresh `npm ci` in an isolated checkout succeeds.
- Lint, type-checking, unit tests, production build, and browser tests run against the clean installation.
- Remaining advisories, if any, have documented applicability and follow-up actions.

## AR-009 — Apply a consistent XML declaration policy

Priority: P2, preventive hardening. Status: Complete. Dependencies: none.

**Description:** KML rejects DTD and entity declarations before passing input to `DOMParser`; GPX and TCX do not. Use the same refusal policy across XML imports. The review did not demonstrate external entity exfiltration or an entity-expansion exploit.

**Relevant files:** `src/parsers/gpx/parseGpx.ts`, `src/parsers/tcx/parseTcx.ts`, `src/parsers/kml/parseKml.ts`.

**Acceptance criteria:**

- All three XML import paths reject unsupported DTD/entity declarations before DOM parsing.
- Refusals use the appropriate typed format error and readable message.
- Valid XML, standard escaped characters, namespaces, and supported extensions continue to parse.
- Tests establish pre-parser rejection rather than relying on a browser-specific expansion limit.

## AR-010 — Add and verify a restrictive Content Security Policy

Priority: P2, preventive hardening. Status: Complete. Dependencies: none.

**Description:** Add a policy compatible with static hosting that limits script execution and network destinations while supporting the app’s workers, local video, generated downloads, and optional basemap. Account for inline theme initialization and the service worker registration path. Absence of a policy is a defense-in-depth gap rather than proof of XSS.

**Relevant files:** `index.html`, `vite.config.ts`, `src/components/ActivityMap.tsx`, `src/components/OverlayPreview.tsx`, `src/overlay/export/client.ts`.

**Acceptance criteria:**

- The production document includes an effective policy using the deployment’s supported mechanism.
- Inline initialization is explicitly authorized or moved to a permitted script.
- Worker startup, video preview, exports, offline operation, and enabled basemap tiles still function.
- Route-only mode remains free of external tile requests.
- Browser checks cover representative allowed features and a harmless blocked script attempt.

## AR-011 — Limit deployment permissions to the jobs that need them

Priority: P2, preventive hardening. Status: Complete. Dependencies: none.

**Description:** Pages and OIDC write permissions are currently granted at workflow scope. Give validation jobs only the permissions they need, and grant deployment capabilities at the appropriate job scope.

**Relevant files:** `.github/workflows/ci-deploy.yml`.

**Acceptance criteria:**

- Verification jobs have read-only repository access and no unnecessary Pages or OIDC write permissions.
- Jobs that configure or deploy Pages retain the exact permissions their actions require.
- Pull-request validation and eligible main-branch deployment continue to work.
- Existing deployment branch and environment restrictions remain effective.

## AR-012 — Evaluate remembering the user’s basemap privacy choice

Priority: P3, optional product decision. Status: Complete. Dependencies: none.

**Description:** Disabling basemap tiles currently lasts only for the session. A returning user receives the enabled default again. Decide whether to remember the choice or default to route-only mode. This changes documented product behavior and should be treated as a deliberate preference decision, not a confirmed security defect.

**Relevant files:** `src/state/interactionStore.ts`, `src/domain/preferences.ts`, `src/components/SettingsModal.tsx`, `README.md`.

**Acceptance criteria:**

- The chosen behavior and rationale are recorded in the planning decisions.
- If preference persistence is selected, only the boolean preference is stored; no route, activity, or filename is persisted with it.
- Settings and privacy documentation accurately explain the behavior.
- A browser regression verifies that reload behavior matches the decision and that disabled basemaps issue no tile requests.

## Verification note

The review’s full unit run had one timeout in `OverlayPage.canvas.test.tsx`; all five tests in that file passed on an isolated rerun. Reassess this during AR-008’s clean-install verification. If it repeats, investigate the slow or unstable operation before increasing timeouts. The production browser suite passed all 153 tests during the review.


## Implementation results

| Task | Result |
| --- | --- |
| AR-001 | Corrected the cursor buffer annotation in the existing untracked WebM module; the normal type-check and build now pass. |
| AR-002 | Document-owned Web Locks protect archives through rendering and the completed download state; disposal releases ownership. |
| AR-003 | Added startup reclamation, explicit Discard export controls, Settings cleanup, and accurate temporary-storage copy. New disk exports require cross-tab coordination; other browsers use bounded memory. |
| AR-004 | Request generations invalidate superseded progress, success, and failures on new loads, clear, and handoff. |
| AR-005 | Shared preservation checks are enforced by availability, generic exports, and direct FIT/TCX serializers; selected sections are assessed separately. |
| AR-006 | Moving time ignores segment gaps; source odometers remain authoritative for total distance, as documented in the decisions. |
| AR-007 | Added 32 MiB, 250,000-point, 64-level XML, and 2,000,000-element limits; Custom Canvas refuses oversized layout files before reading them. |
| AR-008 | Updated Vitest/mocker to 4.1.12 and patched flagged transitive packages. A standard clean npm ci succeeds and audits with zero vulnerabilities. |
| AR-009 | GPX, TCX and KML share declaration rejection before DOM parsing. |
| AR-010 | Production HTML uses a CSP with hashed inline initialization, restricted sources and connections, local media/worker support, and browser regressions. The GoPro binary-parser dependency requires a documented unsafe-eval exception; arbitrary inline and blob scripts remain blocked. |
| AR-011 | Verification has repository read access, the build adds Pages read access, and only deployment receives Pages/OIDC write permissions. |
| AR-012 | The basemap boolean persists in a namespaced preference key; browser coverage verifies reload behavior without activity persistence. |

## Final validation

Validation used a separate copy of the current source with a fresh standard
`npm ci`, preserving the workspace’s pre-existing dependency installation.

- Clean install and dependency audit: passed; zero vulnerabilities.
- ESLint, TypeScript, and the normal production build: passed.
- Unit/component suite: **1,670 tests passed** across 87 files, using two workers.
  The earlier custom-canvas timeout did not recur in the clean-install runs.
- Production browser suite: **158 tests passed**; one video-inspection fixture
  needed updating because the new CSP blocks its blob-script import. The fixture
  now decodes the synthetic output in a separately fulfilled local inspection
  document. That test passed on its targeted rerun, verifying all **159 cases**
  without weakening the application policy.
- Six new browser regressions cover export ownership, startup reclamation,
  explicit cleanup/discard, CSP enforcement, basemap persistence, and merged
  export policy after handoff.
- `git diff --check`: passed.

Parsing still runs on the main thread within the new budgets. A cancellable XML
worker requires a worker-compatible parser and remains a future performance
improvement. The CSP’s GoPro eval exception is a dependency compatibility
constraint, recorded in README. No hosted workflow or deployment was triggered
as part of local verification.
