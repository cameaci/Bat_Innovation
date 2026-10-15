# 01 - Problem, objectives and scope

Last reviewed: 2026-10-15  
Status: research hypothesis, not an approved deployment specification.

## Problem statement

Recorded infrared (IR) and thermal night-vision-aid (NVA) surveys can require lengthy manual review to identify rare, short-duration bat events. A useful in-house tool would reduce time spent reviewing irrelevant footage while preserving evidence for ecological interpretation. This is an intended use case, not a measured claim about WSP's current review times.

## Proposed Phase 1 objective

Build and evaluate an **ecologist-assisted candidate-event review workflow** for existing recorded NVA footage. The first output should be timestamped candidate intervals and evidence clips, not autonomous ecological conclusions.

## Terms

- **Detection:** a model or algorithm locates a possible moving object in one or more frames.
- **Track:** detections linked over time as a probable individual trajectory.
- **Candidate event:** a track or time interval worth human review.
- **Emergence:** an ecologist-supported interpretation of a bat exiting a roost feature.
- **Re-entry:** an ecologist-supported interpretation of a bat entering a roost feature.
- **Commuting:** flight through the scene without evidence of emergence or re-entry.
- **False alert:** a flagged interval that does not meet the target event definition after adjudication.
- **Unlabelled interval:** an interval that has not been systematically reviewed; **not** a verified negative.

These are provisional project terms. A qualified ecological lead must approve the operational event ontology.

## In scope

1. Local video ingestion and technical metadata checks.
2. Motion-based candidate generation and optional learned object detection.
3. Temporal grouping and object tracking.
4. Event review with original timestamps, clips and traceable file identifiers.
5. Human QA, uncertainty recording and review-effort measurement.
6. Technical comparison of algorithms under a common evaluation protocol.

## Out of scope for the first phase

- Fully autonomous roost conclusions or regulatory reporting.
- Species-level identification from video alone.
- Substitution for a suitably qualified bat ecologist.
- Uploading client videos to unapproved external services.
- Acoustic identification, thermal radiometry or 3-D flight reconstruction as required features.

## Hypothesised processing workflow

1. **Ingest:** record file hash, camera, site code, codec, resolution, frame rate, timebase and duration.
2. **Synchronise:** resolve original-speed provenance and any workbook-to-video timestamp offset.
3. **Propose:** identify moving regions with background subtraction / temporal difference or a learned detector.
4. **Track:** associate candidates across frames and estimate trajectory and direction.
5. **Contextualise:** apply ecologist-defined roost entrance regions and trajectory rules.
6. **Review:** show candidate clips with surrounding context and the original source video.
7. **Adjudicate:** record reviewer, final class, confidence/uncertainty and decision history.
8. **Evaluate:** measure event recall, false alerts per hour, reviewer time and traceability.

## Key technical risks

- Tiny, fast-moving bats, motion blur and missed frames.
- Insects near the lens, birds, foliage, rain and illumination changes.
- Camera shake, compressed footage, changed playback speed and time offsets.
- Multiple bats, occlusion, crossing trajectories and repeated detections.
- Domain shift between active IR, thermal, camera models and roost geometry.
- Sparse positive events and falsely assumed negative intervals.

## Deployment constraint

Prefer an offline or WSP-approved internal execution environment. Architecture choices remain subject to security, legal, IT and ecological approval. This public repository contains only shareable research and design notes.

## References

- [Bat Conservation Trust - Good Practice Guidelines, 4th edition](https://www.bats.org.uk/resources/guidance-for-professionals/bat-surveys-for-professional-ecologists-good-practice-guidelines-4th-edition)
- [Bat Conservation Trust - NVA technical guide](https://www.bats.org.uk/resources/guidance-for-professionals/bat-emergence-surveys-with-night-vision-aids-a-technical-guide)
- [University of Exeter - Automated Detection and Tracking of Bats within Infrared Videos (research poster)](https://cdn.bats.org.uk/uploads/events-training/William_Rees_NBC_Poster.pdf?v=1725643811)
