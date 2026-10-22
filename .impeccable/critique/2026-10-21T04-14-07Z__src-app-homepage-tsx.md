---
target: src/app/HomePage.tsx
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/HomePage.tsx"
target_fingerprint: "sha256:0ac035ff82f20bd0e491a2f9bf5e99ba8a6dff7046d88df48ba6d9e839d3ccfe"
target_path: /Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/HomePage.tsx
timestamp: 2026-10-21T04-14-07Z
slug: src-app-homepage-tsx
---
# Critique: src/app/HomePage.tsx — run 5 (after proof strip, two-abreast layout, format captions, Settings button)

Method: dual-agent. Headless; no [Human] overlay.

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility | 3 | Tool name not blue on keyboard focus. |
| 2 | Real world | 3 | Proof captions in test vocabulary. |
| 3 | Control | 3 | Three new-tab links without cue. |
| 4 | Consistency | 3 | Two near-identical links, different targets. |
| 5 | Error prevention | 3 | Burn-in promised; desktop only (BurnedInExportPanel.tsx:270). |
| 6 | Recognition | 3 | Phone: tools below proof strip. |
| 7 | Flexibility | 2 | No GoPro entry in the lead. |
| 8 | Minimalist | 3 | Promise ×5. |
| 9 | Error recovery | 3 | Kept for trend (reviewer n/a). |
| 10 | Help | 3 | Video telemetry vs Overlays not distinguished. |
| **Total** | | **29/40** | **Good** |

## Priority Issues
- [P1] Proof captions overreach their tests: body-only check (viewer.spec.ts never-uploads), load-only window, no-tiles test runs on #/viewer. Fix: "…in a request body", "Uploads when a file is opened", "Outside requests before a file is opened" (or add home-route test). /impeccable clarify.
- [P1] No GoPro entry in the lead; phone hides Overlays below proof strip; ~100px empty under button on desktop. Fix: secondary link line under button; proof after tools at ≤860. /impeccable layout.
- [P2] Overlays burn-in not hedged as desktop-only. /impeccable clarify.
- [P2] Video telemetry vs Overlays: lead with outcomes. /impeccable clarify.
- [P3] .tool:focus-within name colour; trim privacy p3 and footer tagline; delete orphaned CSS comment (global.css:505). /impeccable polish.

## Deterministic
Source 0; URL 1280/390: 1 advisory flat-type-hierarchy (footer h2s; false positive for page). Hit-tests pass; line lengths ≤75; two "Settings" buttons intended; clean load.
