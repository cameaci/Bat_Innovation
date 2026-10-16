# Implementation

Status: **Slice 0, Slice 1A import and the Slice 1B preview candidate verified on synthetic Linux media; independent review, Windows and ownership gates remain open**. Reviewed 2026-10-16.

Build a small, local Windows desktop reviewer for **recorded active-infrared (IR) bat survey video**. Reuse the structure and review ergonomics of [Camera_Trap](https://github.com/cameaci/Camera_Trap), but not its unrelated wildlife models, platform features or entire source tree.

## Read in order

| File | Role |
| --- | --- |
| [AGENTS.md](../AGENTS.md) | Binding development rules, no-workaround policy, review/test gates |
| [design.md](design.md) | Component structure, data/time contracts, quality handling, local security |
| [reuse.md](reuse.md) | Directly inspected Camera_Trap components and third-party library choices |
| [plan.md](plan.md) | Sequenced vertical slices, tasks and measurable definition of done |
| [tests.md](tests.md) | Synthetic fixtures, functional and ecological evaluation, release checks |
| [review.md](review.md) | Architecture alternatives, expert review findings and resolved trade-offs |

Supporting domain documentation: [scope](../docs/01-problem-and-scope.md), [evaluation](../docs/05-evaluation-framework.md), [data governance](../docs/04-data-governance.md), [IR architecture](../docs/09-ir-first-architecture-draft.md).

## One-sentence user journey

Select a local camera recording session (one or more original video files), inspect its timeline, generate **every** timestamped motion-summary window, browse the summaries, verify relevant moments against the source video, record observations and QA decisions, and export an existing-workbook-friendly event CSV plus a separate audit file.

## Selected stack

**Electron -> React/TypeScript -> local FastAPI -> Python FFmpeg/OpenCV -> SQLite + local outputs.**

This is a **small local monolith**, not a multi-service deployment. React and FastAPI can be developed together before Electron is packaged. No cloud API, user account service, trained model, GPU, container orchestration or data lake is needed for v1.

## Non-negotiable first spike

Prove reliable **video playback/seek** for original .MTS/.MP4 media, including segmented recordings and video-relative timestamps. Do not proceed to elaborate computer vision or review UX before this works or a tested, first-class media-preview method is selected. An unsupported codec must produce a clear error, not wrong-time playback.

## Boundaries

- IR only in v1; no thermal or audio/spectral processing.
- Every summary window is retained even when the motion image appears empty.
- Tracking and possible-emergence hints are later optional increments.
- A QA-labeled Excel row is a prelabel until its original video and decision authority are verified.
- No WSP/client footage, extracted images, original survey metadata or review databases in this **public** repository.
- Gate 0 synthetic/licensed-public development is possible now. Real footage feasibility needs the relevant approvals. A measured ecological benchmark additionally needs adjudicated reference events.

## Current implementation status

The backend retains FastAPI and SQLite with authenticated loopback routes. Slice 0 and Slice 1A import are merged. The Slice 1B candidate adds bounded, explicitly derived source previews with exact original PTS mapping; the technical playback gate passed generated MP4/MTS marker tests in Electron on Linux. No motion-summary or ecological result is claimed.

The React/TypeScript UI uses the real backend through a restricted Electron bridge. Local validation passed 76 Python tests, strict TypeScript, 21 Node checks and 9 Electron tests, including visual marker seeking, persistence, explicit failures and worker cleanup. See [recorded validation and limits](../docs/07-research-log.md). Windows preview process limits are not implemented; Windows runtime, camera-original compatibility and binary redistribution/packaging remain unverified. The candidate awaits independent review.

## Delivery order

**Media proof -> summary engine -> reviewer/QA -> exports -> Windows package -> approved-data evaluation.**

Read [plan.md](plan.md) for entry/exit criteria. Do not treat technical synthetic-media checks as ecological validation or mark unfinished gates complete.
