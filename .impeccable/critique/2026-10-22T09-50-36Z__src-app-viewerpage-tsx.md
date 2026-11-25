---
target: the Viewer
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/ViewerPage.tsx"
target_fingerprint: "sha256:c013d5041dc81fa364f53c326d5644ba192fb360182b60b4ef642a1f15483d1d"
target_path: /Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/ViewerPage.tsx
timestamp: 2026-10-22T09-50-36Z
slug: src-app-viewerpage-tsx
---
Method: dual-agent (A: design-review sub-agent · B: detector and browser sub-agent)

# Critique: Viewer (src/app/ViewerPage.tsx)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Load announces nothing, focus drops to body; no hover values; disabled primary button looks enabled |
| 2 | Match System / Real World | 3 | TCX title is a raw ISO timestamp; summary avg pace 60:19 /mi vs chart 8:02 /mi, unlabelled elapsed vs moving |
| 3 | User Control and Freedom | 3 | Reset View and non-destructive focus good; replacing a file needs Close activity first |
| 4 | Consistency and Standards | 2 | Map focus amber / lap violet, reverse of DESIGN.md; hover marker amber on amber focus; device labels break caption rule |
| 5 | Error Prevention | 3 | Unavailable formats disabled with reasons; undercut by enabled-looking disabled button |
| 6 | Recognition Rather Than Recall | 3 | Section nav, axis switch help; chart drag-to-select undiscoverable |
| 7 | Flexibility and Efficiency | 1 | No keyboard scrub/range selection, no shortcuts, no drop-to-replace |
| 8 | Aesthetic and Minimalist Design | 2 | 4-7 unavailable chart stubs, 430px empty map box, 11-cell stat grid without a lead figure |
| 9 | Error Recovery | 3 | Message + hint + code; malformed XML gives no line; only Dismiss |
| 10 | Help and Documentation | 3 | Inline notes exemplary; interactions unexplained |
| **Total** | | **25/40** | **Acceptable** |

## Design Specificity Verdict
Voice authored (candid loss copy, "Your file is unchanged", sensor panel note); composition generic (stats card, map + laps, chart stack, export form). "Instrument Panel" with no live readout; charts with independent x-domains so hover cursors misalign; the inspector question (which fields the file carries) is buried.
Deterministic: CLI scan clean (0 findings, 15 files). Browser overlay 3-7 typographic findings per view: 11px .dropzone__hint/.summary__source/.chart__note (global.css), flat type hierarchy (~1.15:1 steps), .empty-state__note ~89ch, stragglers in .export__body/.chart__empty (no text-wrap: pretty). Root cause: no font-size tokens. False positives: 10px map attribution (deliberate MapLibre override, map.css:46, counted 3x); FIT hierarchy sampled a stat value as body. Overlay ran headless only; no user-visible overlay.

## Priority Issues
- [P1] Charts keyboard-inaccessible: ActivityChart.tsx:356-362 pointer-only svg role=img, no tabindex. Fix: focusable plot with arrows/Shift/Enter/Esc + live region, or numeric Select-section form. /impeccable harden
- [P1] Load and close lose focus, no announcement: ViewerPage.tsx:132-156, AppShell Close activity unmounts itself. Fix: focus summary h2 + announce on load; focus drop zone on close. /impeccable harden
- [P1] No cursor readout; charts don't share x-domain (ActivityChart.tsx:470-479; Pace 110-328 ft vs Elevation 0-438 ft). Fix: shared domain + sticky readout row driven by active point. /impeccable shape
- [P2] State lies: .button--primary no :disabled (global.css:612-620); lap affordance inverted, reason only in title (LapsPanel.tsx:99-103); map palette swapped vs Fixed Map Rule (ActivityMap.tsx:355,370), basemap dim -0.3 too weak. /impeccable polish
- [P2] Empty boxes and wrong-sport stubs (src/domain/charts.ts:128-165; MapPlaceholder no-route). Fix: one "Not in this file" line, sport-hidden charts as toggle, drop map section without route. /impeccable distill

## Persona Red Flags
- Alex: no drop-to-replace; no Esc/arrows; scrolls past stubs; drag-only range.
- Sam: charts unfocusable, single-sentence names; focus loss; section nav doesn't move focus; no prefers-reduced-motion anywhere in src; MapLibre controls no focus ring.
- Riley: malformed GPX no position; .txt rejection "or .fit or .tcx or" with stale empty box; 100k-point hover cost untested.
- Converter: loss list only after download; raw "Model 2691"; Rewrite/Convert label flip unexplained.

## Minor Observations
No font-size tokens; 11px notes; phone header wraps at 360px; 150px stat column gives one stat per row on phones; "Nothing is uploaded" three times on empty screen, basemap sentence not linked to Settings; "Drop/click" copy on touch; Device heading no top gap; laps box ~250px blank; flat series take a full chart.

## Questions to Consider
- Why is a live number under the cursor the one thing the Instrument Panel never shows?
- Should the first box answer which fields this file carries and what each format keeps?
- Would one "not in this file" line be more honest and lighter than a box per absence?
