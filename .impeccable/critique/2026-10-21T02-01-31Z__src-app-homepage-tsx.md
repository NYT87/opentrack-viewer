---
target: src/app/HomePage.tsx
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/HomePage.tsx"
target_fingerprint: "sha256:633bf6625747f94c3e57de409b97cbc62ed25186d373e554b3875ef8da25f01e"
target_path: /Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/HomePage.tsx
timestamp: 2026-10-21T02-01-31Z
slug: src-app-homepage-tsx
---
# Critique: src/app/HomePage.tsx (Home page, Persuade) — run 2, after shape/layout/typeset/clarify/polish

Method: dual-agent (A: design review sub-agent · B: detector/browser sub-agent). Headless Chromium; no [Human] overlay tab.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Static page; nothing shows the product's claim in action. |
| 2 | Match System / Real World | 4 | "activity files" (title) vs "workout file" (intro). |
| 3 | User Control and Freedom | 3 | Tab out of the open Tools menu leaves it open. |
| 4 | Consistency and Standards | 2 | "Open an activity" vs "File viewer" for one destination; Enter opens menu without focusing first item. |
| 5 | Error Prevention | 3 | `.kmz` unmentioned; primary button sends a GoPro creator to a page that rejects MP4. |
| 6 | Recognition Rather Than Recall | 3 | Button/row equivalence and Video telemetry→Overlays order are unstated. |
| 7 | Flexibility and Efficiency | 2 | Home accepts no dropped file. |
| 8 | Aesthetic and Minimalist Design | 3 | Intro restates tool rows; privacy restates footer tagline; four identical SUPPORTED chips. |
| 9 | Error Recovery | 3 | Wrong-file-type not forewarned. |
| 10 | Help and Documentation | 3 | Test link opens new tab with no cue. |
| **Total** | | **29/40** | **Good** |

No heuristic n/a (applicable max 40).

## Design Specificity Verdict

LLM: specific in copy, generic in form; three audiences legible in first viewport; the proof ("This is tested, not just promised" + test link) is below the fold (~y=860 at 1280x820, ~1.6 screens at 390).

Deterministic: source scans of HomePage.tsx, AppShell.tsx, SiteFooter.tsx = 0. URL scans at 1280x820 and 390x844 = 0 counted, 1 advisory `flat-type-hierarchy` on body, a partial false positive: the "h2 12px" is the footer's two `.footer__heading` h2s outvoting the 24px page title (real step 1.71:1). Confirms compressed chrome band h1 16 / h3 15 / body 14. Previous run's two line-length warnings cleared. Clean load: no console errors/warnings, no failed requests, no horizontal overflow.

## Priority Issues

- [P1] The proof is below the fold. Fix: a 12px muted line under `.page__actions`: "Nothing leaves this tab. A browser test fails if it does." linked to PRIVACY_TEST_URL; keep the full paragraph. Command: /impeccable clarify.
- [P1] The intro is an inventory nobody scans; it duplicates the four `.tool` rows and clips Route Builder under the phone fold. Fix: cut `.page__intro` to the positioning line ("Read, convert, overlay or plan a track in this browser tab. The file never leaves your device."). Command: /impeccable distill.
- [P2] One destination, three names ("Open an activity" button/footer vs "File viewer" row/menu). Fix: rename TOOLS_ITEMS[0]/TOOLS[0] to "Activity viewer", or drop the footer duplicate. Command: /impeccable clarify.
- [P2] The Overlays row hides its prerequisite (Video telemetry first). Fix: open its detail with "After Video telemetry has read the track:" or number the rows. Command: /impeccable clarify.
- [P2] Four identical SUPPORTED chips spend Trail Blue on nothing; converters' read/write question unanswered. Fix: neutral "Read · Written" / "Read only" chips. Command: /impeccable distill.
- [P3] Tools menu keyboard model: Enter should focus item 0; items tabIndex -1; close on blur outside container.

## Persona Red Flags

- Jordan: three nouns for one file in three lines; button vs "File viewer" hesitation; description text not clickable; gear opened looking for "open file".
- Riley: drop on Home does nothing; Tab orphans the open menu; primary hover invisible in light; long strings and 320px pass.
- Casey: button at y=311 after six grey lines; 21px tool-name targets; Route Builder clipped under fold; 451px footer.
- Morgan (GoPro creator): "GoPro" first in sentence three; primary button rejects MP4; Overlays prerequisite unstated.

## Minor Observations

- Footer heart in Signal Red (reserved for errors).
- Section title 15px vs tool name 14px, one pixel of rank.
- Promise phrased three ways (intro, privacy, footer).
- Tools caret is a 10px text glyph.
- Test link opens a new tab with no cue.
- Footer h2s smaller than body; trips the advisory.

## Questions to Consider

- Why does the only primary button serve one of three equal audiences?
- Would a live "Requests made by this page since it loaded: 0" readout be forbidden imagery or the most on-brand element?
- What if the home page were the dropzone, with the three paths as the only other content?
