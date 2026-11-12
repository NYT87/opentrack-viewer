---
name: work-issue
description: Work a GitHub issue end to end. Opus documents it and writes a brief, a Sonnet agent implements it (asking Fable for help and review), and Opus verifies and commits. Use for "start working on the next issue" or "/work-issue 16".
argument-hint: "[issue number, default: the next open issue]"
---

# Work an issue

Arguments: `$ARGUMENTS`, an issue number on NYT87/opentrack-viewer. If it is empty, use the lowest-numbered open issue whose work is not already on main; check with `gh issue list --state open` and the git log.

Say which step is running as you go. Do not ask the user to confirm the flow; ask only about a product decision the issue leaves open and the code can't settle.

## 1. Document (you, the lead)

1. Read the issue and its comments: `gh issue view N --comments`.
2. Read the code it touches yourself, enough to write exact instructions.
3. Settle the open questions. Prefer the issue's own decisions, then the codebase's existing rules (TD-xxx in `docs/planning/06-decisions-and-open-questions.md`).
4. Add the task to `docs/planning/04-engineering-tasks.md` as the next `AV-xxxx` in its epic, in the house format: Dependencies, the GitHub issue number, and Acceptance criteria. The criteria are the contract.
5. Write a brief to the scratchpad (`av-xxxx-brief.md`) containing:
   - what exists now, with file paths, functions and test ids;
   - the decisions already made, which the implementer must not re-open;
   - the docs to write when done: the next `TD-xxx` after the last one in 06 (Decision, Reason, Tests, in the voice of the neighbouring entries) and the README feature row;
   - the constraints listed below.

## 2. Implement (Sonnet agent)

Spawn one agent with `model: "sonnet"` and `subagent_type: "general-purpose"`, in the background. Its prompt points it at the brief and the AV entry, and tells it to:

- implement the change, update the unit and component tests, and move or extend the browser tests;
- write the TD entry and the README line;
- run typecheck, lint, the unit tests and the affected Playwright specs until they are green;
- when stuck, ask a Fable agent for help (`model: "fable"`, `subagent_type: "general-purpose"`), with a specific question and the file paths;
- when green, ask a Fable agent to review the working tree (`git diff` plus untracked files) against the AV criteria and the brief: correctness, accessibility, races, layout regressions, missing tests. Fable reports findings with file:line and a failure scenario, and changes nothing;
- fix every real finding, then have Fable re-review the fixes, and fix anything it still finds;
- end with a report: each file changed and why; how each criterion is met; the exact commands run and their counts, including flaky reruns; Fable's findings from both rounds and what was done about each; anything left undone.

Do not duplicate its work while it runs. Wait for the completion notification.

## 3. Verify (you)

1. Read the whole diff against the AV criteria and the brief; don't take the report's word for it.
2. Rerun the checks yourself: `npm run typecheck`, `npm run lint`, `npm test`, and the Playwright specs touched. The burned-in specs run in `--project=chromium-codecs`.
3. Fix small problems yourself. For a larger one, send it back to the same agent with SendMessage.
4. Commit with a message in the repo's style (`feat: …` / `fix: … (TD-xxx)`), ending with the attribution trailer from the system reminder.
5. Report to the user: what was built, the decisions taken, the test results, Fable's findings, and anything open.
6. Update the project memory's roadmap note.

## Constraints (copy these into the brief)

- Code style: width 100, single quotes. Match the surrounding comment density and voice; comments cite AV/TD ids. There is no prettier config, so never run prettier.
- Unit tests can time out under parallel load: rerun a failing file alone before calling it broken. A single e2e flake that passes on rerun is acceptable if reported.
- Agents never commit, push, or touch GitHub issues. The lead commits. Push, and close or comment on the issue, only when the user asks.
- Never read or measure the user's files in `~/Downloads`, or send them to an online service, without asking.
