# 08 - Motion-summary review: public prior art and design implications

Reviewed: 2026-10-15  
Status: public-source research and proposed independent design. **No private meeting transcripts, screenshots or non-public vendor information are reproduced here.**

## Executive finding

A **motion-summary-first** approach is a credible and lower-complexity first milestone for an in-house, human-reviewed IR emergence-video application. It does not require bat-specific model training or reliable individual tracking before it can be tested. It generates a reviewable visual record for **every time window**, with a direct path back to the original video. Tracking, counting and learned classification can be evaluated as separate later features.

The first objective is to **improve ecological review efficiency without silently removing evidence**. It is not to claim automated bat detection or regulatory-grade emergence classification.

## Public evidence: Wildlife Imaging Systems

**Correct public company name:** [Wildlife Imaging Systems](https://www.wildlifeimagingsystems.com/services-bat-emergence). Its emergence-video processing offering is distinct from its wind-turbine products.

| Publicly documented item | Evidence and qualification |
| --- | --- |
| Video modality | Vendor says its service handles near-IR and thermal videos, with best results from a stationary viewpoint. [Official service page](https://www.wildlifeimagingsystems.com/services-bat-emergence) |
| Processing | Vendor describes frame-by-frame motion analysis with **one summary image per 30-60 seconds**. It is a cloud processing service, not a locally released motion-processing engine. [Official service page](https://www.wildlifeimagingsystems.com/services-bat-emergence) |
| Review | Ecologist interprets summary images and opens the corresponding original video when required. [Official service page](https://www.wildlifeimagingsystems.com/services-bat-emergence) |
| Review application | [WISARD](https://www.wildlifeimagingsystems.com/wisard-software) supports image/track labels, notes, original-video navigation, filtering, reporting and sequential multi-reviewer workflows. Its FAQ explicitly says it **does not generate summary images locally**. |
| Public software artefacts | [WISARD releases](https://github.com/WildlifeImagingSystems/wisard-labeling-tool-releases) are available on GitHub, but the repository README says it contains **installers only**. Public binaries are **not equivalent to an open-source implementation or a licence to reuse code**. |
| Reported review savings | The vendor claims up to 90% less review time. **Marketing claim, not an independently established benchmark for target IR footage.** [Official service page](https://www.wildlifeimagingsystems.com/services-bat-emergence) |
| Field-use example | A [publicly available 2025 bat survey report](https://docs.planning.org.uk/20250910/73/SSP14ADWH6X00/ueyziikzwnauclwd.PDF), section 4.3.4 and Plate 1, describes 30-second motion-trace summaries used for a survey, followed by human review and targeted inspection of source footage. It is evidence of a documented workflow, **not an independent sensitivity or time-savings validation**. |

**What is not public or not established:** exact motion detection algorithm, background model, thresholding, noise treatment, colour-to-time mapping, image compositing rules, internal code, model licences, false-negative rate, and event recall. Do not reverse-engineer unverified proprietary implementation details into factual descriptions.

## Other public product references

| Product | Publicly described workflow | Relevance to initial IR app | Limitations |
| --- | --- | --- | --- |
| [Wildlife Imaging Systems + WISARD](https://www.wildlifeimagingsystems.com/services-bat-emergence) | Time-window motion summaries plus ecological review | **High**: direct precedent for low-training-data, reviewer-centred triage | Vendor processing is cloud-based; engine is not published as reusable source |
| [Ecordea Roost](https://www.ecordea.com/) | Composite image for each roughly 32-second thermal interval, linked to video and audio | **High concept relevance** for summary tiles and navigation | Thermal-first integrated product; audio is outside the proposed Phase 1 |
| [TrackBats](https://trackbats.com/en/) | Vendor-reported detection, tracks, exit heatmaps and emergence/re-entry reports | **Later phase** for track/event visualisation | Hosted upload service; internal algorithm, rights and independent accuracy unverified |
| [ThruTracker](https://www.thrutrackeranalytics.com/user-guide) | Detection, tracking, gates and counting, predominantly in thermal emergence settings | **Later phase** for track and gate logic | Camera/modality and high-density colony differences; current product/licence status must be checked |
| [Reflex Cameras motion analysis](https://reflexcameras.co.uk/video-motion-analysis-service/) | Publicly advertised locally processed, timestamped motion images for 15-second intervals | **High concept relevance** for offline processing and alternative interval length | Claims are vendor-reported; implementation and rights unverified |

This table compares **public descriptions**, not tested product quality. Do not copy third-party assets, source code, or distinctive implementation without rights.

## Independent technical concept to evaluate

A straightforward, independently developed design could use standard [OpenCV](https://github.com/opencv/opencv) operations and [FFmpeg](https://ffmpeg.org/) to produce a temporal motion summary:

1. **Audit input:** inspect source codec, frame rate, timebase, timestamps, orientation, duration and original-speed provenance. Hash the original.
2. **Check stability:** estimate global frame movement, cuts, re-aiming, camera shake and IR illumination changes. Mark unreliable intervals.
3. **Partition time:** choose configurable non-overlapping intervals, initially 30 seconds, and preserve each interval's exact original-video start/end timestamps.
4. **Estimate reference scene:** build a streaming background or representative frame without loading an entire full-resolution interval into RAM.
5. **Extract motion evidence:** compare frames or a background estimate, then handle sensor noise and illumination artefacts with **documented, adjustable** settings.
6. **Visualise time:** overlay motion evidence with a colour progression and an optional context panel. The colour mapping must be explicit and testable; a cyclic RGB sequence by itself is not an unambiguous absolute timestamp.
7. **Emit every summary:** generate one image per interval, including apparently quiet intervals, with a visible quality flag and navigation link.
8. **Review:** provide image gallery, next/previous, zoom, original-video jump, bat/insect/bird/unknown annotation, QA state and export.
9. **Audit:** preserve original source, processing parameters, version, image interval, reviewer and corrections.

### Memory and processing caution

At 1920 x 1080, a 30-second interval at 25 fps has 750 frames. Storing all 750 raw RGB frames simultaneously would require approximately **4.67 GB** of pixel data, before additional arrays and Python overhead. Prefer streaming frame accumulation and bounded buffers. This is an engineering estimate, not a claim about any vendor's implementation.

### Boundaries and quality

- Summary images can **hide** faint/brief bats due to motion thresholds, noise filtering, compression, occlusion, overlap or a moving camera. **No classifier does not mean no false negatives.**
- An image containing a track does **not** establish that the track belongs to a bat, represents one individual, or proves roost emergence.
- Multiple tracks in one summary may overlap; the image alone may not resolve count, precise event timing or direction.
- Empty-looking images are not validated negatives. All windows should remain available during initial ecological validation.
- A changed viewpoint may invalidate the reference scene; reset/segment processing and flag the interval for manual inspection.
- A review-speed claim must be benchmarked against complete manual review, including QA corrections and missed-event checks.

## Candidate Phase 1 product definition

**IR Motion Summary Reviewer (MVP):**
- Local / approved-environment ingestion of original IR video.
- One timestamped motion summary for every configurable time window.
- Scene context image, optional colour-coded temporal motion, stability/quality flag.
- Timeline and gallery, original-video jump, review labels and notes.
- Reviewer and QA status; CSV export; original-file/timebase traceability.
- No trained model required and no automatic removal of apparently inactive windows.

**Optional Phase 1.5:** per-object motion tracks, candidate events and roost-region overlays.  
**Later:** bat-specific learned detection, direction-based emergence proposals, counting and acoustic integration.

## Benchmark proposal

Compare (A) full manual review; (B) all-window motion summaries plus source-video verification; (C) selective candidate-clip review; and (D) learned detector/track review when available. Measure adjudicated emergence/re-entry recall, false alerts per hour, total reviewer time, QA disagreement, image/window interpretability and source-video retrieval success. A fast gallery that misses bats is not an acceptable outcome.

## Open questions

- How do colour schemes affect recognition of very short, low-contrast IR flights?
- Are 15, 30 or 60-second intervals better for sparse UK roost footage? Test rather than assume.
- What is the minimum motion sensitivity that preserves adjudicated emergence events?
- Can background resets or alignment mitigate minor tripod movement without erasing small moving targets?
- Should multiple simultaneous tracks be labelled directly on summaries or only in original-video clips?
- How should missing/uncertain absolute clock time be entered and audited?
- What local processing throughput is realistic on an approved CPU-only Windows laptop?

## Sources

1. [Wildlife Imaging Systems - Bat Emergence](https://www.wildlifeimagingsystems.com/services-bat-emergence)
2. [Wildlife Imaging Systems - WISARD Software](https://www.wildlifeimagingsystems.com/wisard-software)
3. [WISARD GitHub releases, installer-only repository](https://github.com/WildlifeImagingSystems/wisard-labeling-tool-releases)
4. [Public 2025 bat survey report, section 4.3.4 and Plate 1](https://docs.planning.org.uk/20250910/73/SSP14ADWH6X00/ueyziikzwnauclwd.PDF)
5. [Reflex Cameras - Motion Analysis Service](https://reflexcameras.co.uk/video-motion-analysis-service/)
6. [Ecordea - Roost](https://www.ecordea.com/)
7. [TrackBats](https://trackbats.com/en/)
8. [ThruTracker - User Guide](https://www.thrutrackeranalytics.com/user-guide)

## Implementation note (2026-10-15)

For the proposed in-house implementation, select the simplest offline stack consistent with the existing [Camera_Trap Gradio pattern](10-camera-trap-architecture-reference.md). A reviewer gallery, source-video verification clip, and a local append-only QA log are sufficient for the first app. An online image service, database server, learned model, and cloud workflow are **not prerequisites**.
