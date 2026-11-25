---
target: Overlays tool
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 4
target_identity: "file:/Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/OverlayPage.tsx"
target_fingerprint: "sha256:3ff7dd6f06019fb8dd10ed8464df91e260f8bde4184b7d78aea87fb8b3fc7a98"
target_path: /Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/OverlayPage.tsx
timestamp: 2026-10-23T12-43-40Z
slug: src-app-overlaypage-tsx
---
Method: dual-agent (A: design-review sub-agent · B: detector and browser sub-agent)

# Critique: Overlays tool, second run (src/app/OverlayPage.tsx)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Per-slot status, quarter progress, stale warning good; Undo banner off-screen after Start over |
| 2 | Match System / Real World | 2 | Clock mismatch shown as "−39015:18:35"; dates needed |
| 3 | User Control and Freedom | 3 | Undo, Stop, replace-in-place; Undo does not restore a finished download |
| 4 | Consistency and Standards | 3 | Heading vs region name mismatch; two "Reset" buttons; Metric strip not full width |
| 5 | Error Prevention | 2 | Exports enabled with no overlap: empty render possible; invalid offset reverts silently |
| 6 | Recognition Rather Than Recall | 2 | Sliders without values; offset sign rule; line-up needs activity time from elsewhere |
| 7 | Flexibility and Efficiency | 3 | Transport keys, steps, m:ss good; ~37 tab stops to export, no jump |
| 8 | Aesthetic and Minimalist Design | 2 | Privacy line x5; hint paragraphs read as documentation |
| 9 | Error Recovery | 3 | Named error, place kept; raw code shown |
| 10 | Help and Documentation | 2 | No help finding the offset; key map only in an aria-label |
| **Total** | | **25/40** | **Acceptable** |

## Design Specificity Verdict
Behaviour authored (J/K/L, NTSC rates, sync line, "this frame is at…", conform note); look generic (fieldset stack, valueless sliders, picture no more prominent than the forms). Missed: transparent-PNG preview toggle, activity trace under the scrubber.
Deterministic: CLI clean (10 files). Overlay: low-contrast "m:ss" placeholder 4.3:1 (real, no ::placeholder rule); page intro uncapped and phone straggler (real, low); flat-type-hierarchy and overlay-text sizes (likely false positives). Export paragraph line-length fixed. Headless only.

## Priority Issues
- [P1] Sticky stage scrolls inside itself (global.css:1250 max-height + overflow + overscroll contain): picture leaves its column during alignment; wheel trapped. Fix: sticky part = picture, transport, one-line sync; offset to the side column; no internal scroll. /impeccable layout
- [P1] Below 1100px the frame is sticky only within the stage (global.css:1259), so it un-sticks before the controls. Fix: sticky element a direct child of the scroll flow. /impeccable adapt
- [P1] Exports enabled when the overlay draws nothing (no overlap); empty MP4 rendered. Fix: block like nothingOn, say why, point to the offset. /impeccable harden
- [P1] Huge offsets print as hour counts ("−39015:18:35") and the bar collapses (OverlayPreview.tsx:359-377). Fix: dates beyond ~24 h, one-click line up at activity start, hide bar at extreme ratios. /impeccable clarify
- [P2] Undo after Start over off-screen; does not restore a finished export. Fix: scroll to top or place Undo by the focused drop zone; keep export state or warn. /impeccable harden

## Persona Red Flags
- Alex: offset steps 9 tab stops; no [ ] nudge keys; silent offset revert; sliders without readout; fps list does not mark the match.
- Sam: key map only in aria-label; two "Reset"s; heading/region mismatch; select names include option text; overlap alert repeats per keystroke; raw code read; ~37 tab stops.
- Riley: empty exports; −39015-hour message; activity-first route panel pushes the video slot down; Start over unconfirmed, destroys a finished download.
- Creator: no transparent-PNG preview; Metric strip not full width; burned-in shown on phones; estimates 30-150% off.

## Minor Observations
Placeholder contrast; Picture size label wraps and select overflows at 1280; disabled buttons unexplained; impossible sport cadence listed; dark sync tint faint; short imperial distances in ft.

## Questions to Consider
- An activity trace under the scrubber to align by eye?
- A video tool with forms in a drawer?
- "Nothing will be drawn" as a hard stop for both exports?
