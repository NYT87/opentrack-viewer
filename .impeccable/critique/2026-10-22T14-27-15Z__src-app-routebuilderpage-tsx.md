---
target: Route Builder
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 4
target_identity: "file:/Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/RouteBuilderPage.tsx"
target_fingerprint: "sha256:1ca96bea57f7af295200b23b42ce5e777c659ea608cb14f8e25ed7c0b72d593d"
target_path: /Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/RouteBuilderPage.tsx
timestamp: 2026-10-22T14-27-15Z
slug: src-app-routebuilderpage-tsx
---
Method: dual-agent (A: design-review sub-agent · B: detector and browser sub-agent)

# Critique: Route Builder (src/app/RouteBuilderPage.tsx)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Adds announce nothing; typed points can land off screen; phone map-press result below the fold |
| 2 | Match System / Real World | 3 | Good vocabulary; "Planned-track-planned-track.gpx"; "Started as" misreports |
| 3 | User Control and Freedom | 2 | Start over unguarded and outside undo; undo of a discard loses marks; no redo |
| 4 | Consistency and Standards | 2 | UA inputs/fieldsets and focus ring; sentences in caption style; import error not ErrorPanel |
| 5 | Error Prevention | 3 | Refusals change nothing; violet preview; Start over unguarded |
| 6 | Recognition Rather Than Recall | 2 | Points only "point 3 of 12"; no list, no map labels |
| 7 | Flexibility and Efficiency | 1 | No shortcuts, no insert-between, no paste of "lat, lon"; one-step Previous/Next |
| 8 | Aesthetic and Minimalist Design | 2 | Up to 13 equal-weight controls; privacy line x3; 30-word status |
| 9 | Error Recovery | 3 | Specific messages; import error hides drop zone, no file name |
| 10 | Help and Documentation | 3 | Honest inline help, verbose and always on |
| **Total** | | **23/40** | **Acceptable** |

## Design Specificity Verdict
Thinking specific (copy, model: never dragged, measured jumps, disabled FIT/TCX with reasons); surface generic (620px prose column shared with Overlays/Video, padded map box against DESIGN.md). Missed: point list, direction/numbering on the map, side-by-side map and editor at 1280.
Deterministic: CLI clean (6 files). Overlay: line-length ~89-97 chars on .page__intro and empty-state p (real: intro uncapped, 66ch cap still ~89 chars); flat-type-hierarchy (partly false positive: footer/shell headings sampled; 15px h3 vs 14px body genuinely narrow); tiny-text on MapLibre attribution (false positive); phone straggler in sources list (minor). Headless only.

## Priority Issues
- [P1] Remove point / Discard section / Deselect unmount the focused button; focus to body (RouteBuilderPage.tsx:666-675, 736-750). Fix: select neighbour, focus Undo, or keep mounted disabled. /impeccable harden
- [P1] Viewer handoff lands at scrollTop 1289 with focus on body. Fix: reset scroll and focus draft title on route change, ideally in AppShell. /impeccable harden
- [P1] Start over wipes draft and history (routeDraftStore.ts:146), unguarded, first control. Fix: keep it in undo history; move to end, quieter destructive style. /impeccable harden
- [P1] No insert-between though addPoint supports afterId (routeDraft.ts:436-441). Fix: "inserts after selected" mode and typed button. /impeccable shape
- [P2] Editor wall: UA fieldsets/inputs, caption-style sentences, 13 equal buttons. Fix: system styling, 12px descriptions, three titled groups, map and editor side by side at >=1100px. /impeccable layout

## Persona Red Flags
- Alex: one-step Previous/Next through 6,000; no Ctrl+Z, no paste "lat, lon"; no fit-to-track.
- Sam: focus lost after Remove/Discard/handoff; adds silent; canvas "Map"; pointer-only legend.
- Riley: Start over + Enter irreversible; malformed import hides drop zone, unnamed; "Select the join" lingers after join.
- Athlete: no direction cue; no insert; "Planned-track-planned-track" name, no rename; no elevation gain.

## Minor Observations
Padded map box; wrong "Started as" after append to blank; 30-word status repeats intro; add form keeps values, Enter re-adds silently; FIT/TCX reasons 5 lines on phone; Undo does not name the edit.

## Questions to Consider
- A numbered, keyboard-navigable point table synced to the map?
- Why is Start over outside the undo history TD-052 chose?
- Direction of travel vs three privacy repetitions at export?
