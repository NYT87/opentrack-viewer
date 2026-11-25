---
target: the Viewer
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/ViewerPage.tsx"
target_fingerprint: "sha256:bdd295a82297cd04214d78796905e89b75747af31abfb754435e229b099f8bb2"
target_path: /Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/ViewerPage.tsx
timestamp: 2026-10-22T12-45-17Z
slug: src-app-viewerpage-tsx
---
Method: dual-agent (A: design-review sub-agent · B: detector and browser sub-agent)

# Critique: Viewer, third run (src/app/ViewerPage.tsx)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Announcements good; failed replace-drop silently swaps to the error screen |
| 2 | Match System / Real World | 2 | Lead "Avg pace 60:19 /mi" (elapsed) vs pace chart 8:02 /mi; readout "At 243 ft" on a miles axis |
| 3 | User Control and Freedom | 2 | Corrupt drop destroys the open activity; Reset View drops focus to body |
| 4 | Consistency and Standards | 3 | Export primary button vs DESIGN one-primary rule; disabled route tools without a route |
| 5 | Error Prevention | 2 | Drop-to-replace has no keep-or-replace safety |
| 6 | Recognition Rather Than Recall | 3 | Enter/Escape for sections not visible on screen |
| 7 | Flexibility and Efficiency | 2 | Tab stop per chart; laps and sections unconnected; map first in tab order |
| 8 | Aesthetic and Minimalist Design | 3 | Two stacked instruction lines in the readout; flat series full charts |
| 9 | Error Recovery | 3 | Named error panel good; refused unsupported drop not shown on screen |
| 10 | Help and Documentation | 2 | No key reference; greyed Distance axis unexplained |
| **Total** | | **25/40** | **Acceptable** |

## Design Specificity Verdict
~65% authored (sticky readout with section scope, absence handling, source line). Structure still four same-weight cards; lead row reads as a bigger table row; map is the weakest element (no start/finish/direction/scale).
Deterministic: CLI clean (19 files). Overlay: flat-type-hierarchy and tiny-text on MapLibre attribution (partial false positives, as before); new repeated-container-text: section distance shown 7x, five of them identical x-axis end labels across stacked charts (real redundancy from the shared extent). Headless only.

## Priority Issues
- [P1] Failed replace-drop destroys the open activity (ViewerPage drop calls loadFile, which clears first). Fix: parse aside, commit on success, error as dismissible notice. /impeccable harden
- [P1] Lead pace (elapsed basis, summaryStats primary) contradicts pace chart. Fix: moving-time basis, labelled; check chart basis. Needs product call. /impeccable clarify
- [P1] Reset View unmounts itself; focus to body; status goes silent. Fix: focus the originating chart or scope row; announce whole activity. /impeccable harden
- [P2] Map: no start/finish, no scale, canvas first tab stop announced only "Map", browser focus ring, bright white controls in dark. /impeccable polish
- [P2] No-location: lead row of dashes, disabled route tools, route hint without a route, unexplained disabled axis. /impeccable distill

## Persona Red Flags
- Alex: map and zoom between title and charts in tab order; flat charts uncollapsible; lap cannot become a section; section end time clipped at 1280.
- Sam: focus lost on Reset View; unlabelled map; lap toggle name flips plus aria-pressed; title underline focus looks like a link.
- Riley: malformed drop wipes activity; pace contradiction; END wraps in grid; phone Tools/Close 1px apart; lead trio breaks 2+1 on phone.
- Converter: no channel list or sample rate; no pre-export loss matrix; parser note collapsed.

## Minor Observations
Readout x value ignores scale unit; two instruction lines; orphan hairline above x-axis row; Charts and Laps lack visible box titles; dark map frame merges with canvas; refused drop silent on screen; privacy line ~7 times.

## Questions to Consider
- Readout (whole / cursor / section) as the page's spine?
- One header status instead of seven privacy repetitions?
- A lap as a named section: one model, colour and Reset?
