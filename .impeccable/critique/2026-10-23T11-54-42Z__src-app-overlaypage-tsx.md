---
target: Overlays tool
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/OverlayPage.tsx"
target_fingerprint: "sha256:a360547c81d915043bd85f2c93e2806eac43333a2da47a1f5316700ab9643545"
target_path: /Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/OverlayPage.tsx
timestamp: 2026-10-23T11-54-42Z
slug: src-app-overlaypage-tsx
---
Method: dual-agent (A: design-review sub-agent · B: detector and browser sub-agent)

# Critique: Overlays tool (src/app/OverlayPage.tsx)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Never says how video and activity were lined up; clip with no clock anchored silently |
| 2 | Match System / Real World | 3 | Plain words; "Held here … until then" points at nothing |
| 3 | User Control and Freedom | 2 | Start over clears files and every setting, unconfirmed; bad activity hides workspace |
| 4 | Consistency and Standards | 2 | Browser-default controls, no accent; two primaries; home-made error box |
| 5 | Error Prevention | 3 | Stale-export warning good; no warning when spans do not overlap |
| 6 | Recognition Rather Than Recall | 2 | Loaded files listed at the bottom; offset sign rule to remember |
| 7 | Flexibility and Efficiency | 1 | No transport keys; scrubber arrows 1% of clip; max offset nudge 1 s |
| 8 | Aesthetic and Minimalist Design | 2 | Long paragraphs; privacy x6; 11-item Show list beside an empty Template group |
| 9 | Error Recovery | 2 | Error names no file or slot, drops the hint, focus to body |
| 10 | Help and Documentation | 3 | Good inline help; nothing on templates or editor frame rate |
| **Total** | | **23/40** | **Acceptable** |

## Design Specificity Verdict
Copy authored (candid limits, stale-export invalidation, "not in this activity", checkerboard transparency); structure is the Terms page (620px prose column), breaking the change-and-see loop. Missed: timeline of video span in activity span, "this frame is this moment" sync, sticky preview, one privacy proof line.
Deterministic: CLI clean (10 files; regex-only on .tsx, undercount). Overlay: line-length ~89-95ch on intro and export paragraphs (real); em-dash overuse 10 (style); undersized overlay text 4-7px (likely false positive, frame-relative sizing on a 256x144 clip; phone preview genuinely unreadable); flat-type-hierarchy (partial false positive, footer headings). Burned-in export not exercised (headless shell has no H.264 encoder). Headless only.

## Priority Issues
- [P1] Preview leaves the screen while its controls are used (preview ends ~595px, controls ~800px, exports ~1500px; ~4px overlay text on phone). Fix: sticky preview and transport beside controls at >=1100px; sticky preview on narrow. /impeccable layout
- [P1] Sync silent and offset unsuited: no-clock anchoring silent (timeline.ts:182-230), non-overlap silent, seconds-only offset with 1 s max nudge. Fix: alignment status line, non-overlap warning, m:ss input, ±10 s/±1 min, "this frame is…", span timeline. /impeccable shape
- [P1] Failed activity read hides workspace and loses state (OverlayPage.tsx:86 idle gate): playhead lost, running export cancelled, download gone, unnamed error, focus to body. Fix: per-slot busy and ErrorPanel, keep previous activity until parse succeeds, focus the slot. /impeccable harden
- [P2] Controls off system: selects without .select, undefined .input, default number/colour inputs, no accent-color; .overlay-preview__hint capped by .prose p max-width splits the offset buttons. /impeccable polish
- [P2] Start over clears files and resets every control (overlayStore.ts:184), unconfirmed, against TD-043. Fix: files only, separate reset, or short undo. /impeccable harden

## Persona Red Flags
- Alex: no Space/J/K/L/frame-step; arrows 1%; ~2,900px to PNG export; picture size twice; no template save/load.
- Sam: focus to body after try-another, replace and Start over; radio names are full descriptions; progress not announced; alert names no file or slot.
- Riley: malformed GPX wipes workspace; replacing activity mid-export cancels silently; non-overlapping run works silently; identical errors for broken containers.
- Creator: no 23.976/29.97/59.94 (plan.ts:11), so a 29.97 clip drifts ~0.6 s per 10 min; no import note; no in/out range.

## Minor Observations
"Add an activity" x3 with no GPS fix; empty Template group and route-preview half; phone time and offset wrapping; dark grey number field; no duration without telemetry clock; error title breaks "Could not open {file}"; burned-in promises before refusing; PNG estimate 2.4x low.

## Questions to Consider
- Alignment as a timeline you slide the video along?
- A workspace rather than a document?
- One tested privacy proof line instead of six?
