# 06 - Research backlog and decision questions

Last reviewed: 2026-10-15  
Status: open research programme. Priorities are proposals, not committed WSP tasks.

## Immediate implementation and evidence priorities

| ID | Deliverable | Responsible role (not assigned person) | Dependency |
| --- | --- | --- | --- |
| I01 | Confirm local Windows workstation, installation permissions, data folder and approved offline execution | App owner + IT | Before real-file execution |
| I02 | Build clean Gradio/Python project skeleton matching the [Camera_Trap reference](10-camera-trap-architecture-reference.md) | Developer | Gate 0, synthetic inputs |
| I03 | Unit-test segmented timebase, clock-offset handling, camera movement and all-window summaries | Developer | I02 |
| I04 | Produce local reviewer and QA history with reporting CSV and audit export | Developer + ecological reviewer | I02 |
| I05 | Verify original-file format and metadata on permitted examples; treat spreadsheet labels as prelabels | Data custodian + ecological lead | Gate 1 access/permissions |
| I06 | Identify final ecological sign-off owner, disagreeing QA reconciliation and acceptance thresholds | Ecological lead | Before benchmark |
| I07 | Measure full manual review baseline and compare with complete summary-assisted review | Ecological lead + reviewer(s) | Gate 2 benchmark |
| I08 | Decide whether optional motion tracks materially improve review | Developer + ecological lead | I07 results |

**Focus:** deliver a working **local summary reviewer**, not an infrastructure platform. Future multi-user sharing, hosted services, detectors and acoustic/thermal integration are deferred.

## Priority 0 - Evidence and rights

| ID | Question / task | Evidence required | Completion condition |
| --- | --- | --- | --- |
| R01 | Which bat-specific IR/thermal video detection and tracking projects are publicly documented? | Papers, technical reports, code, datasets, author/project pages | Annotated prior-art map with direct links and limitations |
| R02 | Which datasets include flying bats, original video, frame annotations and event labels? | Dataset landing pages, manifests, licence and download inspection | Dataset suitability matrix with access and reuse status |
| R03 | Which open-source dependencies and weights are appropriate for an internal commercial workflow? | Exact licences for code, model weights, dependencies and data | Version-specific licence review, subject to legal approval |
| R04 | What do the latest BCT NVA guidance and relevant jurisdictions require for video analysis and evidence? | Authoritative current guidance | Requirements summary reviewed by an ecological lead |
| R05 | What are the legal and organisational gates for using project footage for training, testing and retention? | Executed project terms and internal approvals, stored privately | Written authorisation and approved environment |

## Priority 1 - Technical comparison

| ID | Question / task | Evidence required | Completion condition |
| --- | --- | --- | --- |
| R06 | Can simple motion detection find sparse bat events with a manageable alert rate? | Approved video sample, adjudicated event labels | A1 baseline with event recall and false alerts/hour |
| R07 | Does tracking plus roost geometry improve event proposals? | Entrance polygons and reviewed trajectories | A2 comparison against A1 |
| R08 | Does a bat-specific detector outperform a generic wildlife model? | Comparable train/test split and model/weights licences | A3 comparison under the same protocol |
| R09 | Can an ecologist use candidate clips to save review time? | Timed blinded or counterbalanced review sessions | Time-savings estimate with missed-event audit |
| R10 | What failure modes dominate across camera types and sites? | Stratified error review | Documented error taxonomy and mitigation backlog |

## Priority 1A - Motion-summary-first MVP

| ID | Question / task | Evidence required | Completion condition |
| --- | --- | --- | --- |
| R11 | Can an all-window 30-second motion-summary gallery make sparse IR emergence review faster without missed events? | Approved representative IR videos, adjudicated events, timed ecologist reviews | Measured event recall and total review effort versus full manual review |
| R12 | Which temporal encoding, motion thresholds and window sizes preserve faint, fast IR bat flights? | Controlled parameter sweep on validated positives and hard negatives | Documented visibility/false-motion trade-offs across 15, 30 and 60 seconds |
| R13 | How do minor tripod shifts, camera re-aiming and illumination changes affect summaries? | Stability tests and flagged original intervals | Explicit failure/quality flags and recovery policy |
| R14 | Which local review functions provide the greatest practical benefit? | User workflow testing: gallery, zoom, original-video seek, labels, QA, CSV | Usable reviewer with traceable and complete window coverage |
| R15 | What is the local CPU processing speed and memory footprint for representative MP4/MTS footage? | Approved workstation, original-format video and profiler | Repeatable throughput and resource measurements |

## Deferred productisation questions (not blockers for Gate 0 code scaffolding)

- Offline Windows workstation versus internal server deployment.
- Support for `.MTS`, `.MP4` and camera-specific timebases.
- Multi-camera synchronisation and duplicate-event handling.
- Traceable evidence exports compatible with ecological reporting.
- Dependency, model and annotation versioning.
- Security monitoring, retention, role-based review and QA sign-off.

## Research deliverables

1. A source-backed landscape of papers, reports, grey literature, public projects, tools, algorithms and datasets.
2. A modality-aware comparison of active IR versus thermal methods.
3. A software/weights/data licence and deployment suitability matrix.
4. A proposed minimal reproducible baseline and ecological benchmark.
5. A prioritised evidence-gap list and decisions that need ecological, legal and IT approval.

## Decision log

| Date | Decision | Basis | Revisit when |
| --- | --- | --- | --- |
| 2026-10-15 | Use public Markdown repository for non-confidential research and documentation. | Repository visibility confirmed public. | Visibility/governance changes |
| 2026-10-15 | Prioritise in-house, human-reviewed event triage over autonomous roost conclusions. | Technical/ecological risk framing; not an empirical result. | Pilot evidence available |
| 2026-10-15 | Do not select a target dataset or model yet. | Provenance, permissions and target performance not established. | Data and approval gates satisfied |
| 2026-10-15 | Prioritise **all-window IR motion summaries plus ecological review** as the first prototype, with tracking and AI as optional later stages. | Publicly documented workflows and lower initial training-data requirements; not a performance finding. | Representative IR benchmark or reviewer feedback contradicts the hypothesis |
| 2026-10-15 | Use a **local Windows-first Gradio/Python monolith** inspired by the publicly inspected Camera_Trap app. No server, database, cloud or model-training dependency in v1. | Direct repository inspection and explicit lean-code preference. | Real multi-user or offline constraints demand change |
| 2026-10-15 | Thermal and acoustic processing are **out of v1**. | IR-first scope decision. | Separately prioritised later |
| 2026-10-15 | Start with existing spreadsheet entries as **prelabels, not verified ground truth**. | Label provenance must be independently checked. | Final ecological adjudication establishes test labels |
| 2026-10-15 | Conduct any client-footage PoC only **after relevant Gate 1 and Gate 2 requirements**. | Data, security and ecological evaluation prerequisites. | Permissions and benchmark are documented |
