# 02 - Evidence and source register

Last reviewed: 2026-10-15  
Scope: **initial curated scoping review**, not an exhaustive systematic review. Sources are public unless marked otherwise. This register records relevance and open checks, not approval for WSP use.

## Evidence status convention

- **Directly verified:** the cited source was inspected. This verifies what the source says, not that its performance claims have been reproduced.
- **Source-reported:** the author, vendor or maintainer states a claim; it has not been independently reproduced or legally approved.
- **Inference:** a reasoned interpretation that is not directly established by the source.
- **Unverified:** a lead or claim that has not yet been checked.

## Search and inclusion method (living scoping review)

This register is **curated**, not exhaustive or PRISMA-complete. Future additions should record the research date, searched location (journal database, scholarly search, GitHub, official regulator site or vendor site), exact search string, inclusion/exclusion reason and date accessed in [the research log](07-research-log.md). Prioritise original IR/thermal bat video, verified repositories and reproducible methods. Exclude purely acoustic classification from the initial video-method shortlist. Check vendor claims against papers or independent examples where possible; record failed searches and access barriers. **Do not backfill fictitious search strings for older entries.**

## Camera_Trap reference

The public [Camera_Trap repository](https://github.com/cameaci/Camera_Trap) was inspected directly on 2026-10-15 as an **application architecture and review workflow reference**, not as a bat-detection benchmark. Current code contains an [Electron desktop shell](https://github.com/cameaci/Camera_Trap/blob/main/electron/src/main.ts), [React + TypeScript frontend](https://github.com/cameaci/Camera_Trap/blob/main/frontend/package.json), [FastAPI backend](https://github.com/cameaci/Camera_Trap/blob/main/backend/app/main.py), [SQLite data layer](https://github.com/cameaci/Camera_Trap/blob/main/backend/app/db/base.py), and a [verify gallery](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/VerifyView.tsx) with human labels and count confirmation. See the corrected [implementation review](10-camera-trap-architecture-reference.md). The reference has an [MIT licence with a WSP copyright notice](https://github.com/cameaci/Camera_Trap/blob/main/LICENSE); the licence and approval for Bat Innovation must be assessed separately.

**Correction:** an earlier entry incorrectly described the live reference repository as a Gradio application. That claim has been withdrawn.


## A. Professional guidance and grey literature

| ID | Source | What it contributes | Applicability / open check | Status |
| --- | --- | --- | --- | --- |
| G01 | [Bat Conservation Trust - Bat Surveys for Professional Ecologists: Good Practice Guidelines, 4th ed.](https://www.bats.org.uk/resources/guidance-for-professionals/bat-surveys-for-professional-ecologists-good-practice-guidelines-4th-edition) | UK professional survey context, NVA use and ecological judgement; amended PDF linked by publisher (March 2024). | Define survey-context and expert-review constraints; not an algorithm benchmark. | Directly verified (source reviewed) |
| G02 | [Bat Conservation Trust - Bat Emergence Surveys with Night Vision Aids: A Technical Guide](https://www.bats.org.uk/resources/guidance-for-professionals/bat-emergence-surveys-with-night-vision-aids-a-technical-guide) | Technical NVA fieldcraft, equipment limitations and data management. | Guide is offered as a paid publication; full contents **not reviewed** here. Obtain through authorised channels before relying on details. | Directly verified (publisher page) |
| G03 | [NatureScot - Bats and licensing](https://www.nature.scot/professional-advice/protected-areas-and-species/licensing/species-licensing-z-guide/bats-and-licensing) | States that NVAs are expected as standard for building and tree emergence surveys from the 2025 season in its context. | Jurisdiction-specific; do not treat as a universal UK legal rule. | Directly verified (source reviewed) |
| G04 | [BCT - New Technologies for Bat Surveys](https://www.bats.org.uk/resources/guidance-for-professionals/new-technologies-for-bat-surveys) | Practitioner technology comparison and survey-use considerations. | Useful for requirements gathering; not model-performance evidence. | Directly verified (source reviewed) |
| G05 | [William Rees, University of Exeter - Automated Detection and Tracking of Bats within Infrared Videos](https://cdn.bats.org.uk/uploads/events-training/William_Rees_NBC_Poster.pdf?v=1725643811) | Directly relevant research poster describing event annotation, tracking, segmentation and AI classification in long-form IR footage. | Seek publication, code, evaluation details and data rights. A poster is not independently replicated performance evidence. | Directly verified (source reviewed) |

## B. Academic papers and research projects

| ID | Source | What it contributes | Applicability / open check | Status |
| --- | --- | --- | --- | --- |
| P01 | [Boston University - Infrared Thermal Video Analysis of Bats](https://www.cs.bu.edu/faculty/betke/research/bats/) | Long-running research on thermal-video detection, tracking and counting of bat emergences. | Thermal colony counting differs from sparse UK NVA events; investigate algorithms and code/data rights. | Directly verified (source reviewed) |
| P02 | [Thermal Imaging Reveals Significantly Smaller Brazilian Free-Tailed Bat Colonies Than Previously Estimated (2008)](https://academic.oup.com/jmammal/article/89/1/18/1021254) | Field methodology and thermal bat-counting context. | High-density colonies, not necessarily comparable to single emergence events. | Directly verified (paper page) |
| P03 | [Evaluation of different monitoring methods at maternity roosts of greater mouse-eared bats (2022)](https://link.springer.com/article/10.1007/s10531-022-02389-7) | Describes IR video counting, human review, and independent validation of sampled segments. | Relevant for designing QA and manual baseline; not proof of automated accuracy. | Directly verified (paper) |
| P04 | [Deep Learning for Wildlife Monitoring: Near-Infrared Bat Detection Using YOLO Frameworks (2025)](https://doi.org/10.3390/signals6030046) | Direct NIR bat detection study comparing YOLO variants. Authors report strong in-dataset detection results. | **Do not transfer reported mAP to WSP footage.** Source says data are available only on reasonable request, not an open ready-to-use dataset. Reproducibility and licensing require follow-up. | Directly verified (paper); results source-reported |
| P05 | [Integrating 3-D thermal videography, ultrasonic acoustics, and weather radar to characterize bird and bat activity at wind turbines (2026)](https://doi.org/10.1371/journal.pone.0352329) | Thermal tracking and multimodal monitoring; paper links [code and data](https://github.com/AaronJCorcoran/wind-turbine-multi-sensor-study). | Wind-turbine activity is not roost emergence. Article reports MIT code and CC BY 4.0 data; confirm individual assets before reuse. | Directly verified (paper); licensing source-reported |

## C. Software, algorithms and repositories

| ID | Source | Candidate role | Licence and suitability caveat | Status |
| --- | --- | --- | --- | --- |
| T01 | [OpenCV](https://github.com/opencv/opencv) | Video I/O, background subtraction, morphology, connected components, optical flow. | Check deployed build/dependencies and codec support. Needs site-specific tuning. | Unverified (repository lead) |
| T02 | [FFmpeg / ffprobe](https://ffmpeg.org/ffprobe.html) | Inspect stream metadata, frame rates, timestamps, timebase and container information. | Original-speed provenance cannot be established from metadata alone. Check binary build and codec licences. | Unverified (documentation lead) |
| T03 | [Norfair](https://github.com/tryolabs/norfair) | Lightweight multi-object tracking of detections. | Maintainer states BSD-3-Clause; test ID switches and small-target performance. | Directly verified (repository statements) |
| T04 | [CVAT Community](https://github.com/cvat-ai/cvat) | Self-hosted image/video annotation, review and audit workflow. | Maintainer states MIT-licensed core; dependencies and deployment require review. **Self-hosted**, not CVAT Online, is the candidate for restricted data. | Directly verified (repository statements) |
| T05 | [FiftyOne](https://github.com/voxel51/fiftyone) | Dataset inspection, visual QA and model-error analysis. | Deployment and licence review pending. | Unverified |
| T06 | [Microsoft MegaDetector](https://github.com/microsoft/MegaDetector) | Wildlife detector for screening images; possible comparison baseline. | Camera-trap domain differs from tiny flying bats. Maintainer states code MIT, but **model weights have variant-specific MIT, Apache-2.0 or AGPL-3.0 terms**; check exact version. | Directly verified (repository) |
| T07 | [Ultralytics](https://github.com/ultralytics/ultralytics) | YOLO training/inference candidate. | Model suitability untested; licensing/commercial deployment terms require legal review. Do not assume every YOLO implementation is permissively licensed. | Unverified |
| T08 | [Bat density estimation (yuonny)](https://github.com/yuonny/bat_density_estimation) | Research lead on thermal bat emergence density-map counting. | Repository describes thermal data and annotation tiles; **dataset download, origin, permission, licence and transferability not established**. | Unverified |
| T09 | [TrackBats](https://trackbats.com/en/) | External reference for possible outputs such as counts, tracks and highlight clips. | Hosted upload service, not evidence of an in-house reusable model. Do **not** upload client video without explicit approval. Claims are vendor-reported. | Source-reported (commercial reference) |

## D. Dataset and media availability assessment

| Candidate | Modality | Availability assessment | Reuse assessment |
| --- | --- | --- | --- |
| Near-infrared bat images in [P04](https://doi.org/10.3390/signals6030046) | NIR still images/video-derived frames | **Not openly downloadable** according to paper; author request needed. | Not cleared. |
| Bat emergence density-map training data in [T08](https://github.com/yuonny/bat_density_estimation) | Thermal video-derived tiles | Repo describes data layout, but access to original recordings and full training data not verified. | Not cleared. |
| Wind-turbine multi-sensor materials in [P05](https://github.com/AaronJCorcoran/wind-turbine-multi-sensor-study) | Thermal / acoustic / radar | Paper reports linked public materials; exact usable video samples need inspection. | Source-reported open licences, per-asset verification pending. |
| BU project demonstration media in [P01](https://www.cs.bu.edu/faculty/betke/research/bats/) | Thermal bat videos | Research/demo material, not a verified training corpus. | No redistribution/training permission assumed. |

**No dataset in this register is yet confirmed to be a cleared, representative benchmark for UK roost emergence analysis.** An acoustic bat-call dataset is not interchangeable with an IR-video event dataset.

## E. Public commercial and grey-literature workflow precedents (2026-10-15 update)

| ID | Source | Publicly supported relevance | Limits / deployment implications | Status |
| --- | --- | --- | --- | --- |
| V01 | [Wildlife Imaging Systems - Bat Emergence](https://www.wildlifeimagingsystems.com/services-bat-emergence) | Vendor describes cloud-based, camera-agnostic near-IR/thermal motion summaries, one per **30-60 seconds**, with ecologist review and source-video navigation. | Up to 90% time savings is a **vendor claim**, not a validated WSP result. Exact algorithm and code are not disclosed. | Directly verified (vendor page) |
| V02 | [Wildlife Imaging Systems - WISARD](https://www.wildlifeimagingsystems.com/wisard-software) | Image/track labels, notes, original-video jump, filtering, QA and reporting; its FAQ confirms the review app **does not produce summaries locally**. | [GitHub releases](https://github.com/WildlifeImagingSystems/wisard-labeling-tool-releases) are **installer-only**, not reusable open-source code. | Directly verified (vendor page and README) |
| V03 | [Public bat survey report (2025), section 4.3.4 and Plate 1](https://docs.planning.org.uk/20250910/73/SSP14ADWH6X00/ueyziikzwnauclwd.PDF) | Documents actual use of 30-second colour motion-trace summaries followed by ecological review and original-video inspection. | One public report demonstrates workflow use, not sensitivity or quantified time savings. Avoid republishing survey site details or imagery. | Directly verified (published report) |
| V04 | [Reflex Cameras - Motion Analysis Service](https://reflexcameras.co.uk/video-motion-analysis-service/) | Vendor describes **locally processed**, 15-second timestamped motion-summary images for bat IR/thermal footage. | Independent quality, licence and local implementation not verified. | Directly verified (vendor page) |
| V05 | [Ecordea Roost](https://www.ecordea.com/) | Vendor describes one motion composite per approximately 32 seconds with original thermal video and acoustic review. | Thermal-first; acoustic integration out of scope for Phase 1. | Directly verified (vendor page) |
| V06 | [ThruTracker - User Guide](https://www.thrutrackeranalytics.com/user-guide) | Public guidance on tracking, crossing gates and emergence counting. | Primarily thermal tracking/counting precedent; evaluate separately from IR motion-summary baseline. | Directly verified (official docs) |

See [motion-summary prior art and independent design considerations](08-motion-summary-prior-art.md). Public vendor descriptions and published examples do not establish permission to copy proprietary implementations.

## Initial synthesis

1. Directly relevant precedent exists for automated bat tracking and counting, especially thermal video. The closest NVA-specific lead is the Exeter poster.
2. A **simpler first baseline** is a complete set of timestamped motion-summary images with ecologist review and original-video navigation. Add tracking and learned detectors only if they improve measured outcomes.
3. Roost emergence classification is a **temporal and spatial ecological decision**, not simply object detection.
4. Public availability, reproducibility, permissive software licences, dataset licences and client reuse permissions are separate checks.
5. No external reported accuracy should be presented as validated WSP performance.

## Source-review rules

For each new item record: stable URL/DOI, authors, year, modality (active IR, thermal, RGB, acoustic), task, method, evaluation protocol, reported performance, code availability, data availability, licence, deployment constraints, and relevance to WSP in-house use. Distinguish quoted/source-reported findings from independent verification. Use the [review template](source-review-template.md).

## Open research gaps

- A survey of current bat-specific open-source video detectors and benchmarks, beyond these initial leads.
- Comparable false-positive rates for insects/birds and sparse roost emergence.
- Data and model licences suitable for internal commercial consulting use.
- Full NVA technical-guide requirements and local jurisdiction differences.
- Benchmark videos with frame-level bat boxes **and** adjudicated event-level emergence labels.

## Additional practice-relevant research leads (not yet verified)

Further checks are warranted for Fiji/TrackMate, DeepLabCut, thermal bat tracking products and publicly shared bat-counting YOLO/SORT examples. These are **research leads only**: modality, code/weight licences, download availability and practical relevance have not yet been verified. Validate before citing as evidence or recommending installation. Record FFmpeg build-specific licence terms and exact Ultralytics code/weight licensing as priority reviews.
