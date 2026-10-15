# 03 - Technical approaches for in-house NVA video analysis

Last reviewed: 2026-10-15  
Status: design hypotheses. No approach has been benchmarked on authorised target footage.

## Design premise

The first output is a **complete gallery of all time-window motion summaries** linked to original video. Optional candidate events and tracks are secondary. Detection, tracking and ecological event interpretation are separate tasks. The first prototype should be reproducible, inspectable and runnable in an approved environment.

## Preferred first baseline - All-window temporal motion summaries

**Components:** configurable time windows (initially 30 seconds), frame-wise motion evidence, representative/background scene, temporal colour overlay, camera-stability diagnostics, a timestamped image for **every window**, and a human review gallery linked to original footage.

**Why test first:** a working reviewer can be built without individual object tracking, bat classification or training labels. Every time window remains visible to the ecologist, avoiding automatic exclusion of apparently quiet intervals during initial validation.

**Important limitations:** motion suppression may miss faint bats; composite tracks can overlap; colours do not automatically give exact timing; an apparently empty image is not a verified negative. The method is a review aid, not an automated ecological decision.

**Evidence:** [public motion-summary prior art](08-motion-summary-prior-art.md), including [Wildlife Imaging Systems](https://www.wildlifeimagingsystems.com/services-bat-emergence), [WISARD](https://www.wildlifeimagingsystems.com/wisard-software) and a [published survey workflow example](https://docs.planning.org.uk/20250910/73/SSP14ADWH6X00/ueyziikzwnauclwd.PDF).

## Option A - Classical computer vision baseline

**Components:** frame differencing or background subtraction (for example, OpenCV MOG2/KNN), morphological filtering, connected components, size/shape/motion filters, track association, event grouping.

**Why test first:** no model-training data required; interpretable threshold choices; practical way to measure whether most review time is spent on visually static footage.

**Expected failure modes:** swaying vegetation, rain, insects near the lens, camera shake, changing IR illumination, noise and compression artefacts. Small bats may disappear in low-contrast frames.

**Evidence:** OpenCV [repository](https://github.com/opencv/opencv) and [background subtraction tutorial](https://docs.opencv.org/4.x/d1/dc5/tutorial_background_subtraction.html).

## Option B - Learned object detection

**Components:** a detector trained or fine-tuned for small, fast-moving flying bats in active-IR/thermal imagery, followed by tracking.

**Why test:** may distinguish animal-like targets from generic motion better than a threshold pipeline.

**Risks:** needs frame-level bounding-box labels; modality/domain shift; small-object recall; licensing of code **and** weights; GPU and maintenance costs. Reported mAP from another camera/domain does not validate performance here.

**Research leads:** [near-infrared YOLO bat paper](https://doi.org/10.3390/signals6030046), [MegaDetector](https://github.com/microsoft/MegaDetector), [Ultralytics](https://github.com/ultralytics/ultralytics).

## Option C - Tracking and trajectory reasoning

**Components:** association of detections across frames, temporal smoothing, velocity/direction, line or region crossings, roost-entrance polygons, re-entry versus emergence direction.

**Why test:** ecological events depend on where an animal came from and where it went. A detector alone cannot distinguish commuting from emergence.

**Risks:** occlusion, multiple individuals, ID switches, camera perspective, entrance position ambiguity. A line crossing is an **event proposal**, not proof of roost use.

**Research leads:** [Norfair](https://github.com/tryolabs/norfair), [BU thermal-video bat research](https://www.cs.bu.edu/faculty/betke/research/bats/), [Exeter IR-video tracking poster](https://cdn.bats.org.uk/uploads/events-training/William_Rees_NBC_Poster.pdf?v=1725643811).

## Option D - Human-in-the-loop review

**Components:** event thumbnails, short clips with pre/post context, original-video jump link, event class and confidence, review history, duplicate-event handling, evidence export.

**Why test:** it may deliver useful time savings even when the algorithm cannot classify every bat event. The ecological reviewer retains authority over final labels.

**Research lead:** [CVAT Community](https://github.com/cvat-ai/cvat) for self-hosted annotation; [FiftyOne](https://github.com/voxel51/fiftyone) for dataset and error inspection.

## Candidate processing architecture

```text
Original IR session in approved local storage (ordered segments)
    -> original files inventory and SHA-256
    -> ffprobe metadata: FPS, field order, rotation, timestamps
    -> segment timeline, missing-gap check and clock offset
    -> camera movement / IR illumination / scene-change flags
    -> streamed frame decoding with optional clock-overlay mask
    -> per-window motion summary (ALL windows retained)
    -> stability/quality flags and timestamped image manifest
    -> ecologist gallery, original-video seek and adjudication
    -> optional candidate detection / tracking / roost-zone analysis
    -> reviewer + QA records in local append-only log
    -> reporting CSV and separate audit export
```

The original video must remain accessible for review. Derived clips should be linked by file identity and frame/timestamp range; do not silently replace original evidence with speed-altered clips.

## Experimental comparison

| Baseline | Training required | Primary output | What it can establish |
| --- | --- | --- | --- |
| A0 - Full manual review | No | Human event log | Reference review time and QA process |
| A1S - All-window motion-summary review | No | Time-ordered summary images, labels and video links | Review time and visibility of adjudicated events without automatic exclusion |
| A1 - Frame differencing / background subtraction | No | Motion intervals | Value of motion-based triage |
| A2 - A1 plus tracking and entrance-region rules | No | Candidate event tracks | Value of temporal/spatial context |
| A3 - Learned bat detector plus tracking | Yes, or external weights | Candidate bat tracks | Added value versus A2 |
| A4 - A2/A3 plus ecological review interface | May vary | Adjudicated event records | End-to-end review efficiency and auditability |

## Decision rule

Select by **event recall at an acceptable false-alert burden**, not frame mAP alone. Report review time, false alerts per video hour, evidence traceability, deployment complexity, licence constraints and robustness across cameras/sites. Do not claim automation of emergence classification from generic motion detection.

## IR-specific failure modes and safeguards

- Dusk-to-IR transitions, torch beams and lighting changes can overwhelm ordinary background subtraction: flag the affected interval and rebuild the background as required.
- Tripod-mounted cameras can be re-aimed: detect significant global motion and invalidate saved roost regions until reconfirmed.
- Insects near IR sources may dominate candidates. Begin with visible, configurable sensitivity and **flagging rather than aggressive suppression**, to avoid masking bats. Evaluate optional track-based insect discrimination only against adjudicated data.
- A recording may contain multiple video files; build the session timeline explicitly rather than interpreting every file as a new survey.
- Original-speed changes, interlacing, image rotation, broken/missing timestamps and moving clock overlays require inspection or quality flags, not blanket assumptions.
- Exact bat flight speed, distance or species cannot reliably be inferred from one uncalibrated camera view.

**Implementation architecture:** [lean local Gradio design](09-ir-first-architecture-draft.md); [Camera_Trap patterns](10-camera-trap-architecture-reference.md).

## Reproducibility requirements

Log source video hash, exact stream and frame timestamps, code version, dependency versions, model/weights identity, processing parameters, hardware, test split and adjudicated labels. Keep restricted artefacts outside this public repository.

## Architecture update

For the IR-first MVP, the **A1S all-window summary** should be built and benchmarked before track-level detection. See [draft architecture](09-ir-first-architecture-draft.md). The earlier track-first pipeline remains a candidate later enhancement, not a mandatory dependency of the first reviewer.
