# 07 - Research log

## 2026-10-15 - Lean local architecture review and decisions

**Question:** How should a local IR bat reviewer be structured without overengineering, and what patterns can be reused from an existing camera-trap application?

**Method:** Inspected GitHub metadata and source files in [cameaci/Camera_Trap](https://github.com/cameaci/Camera_Trap), especially [app.py](https://github.com/cameaci/Camera_Trap/blob/main/app.py), [classifier adapter](https://github.com/cameaci/Camera_Trap/blob/main/wildlife_classifier.py), [utility module](https://github.com/cameaci/Camera_Trap/blob/main/species_postprocessing.py), [tests](https://github.com/cameaci/Camera_Trap/tree/main/tests), and [dependencies](https://github.com/cameaci/Camera_Trap/blob/main/requirements.txt). Also checked the public visibility of both repositories via GitHub metadata.

**Findings:**
1. The reference app uses **Gradio Blocks**, local Python callbacks, image/video/batch actions and JSON inference results; it launches with `share=False`.
2. Its inspected app and repository search did **not establish a complete human ecological QA sign-off feature**. Reuse the interaction design, but implement a minimal explicit reviewer/QA history for Bat Innovation.
3. The reference has useful unit-test and modular adapter patterns, but its ML dependencies, trained weights, demo assets and generated files are **not** needed in the IR motion-summary MVP.
4. Existing spreadsheet entries in the intended workflow may provide event **prelabels**; they must not be presented as approved ground truth.
5. IR-specific timing, camera movement and survey-level evaluation requirements should be addressed in a simple local workflow.

**Decisions:** Local Windows-first **Gradio** app, with five small Python modules; no database, web API, cloud infrastructure or deep-learning dependency in v1. Video session -> segments -> all motion-summary windows -> ecologist review/QA -> reporting and audit exports. Simple tracking can be added later; thermal/acoustics are out of scope. User-specific requirements not yet resolved are documented as open, not invented.

**Governance:** Both GitHub repositories were **public** at inspection. This research record adds no client footage, private workbook, site details or non-public vendor meeting content. Rights, data access, final ecological owner and acceptance thresholds remain to be established before a real-data pilot.

**Sources and direct links:** [Camera_Trap architecture audit](10-camera-trap-architecture-reference.md) | [IR architecture](09-ir-first-architecture-draft.md).

**Changed files:** README.md, docs/01-problem-and-scope.md, docs/02-source-register.md, docs/03-technical-approaches.md, docs/04-data-governance.md, docs/05-evaluation-framework.md, docs/06-research-backlog.md, docs/07-research-log.md, docs/08-motion-summary-prior-art.md, docs/09-ir-first-architecture-draft.md, docs/10-camera-trap-architecture-reference.md, docs/source-review-template.md.

---

## 2026-10-15 - Public motion-summary prior art and IR-first design revision

**Question:** Could an in-house, IR-first bat survey reviewer be useful before implementing individual-object tracking or training a bat detector?

**Method:** Checked official public product pages, the WISARD public installer-only GitHub repository, a publicly available bat survey report and related public motion-summary and tracking product descriptions. **No non-public demonstration transcript, video, screenshot or proprietary code was added to this repository.**

**Sources:**
- [Wildlife Imaging Systems - emergence service](https://www.wildlifeimagingsystems.com/services-bat-emergence).
- [WISARD software and FAQ](https://www.wildlifeimagingsystems.com/wisard-software).
- [WISARD installer-only GitHub releases](https://github.com/WildlifeImagingSystems/wisard-labeling-tool-releases).
- [2025 public bat survey report, section 4.3.4](https://docs.planning.org.uk/20250910/73/SSP14ADWH6X00/ueyziikzwnauclwd.PDF).
- [Reflex Cameras - local motion analysis](https://reflexcameras.co.uk/video-motion-analysis-service/).
- [Ecordea Roost](https://www.ecordea.com/).
- [ThruTracker user guide](https://www.thrutrackeranalytics.com/user-guide).

**Findings:**
1. Public sources document bat video review using one timestamped motion-summary image per roughly 15-60-second interval and subsequent ecological review of source footage.
2. WISARD is a review application; its FAQ says motion summaries are produced by a separate processing service, not by WISARD locally. Its GitHub release repository contains installers, **not open-source processing code**.
3. An independently published survey report describes actual use of 30-second colour motion traces and targeted original-video checking, but does not independently quantify accuracy or time savings.
4. Exact vendor algorithms and motion-colour mapping are **not established**. No algorithm has been reproduced or benchmarked here.
5. Camera stability checks and retention of all summary windows should be first-class design requirements.

**Decision:** Prefer a **complete, all-window, IR motion-summary reviewer** as the first implementation candidate. Track-level detection, roost-zone reasoning, and learned bat classifiers are optional extensions, not first-release prerequisites. Acoustic integration remains out of scope.

**Limitations:** No source video analysed, no permission or original-file availability established, no empirical recall or review-time results measured. Requirements and deployment choices remain provisional.

**Changed files:** README.md; docs/01-problem-and-scope.md; docs/02-source-register.md; docs/03-technical-approaches.md; docs/04-data-governance.md; docs/05-evaluation-framework.md; docs/06-research-backlog.md; docs/07-research-log.md; docs/08-motion-summary-prior-art.md; docs/09-ir-first-architecture-draft.md.

---

## 2026-10-15 - Repository initialization and first scoping review

**Objective:** Establish a public, English-language Markdown research record for a possible WSP in-house bat NVA video analysis workflow.

**Repository check:** `cameaci/Bat_Innovation` was found to be public and initially empty. Public documentation was therefore limited to shareable, externally sourced research and generic design notes.

**Search themes:**
- UK bat emergence survey guidance and NVA technical practice.
- Bat detection, counting and tracking from IR and thermal video.
- Open-source motion detection, tracking and annotation tools.
- Bat-related data sources and reproducibility.
- In-house deployment and model/data licence risks.

**Public sources inspected:**
- [BCT professional guidance](https://www.bats.org.uk/resources/guidance-for-professionals).
- [BCT NVA technical-guide publisher page](https://www.bats.org.uk/resources/guidance-for-professionals/bat-emergence-surveys-with-night-vision-aids-a-technical-guide).
- [Exeter infrared-video tracking research poster](https://cdn.bats.org.uk/uploads/events-training/William_Rees_NBC_Poster.pdf?v=1725643811).
- [Boston University thermal-video bat research](https://www.cs.bu.edu/faculty/betke/research/bats/).
- [2025 near-infrared bat YOLO paper](https://doi.org/10.3390/signals6030046).
- [2022 maternity-roost monitoring methods paper](https://link.springer.com/article/10.1007/s10531-022-02389-7).
- [2026 thermal multi-sensor paper](https://doi.org/10.1371/journal.pone.0352329).
- [OpenCV](https://github.com/opencv/opencv), [CVAT](https://github.com/cvat-ai/cvat), [Norfair](https://github.com/tryolabs/norfair), [MegaDetector](https://github.com/microsoft/MegaDetector).

**Initial findings (scoping-level):**
1. Bat-specific automated IR/thermal detection and tracking have credible research precedents.
2. Relevant UK professional guidance emphasises technical limitations and ecological judgement.
3. A source-reported detection score on one NIR dataset cannot be assumed to transfer to UK emergence survey recordings.
4. Model-code licences, model-weight licences, dataset rights and client footage permissions must be evaluated separately.
5. A full review of available training video and event-level annotations is still missing.

**What was not done:** no WSP footage accessed, downloaded, uploaded, analysed or validated; no original video metadata measured; no dataset rights cleared; no model trained; no performance benchmark conducted; no WSP internal approval claimed.

**Documents created:** problem/scope, source register, technical approaches, governance, evaluation, research backlog and source-review template.

**Next research action:** commission a deeper, source-backed literature/prior-art and dataset/licence review; integrate its verified findings into the source register and log after review. Do not present the initial register as exhaustive.

---

## Log entry template

### YYYY-MM-DD - Short title

**Question:**

**Sources and links:**

**Search locations / exact queries (if applicable):**

**Method:**

**Findings:**

**Limitations and uncertainty:**

**Licences/access:**

**Decision or next action:**

**Changed files:**
