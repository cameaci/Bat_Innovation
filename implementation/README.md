# Implementation

Status: **Slices 0-4B1 are merged. The Windows beta, the Camera_Trap-style interface and feature expansion E1-E7 (tracks, gates and three-layer counts, highlight review, timeline and heatmaps, rendered thermal, audio) are on the open beta branch, Linux-verified only. Native Windows, binary distribution, ownership and ecological validation remain open.** Reviewed 2026-10-23.

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
| [feature-expansion.md](feature-expansion.md) | Owner-approved P1 expansion: tracks, gates, counts, timeline, heatmaps, highlights, rendered thermal, audio sync; separate tracker |

Supporting domain documentation: [scope](../docs/01-problem-and-scope.md), [evaluation](../docs/05-evaluation-framework.md), [data governance](../docs/04-data-governance.md), [IR architecture](../docs/09-ir-first-architecture-draft.md).

## One-sentence user journey

Select a local camera recording session (one or more original video files), inspect its timeline, generate **every** timestamped motion-summary window, browse the summaries, verify relevant moments against the source video, record observations and QA decisions, and export an existing-workbook-friendly event CSV plus a separate audit file.

## Selected stack

**Electron -> React/TypeScript -> local FastAPI -> Python PyAV/NumPy/Pillow -> SQLite + local outputs.**

This is a **small local monolith**, not a multi-service deployment. React and FastAPI can be developed together before Electron is packaged. No cloud API, user account service, trained model, GPU, container orchestration or data lake is needed for v1.

## Non-negotiable first spike

Prove reliable **video playback/seek** for original .MTS/.MP4 media, including segmented recordings and video-relative timestamps. Do not proceed to elaborate computer vision or review UX before this works or a tested, first-class media-preview method is selected. An unsupported codec must produce a clear error, not wrong-time playback.

## Boundaries

- Active IR first. Rendered thermal video and full-spectrum WAV synchronisation are planned review aids in the [feature expansion plan](feature-expansion.md); no radiometric thermal analysis or acoustic species identification.
- Every summary window is retained even when the motion image appears empty.
- Tracks, gate crossings and counts are planned review candidates ([feature expansion plan](feature-expansion.md)); they never hide windows or replace human decisions.
- A QA-labeled Excel row is a prelabel until its original video and decision authority are verified.
- No WSP/client footage, extracted images, original survey metadata or review databases in this **public** repository.
- Gate 0 synthetic/licensed-public development is possible now. Real footage feasibility needs the relevant approvals. A measured ecological benchmark additionally needs adjudicated reference events.

## Current implementation status

The backend retains FastAPI and SQLite with authenticated loopback routes. Merged import, bounded source preview and complete motion-window ledger use exact original PTS. Slice 3A adds explicit first-review actions, provisional observations, run-specific progress and an append-only local audit through the existing React list/player and restricted Electron bridge. No automated ecological result is claimed.

The merged [Slice 3B gallery](../docs/15-slice-3b-validation.md) adds a paginated all-window gallery, filters, scoped navigation and exact displayed-source-PTS draft helpers. It preserves the existing review/audit contract and Windows guards. Slice 3B merged as `2f0332cdd1734691ee9ffb1be6fa275b2c8bb660`.

The independently reviewed and merged [Slice 4A increment](../docs/16-slice-4a-validation.md) adds explicit v5 storage, separate append-only second-review decisions, observation-linked provisional suggestions, stale-evidence handling and protected QA navigation. Different local labels do not authenticate independent humans. Slice 4A was squash-merged as `d9660c79dabec3740855e74ae99f5847620bab76`.

The [Slice 4B1 candidate](../docs/17-slice-4b1-validation.md) adds explicitly provisional observations and complete-window audit CSVs from one bounded read-only v5 snapshot. Native main-process streaming saves a fresh atomic bundle. No approved ecological template or finalisation is supplied; independent technical review is required before merge.

See [Slice 3A validation](../docs/13-slice-3a-validation.md) for local audit evidence and the [early Windows feasibility report](../docs/14-windows-beta-feasibility.md) for the gated blocker matrix and exact candidate artifacts. Slice 3A merged as `b4fd13c4325475b413e2072eb539ce00d9a18579`. Windows processing limits, native runtime, camera-original compatibility and binary redistribution/packaging remain unverified. No Windows installer exists from this work.

## Delivery order

**Media proof -> summary engine -> reviewer/QA -> exports -> Windows package -> approved-data evaluation.**

Read [plan.md](plan.md) for entry/exit criteria. Do not treat technical synthetic-media checks as ecological validation or mark unfinished gates complete.
