# Architecture review and refinement record

Reviewed 2026-10-15. This records **design review and decisions before code**, not results of executed tests. References are source-inspected where linked; proposed changes remain hypotheses until implemented and measured.

## Pass 1: architecture and maintainability review

| Question | Alternatives weighed | Finding and refinement |
| --- | --- | --- |
| What stack minimises total work? | New Gradio/Streamlit app; directly fork Camera_Trap; small Camera_Trap-style local desktop | **Choose small Electron/React/FastAPI/SQLite**. A second UI stack would require a rewrite; a full fork imports a very large unrelated dependency and feature surface. Use a minimal Electron *development shell* in the media spike to select large original files safely, while deferring Windows installer packaging |
| How much Camera_Trap should be reused? | Copy full files; copy isolated helpers; adopt UX patterns | **Use bounded helpers where permitted**, especially download/shortcut/viewer shell. Prefer pattern-only for deeply coupled VerifyView and EventCountPanel |
| How should local data persist? | Flat JSON/JSONL; SQLite stdlib; complete SQLAlchemy/Alembic stack | **Choose SQLite stdlib with transactions and schema version**. Review history is relational; flat files risk concurrent/incomplete edits, while a mature ORM/migration stack is premature |
| How many services? | Separate UI server, worker, DB and message queue; single local API/backend | **One local Python process**, at most one persisted processing job. Polling rather than WebSockets. Electron only manages lifecycle and native dialogs |
| Should we implement bat recognition now? | Train YOLO first; classic motion summary first; track-first baseline | **All-window motion summary first**. Without approved event labels and baseline, training can consume effort without proving review value |
| How should approval work? | One "verified" Boolean; separate first/QA/final states | **Distinct human review stages with audit history**. A verified motion track is not an approved roost conclusion |

**Code minimisation outcome:** no training stack, map framework, model manager, message broker, central database, dedicated router hierarchy, remote login or large frontend state library is needed for v1.

## Pass 2: bat-video and ecological risk review

| Risk in a superficially simple implementation | Required solution, not a workaround | Test/gate |
| --- | --- | --- |
| `.MTS` sometimes does not play in Chromium | Prove codec-specific playback and use documented **on-demand local preview transcoding** when necessary, preserving source PTS | First media fidelity spike |
| `frame_index / fps` creates false timing | Read and preserve actual decoded presentation timestamps; evaluate PyAV versus FFmpeg timestamp workflow | VFR / discontinuity fixtures |
| Several recorded clips treated as one continuous file | Explicit `session -> segment` timeline and continuity state, source-linked event spans | Segment gap/boundary tests |
| Tripod moves or IR lamp activates | Global-scene/illumination diagnostic, flag, explicit reference reset and invalidated roost zones | Scene-change fixtures |
| An empty-looking image suppresses an emergence | Generate **all windows** and preserve source-video navigation; never auto-label quiet as negative | Coverage and ecological miss analysis |
| A summary window is counted as one bat | Separate review window from biological observation and optional count | Multiple-event fixture and ecological rubric |
| Bugs in manual reference are inherited as truth | Keep prelabels distinct; union-adjudicate human, QA and app suggestions | Independent benchmark |
| Missing roost polygon blocks analysis | Roost region optional; possible emergence never equates to proven origin | Unknown/off-screen feature scenario |
| Review too slow because whole video was copied for every clip | Small previews on demand, bounded cache and FFmpeg; avoid bulk full-recording conversion | CPU/storage profile |
| False alarms from IR insects | Keep raw motion visible and quality flags; test discriminators only after validated labels | Difficult negatives and insect fixture |

**Ecological refinement:** survey-level roost conclusion and count errors are higher-stakes than cosmetic motion-image quality. Human finalisation is separate from candidate detection.

## Pass 3: robustness, privacy and delivery review

| Problem | Refinement |
| --- | --- |
| App says complete after a frame decode failure | Track planned, completed and failed windows; atomic image output and durable run status |
| The reviewer sees the wrong point after seeking | PTS-aware clip mapping with marked preview source and explicit unsupported-error states |
| React directly opens any path passed in a URL | Native file chooser -> backend allowlisted source ID -> constrained preview endpoint |
| Web page can reach an unrestricted local API | Loopback binding, restricted origins, narrow preload IPC and a required per-launch token |
| A prior reviewer overwrites a conflicting QA decision | Append-only review actions, explicit revision conflicts and no silent finalisation |
| Internal recordings or coordinates leak into Git | Public source only, local app data, ignore generated files and verify commits before push |
| App works only on a development machine | Clean Windows install, bundled/vetted media runtime, startup and offline test |
| "More robust" becomes framework overengineering | One processing job, minimal schema, direct typed API, only tested UI modules; add complexity only in response to a failing measured requirement |

## Revised architecture after all three review passes

**Electron shell -> React review workspace -> one loopback FastAPI backend -> FFmpeg/PyAV-or-equivalent timestamp-aware decode + OpenCV motion summaries -> SQLite.**

The media decoder choice is an explicit early **technical spike**, not a hidden late fallback. [PyAV](https://github.com/PyAV-Org/PyAV) provides direct frame PTS and Windows wheels according to its current repository README, but a pinned compatible version, bundled FFmpeg terms and target-runtime performance must be verified. The selected decoder must pass the same seek and timing tests before it becomes a dependency.

Ship one full workflow first. Review must be able to process an arbitrary permitted IR source and explain any unsupported case. No fake successes, skipped windows or hardcoded files.

## Open decisions, not excuses to postpone coding

| ID | Decision owner | When it must be resolved |
| --- | --- | --- |
| O1 | Developer and IT/licensing | Before copying WSP-owned Camera_Trap components or releasing a build: rights and dependency notices |
| O2 | Developer | Before completing Slice 1: single PTS-preserving decoder and verified .MTS preview strategy |
| O3 | Developer plus pilot ecologist | Before Slice 2 sign-off: baseline mask method, sensitivity and motion-image interpretability |
| O4 | Ecological lead | Before QA finalisation is presented as official: permitted labels, precautionary decisions and sign-off authority |
| O5 | Ecological lead | Before benchmark: acceptable missed-event margin, false alerts if relevant, survey-level count/conclusion rule |
| O6 | Data custodian, privacy and IT | Before real footage: data access, local storage, privacy treatment, permitted downstream reuse and any UK/GCC handoff |
| O7 | Reporting ecologist | Before official workbook export: exact column mappings and provisional/final status expectations |

## Evidence boundary

- **Verified from code:** the Camera_Trap component paths and architecture in [reuse.md](reuse.md).
- **Source-reported:** vendor methods and academic results in the [source register](../docs/02-source-register.md); PyAV's published packaging statements.
- **Our engineering decisions:** this reviewed, smaller application plan and its selected invariants.
- **Not yet verified:** actual WSP camera stream compatibility, video review time saved, event sensitivity, operational approvals, installer behavior and exact reuse/legal rights.

## Final self-review checklist

- [x] Existing reference implementation inspected, rather than assumed.
- [x] Alternative stacks and copying strategies considered and rejected with reasons.
- [x] Critical .MTS playback and frame-PTS risks moved before computer-vision implementation.
- [x] Camera changes, IR mode switches, insects and split recordings captured as designed failure cases.
- [x] Biological events distinguished from summary windows, tracks and reviewer states.
- [x] All-window completeness and original-video evidence protected by acceptance tests.
- [x] Local privacy, licences, offline/packaging risks documented.
- [x] Explicit non-goals prevent expensive premature AI/cloud/analytics features.
- [ ] Implementation and tests executed (intentionally not done in this planning phase).
- [ ] Representative approved IR footage benchmark completed (requires external permissions and adjudication).

**Conclusion:** proceed only with the narrow Slice 0 -> Slice 1 proof, then re-evaluate the plan using actual compatibility and test evidence. Review/refinement of the *plan* is complete; implementation validation is not.
