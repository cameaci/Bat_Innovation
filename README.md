# Bat Innovation

**Research and documentation for an in-house, human-reviewed bat emergence video analysis workflow.**

Status: **research / discovery**. Last reviewed: **2026-10-15**.

## Purpose

This public repository collects literature, open-source software, datasets, technical options, validation methods, and decision records relevant to analysing bat emergence and re-entry in recorded night-vision footage. The intended use case is to investigate a potential **WSP-operated, in-house** workflow that reduces manual video review while retaining ecological oversight and an auditable trail.

This is an exploratory project, **not an official WSP publication, endorsed solution, or approved use of client data**. No model, dataset, workflow, or research-use permission has yet been validated for WSP deployment.

## Research questions

1. Can a local or WSP-approved environment identify candidate bat activity in infrared/night-vision recordings?
2. Can trajectories and roost context help distinguish emergence, re-entry, commuting, insects, birds, and uncertain events?
3. Can ecologists review a complete set of timestamped motion-summary windows, then inspect original video only where necessary, without missing important events?
4. Which tools, algorithms, datasets, and licences are suitable for an internally operated solution?
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
| [09 - IR-first architecture draft](docs/09-ir-first-architecture-draft.md) | Provisional in-house motion-summary-first pipeline, data contracts and review UI |
| [Source review template](docs/source-review-template.md) | Standard format for future source assessments |

## Working principles

- **Research before implementation:** document evidence and limitations before choosing a model.
- **Human-in-the-loop:** support, do not replace, qualified ecological judgement.
- **In-house by design:** prefer local execution or an explicitly approved internal environment. Do not upload client footage to public AI services.
- **Evidence traceability:** link each finding to a primary source, date, source modality, licence/access status, and relevance.
- **Reproducibility:** preserve versioned methods, evaluation protocols, and decisions.
- **Data minimisation:** do not put confidential WSP/client material in this public repository.

## Status and next step

The initial source register is a **scoping review**, not a systematic or exhaustive literature review. External-source links have been collected, but repository/code quality, dataset availability, licence compatibility, and empirical performance on target footage still require checks. A deeper literature and prior-art review has been requested. The [motion-summary review](docs/08-motion-summary-prior-art.md) adds public evidence for a lower-complexity, all-window summary-first MVP; the [architecture draft](docs/09-ir-first-architecture-draft.md) is provisional pending requirements answers.

## Documentation conventions

All project documentation is written in English and stored as Markdown (`.md`). New research should update the [source register](docs/02-source-register.md), [research log](docs/07-research-log.md), and relevant topic document. Label claims as **verified from source**, **reported by source**, **inference**, or **unverified**.

## Security note

**This repository is public.** Do not commit survey footage, internal workbooks, customer/site identifiers, access paths, contract terms, credentials, restricted datasets, or other non-public material. Internal project evidence must stay in separately approved WSP storage and governance systems.
