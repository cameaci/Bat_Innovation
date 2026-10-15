# 05 - Evaluation and ecological validation framework

Last reviewed: 2026-10-15  
Status: proposed protocol. No benchmark results have been produced.

## Unit of evaluation

Use **events and review intervals** as the primary units, with frame-level detection metrics as secondary diagnostics. A model that detects moving pixels can still miss emergence events or generate too many false alerts.

A ground-truth event should include a unique event ID, original video hash/reference, start and end time or frame range, camera, final event class, reviewer identity, adjudication status, confidence/uncertainty and a link to the original footage in approved storage.

## Provisional six-class ontology

| Class | Proposed interpretation | Requirement |
| --- | --- | --- |
| Emergence | Bat exiting a roost feature | Direction and roost-context evidence; ecological approval |
| Re-entry | Bat entering a roost feature | Direction and roost-context evidence; ecological approval |
| Commuting | Bat moving through the field of view without supported roost interaction | Bat identity and movement supported |
| Insect | Movement attributable to an insect | Reviewer-supported identification |
| Bird | Movement attributable to a bird | Reviewer-supported identification |
| Uncertain / other | Evidence insufficient for a final class | Retain uncertainty; do not force a positive or negative label |

This taxonomy is **provisional**. The ecological lead must confirm class definitions and whether additional classes such as foraging are required. Multiple individuals and events in one clip must be represented explicitly, not inferred from row counts.

## Ground-truth policy

- Distinguish original observer labels, QA comments, and **signed-off final adjudication**.
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

Secondary measures: frame-level precision/recall, detection mAP (where boxes exist), track fragmentation/ID switches, timestamp error, processing throughput and compute cost.

## Matching policy (to agree before testing)

An algorithmic alert matches a ground-truth event only if it overlaps the adjudicated time interval or falls within a **pre-registered** tolerance. Count each ground-truth event at most once. Deduplicate overlapping alerts before computing precision and false-alert burden. Pre-register rules for multi-bat events, uncertainty and clips spanning multiple cameras.

No numeric tolerance or success threshold is set yet because frame rates, ecological requirements and baseline review performance are unverified.

## Split and sampling strategy

- Split by **site/survey/camera session** rather than random adjacent frames, to reduce leakage.
- Reserve an unseen holdout set for final assessment.
- Sample difficult negatives: insects, birds, foliage, weather, lighting artefacts, commuting and ambiguous roost-adjacent motion.
- Include varied camera models, active IR versus thermal, distances, entrances, lighting and seasons where available.
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

## References

- [Evaluation of different monitoring methods at maternity roosts of greater mouse-eared bats](https://link.springer.com/article/10.1007/s10531-022-02389-7)
- [Exeter - automated bat tracking in infrared video](https://cdn.bats.org.uk/uploads/events-training/William_Rees_NBC_Poster.pdf?v=1725643811)
- [Near-infrared bat detection with YOLO](https://doi.org/10.3390/signals6030046)
