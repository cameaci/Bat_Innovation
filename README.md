# Bat Innovation

**Research and a local development foundation for a human-reviewed bat emergence video workflow.**

Status: **Gate 0; React/Electron session foundation verified on Linux, Windows and media work pending**. Last reviewed: **2026-10-15**.

## Purpose

This public repository contains research **and the initial source code** for a lean local application to support human review of recorded **active infrared (IR)** bat emergence footage. The intended use case is to investigate a potential **WSP-operated, in-house** workflow that reduces manual video review while retaining ecological oversight and an auditable trail.

This is an exploratory project, **not an official WSP publication, endorsed solution, or approved use of client data**. No model, dataset, workflow, or research-use permission has yet been validated for WSP deployment.

## Research questions

1. Can a local or WSP-approved environment identify candidate bat activity in infrared/night-vision recordings?
2. Can trajectories and roost context help distinguish emergence, re-entry, commuting, insects, birds, and uncertain events?
3. Can ecologists review a complete set of timestamped motion-summary windows, then inspect original video only where necessary, without missing important events?
4. Which tools, algorithms, datasets, and licences are suitable for an internally operated solution, without unnecessary infrastructure?
5. What evidence, governance approvals, and validation results are required before a pilot?

**Important distinction:** detecting a moving animal is not equivalent to proving a roost emergence. Event interpretation requires location, direction, temporal context, and ecological review.

## Documentation index

| File | Contents |
| --- | --- |
| [01 - Problem and scope](docs/01-problem-and-scope.md) | Objectives, constraints, definitions and initial pipeline |
| [02 - Evidence and source register](docs/02-source-register.md) | Curated papers, guidance, projects, repositories, datasets and tools |
| [03 - Technical approaches](docs/03-technical-approaches.md) | Classical computer vision, tracking and learned detection |
| [04 - Data governance](docs/04-data-governance.md) | Public-repo restrictions, research-use clearance and approval gates |
| [05 - Evaluation framework](docs/05-evaluation-framework.md) | Label policy, split strategy, metrics and ecological QA |
| [06 - Research backlog](docs/06-research-backlog.md) | Open questions and priority research tasks |
| [07 - Research log](docs/07-research-log.md) | Dated research notes and decisions |
| [08 - Motion-summary prior art](docs/08-motion-summary-prior-art.md) | Public product comparison, time-window summaries, evidence limitations |
| [09 - IR-first app architecture](docs/09-ir-first-architecture-draft.md) | Lean Electron/React/FastAPI/SQLite desktop application, recording sessions, review/QA and exports |
| [10 - Camera_Trap reference](docs/10-camera-trap-architecture-reference.md) | Reviewed implementation patterns to reuse and avoid |
| [11 - Slice 0 development shell](docs/11-slice-0-development.md) | Setup, API-origin decision, source reuse, dependency licences and limits |
| [18 - Windows internal beta](docs/18-windows-beta.md) | Install, build, Windows containment, limits, licence notice and acceptance checklist |
| [Source review template](docs/source-review-template.md) | Standard format for future source assessments |
| [Implementation plan](implementation/README.md) | Reviewed delivery sequence, technical contracts, reuse audit and tests |
| [AGENTS.md](AGENTS.md) | Working rules for AI coding agents and contributors |

## Working principles

- **Research before implementation:** document evidence and limitations before choosing a model.
- **Human-in-the-loop:** support, do not replace, qualified ecological judgement.
- **In-house by design:** prefer local execution or an explicitly approved internal environment. Do not upload client footage to public AI services.
- **Evidence traceability:** link each finding to a primary source, date, source modality, licence/access status, and relevance.
- **Reproducibility:** preserve versioned methods, evaluation protocols, and decisions.
- **Data minimisation:** do not put confidential WSP/client material in this public repository.

## Status and next step

The minimal React/TypeScript UI and Electron development shell now display actual backend readiness and create/list synthetic sessions in the existing SQLite database. Tests verify persistence across reload and full application reopening, fresh per-launch credentials, explicit failure states and backend cleanup. Start with the [development instructions](docs/11-slice-0-development.md); results and decisions are in the [research log](docs/07-research-log.md).

This is a foundation for the [planned workflow](implementation/plan.md). The Linux development shell supports source-PTS import/preview, all-window motion evidence, manual review and independent QA. [Provisional CSV exports](docs/17-slice-4b1-validation.md) are an unmerged review candidate. Ecological finalisation, approved output-template mapping and Windows packaging remain gated. No ecological performance result or production-ready desktop app is claimed. The source register remains a scoping review, and ownership/publication rights, approved footage and ecological evaluation remain open.

## Install (Windows internal beta)

An unsigned Windows installer is built from this repository by `scripts/build-windows.ps1` (or the `Build Windows installer` workflow) and published as a GitHub pre-release. It installs per user, runs offline and keeps your originals untouched. Exports are provisional, and **it has not yet been run on native Windows**: follow the [install notes, limits, codec licence notice and acceptance checklist](docs/18-windows-beta.md) before relying on it.

For development on Linux or Windows: install `backend/requirements-dev.txt`, run `npm ci` and `npm run setup:electron`, then `npm run dev` (set `BAT_PYTHON` to the interpreter that has the requirements).

## Documentation conventions

All project documentation is written in English and stored as Markdown (`.md`). New research should update the [source register](docs/02-source-register.md), [research log](docs/07-research-log.md), and relevant topic document. Use these four evidence labels consistently: **directly verified** (we inspected the cited source), **source-reported** (claim stated by a source but not reproduced), **inference** (our interpretation), or **unverified** (not checked). Source verification never implies the claim is independently reproduced.

## Security note

**Both this repository and the Camera_Trap reference repository were confirmed public through GitHub repository metadata on 2026-10-15.** Do not commit survey footage, internal workbooks, customer/site identifiers, access paths, contract terms, credentials, restricted datasets, or other non-public material. Internal project evidence must stay in separately approved WSP storage and governance systems.

## App design decision

Use the **actual Electron + React/TypeScript + FastAPI + SQLite desktop architecture** of [Camera_Trap](docs/10-camera-trap-architecture-reference.md), with a much smaller feature set and dependency tree. The [file-level reuse audit](implementation/reuse.md) records what can be copied, adapted or used only as a design pattern after licensing checks. The previous Gradio reference was incorrect and has been superseded. Start with streamed time-window IR motion summaries, original video verification, review/QA records, and CSV export. Tracking is an optional next enhancement. **Thermal and acoustic analysis are outside v1.** Any controlled test on client footage requires documented access and permission checks first. See [architecture](docs/09-ir-first-architecture-draft.md).

## Delivery boundary

The repository holds public research, Markdown architecture and initial shareable application source. Engineering with synthetic or appropriately licensed public test clips is compatible with the research stage; real client footage and a controlled pilot require the relevant access, privacy, IT and ecological checks. Existing time-stamped observations are **prelabels**, not validated ground truth. Acceptance thresholds and final ecological sign-off remain to be agreed.

## Ownership and licence

The code/IP owner and intended distribution licence have **not been determined**. No licence should be inferred from the repository's public visibility. Confirm ownership and reuse rights before publishing application code or copying reference implementations.
