# 09 - IR-first architecture draft (pending requirements answers)

Drafted: 2026-10-15  
Status: **provisional design**. The deployment, format, timing, review and output requirements have not yet been confirmed. No WSP internal approval or pilot performance is implied.

## Architectural decision

Start with **summary-first, human-in-the-loop review** for recorded **active infrared (IR) night-vision** footage. Use a configurable time-window motion summary for every interval, including those with no apparent motion. Add individual object tracking, bat classification, entrance-zone rules and thermal/acoustic processing only after the initial workflow is evaluated.

This ordering is motivated by publicly described motion-summary review services and the ability to prototype classical video processing without an annotated bat-training dataset. It is a **product hypothesis** requiring validation.

## Initial deployment assumption

- Windows laptop/workstation, CPU-first.
- Runs locally or in an explicitly approved internal environment.
- No external video uploads or external AI APIs.
- Recorded video input; support for MP4 and MTS to be tested rather than presumed.
- Single-video workflow first, with batch processing designed as a future extension.
- Audio and species classification excluded from Phase 1.
- No trained model in Phase 1.

## Component diagram

```text
Approved local/internal video storage
        |
        v
[Ingest + ffprobe + source SHA-256]
        |
        v
[Timebase + camera stability audit]
        |
        v
[Streaming frame reader]
        |
        v
[Configurable window processor] <---- parameters / QA flags
        |
        +--> [Reference scene / background]
        +--> [Motion masks + temporal colour summary]
        +--> [Quality indicators / scene-change detection]
        |
        v
[Window summary image + interval manifest]
        |
        v
[Local review UI]
  |  gallery / timeline / zoom
  |  jump to original video
  |  labels / notes / uncertainty
  |  reviewer / QA / status
        |
        v
[SQLite review database + CSV export]
        |
        v
[Validated evidence record / audit trail]

Optional later branch:
  motion blobs -> object tracks -> roost-zone candidates
  -> learned bat detector -> ecologist adjudication
```

## Modules and interfaces

| Module | Proposed implementation | Key contract |
| --- | --- | --- |
| `ingest` | FFmpeg/ffprobe + Python | Immutable source ID/hash, streams, timebase, format, duration and errors |
| `stability` | OpenCV feature alignment/global motion checks | Stable, minor movement, re-aimed/scene-cut, unreliable; never silently discard intervals |
| `windowing` | Streaming frame iterator | Start/end frame and source timestamp; configurable interval (initially 30 s) |
| `motion_summary` | OpenCV frame difference/background model | Motion mask and colour-coded composite; all thresholds recorded |
| `quality` | Scene-change/illumination/noise diagnostics | Flag suspect summaries and preserve manual-review path |
| `manifest` | JSON or SQLite | Source hash, window ID, timestamps, settings, output path, software version |
| `review` | Local UI, technology to confirm | Every window reviewable, original video seek, notes and event labels |
| `export` | CSV, optional report-ready images | Evidence links, QA decisions, reviewer and event uncertainty |

## Proposed minimal records

**Video**: `video_id`, `sha256`, `source_reference`, `codec`, `width`, `height`, `fps_num`, `fps_den`, `duration`, `timebase`, `absolute_start_time`, `time_source`, `speed_provenance`.

**Window**: `window_id`, `video_id`, `start_pts`, `end_pts`, `start_seconds`, `end_seconds`, `summary_path`, `motion_diagnostics`, `stability_status`, `processing_version`, `parameters_hash`.

**Annotation**: `annotation_id`, `window_id`, `event_start_seconds`, `event_end_seconds`, `event_class`, `count`, `confidence`, `notes`, `reviewer_id`, `review_status`, `adjudication_id`, `created_at`.

An annotation may cover a window or a narrower original-video event interval. **One window does not imply one event or one bat.** Event counts require explicit reviewed evidence.

## Critical engineering invariants

1. **Preserve original evidence:** no change to the source video; derived outputs have traceable source and interval identifiers.
2. **Use video presentation timestamps:** avoid assuming `frame_number / nominal_fps` is always the correct time for variable-rate or irregular footage.
3. **Distinguish absolute time from video-relative time:** do not infer clock time when metadata or survey notes are missing.
4. **Inspect original-speed provenance:** an exported accelerated clip may not represent original recording time.
5. **Stream rather than bulk-load:** avoid loading all 750 full-HD frames of a 30-second 25-fps window into memory.
6. **Process every window:** retain even apparently empty or low-quality intervals for human review during validation.
7. **Treat camera movement as a first-class condition:** detect/reinitialise or flag frame shifts; do not assume tripod means static.
8. **Never interpret a composite as a final ecological classification.**
9. **Keep code, software, model and dataset rights separate:** publicly downloadable installers do not confer source reuse rights.
10. **Do not write restricted video content, metadata or survey details to the public GitHub repository.**

## Suggested UI layout

- **Project / camera navigator** (future batch support).
- **Window gallery**: time-sorted summary thumbnails for all intervals; zoom and motion overlays.
- **Source video panel**: seek to the chosen window or event, frame stepping, speed control, original-time display.
- **Review panel**: bat, insect, bird, other/uncertain; emergence, re-entry, commuting only when supported; notes, counts and QA status.
- **Quality bar**: camera stability and decoding/timebase warnings.
- **Export**: CSV event log, QA summary and optional report images.

## Phase sequencing

**Milestone 0 - Synthetic/public-media prototype:** confirm streaming decode, window summary, file/PTS links, stability flags and UI on appropriately licensed non-client examples.

**Milestone 1 - Approved IR feasibility:** run on permission-cleared original recordings and manually audit summary visibility for known bat events.

**Milestone 2 - Review workflow evaluation:** measure ecological review time, missed events and QA corrections compared with complete manual review.

**Milestone 3 - Optional smart tracking:** add motion-blob association, track overlays, roost zones and candidate event generation only if they demonstrably improve performance.

**Milestone 4 - Optional learned detector:** collect adjudicated labels and train/compare an IR bat-specific model if necessary and permitted.

## Pending decisions (to be resolved once, before freezing architecture)

1. Approved Windows workstation, server or cloud environment.
2. Available CPU/GPU and software installation restrictions.
3. Representative original codecs, resolution, frame rate and file size.
4. Typical survey camera count and recording duration.
5. Time synchronization and original recording start-time source.
6. Manual roost-region annotation needs.
7. Desired first-release event detection/tracking sophistication.
8. Availability and rights for verified example footage and labels.
9. Reviewer preference: full timeline, summaries, clips or hybrid.
10. CSV/Excel and reporting outputs.
11. IT/data-governance restrictions and authorised storage.
12. Demo, controlled PoC or production-readiness target.

**Current assumption:** prioritize a working, locally operated motion-summary reviewer. Do not lock the final interface or deployment choice until these answers are received.
