# 05 - Evaluation and ecological validation framework

Last reviewed: 2026-10-15  
Status: proposed protocol. No benchmark results have been produced.

## Unit of evaluation

Use **events and review intervals** as the primary units, with frame-level detection metrics as secondary diagnostics. A model that detects moving pixels can still miss emergence events or generate too many false alerts.

A ground-truth event should include a unique event ID, original video hash/reference, start and end time or frame range, camera, final event class, reviewer identity, adjudication status, confidence/uncertainty and a link to the original footage in approved storage.

## Provisional observation and ecological-decision ontology

Keep **what was seen** separate from **what an ecologist concludes**. A single six-class model is too restrictive for practical IR emergence review.

| Field | Examples | Rules |
| --- | --- | --- |
| Observation | bat, insect, bird, other moving object, uncertain | Describes the visual evidence, not roost use |
| Activity | commuting, foraging, flight past feature, unknown | Optional; may coexist with other observations |
| Ecological decision | emergence, re-entry, no supported emergence, precautionary emergence, uncertain | Must have a reviewer and supporting evidence |
| Count | non-negative integer or unknown | Never assume number of tracks equals number of individuals |
| Status | prelabel, reviewed, QA pending, QA reviewed, finalised | Approval level is independent of class |
| Quality flag | camera shift, IR-mode change, low contrast, timebase uncertain | Keep uncertainty visible through export |

A known roost entrance polygon is **optional**: the feature may be unknown or outside the frame. A **precautionary emergence** is an explicit conservative decision, not an automatically confirmed emergence. Definitions and export mappings require sign-off by a qualified ecological lead.

## Ground-truth policy

- Distinguish original observer labels, QA comments, and **signed-off final adjudication**. Existing annotated spreadsheets are **prelabels** until the original video and final review are checked.
- Treat human review as an **imperfect reference**: adjudicate the union of original reviewer, QA and app-suggested events using an independent qualified reviewer for the benchmark.
- Record all reviewer disagreements and resolution chronology.
- Do not count keyword matches as verified events.
- Do not treat missing annotations or unobserved intervals as negative.
- Do not treat unreviewed potential emergences as confirmed positives.
- Verify source-file and timestamp linkage before an event enters the benchmark.
- Use double review or targeted adjudication on difficult and sampled negative intervals.
- Include **QA-discovered events** as a specific missed-event challenge category once validated.

## Primary performance measures

1. **Event recall:** proportion of adjudicated target events covered by at least one timely candidate alert.
2. **Event precision:** proportion of candidate alerts that correspond to an adjudicated target event.
3. **False alerts per video hour:** operational burden on reviewers.
4. **Review time per original video hour:** measured analyst time including adjudication and corrections.
5. **Missed emergence/re-entry count:** report explicitly, with severity and confidence.
6. **Traceability:** percentage of alerts with reproducible original-file, time and evidence links.
7. **Survey-level conclusion agreement:** compare feature/roost presence interpretation and survey outcome between full review and app-assisted review.
8. **Count agreement:** compare supported peak counts and explicitly flag uncertain or multi-bat events.

Secondary measures: frame-level precision/recall, detection mAP (where boxes exist), track fragmentation/ID switches, timestamp error, processing throughput and compute cost.

## Matching policy (to agree before testing)

An algorithmic alert matches a ground-truth event only if it overlaps the adjudicated time interval or falls within a **pre-registered** tolerance. Count each ground-truth event at most once. Deduplicate overlapping alerts before computing precision and false-alert burden. Pre-register rules for multi-bat events, uncertainty and clips spanning multiple cameras.

No numeric tolerance, acceptance margin, allowed miss rate or false-alert burden is set yet. These must be approved by a qualified ecological owner **before acceptance testing**.

## Split and sampling strategy

- Split by **site/survey/camera session** rather than random adjacent frames, to reduce leakage.
- Reserve an unseen holdout set for final assessment.
- Sample difficult negatives: insects, birds, foliage, weather, lighting artefacts, commuting and ambiguous roost-adjacent motion.
- Include varied camera models, active-IR illumination, distances, entrances, lighting and seasons where available. **Thermal is explicitly outside the v1 benchmark** and must not be mixed into the primary IR score.
- Audit complete selected intervals for negatives rather than assuming that blank workbooks imply no events.
- Record class imbalance and confidence intervals; avoid presenting a small pilot as generalisable accuracy.

## Minimum pilot report

| Field | Expected output |
| --- | --- |
| Dataset scope | Number of original videos, hours, sites, cameras and modality |
| Eligibility | Provenance, permission and QA approval status |
| Ground truth | Class counts by adjudication status and sampling method |
| Baseline | Manual review time and quality controls |
| Models | Versions, settings, hardware and training data |
| Outcomes | Recall, precision, false alerts/hour, time saved, missed events |
| Failure analysis | Difficult negatives, missed positives and site/camera drift |
| Limitations | Unreviewed intervals, uncertainties and generalisability |
| Decision | Continue, revise, or stop with named reviewer sign-off |

## Safety of a small rare-event pilot

When positives are rare, zero observed misses does not establish that the miss probability is zero. As a rough illustration, with zero misses in `n` independent positive events, the approximate upper 95% bound on the miss rate is `3/n`. This is an **illustration, not a fixed dataset target**: survey/site clustering, imperfect reference labels and unequal difficulty complicate real inference. Report confidence intervals and never claim production-ready sensitivity from a handful of positives. A defensible future framing is **non-inferiority to a carefully adjudicated manual baseline on ecological outcomes plus review-time improvement**, with the margin pre-agreed.

## References

- [Evaluation of different monitoring methods at maternity roosts of greater mouse-eared bats](https://link.springer.com/article/10.1007/s10531-022-02389-7)
- [Exeter - automated bat tracking in infrared video](https://cdn.bats.org.uk/uploads/events-training/William_Rees_NBC_Poster.pdf?v=1725643811)
- [Near-infrared bat detection with YOLO](https://doi.org/10.3390/signals6030046)

## Desktop reviewer and QA comparability

The local review UI follows the [public Camera_Trap human verification interaction patterns](10-camera-trap-architecture-reference.md): a browsable gallery, next-unreviewed navigation, count correction, visible progress and persistent edits. It does **not** inherit camera-trap species-count semantics or confer authority for final bat-roost decisions. Evaluate the bat-specific reviewer and independent QA together, recording disagreements and survey-level changes. Keep output rows suitable for existing ecological spreadsheets while storing processing diagnostics separately.

## Additional baseline - Complete time-window motion-summary review

Before evaluating any automatic skip/triage, benchmark an **all-window summary gallery** that retains every interval and links each image to the original recording. Compare full manual review against summary-assisted review using the same adjudicated videos. Measure (1) time spent reviewing summary images, (2) time spent checking original video, (3) missed emergence/re-entry events, (4) reviewer confidence and disagreements, and (5) camera-stability/low-contrast failure cases. A motion summary is not itself a detection or a validated negative.

The window size (for example, 15, 30 or 60 seconds) is an experimental parameter. Record the exact time interval and processing settings for every summary. Source-reported vendor time savings are not baseline results.
