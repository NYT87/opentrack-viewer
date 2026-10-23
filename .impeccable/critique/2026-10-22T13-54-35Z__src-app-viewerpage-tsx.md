---
target: the Viewer
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/ViewerPage.tsx"
target_fingerprint: "sha256:7b27c16cbfb40452943b82ce1f69c6e07319722ebeb3e47525c0ab3d8e2c4b63"
target_path: /Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/ViewerPage.tsx
timestamp: 2026-10-22T13-54-35Z
slug: src-app-viewerpage-tsx
---
Method: dual-agent (A: design-review sub-agent · B: detector and browser sub-agent)

# Critique: Viewer, fourth run (src/app/ViewerPage.tsx)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Drop result reported at the top of the page, out of view when scrolled |
| 2 | Match System / Real World | 3 | Y ticks on raw values (328/377/427 ft); short run distance in ft |
| 3 | User Control and Freedom | 3 | Reset View forgets the cursor; no fit-route after panning |
| 4 | Consistency and Standards | 2 | Export defaults to section, other tools to whole activity; readout unit flips on keep |
| 5 | Error Prevention | 3 | Replacement parsed aside; Export section pre-selected |
| 6 | Recognition Rather Than Recall | 3 | Key help on screen, hidden on phones |
| 7 | Flexibility and Efficiency | 2 | No shortcuts, no skip link, tab stop per chart |
| 8 | Aesthetic and Minimalist Design | 3 | Export process copy; repeated per-chart x-axis meta |
| 9 | Error Recovery | 3 | Raw code shown; no next step |
| 10 | Help and Documentation | 1 | No in-context help for gestures; no link to limits docs |
| **Total** | | **26/40** | **Acceptable** |

## Design Specificity Verdict
Specific in copy and behaviour (lead fields, shared readout, night map, reassurance in place); generic in structure and chart panel (five identical 190px area charts, raw-value ticks, flat series full plots). Inspector audience still gets a source line only.
Deterministic: CLI clean (20 files). Overlay: flat-type-hierarchy, tiny-text on MapLibre attribution (false positive), tiny-text on .summary__missing small 11px (global.css:453, real), repeated-container-text "387 ft" x3 (likely false positive). Headless only.

## Priority Issues
- [P1] Replace-drop result invisible when scrolled: notice at top of sections, overlay text at top of main. Fix: sticky/fixed notice in viewport; centre overlay text. /impeccable harden
- [P1] Chart axes not instrument-grade: buildGridLines four equal steps; flat series full plot. Fix: nice-number ticks; collapse flat series. /impeccable polish
- [P2] Export scope defaults disagree (ExportPanel.tsx:44 section vs RouteOverlayLink/CustomTrackLink whole). Fix: whole by default; scope in button label. /impeccable harden
- [P2] Readout unit flips on keep (scaleMax from focused domain); Reset forgets cursor. /impeccable polish
- [P2] Map: rest of route dims to 0.28 with a section; fixed 46vh for tiny routes; no fit-route; 3.5px hover target. /impeccable polish

## Persona Red Flags
- Alex: 13 tab stops to first chart, no skip link; no lap/section shortcuts; hint reappears.
- Sam: map description promises arrow stepping the canvas does not do; title ring after mouse open; silent co-moving charts; raw code read aloud.
- Riley: silent drop when scrolled; arrow step ~111 points on 100k file; missing reason twice for hover; phone lead caption wraps.
- Converter: no channel inventory; section pre-selected; loss only after download; file stem vs name.

## Minor Observations
Temperature precision mismatch; repeated x-axis meta; section start clipped and full date; laps box dead space; stray hairline above x-axis row; export tools read as formats.

## Questions to Consider
- One compact stacked strip with a channel picker, readout as hero?
- A file-inspector view for converters?
- Drop-to-replace vs comparing two recordings?
