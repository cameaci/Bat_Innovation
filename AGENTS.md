# Agent instructions

These instructions apply to all work in this repository. Read [implementation/README.md](implementation/README.md), [implementation/design.md](implementation/design.md), [implementation/plan.md](implementation/plan.md), [implementation/reuse.md](implementation/reuse.md) and [implementation/tests.md](implementation/tests.md) before changing application code. For ecological meaning read [docs/01-problem-and-scope.md](docs/01-problem-and-scope.md) and [docs/05-evaluation-framework.md](docs/05-evaluation-framework.md).

## Product contract

- Build a **local, Windows-first active-IR bat video reviewer**, not a cloud platform or autonomous ecological decision system.
- Follow the proven [Camera_Trap](https://github.com/cameaci/Camera_Trap) stack: **Electron + React/TypeScript + FastAPI/Python + local SQLite**. Keep the Bat Innovation implementation substantially smaller.
- First vertical slice: ordered source-video segments -> complete time-window motion summaries -> original-time video verification -> human review and optional second QA -> report and audit exports.
- Every recorded window must remain accessible. A blank-looking summary is **not** proof of no bats. Preserve access to original video.
- Split media and camera motion are normal cases to handle or explicitly flag; a tripod does not prove a fixed scene.
- Thermal processing, acoustic synchronisation, species identification, trained models, multi-user cloud services and automatic roost conclusions are **out of v1**.
- Existing spreadsheet entries are candidate **prelabels**, not final ground truth. Final ecological classifications belong to appropriately authorised human reviewers.

## Development principles

1. **KISS, DRY, YAGNI:** use existing standard features and small composable functions. Do not add abstraction layers, frameworks, service meshes, queues or model infrastructure without a demonstrated need.
2. **No workarounds:** never hide an unsupported format, silently skip bad files/windows, invent absolute times, duplicate source records, hardcode special cases, swallow exceptions, or return success for partially failed processing. Fix the cause or report an explicit supported limitation with tests.
3. **Source-first reuse:** search the Camera_Trap tree and upstream libraries before writing custom code. Use the [reuse map](implementation/reuse.md) to distinguish copying/adapting a small helper from reproducing a tightly coupled workflow. Do not bulk-copy the application.
4. **Licences and IP:** Camera_Trap has a public MIT licence with a WSP copyright notice. Keep required notices if any portion is reused; confirm ownership/publication authorisation before copying code. Review every other dependency, binary and model licence separately.
5. **Source of truth:** the original video and exact source timestamps are authoritative evidence. Processing output is derived and reproducible. Never equate estimated frame-rate time, imported Excel clock time or a motion image with verified source timing.
6. **Correctness before performance:** test original playback and .MTS handling first. Stream frames with bounded memory. Do not optimise or GPU-port until measurement justifies it.
7. **Data minimisation:** this repository is **public**. Never commit client footage, extracted frames, event logs, real survey metadata, site coordinates, personal data, private workbook examples, credentials, sensitive paths or model weights trained on restricted data.
8. **Offline by design:** runtime must not download code, send telemetry or call external AI services. Bind the local API to loopback with restricted origins and a per-launch token; use narrow Electron IPC, context isolation, non-shell subprocess calls and source-file IDs rather than arbitrary media paths.
9. **Explicit configuration:** parameters affecting evidence must be visible or versioned; fail clearly if required files, binaries, source-speed information or codec support are missing.
10. **Typing and tests:** use Python type annotations and strict TypeScript. Write tests for timebase, split files, motion visibility, scene changes, review transitions and exports. No placeholder algorithms presented as working features.
11. **Lean repository:** few coherent modules and no redundant documentation. Keep generated videos, summary images, logs, SQLite databases, caches, local configuration and installers out of Git. Avoid oversized source files; factor code by responsibility when warranted.
12. **Writing style:** English only for repository documentation and code comments; concise, natural sentences; sentence-case headings; use ordinary hyphens, not en/em dashes.

## Mandatory workflow for every implementation slice

1. **Inspect:** review the relevant Camera_Trap code, upstream API and current Bat Innovation contracts. Record the candidate reuse path and its dependencies. Do not assume older repository descriptions are correct.
2. **Design:** state the smallest user-visible behavior, affected files, invariants and failure cases. Prefer built-in FFmpeg/OpenCV/SQLite/Electron features.
3. **Review before coding:** challenge the plan as (a) bat IR computer-vision engineer, (b) ecological reviewer, (c) desktop/QA engineer, (d) security/licensing engineer, and (e) maintainer seeking fewer lines and dependencies.
4. **Implement one vertical slice:** production behavior and its tests in the same change. Do not build preparatory frameworks, unrequested settings pages or speculative integrations.
5. **Verify:** run relevant backend tests, frontend type checks, and an end-to-end test when a UI contract changes. Test at least one negative/error path. Never claim a test ran when it did not.
6. **Refine:** remove duplication, test assumptions and re-review error handling, output completeness and user-visible messages. No silent skips, hidden fallback or hardcoded file-specific exception.
7. **Record:** update only relevant docs, [implementation/plan.md](implementation/plan.md) checkboxes and [docs/07-research-log.md](docs/07-research-log.md) when research or design decisions materially change. Include exactly what was verified, and what remains unverified.

## Decision and approval boundaries

- Gate 0 allows public/synthetic clean-code development, not uploading or processing uncleared client media.
- Authorised original-file testing requires the applicable access, processing-right, privacy and IT checks. A validated benchmark additionally needs independent ecological adjudication.
- No fabricated performance thresholds. An ecological owner must approve acceptable misses, review burden and survey-level conclusion criteria before acceptance testing.
- A local reviewer name is an audit attribution, **not** enterprise identity verification.
- Keep per-camera observations separate. Do not claim distinct animals across cameras or infer emergence from a motion trail alone.
- Do not change the architecture stack, add dependencies, publish releases, alter repository visibility or begin copying substantial WSP-owned code without documenting the reason and any required authorisation.

## Definition of done

A slice is done only if its source/derived outputs are traceable, failure behavior is explicit, source files remain untouched, negative cases are tested, the user can see what happened, and added complexity is justified. A passing demo is not proof of bat-event recall or suitability for ecological reporting.

**Current status: Slices 0, 1A, 1B, 2A, 3A and 3B are independently reviewed and merged. Slice 4A independent second-review QA is an unmerged review candidate; see its [validation report](docs/16-slice-4a-validation.md). The early Windows beta feasibility gate has a Stage A blocker/artifact report only; no native Windows environment, boot proof, installer or redistribution approval is available. Preview and summary remain fail-closed on Windows. Representative camera originals, project ownership/publication and binary distribution remain open. No ecological acceptance, finalisation, exports or installed app is delivered. See the [feasibility report](docs/14-windows-beta-feasibility.md), [research log](docs/07-research-log.md) and [plan](implementation/plan.md).**
