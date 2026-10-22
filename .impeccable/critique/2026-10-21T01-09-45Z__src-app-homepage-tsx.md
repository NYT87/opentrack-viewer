---
target: src/app/HomePage.tsx
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:/Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/HomePage.tsx"
target_fingerprint: "sha256:9ab3d714970ea0839434c292c602c05cbae10e05d0da52f4c52c9b955efeaedc"
target_path: /Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/HomePage.tsx
timestamp: 2026-10-21T01-09-45Z
slug: src-app-homepage-tsx
closed: true
---
# Critique: src/app/HomePage.tsx (Home page, Persuade)

Method: dual-agent (A: design review sub-agent · B: detector/browser sub-agent). Dev server http://localhost:5199/opentrack-viewer/#/ (headless Chromium; no [Human] overlay tab).

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Static page; menu marks the current tool, body never says which tools exist. |
| 2 | Match System / Real World | 3 | "basemap", "tile provider", "Video telemetry" are engineer words. |
| 3 | User Control and Freedom | 3 | "Turn the basemap off in Settings" names a control unreachable from here. |
| 4 | Consistency and Standards | 2 | One destination, three names ("Open an activity" vs "File viewer"); footer "Home" on Home. |
| 5 | Error Prevention | 3 | Formats list never says MP4/MOV belong to another tool. |
| 6 | Recognition Rather Than Recall | 2 | Four tools behind "Tools ▾" with bare labels and no descriptions. |
| 7 | Flexibility and Efficiency | 2 | Only the viewer has a direct link; keyboard excellent. |
| 8 | Aesthetic and Minimalist Design | 3 | Four identical SUPPORTED chips; footer tagline repeats intro. |
| 9 | Error Recovery | 3 | "Report an issue" is the only path, below the fold at 1280. |
| 10 | Help and Documentation | 2 | Landing page documents one tool of four. |
| **Total** | | **26/40** | **Acceptable** |

No heuristic n/a (applicable max 40).

## Design Specificity Verdict

LLM: composition generic, copy specific, audience coverage one of three. Local-only position legible in first viewport but asserted, not shown (no "tested"). No mention of video/GoPro/overlay/route in the body; Product Principle 2 fails on the front door.

Deterministic scan: source scan of HomePage.tsx, AppShell.tsx, SiteFooter.tsx = 0 findings (regex-only caveat). Rendered route at 1280x820 = 3 findings: line-length on `.page__intro` (~94 chars, no max-width, src/app/HomePage.tsx:32-35, global.css:266); line-length on privacy paragraph 2 (~90 chars on 3 of 4 lines, HomePage.tsx:50-55); flat-type-hierarchy advisory (h2 12px from footer headings, body 14, h3 15, h1 16; step 1.17:1 vs 1.25:1). Page load clean: no console errors, no failed requests.

## Priority Issues

- [P0] Two of three audiences cannot see their path. HomePage.tsx names no tool but the viewer; Video telemetry, Overlays, Route Builder exist only inside the "Tools ▾" menu with bare labels. Fix: add a "Tools" section under the page header using the `.format` grid recipe, each name a Link with a one-line description; rewrite `.page__intro` to name all three jobs. Command: /impeccable shape, then /impeccable layout.
- [P1] The differentiator is asserted, not shown. Fix: third paragraph in "Your file stays on your device" stating the browser tests fail on any escaping request, coordinates in a body, or a tile before an activity, linking e2e/viewer.spec.ts on GitHub. Command: /impeccable clarify.
- [P1] No front-door hierarchy. `.page__title` 18px vs 16px brand, 37px under the header. Fix: Home-only display step (24px, lh 1.25, -0.01em), 40px top gap, intro at 15px with max-width under 80ch; record in DESIGN.md. Command: /impeccable typeset.
- [P2] Four identical "SUPPORTED" chips; "Planned" branch dead. Fix: drop the chip from the list, move exceptions into detail text, add the `.kmz` rejection note. Command: /impeccable distill.
- [P2] Three names for one destination; unreachable Settings instruction. Fix: one noun for the viewer across button, menu, footer; pass an open-settings handler or say "the Settings gear at the top right". Command: /impeccable clarify.

## Persona Red Flags

- Jordan: GPX/FIT assumed known; no "how to get your file" hint; three jargon terms in one sentence; "Tools" means nothing; gear unlabelled while page says "Settings".
- Riley: drop on Home does nothing; footer "Home" no-op; Tools menu overlaps h2 at 390 with no viewport clamp; caret is a 10px text glyph.
- Casey: first viewport good; ~1.5 screens of muted paragraphs before Formats; 11px chips; no bottom CTA.
- Morgan (GoPro creator): zero mention of video/overlays; Formats implies MP4 unsupported; primary button leads to a rejected file; must guess between "Video telemetry" and "Overlays".

## Minor Observations

- Hairline borders 1.32:1 light / 1.43:1 dark, under 3:1 non-text; chip relies on border.
- Footer "App"/"Project" are h2s at page-title level.
- Footer tagline restates the intro.
- Document title 78 chars, truncates.
- Primary hover brightness tick barely visible in light.
- 330px empty canvas each side at 1280; 620px column suits prose, not a front door.
- CTA in a bare <p>; an actions row would allow a second link.

## Questions to Consider

- Why does the one front door speak to one audience and hide two behind "Tools"?
- Why is the "a test fails if a byte leaves this tab" sentence not on the page, one click from the test?
- Should the primary control be a link to a drop zone, or the drop zone itself?
