# 06 - Research backlog and decision questions

Last reviewed: 2026-10-15  
Status: open research programme. Priorities are proposals, not committed WSP tasks.

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

## Priority 2 - Productisation questions

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
