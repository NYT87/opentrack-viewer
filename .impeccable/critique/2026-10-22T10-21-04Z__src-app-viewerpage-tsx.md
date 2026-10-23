---
target: the Viewer
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/ViewerPage.tsx"
target_fingerprint: "sha256:782d8ea6cf41ae621fdf11ba97adf6194994e63270617ec0d4e91d1a381627ba"
target_path: /Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/ViewerPage.tsx
timestamp: 2026-10-22T10-21-04Z
slug: src-app-viewerpage-tsx
---
Method: dual-agent (A: design-review sub-agent · B: detector and browser sub-agent)

# Critique: Viewer, second run (src/app/ViewerPage.tsx)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Focus bar and Reset View scroll away under the sticky readout once a section is selected |
| 2 | Match System / Real World | 3 | x-axis mixes units ("0 ft" … "0.37 mi"); "Model 2691" raw id |
| 3 | User Control and Freedom | 3 | Escape and Reset View good; Close activity discards in one press |
| 4 | Consistency and Standards | 3 | Per-chart y gutter: shared cursor a few px apart; "Distance" means three things |
| 5 | Error Prevention | 2 | Export defaults to an unavailable format (ExportPanel.tsx:40) |
| 6 | Recognition Rather Than Recall | 3 | Chart keys only in hidden description; visible hint mouse-only |
| 7 | Flexibility and Efficiency | 2 | No drop-to-replace; no section nav below 1100px; a tab stop per chart |
| 8 | Aesthetic and Minimalist Design | 3 | Restrained; flat series still full charts; 11-cell grid without a lead figure |
| 9 | Error Recovery | 3 | Error panel does not name the file; raw code shown as chrome |
| 10 | Help and Documentation | 2 | No inline explanation of moving time, elevation gain, parser notes |
| **Total** | | **27/40** | **Acceptable** |

## Design Specificity Verdict
Partly authored: sticky readout, fixed night map with amber lap and violet selection, candid copy. Structure still equal boxes plus sidebar; overview has no lead figure. Opportunity: one numbers component with whole / section / cursor modes.
Deterministic: CLI clean (17 files). Overlay 1-2 findings per view (was 3-7): flat-type-hierarchy (partly false positive: samples brand h1 16px and export h2 15px, not the 18px title; steps genuinely small), tiny-text on MapLibre attribution (deliberate 11px, false positive). Overlay ran headless only.

## Priority Issues
- [P1] Shared cursor not shared in pixels: per-chart gutter (ActivityChart.tsx:46,132), plots start 312 vs 318px. Fix: one panel-wide gutter passed with xDomain. /impeccable polish
- [P1] Selecting a section inserts ~230px above the charts; Reset View scrolls off. Fix: carry the focused state in the sticky readout row. /impeccable layout
- [P1] Slider valuetext ambiguous ("142 ft: 358 ft"). Fix: "at 142 ft, elevation 358 ft". /impeccable clarify
- [P2] Export defaults to unavailable format (ExportPanel.tsx:40). Fix: first available format. /impeccable harden
- [P2] No section nav or file swap at narrow widths; Export ~5000px down on a phone; no drop on loaded viewer; visible hint mouse-only. /impeccable adapt

## Persona Red Flags
- Alex: close-and-reopen to swap; 5-6 slider tab stops; no shortcut to Export; unround ticks.
- Sam: ambiguous valuetext; section nav precedes title in DOM; map canvas undescribed; "1 parser note" opaque.
- Riley: flat pace series as solid block; 15 s section same start/end (no seconds); error panel unnamed file; device names wrap mid-word.
- Converter: Export last; select opens unavailable; loss as paragraph; no file facts.

## Minor Observations
Title focus ring reads as a text field; readout "Distance" caption clashes with section summary; phone readout scrolls without affordance; no in-viewer cue that tiles are live; empty state repeats privacy line three times and Settings twice in tab order.

## Questions to Consider
- Lead with three large figures and demote the other eight?
- One component for whole / section / cursor numbers?
- For converters, "what's in this file and what export loses" directly under the title?
