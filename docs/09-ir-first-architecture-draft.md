# 09 - IR-first app architecture

Updated: 2026-10-15  
Status: **architecture direction agreed; detailed parameters and organisational approvals pending.** No application code has been created in this repository.

## Architecture decision

Build a **lean, local Windows-first, IR-only reviewer** using the same overall design philosophy as [Camera_Trap](10-camera-trap-architecture-reference.md): a small Gradio interface calling straightforward Python processing modules, writing local structured outputs. **Do not build a cloud service, separate API, distributed worker system, or central database in v1.**

Our first complete workflow is **all-window motion summaries -> original-video verification -> ecological annotation/QA -> report-ready CSV**. Basic movement blobs/tracking (user's preferred A+B) can be added as an independent processing option once the summary baseline works. Roost-context rules can propose **possible emergence**, never an autonomous final emergence outcome.

Audio is out of scope because existing acoustic review is separate. Thermal is **explicitly out of v1**, but the app should report unsupported input modalities rather than silently process them as equivalent to active IR.

## What is known versus what remains open

| Area | Agreed direction / evidence | Still to verify |
| --- | --- | --- |
| Deployment | **Local application** on a Windows machine; offline by design | Which specific workstation and installation restrictions are approved |
| Users | Primary ecologist reviewer and potential separate QA reviewer; shared use may be relevant in future | Whether local sequential hand-off is enough for UK and GCC workflows |
| Input | Recorded active-IR video; MP4 and MTS as initial candidate formats | Real codecs, FPS, interlacing, resolution, orientation and original-speed provenance |
| Recording unit | A **session** may contain several sequential video segments | Segment continuity, missing frames and gap conventions |
| Time | Separate **video-relative** and **survey clock** times; allow a manually documented offset | Trustworthy offset source and treatment of changed clock/segment starts |
| Stability | Tripod likely, but scene changes, IR light transitions and re-aiming possible | Detection thresholds and which segments require manual review |
| Labels | Existing review spreadsheets may contain **prelabels**, not authoritative ground truth | Original-file mapping and ecological adjudication |
| Output | Existing workbook-style event rows plus a separate technical audit export | Final column naming and survey-specific reporting template |
| QA | Reviewer decisions and subsequent QA decisions must remain distinguishable | Final ecological sign-off owner, disagreements and allowed status changes |
| Target | A **controlled PoC** after original-footage access, use rights and environment checks | Acceptance thresholds and scope of authorised datasets |

## Workflow

```text
Local folder: one survey / camera session
  containing one or more ordered source video segments
            |
            v
  1. Ingest + ffprobe metadata
     file hash, original timebase, rotation/interlacing, relative duration
            |
            v
  2. Session timeline + video quality check
     segment joins/gaps, camera shift, day-to-IR transition,
     illumination reset, optional on-screen clock mask
            |
            v
  3. Motion summary windows (default proposal: 30 seconds)
     all windows kept, including those apparently inactive
     original-time IDs and source-video navigation
            |
            v
  4. Gradio review UI
     gallery -> source clip -> label/count/note -> save
     optional motion blobs and simple tracks
            |
            v
  5. QA in the same UI
     independent review entry -> agreement/disagreement ->
     final ecological decision by authorised reviewer
            |
            v
  6. Exports
     (a) reporting-compatible CSV
     (b) technical audit CSV/JSON
```

The source video is the evidence of record; a composite image is a **review aid**. Do not auto-skip quiet windows during the first validation exercises.

## Minimal proposed code layout

```text
app.py           # Gradio UI and callbacks
video.py         # segment inventory, ffprobe, frame PTS, stability/illumination flags
motion.py        # streaming background and colour motion summaries
reviews.py       # annotations, reviewer/QA records, append-only decisions
exports.py       # simple reporting CSV and technical audit CSV
tests/           # small tests per module
requirements.txt
.gitignore
docs/            # research and architecture Markdown
```

**Five small Python files to start.** No `api/`, `services/`, `workers/`, `db/`, `models/`, `frontend/`, or cloud configuration folders by default. Split a module only when justified by actual complexity.

- **Gradio**, not Streamlit, is the starting UI choice to align with [Camera_Trap](10-camera-trap-architecture-reference.md).
- **FFmpeg/ffprobe** for inspection and on-demand verification clips; **OpenCV/NumPy** for streamed image processing.
- **Local JSON manifest plus append-only JSONL review history**, with CSV exports. **No database in v1**; introduce SQLite only if persistence, concurrency or queries require it.
- **No PyTorch, YOLO, SpeciesNet, CVAT server, GPU requirement or model download** in v1.
- Start using ordinary synchronous jobs with progress feedback; avoid background orchestration or scheduling infrastructure.
- Keep output folders outside the Git repository and excluded by `.gitignore`.

## Source video and time handling

Use a **session -> segment -> window -> annotation** hierarchy.

- A **session** is one camera's recording for a survey, not necessarily one file.
- Each **segment** retains source path/identifier, checksum, stream metadata, recording order, and any gap/continuity status.
- Each **window** has explicit source segment/time or a set of ranges when it spans a boundary.
- **Video-relative times** are the primary analysis reference. A separately entered, provenance-labelled offset maps them to real-world survey time. Never infer a trustworthy absolute start timestamp from a Canon file by default.
- Original-speed recorded footage and sped-up derivatives must not be silently interchanged; flag unknown provenance.
- Inspect possible interlaced fields and rotated footage; handle only when actually encountered.
- If the camera changes view or IR light mode, segment/reinitialise the background model and flag the window. Invalidate any existing roost-zone mapping until manually reconfirmed.

## Lean review and QA semantics

The UX may follow the simple tab-and-action style of Camera_Trap, but ecology review states require explicit records:

1. **Unreviewed**: summary generated, no ecological judgement made.
2. **Reviewed**: first reviewer has recorded an observation and any count.
3. **QA pending / QA reviewed**: another reviewer agrees, modifies or disputes the observation.
4. **Finalised**: an authorised ecological owner has resolved relevant disagreements and approved the event / survey record.

Each change is appended as an immutable revision with reviewer identity or identifier, timestamp, original video reference, previous decision ID and reason. This is an **audit history**, not a full role-management product. Local users identify themselves in the UI; this does not constitute authentication or enterprise access control.

**Observation** (for example bat, insect, bird, foraging, commuting or uncertain) must be distinct from **ecological decision** (emergence, re-entry, no supported emergence, precautionary emergence, uncertain). A possible event near an entrance is not final emergence evidence. Roost polygons are optional because roost features may initially be unknown or outside the frame.

**For multiple cameras:** retain camera-specific observations and raw counts; **do not automatically deduplicate unique bats across cameras in v1**. Survey-level reconciliation is a separate human decision.

## Minimal output contracts

**Manifest JSON:** session ID; ordered segment IDs/hash and metadata; window ID; segment-relative and session-relative timestamps; stability/illumination flags; parameters/version; generated summary path.

**Review JSONL:** window/event reference; reviewer identity; observation label; ecological decision; count when supportable; notes; uncertainty; QA status; revision relation; sign-off metadata.

**Reporting CSV (user-facing):** `video_ref`, `video_timestamp`, `real_time`, `observation`, `qa_status` plus optional count/notes if desired by the reporting template. **Report export contains only finalised or explicitly labelled provisional results.**

**Audit export (technical):** segment hash, time offset source, window boundaries, processing parameters, quality flags, all review revisions, any source-video jumps and export version.

## Ecological and operational verification

Evaluation must consider:
- Event recall and **missed emergence/re-entry** on independently adjudicated footage.
- Whether assisted review changes **survey-level roost conclusion or peak count**, not just boxes and tracks.
- Total reviewer time (summary scanning + video rechecks + QA corrections) versus full manual review.
- Difficult IR cases: day-to-IR switch, torch/light changes, insects near lamps, noise, camera movement, unknown roost zone and split files.
- Union of human and app candidates, independently adjudicated; prelabels are **leads, not truth**.
- Ecological lead defines acceptable miss rate and false-alert burden before acceptance testing.

There is **no numeric acceptance threshold and no performance claim** at this stage.

## Governance and sequence

- **Gate 0:** public documentation, clean-code scaffolding, and tests with synthetic or appropriately licensed open media.
- **Gate 1:** original-footage access and use-right confirmation plus local environment/privacy screening.
- **Gate 2:** verified source-file/time mapping and independently adjudicated test events.
- **Then controlled PoC:** test with authorised originals, compare manual and summary-assisted review.

This is intentionally **not** a production deployment design. UK/GCC shared-service hosting, identity management, central SQL storage, AI models and acoustic/thermal integration require evidence of need and additional approval.

## First implementation slices

1. Ingest ordered segments and print an auditable metadata/timeline report.
2. Generate one correctly timed summary per 30-second interval, streaming memory and flagging unstable scenes.
3. Build Gradio local gallery with preview of corresponding original-video interval.
4. Add human observation, QA revision history and report/audit CSV exports.
5. Benchmark before introducing extra tracking, automated filtering or trained models.

## Reference

[Camera_Trap architecture reference](10-camera-trap-architecture-reference.md) | [Motion-summary prior art](08-motion-summary-prior-art.md) | [Evaluation framework](05-evaluation-framework.md) | [Data governance](04-data-governance.md).
