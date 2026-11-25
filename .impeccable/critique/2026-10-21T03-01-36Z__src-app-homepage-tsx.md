---
target: src/app/HomePage.tsx
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/HomePage.tsx"
target_fingerprint: "sha256:35c75dee1295b946c83c74a5742a03c552912b86a187ad4312791b3a93fd4b59"
target_path: /Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/HomePage.tsx
timestamp: 2026-10-21T03-01-36Z
slug: src-app-homepage-tsx
closed: true
---
# Critique: src/app/HomePage.tsx (Home page, Persuade) — run 4

Method: dual-agent (A: design review sub-agent · B: detector/browser sub-agent). Headless Chromium; no [Human] overlay tab. All three P1s from run 3 confirmed cleared (links underlined; tool rows stretched; Overlays copy accurate).

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Proof line is a claim, not a status; external links lack a new-tab cue. |
| 2 | Match System / Real World | 3 | "telemetry", "activity" before definition. |
| 3 | User Control and Freedom | 3 | "in Settings" with no way there. |
| 4 | Consistency and Standards | 3 | KML "SUPPORTED" + "Not written". |
| 5 | Error Prevention | 3 | Pre-empts the tile leak. |
| 6 | Recognition Rather Than Recall | 3 | "Settings" = unlabeled gear. |
| 7 | Flexibility and Efficiency | 2 | No skip link, no drop target. |
| 8 | Aesthetic and Minimalist Design | 3 | Promise ×4, viewer ×4 ways, spec linked twice, identical pills. |
| 9 | Error Recovery | 3 | Kept applicable for trend (reviewer: n/a). |
| 10 | Help and Documentation | 3 | README privacy section never linked. |
| **Total** | | **28/40** | **Good** |

## Design Specificity Verdict

LLM: textually specific, visually generic. Three audiences legible in first viewport at every width. Instrument Panel idiom absent from the front door; differentiator asserted via a TypeScript link; 290px dead column beside privacy prose at ≥900.

Deterministic: source scans 0. URL scans 1280/390: 0 counted, 1 advisory `flat-type-hierarchy` (false positive for the page: 24px title → 1.6:1; residue is shell h1 16px < h2, footer h2 12px < body). Verified: `.page__proof a` and `.prose .link` 1px underline in 60% accent; all four `.tool` rows hit-test to the name link; accessible names are labels only. Clean load.

## Priority Issues

- [P1] Differentiator asserted, not shown; no instrument-panel artefact. Fix: replace `.page__proof` with a hairline proof strip in caption-over-figure idiom (three captions over "0 allowed", trailing "Enforced by a browser test" link), in the right column at ≥860, under the button below. Command: /impeccable shape.
- [P1] Proof link sends non-engineers to raw TypeScript in a new tab with no cue. Fix: hero link → README.md#privacy-model labelled "how this is tested"; spec URL only in prose with visible "(GitHub)". Command: /impeccable clarify.
- [P2] Left-heavy layout below the tool grid at ≥900. Fix: privacy prose and Formats two abreast in the tool grid, or Formats in the proof strip's right column. Command: /impeccable layout.
- [P2] Formats block: four identical accent pills, unused 'Planned', KML contradiction. Fix: muted "Read · Write" / "Read only" captions. Command: /impeccable distill.
- [P3] "Settings" named in prose with no way to open it. Fix: link-styled button opening the dialog, or "(the gear in the header)". Command: /impeccable clarify.

## Persona Red Flags

- Jordan: "activity"/"telemetry" undefined; browser-test link lands on code.
- Riley: tool-row description text not selectable (stretched link); scroll-tap anywhere in row navigates. 320/200%/long strings pass.
- Casey: proof link 76x16 12px under the button; footer six stacked links; fourth "Open an activity".
- Morgan: GoPro twelve words in; primary button wrong tool; Video telemetry listed first reads as prerequisite; MP4/MOV unnamed; burn-in not hedged.

## Minor Observations

- Primary hover imperceptible; inline link focus ring touches glyphs; caret glyph vs drawn arrow; spec linked twice; promise ×4; footer h2 level; dark primary focus ring low-margin.

## Questions to Consider

- Why does the home page not count requests live?
- Is "Open an activity" the right primary action for three audiences?
- Is a route line from a fixture "imagery" or the instrument's own reading?
