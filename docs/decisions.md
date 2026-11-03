# Decisions

Project-owner and project-level decisions, newest first. Each one states what it allows and what it does not. Agents and contributors must not go beyond them; a new decision is added here, dated, before work that depends on it.

## 2026-10-29 - WSP logo and AI-ready repository layout

- The WSP logo (Camera_Trap `wsp/brand/wsp-logo-red.svg`) is shown in the app's sidebar and on the Surveys page. Bat Innovation is a WSP internal tool. The logo is inlined as an SVG component (`frontend/src/components/layout/WspLogo.tsx`), so the strict Content Security Policy and the `app://` protocol are unchanged. The MIT licence of Camera_Trap covers code, not trademarks; the logo is used here on the owner's authority as a WSP internal tool, and it must not be used to present the repository as an official WSP publication.
- The repository is organised for AI-assisted development: a short [AGENTS.md](../AGENTS.md) with the rules, [CLAUDE.md](../CLAUDE.md) importing it, task playbooks in `.claude/skills/` indexed by [SKILLS.md](../SKILLS.md), this decisions record, the [technology register](technology-register.md) and a pull request template.
- The Process page shows summary status only; summary images are looked through on the Review page. A processing window (after Camera_Trap's job progress modal) shows every pipeline step and can be hidden while processing continues.

## 2026-10-28 - Owner's real-footage test set

The owner provided a set of real recordings in a private shared folder for testing the app. They may be processed outside the repository for engineering tests; only numbers and text are recorded ([research log](07-research-log.md)). This is not an ecological benchmark or acceptance test.

## 2026-10-27 - Phase 3 approved

The [Phase 3 plan](../implementation/phase3.md) X1-X10 is approved: competitor-style overlays and count board, a benchmark and in-app sample check, tracks-v3, guided setup and site templates, an enhanced display view, a track table with group labels, several gates and an emergence profile, overlay/highlights video and a PDF report, and several audio sources with call-activity marks. Rendered outputs are derived and provisional; species stay human-entered; no new runtime dependency.

## 2026-10-24 - Phase 2 of the feature expansion

Watching a window end to end in the lossy full-video playback copy at no more than 4x is an accepted review receipt for "no activity seen"; the receipt records the copy, the watched intervals and the maximum speed, and exact-frame verification from the original stays available. After every uncertain crossing of a gate is resolved, the reviewer may accept the algorithm's coherent-crossing proposal for that gate in one audited action; layers stay separate and counts stay provisional. No Ultralytics/YOLO or trained models.

## 2026-10-22 - Feature expansion P1 and Camera_Trap-style interface

The P1 features of the [feature expansion plan](../implementation/feature-expansion.md) are in scope. Tracks, crossings and counts are candidate evidence for human review, never final counts; algorithm, reviewer and QA count layers stay separate and audited. The all-window gallery stays the review denominator. The research metrics in that plan are proposals, not approved thresholds. The fixed 44/70 tracker is unchanged; the expansion has its own tracker. Camera_Trap's UI primitives, layout components and Tailwind theme were adapted under its MIT licence ([NOTICE](../frontend/src/components/ui/NOTICE)).

## 2026-10-21 - Windows internal beta

The Windows media paths (import, preview, summaries, export) run under Job Object limits as an **internal beta**, distributed as an unsigned GitHub pre-release with provisional exports only. The owner accepted the unbounded-disk, codec-licence and untested-native-Windows risks recorded in [docs/18](18-windows-beta.md). This does not approve finalisation, ecological claims, signing or any general release. PyInstaller and electron-builder are approved build-time dependencies.

## 2026-10-15 - Scope and gates

- Product: a local, Windows-first active-IR bat video reviewer on the Camera_Trap stack (Electron + React/TypeScript + FastAPI/Python + SQLite), substantially smaller. Radiometric thermal analysis, acoustic species identification, trained models, multi-user cloud services and automatic roost conclusions are out of scope.
- Gate 0 allows public or synthetic clean-code development, not uploading or processing uncleared client media. Authorised original-file testing requires the applicable access, processing-right, privacy and IT checks; a validated benchmark additionally needs independent ecological adjudication.
- Existing spreadsheet entries are candidate prelabels, not final ground truth. Final ecological classifications belong to appropriately authorised human reviewers.
- Camera_Trap has a public MIT licence with a WSP copyright notice; keep required notices if any portion is reused, and review every other dependency, binary and model licence separately.
