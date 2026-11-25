---
target: src/app/HomePage.tsx
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/HomePage.tsx"
target_fingerprint: "sha256:d2ad820dc4e31e212ca46f54a6b688f791b2647ae80a9e54b493a1c59689023f"
target_path: /Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/HomePage.tsx
timestamp: 2026-10-21T02-27-31Z
slug: src-app-homepage-tsx
---
# Critique: src/app/HomePage.tsx (Home page, Persuade) — run 3, after clarify/distill/polish

Method: dual-agent (A: design review sub-agent · B: detector/browser sub-agent). Headless Chromium; no [Human] overlay tab.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Tools menu has no Home item; nothing marked current on Home. |
| 2 | Match System / Real World | 3 | "Video telemetry", "Overlays" insider terms; "Open an activity" before "activity" is defined. |
| 3 | User Control and Freedom | 2 | Menu items are buttons: no middle-click / new tab / URL preview. External links open new tab with no cue. |
| 4 | Consistency and Standards | 2 | Two link affordances, neither underlined; footer h2s outrank page h3s. |
| 5 | Error Prevention | 3 | `.kmz` unmentioned. |
| 6 | Recognition Rather Than Recall | 2 | Overlays row teaches a false two-step order; "convert" promised with no tool. |
| 7 | Flexibility and Efficiency | 2 | No dropped-file path (reviewer argued n/a; kept for like-for-like trend). |
| 8 | Aesthetic and Minimalist Design | 3 | Identical SUPPORTED chips; promise stated five times. |
| 9 | Error Recovery | 3 | No error state here (reviewer argued n/a; kept). |
| 10 | Help and Documentation | 3 | No README/limits link beyond KML. |
| **Total** | | **26/40** | **Acceptable** |

Score fell from 29: one real regression (Overlays copy introduced last pass is wrong: OverlayPage.tsx:104 accepts a video, an activity file, or both) plus a stricter read of pre-existing 3 and 4.

## Design Specificity Verdict

LLM: specific through copy alone; composition generic. Three audiences legible in first viewport at 1280/900. Local-only asserted five times, shown once via a 12px muted un-underlined link. Converter path weakest.

Deterministic: source scans 0. URL scans at 1280 and 390: 0 counted, 1 advisory `flat-type-hierarchy` on body, a false positive for the page (footer 12px h2s outvote the 24px title; real step 1.71:1). Line lengths within range except privacy p2/p3 at 83/86 chars on one line each. Tool-name links 21px tall. Clean load.

## Priority Issues

- [P1] Overlays copy misdescribes the product (TOOLS[2].detail says "After Video telemetry has read the track"; the Overlays page accepts a GoPro video directly). Fix: "Bring a GoPro video, an activity file, or both. Draw speed, distance, the route and the climbs over the picture, then export a transparent PNG sequence for your editor or burn it into the video." Command: /impeccable clarify.
- [P1] Links in muted prose identified by colour alone (`.link` text-decoration none; link vs surrounding text 1.01:1 light / 1.08:1 dark; WCAG 1.4.1). Fix: `.link` 1px underline, 0.15em offset, 60% Trail Blue mix, full accent on hover; raise `.page__proof` to 13px. Command: /impeccable polish.
- [P1] Tool names do not look clickable; target ~80x17px, row inert. Fix: whole `.tool` row is the Link, top hairline → Trail Blue on hover, trailing arrow on the name. Command: /impeccable polish.
- [P2] Conversion promised in intro, no tool; MP4/MOV absent from Formats. Fix: "File viewer and converter" in Home and menu, detail leads with both verbs and loss listing; Formats line "GoPro MP4 and MOV are read by the Video telemetry tool." Command: /impeccable clarify.
- [P2] SUPPORTED chips informationless. Fix: render chip only when not supported; muted "Read only" on KML. Command: /impeccable distill.
- [P3] Promise stated five times; cut privacy p3 to the three test conditions and drop the second link.

## Persona Red Flags

- Jordan: "activity" undefined; tool names read as definitions; GitHub link opens TypeScript in a new tab unwarned.
- Riley: menu items not real links; links vanish under deuteranopia; footer h2 outline; German title orphan at 390. Keyboard/320/zoom pass.
- Casey: 12px proof skipped; 80x17px tool targets; Route Builder cut at y=771.
- Morgan: Overlays row sends them on a false detour; MP4 absent from Formats; export format unnamed.

## Minor Observations

- Section titles have inconsistent hairline relationships.
- Promise five times; second identical GitHub link.
- External links lack "opens in new tab" cue.
- Document title omits GoPro/video.
- Primary hover barely perceptible.
- Footer "Home" dead link on Home; route glyph only in footer.

## Questions to Consider

- What would a live, honest instrument on the page look like (request counter, assertion excerpt)?
- Should the hero be three named doors and no "primary"?
- If the menu is the thing to mirror, is the menu right?
