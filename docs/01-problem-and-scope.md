# 01 - Problem, objectives and scope

Last reviewed: 2026-10-15  
Status: research hypothesis, not an approved deployment specification.

## Problem statement

Recorded active-infrared (IR) night-vision-aid (NVA) surveys can require lengthy manual review to identify rare, short-duration bat events. A useful in-house tool would reduce time spent reviewing irrelevant footage while preserving evidence for ecological interpretation. This is an intended use case, not a measured claim about WSP's current review times.

## Proposed Phase 1 objective

Build and evaluate an **ecologist-assisted, IR-first review workflow** for existing recordings, beginning with a complete motion-summary gallery and source-video review. The preferred initial output is a **time-ordered summary image for every video window**, including apparently quiet windows, with a direct link to the original video. Candidate-event intervals and evidence clips are optional enhancements. The tool must not issue autonomous ecological conclusions.

## Terms

- **Detection:** a model or algorithm locates a possible moving object in one or more frames.
- **Track:** detections linked over time as a probable individual trajectory.
- **Candidate event:** a track or time interval worth human review.
- **Emergence:** an ecologist-supported interpretation of a bat exiting a roost feature.
- **Re-entry:** an ecologist-supported interpretation of a bat entering a roost feature.
- **Commuting:** flight through the scene without evidence of emergence or re-entry.
- **Foraging:** activity characterised by feeding-related movement; may coexist with a bat observation, but does not establish roost emergence.
- **Precautionary decision:** a reviewer conservatively records possible roost use despite uncertain evidence; it is not the same as confirmed emergence.
- **False alert:** a flagged interval that does not meet the target event definition after adjudication.
- **Unlabelled interval:** an interval that has not been systematically reviewed; **not** a verified negative.

These are provisional project terms. A qualified ecological lead must approve the operational event ontology. **Observed activity** and **ecological decision** must be recorded in separate fields. A known roost polygon is optional; a feature may be unknown or off-camera.

## In scope

1. Local IR recording-session ingestion (including split segments) and technical metadata checks.
2. Complete timestamped motion-summary windows, camera stability and day-to-IR/illumination change checks.
3. Optional motion blobs and object tracking, after the baseline summary gallery works.
4. Event review with original timestamps, clips and traceable file identifiers, using a **Camera_Trap-style desktop verification interface**.
5. Explicit reviewer and QA decisions, uncertainty recording, and review-effort measurement.
6. Technical comparison of algorithms under a common evaluation protocol.

## Out of scope for the first phase

- Fully autonomous roost conclusions or regulatory reporting.
- Species-level identification from video alone.
- Substitution for a suitably qualified bat ecologist.
- Uploading client videos to unapproved external services.
- Acoustic species identification, thermal radiometry or 3-D flight reconstruction as required features. (Rendered thermal video and synchronised full-spectrum audio as review aids were brought into scope by the owner on 2026-10-22; see the [feature expansion plan](../implementation/feature-expansion.md).)

## Hypothesised processing workflow

1. **Ingest:** record file hash, camera, site code, codec, resolution, frame rate, timebase and duration.
2. **Synchronise:** resolve original-speed provenance and any workbook-to-video timestamp offset.
3. **Summarise:** generate an inspectable, timestamped motion summary for every configurable interval, and flag scene instability. Do not silently drop apparently quiet intervals.
4. **Optional tracking:** associate candidates across frames and estimate trajectory and direction once baseline summary review is evaluated.
5. **Optional context:** apply ecologist-defined roost entrance regions and trajectory rules as candidate interpretations.
6. **Review:** show every window summary, allow original-video seeking and optional candidate clips.
7. **Adjudicate:** record reviewer, final class, confidence/uncertainty and decision history.
8. **Evaluate:** measure event recall, false alerts per hour, reviewer time and traceability.

## Key technical risks

- Tiny, fast-moving bats, motion blur and missed frames.
- Insects near the lens, birds, foliage, rain and illumination changes.
- Camera shake/repositioning, day-to-IR switching, changing illumination, on-screen timestamp motion, rotated/interlaced video, split recordings, compressed footage, changed playback speed and time offsets.
- Multiple bats, occlusion, crossing trajectories and repeated detections.
- Domain shift between active IR, thermal, camera models and roost geometry.
- Sparse positive events and falsely assumed negative intervals.

## Deployment constraint

A local Windows application with an Electron desktop shell, React UI, local FastAPI Python processing and SQLite persistence is the selected implementation pattern. Its first instance is single-user and offline by design. Organisational execution remains subject to security, legal, IT and ecological approval. This public repository contains only shareable research and design notes.

## References

- [Bat Conservation Trust - Good Practice Guidelines, 4th edition](https://www.bats.org.uk/resources/guidance-for-professionals/bat-surveys-for-professional-ecologists-good-practice-guidelines-4th-edition)
- [Bat Conservation Trust - NVA technical guide](https://www.bats.org.uk/resources/guidance-for-professionals/bat-emergence-surveys-with-night-vision-aids-a-technical-guide)
- [University of Exeter - Automated Detection and Tracking of Bats within Infrared Videos (research poster)](https://cdn.bats.org.uk/uploads/events-training/William_Rees_NBC_Poster.pdf?v=1725643811)

## Motion-summary-first MVP decision

Publicly documented bat video review workflows demonstrate a simpler initial product: a complete gallery of timestamped motion-summary images with original-video navigation and ecologist annotations. This is now the **preferred prototype order** for predominantly IR recordings, with tracking and AI classification as optional later features. See [public prior art](08-motion-summary-prior-art.md) and [provisional architecture](09-ir-first-architecture-draft.md). Camera stability must be assessed per recording, even for tripod-mounted cameras.

## Operational review modes

The workflow must accommodate **attended and unattended** cameras. For attended footage, observer notes may be cross-checked; for unattended footage, a complete review and explicit QA strategy matter more. Pre-existing spreadsheet annotations may serve as **prelabels for locating candidate events**, but they are not automatically verified ground truth.

A qualified ecological owner must define the acceptable miss rate and decide final event and survey conclusions. Camera_Trap's existing verified/confirmed review patterns are a UI and persistence reference, **not an ecological sign-off procedure**. No threshold is invented in this document. Follow the minimal [local app architecture](09-ir-first-architecture-draft.md).
