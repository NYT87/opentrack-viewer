---
target: Overlays tool
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/OverlayPage.tsx"
target_fingerprint: "sha256:9aacc8f66d2bb6640d274aaed60b0d3b6a3cebf7524d739d7c6a8aee4111baf4"
target_path: /Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/OverlayPage.tsx
timestamp: 2026-10-23T13-53-37Z
slug: src-app-overlaypage-tsx
---
Method: dual-agent (A: design-review sub-agent · B: detector and browser sub-agent)

# Critique: Overlays tool, third run (src/app/OverlayPage.tsx)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Sync bar and playhead scroll out of view while scrubbing |
| 2 | Match System / Real World | 2 | Offset sign inverse to creators' model ("1:30" puts the video at −1:30) |
| 3 | User Control and Freedom | 3 | Start over undo and confirm good; Reset overlay settings has no Undo |
| 4 | Consistency and Standards | 2 | Three primaries after both exports; two Picture size selects; "Drop a MP4" |
| 5 | Error Prevention | 3 | Empty exports blocked; "This frame is at" accepts 9:99 or past the end |
| 6 | Recognition Rather Than Recall | 3 | Keys shown only on keyboard focus; mouse users never learn them |
| 7 | Flexibility and Efficiency | 2 | 38 tabs to export; 8 step stops; bar not clickable or draggable |
| 8 | Aesthetic and Minimalist Design | 2 | Same-weight fieldset wall; ~250px empty stage; privacy line x5 |
| 9 | Error Recovery | 3 | Named errors, good file kept; raw code shown |
| 10 | Help and Documentation | 3 | Good notes; nothing on how to find the offset |
| **Total** | | **26/40** | **Acceptable** |

## Design Specificity Verdict
Authored in behaviour (empty exports refused, dates for far clocks, "this frame is at", NTSC rates, J/K/L); generic settings-column form. Missed: the sync bar and trace live in the scrolling side column, not under the picture, and cannot be clicked or dragged; no privacy proof strip.
Deterministic: CLI clean (10 files). Overlay: low-contrast 4.3:1 and ~90ch line length on .overlay-sync__warning p (real, my CSS: .prose p overrides colour; max-width removed); uncapped .page__intro and a phone straggler (real); placeholder contrast fixed; overlay-text sizes and flat hierarchy (likely false positives). Headless only.

## Priority Issues
- [P1] Offset sign fights the creator's model (OverlayPreview.tsx:519). Fix: primary field "Video starts at m:ss of the activity", signed offset as readout, earlier/later steps. /impeccable clarify
- [P1] Sync bar and trace scroll away (portal at OverlayPage.tsx:291; empty stage under transport). Fix: bar, trace, playhead into the stage; bar interactive (click to seek, drag to offset, accessible value). /impeccable layout
- [P2] Metric strip wraps into a block, corner artefacts, no legibility guard at 0% background. Fix: one row cap or say capacity, one background per row, text halo under ~0.2 opacity. /impeccable polish
- [P2] Keyboard: focus to body after Start over confirm; 38 tabs; keys only on the frame; scrubber step 0.049 s not one frame. Fix: focus Keep it; roving toolbar or arrow-key steps; keys anywhere in the stage; skip link. /impeccable harden
- [P2] Three primaries and stale download stays primary; PNG estimate 2x low for small frames. Fix: Download primary when ready, Export again primary when stale; estimate floor. /impeccable polish

## Persona Red Flags
- Alex: sign relearned; 8 step stops; no global keys, no click-to-seek; Picture size twice; Reset overlay settings no Undo.
- Sam: focus to body after confirm; bar and trace aria-hidden; steps announced "−1 min"; 15-word picture name; focus on heading after error.
- Riley: "This frame is at 9:99" accepted; controls interactive with nothing to draw.
- Creator: estimate 2x low; strip breaks; no 0% legibility guard; ZIP name lacks offset; blank-frame stretches unexplained.

## Minor Observations
"Drop a MP4"; raw error code; uneven step wrap at 1280; key hint shifts the transport; cycling distance in ft; video slot note reads as an error with a GPX attached; "Desktop browsers only" redundant; dark theme holds up.

## Questions to Consider
- Drag the video block along the trace, with the number as fine-tune?
- Template and export panels only once the files overlap?
- A privacy proof on the footage page instead of five prose repetitions?
