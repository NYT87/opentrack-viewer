# OpenTrack Viewer Implementation Plan

This is the index for the OpenTrack Viewer engineering plan. The detailed plan has been split into focused documents so product scope, architecture, task execution, testing, and decisions can evolve independently.

## Document Map

- [Product Scope](01-product-scope.md): product goals, non-goals, privacy constraints, early guardrails, and README positioning.
- [Architecture and Domain Model](02-architecture-and-domain.md): proposed stack, browser-only data flow, normalized activity model, layout states, and repo structure.
- [Roadmap and Stages](03-roadmap-and-stages.md): milestones, Stage 3 export, Stage 4 TCX, first tasks, and definitions of done.
- [Engineering Tasks](04-engineering-tasks.md): epics, task IDs, dependencies, and acceptance criteria.
- [Testing, Performance, and Error Handling](05-testing-performance-errors.md): test strategy, privacy regressions, performance risks, and error categories.
- [Decisions and Open Questions](06-decisions-and-open-questions.md): technical decisions and unresolved product/engineering questions.

## How To Use This Plan

- Start with the roadmap to understand sequencing.
- Use the engineering tasks document for implementation tickets.
- Keep architecture changes in the architecture/domain document before changing task acceptance criteria.
- Keep unresolved choices in the decisions/open questions document until they become explicit decisions.
- Avoid adding large new sections to this root file; link to a focused document instead.

## Current Product Direction

OpenTrack Viewer is a privacy-first, 100% client-side web/PWA for viewing activity files. The app has a homepage for project description, a viewer/process page for local activity-file processing, a routed Terms and Conditions page, and a settings modal that does not navigate away from loaded data. The header uses the brand/title as the home link, avoids duplicate Home navigation, omits global subtitle text, and opens Settings from an icon on non-home pages. The loaded viewer uses max-width content, a large-screen left section sidebar, an overview box first, a map box second, laps beside the map when available on large screens, and charts later. Settings include app-wide theme modes: system, dark, and light. Charts need readable axis spacing, with distance tick marks every 1 km and time tick marks every 5 minutes where space permits. Running cadence should be modeled and displayed as strides per minute, not RPM. GPX is first, FIT follows, Stage 3 adds browser-side GPX/FIT export, and Stage 4 adds TCX import/export. Activity files are parsed, normalized, calculated, visualized, and exported in the browser without backend processing or upload.
