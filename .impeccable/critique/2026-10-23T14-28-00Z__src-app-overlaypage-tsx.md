---
target: Overlays tool
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/OverlayPage.tsx"
target_fingerprint: "sha256:6fe39aeb87ee3e2ecaadd8e650cb39a229cd5ec548e5f55106dd68694ceaef6e"
target_path: /Users/josemiguel/workspace_jmn8718/opentrack-viewer/src/app/OverlayPage.tsx
timestamp: 2026-10-23T14-28-00Z
slug: src-app-overlaypage-tsx
---
Method: dual-agent (A: design-review sub-agent · B: detector and browser sub-agent)

# Critique: Overlays tool, fourth run (src/app/OverlayPage.tsx)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | No-overlap notice far from the bar below 1100px (stage summary hidden) |
| 2 | Match System / Real World | 3 | "Set the offset in Sync first" survives; times written three ways |
| 3 | User Control and Freedom | 3 | Sync changes have no undo; start unbounded |
| 4 | Consistency and Standards | 2 | Burned-in stale button keeps first-run label; Size inert in strip; exports 0px apart |
| 5 | Error Prevention | 3 | Line-up exemplary; start field/bar unbounded (valuenow 71 > max 60) |
| 6 | Recognition Rather Than Recall | 2 | Sync starts at y=791 below file cards; hint omits Alt/PageUp |
| 7 | Flexibility and Efficiency | 3 | Transport keys dead from the side column |
| 8 | Aesthetic and Minimalist Design | 2 | All section titles 15px; privacy line 6+ times; strip broken with everything on |
| 9 | Error Recovery | 3 | Invalid draft sticks after other controls move the start |
| 10 | Help and Documentation | 3 | Key line, import note good; PNG sequence purpose unexplained |
| **Total** | | **27/40** | **Acceptable** |

## Priority Issues
- [P1] Start field keeps an invalid draft ("abc") after the bar/keys/line-up move the start (OverlayPreview.tsx draft only cleared by nudges). Fix: drop the draft when start changes from elsewhere. /impeccable harden
- [P1] Focus lost on Reset/Undo reset (button unmounts); on phones the sticky stage covers focused controls (2.4.11). Fix: one swapping button or move focus; scroll-padding-top = stage height. /impeccable harden
- [P1] Metric strip with everything on: values ~6px in a 618px preview, route inset a third of the row; Size inert; Compact HUD covers 2/3 of frame. Fix: minimum figure size, warn past it, dock route separately, Size meaningful. /impeccable layout
- [P2] Sync buried below file cards (y=791); no-overlap notice off-screen below 1100px; bar unbounded. Fix: compact Files row, Sync first, in-stage amber line at every width, clamp. /impeccable layout
- [P2] Export panels: 0px gap, stale burned-in label, filename wraps in button, offset wording, two download primaries; PNG estimate 4x high on a 256x144 clip (my sqrt scaling overshoots tiny frames). /impeccable polish

## Deterministic
CLI clean (10 files). Browser: page__intro and hint ~92ch (real); phone right inset 6.4px vs 20px left (real, layout-wide); hint straggler at 390 (real); overlay text sizes (false positive by design, though the strip-with-everything finding stands on its own); flat hierarchy (partly, A agrees the section titles are flat). Headless only.

## Persona red flags
Editor: no in/out range, no sync undo, no timecode in names, PNG-ZIP only alpha. Keyboard: focus lost on reset, obscured on phone, slider out of range. Stress: "1:2:3" and 90 s accepted silently. Creator: estimate 4x high, burned-in hidden on phone without mention, no safe-area guide.

## Minor
Sync bar non-text contrast: activity span 1.35:1 light / 1.99:1 dark; video vs activity 2.88:1 dark. Empty state leads with reload edge case. ~150px empty band under the stage at 1280. Controls stretch at 1099. "Video start" legend + "Video starts at" label redundant. Line up success not announced.

## Questions
- Do two file cards earn the top of the column over Sync?
- Which of four sync mechanisms would you delete?
- What would a signature OpenTrack overlay look like?
