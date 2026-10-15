# 09 - IR-first application architecture

Updated: 2026-10-15  
Status: **architecture direction selected; pilot thresholds, real-footage access and deployment approval remain open.** No application code has been committed.

## Decision

Develop a **local Windows-first bat IR video reviewer** that follows the actual [Camera_Trap desktop architecture](10-camera-trap-architecture-reference.md):

- **Electron** for the desktop window and optional Windows installer.
- **React + TypeScript** for a responsive review UI with the same interaction patterns as Camera_Trap.
- **FastAPI + Python** for local video processing and review/export endpoints.
- **SQLite** for persistent projects, recording sessions, summary windows, annotations and QA records.
- **FFmpeg / ffprobe + OpenCV + NumPy** for original video inspection and streaming motion summaries.

All services run **on the user's computer**. The Python API binds to loopback, not a public network interface. No cloud hosting, external AI API or trained model is required for the initial app. First develop/test React and FastAPI locally; package with Electron once that path works. Avoid unrelated Camera_Trap features and dependencies.

**First deliverable:** time-ordered summaries of **every** video window, original-video jump, human review/QA and existing-workbook-compatible CSV plus a separate technical audit export. Motion-blob detection and basic tracking are the next optional processing increment; entrance-zone rules may only propose **possible emergence**. Thermal, acoustics and species identification are excluded from v1.

## Confirmed direction and open parameters

| Area | Current direction | Outstanding detail |
| --- | --- | --- |
| App | Single-user, local Windows desktop first | Approved workstation and installation restrictions |
| Reviewers | Primary ecologist; second QA reviewer in the same local dataset | Whether UK/GCC transfer is needed and under what approved mechanism |
| Modality | Active IR only; thermal deferred | Camera-specific codec/illumination variations |
| Formats | MP4 and MTS candidates | Actual stream metadata, interlacing, speed provenance, file segmentation |
| Session length | Potentially multiple camera recording segments | Explicit order, gaps and segment continuity |
| Clock | Video-relative time first; separately sourced survey-clock offset | Reliable clock anchor and time conversion checks |
| Stability | Tripod common, but movement and IR switching possible | Thresholds, reset rules, false-motion burden |
| Existing annotations | Spreadsheet event notes may be **prelabels** | Original-file matching, final QA and permissions |
| Review outputs | Reviewable event rows and separate audit data | Column mapping to an approved workbook template |
| Acceptance | Event and survey-level comparison against adjudicated reference | Ecological owner, allowed misses and false alerts/hour |

No numeric accuracy, review-time or per-video performance target has yet been established.

## End-to-end flow

```text
Original active-IR camera recordings in authorised local storage
        |
        v
[Import recording session]
  one camera -> ordered original segments
  ffprobe + source IDs / checksums
        |
        v
[Time and image audit]
  video-relative PTS, optional real-time offset
  split-file joins/gaps, orientation / interlacing
  camera shift and day-to-IR/lighting change flags
        |
        v
[Streaming motion-summary engine]
  configurable windows, initially 30 seconds
  reference scene + temporal motion composite
  output for ALL windows (including apparently empty)
        |
        v
[Review workspace in React]
  timeline/gallery -> original video/clip
  observation + possible event + count + notes
  next-unreviewed / QA correction
        |
        v
[SQLite]
  sessions, segments, windows, review decisions, QA history
        |
        v
[Exports]
  report-friendly CSV / XLSX-compatible columns
  separate technical audit CSV / JSON
```

The original file remains the **evidence of record**. The composite is a review aid. No automatic skipping of apparently quiet windows during initial validation.

## Lean code structure

```text
Bat_Innovation/
  backend/
    app/
      main.py            # minimal local HTTP API and job status
      db.py              # SQLite tables and transactions
      video.py           # ingest, ordered segments, timestamps, stability checks
      motion.py          # bounded-memory summary processing
      reviews.py         # observation and QA logic
      exports.py         # two export formats
    tests/               # focused unit/integration tests
  frontend/
    src/
      App.tsx            # route / state and layout
      components/        # VideoPlayer, SummaryGallery, ReviewPanel
  electron/
    src/main.ts          # starts/stops backend and desktop window
  docs/                  # research / architecture
```

Keep responsibilities clear, add a new file only when it makes the existing code simpler. No `models/`, `training/`, message broker, orchestrator, authentication service, geospatial dashboard or cloud layer in v1. Do not duplicate timestamp, validation or export logic between React and Python.

## Minimal data model

| Table | Main purpose | Essential fields |
| --- | --- | --- |
| `session` | One camera on one survey visit | `id`, `display_name`, `camera_ref`, `clock_offset`, `offset_source` |
| `segment` | Original video file in recording order | `id`, `session_id`, `order`, `source_path`, `hash`, `duration`, `fps`, `timebase`, `status` |
| `window` | Every time-window summary | `id`, `session_id`, `start_s`, `end_s`, `summary_path`, `quality_flags`, `algorithm_version` |
| `review` | Human observation and decision | `id`, `window_id`, optional `event_time`, `observation`, `activity`, `ecological_decision`, `count`, `reviewer`, `status`, `notes` |
| `review_change` | Minimal audit trail | `id`, `review_id`, `actor`, `time`, `old_value`, `new_value`, `reason` |

Use source-file timestamp ranges when a summary window overlaps more than one segment. Record elapsed session time **separately** from the file's presentation timestamps and any real-world clock time. Do not assume a fixed 25 fps or infer absolute time from unreliable metadata. Source media stays outside SQLite; the DB contains paths and references, not video blobs. Quality flags are first-class but can be stored compactly.

## Ecological review semantics

**Observation:** bat, insect, bird, other or uncertain.  
**Activity:** commuting, foraging, flyby, unknown.  
**Ecological decision:** possible/confirmed emergence, re-entry, no supported emergence, precautionary emergence or uncertain, subject to an ecology-lead-approved vocabulary.  
**Review stage:** unreviewed -> reviewed -> QA reviewed -> finalised, with explicit QA pending/disagreement when needed.

The first reviewer can amend observations and counts; QA can agree or correct; a designated ecological reviewer authorises the final conclusion. Preserve revision history rather than overwriting the record without a trace. **Reviewer display names are not secure authentication** in the local MVP.

An entrance-region annotation is optional; roost features may be unknown or outside the video. If the camera moves, any previous region is invalid until re-confirmed. An event may span multiple windows or video segments. For multiple cameras, keep observations camera-specific and leave cross-camera individual reconciliation to the ecologist. Do not automatically infer distinct bats from the number of tracks.

## WSP-compatible and audit exports

**Ecology-facing output:** adapt to existing worksheet headings such as `video_ref`, `timestamp`, `real_time`, `observation`, `qa`, with supplementary count, uncertainty and status fields only where needed. Mapping must be checked against an authorised sample template. Do not assert that an exported row is signed off unless it is.

**Technical audit output:** source hashes, timebase and clock-offset provenance, exact window and segment ranges, camera stability/IR mode warnings, processing version/parameters, prelabel versus reviewer/QA changes, and export version.

No confidential example spreadsheet or footage is committed here.

## Build only the vertical slice

1. Minimal local backend/React workspace and a working original-video player.
2. Session/segment import and `ffprobe` checks; time mapping and camera-change flags.
3. Streaming all-window IR motion summaries; gallery/timeline links to source recording.
4. Review, second-review correction, progress tracking and local SQLite persistence.
5. Ecological/report CSV and separate audit export.
6. Compare with independently adjudicated recordings **after** applicable access and approval gates.
7. Add motion tracks, roost rules or learned detection only if they improve measured results.

Develop/test using synthetic or appropriately licensed public footage at Gate 0. Use of client footage, training or pilot deployment follows documented access, security, privacy and label-adjudication checks.

## Explicitly deferred

- Central server / multi-user database and automatic UK/GCC sharing.
- Machine-learning inference and model management.
- Audio / Kaleidoscope Pro integration.
- Thermal input analysis.
- Automatic roost conclusions, cross-camera individual deduplication and automated reporting sign-off.

**Design rule:** adapt the tested desktop and reviewer concepts of Camera_Trap; keep the Bat Innovation codebase much smaller. There is no reason to create extra layers until a real requirement demands them.

References: [Camera_Trap architecture inspection](10-camera-trap-architecture-reference.md), [scope](01-problem-and-scope.md), [evaluation](05-evaluation-framework.md), [data governance](04-data-governance.md).
