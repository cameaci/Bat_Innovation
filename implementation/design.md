# Technical design

Reviewed: 2026-10-16. Status: **Slice 0, Slice 1A import and the Slice 1B preview candidate are Linux-tested; motion/review/export sections remain specifications**.

## 1. Architecture and boundaries

```text
Electron shell (Windows, production packaging)
  native select-files / select-folder; start and stop local backend
     |
React + TypeScript (Vite development)
  Import -> Summaries -> Review/QA -> Export
     |
FastAPI (127.0.0.1 only, limited routes and local launch token)
     |
Python: ingest/time -> video preview -> motion summary -> review/export
     |
SQLite (small schema) + local generated summary images and previews
     |
Original media files remain untouched in authorised local storage
```

Use a **single application**, one local backend process and one processing job at a time in v1. Do not introduce a distributed queue, WebSocket service, multi-user auth system, cloud persistence or generic plugin platform. Run React and FastAPI in development from Slice 0. Use the **minimal Electron development shell from Slice 0 and add a native file picker in Slice 1**, because large source videos must not be uploaded through a browser file form or accepted as arbitrary paths. Build the distributable Windows installer only in Slice 5.

**Ownership:** Python owns original-media time mapping, processing and ecological record validation. React presents typed data and asks Python to save review decisions; it does not recompute time offsets or decide which data are final.

## 2. Minimal code layout

```text
backend/
  app/
    main.py                 # FastAPI wiring, request validation, health, media ID routes
    media.py                # ffprobe, segment inventory, PTS and preview requests
    motion.py               # streaming summary engine and scene-quality flags
    store.py                # SQLite schema, transactions, run and review operations
    export.py               # reporting CSV and audit export
  tests/
frontend/
  src/
    App.tsx                 # small top-level workspace; no routing framework until needed
    api.ts                  # single typed API client
    components/
      SessionImport.tsx
      SummaryGallery.tsx
      ReviewPanel.tsx
      SourcePlayer.tsx
electron/
  src/
    main.ts                 # app lifecycle and native file chooser
    preload.ts              # narrow, typed contextBridge
implementation/
docs/
AGENTS.md
```

This tree is an **upper bound to start**, not a minimum number of files to create immediately. Add test files and UI helpers as features are built. One responsibility per module; factor when a source file becomes hard to understand, not pre-emptively. Avoid `crud/`, `routers/`, `services/`, `models/` and frontend state frameworks until use justifies them.

Use the reference repo only as a **pattern library** for API boundaries, desktop startup, validation, gallery navigation, status and export. See [reuse.md](reuse.md).

## 3. Media and time contracts

**Decoder decision:** test [PyAV](https://github.com/PyAV-Org/PyAV) as the first candidate for reading frames with their actual `pts` and `time_base`, with OpenCV used for pixel masks and FFmpeg/ffprobe for media inspection and preview. Adopt PyAV only after pinned Windows build, codec, PTS and licensing tests; avoid simultaneously maintaining two unsynchronised decoder pipelines.

**Recording session:** one camera on one survey visit. It contains an explicitly ordered list of original **segments** (e.g. independently recorded clips). Each segment has a source-file ID, path stored **only locally**, checksum, video stream metadata, orientation, field order/interlacing and source PTS timebase.

- Do **not** concatenate files and assume contiguous recording. A session may contain gaps, clock discontinuities, camera moves or multiple start/stop events. The user must be able to confirm order and continuity or leave them **unknown**.
- Windowing is **per original segment**, initially 30 seconds (configuration is versioned). The final shorter window of a segment still receives an image. No silent loss of boundary frames. Each window links to an exact `segment_id` and `[start_pts, end_pts)` coverage in that segment.
- Keep four concepts distinct: **source PTS**, segment-relative elapsed time, optional session-relative position (only when continuity is defensible), and optional absolute survey time from a user-provided, provenance-labelled clock anchor.
- Never map time solely via `frame_index / nominal_fps`; use source timestamps when available. If timestamp integrity cannot be established, mark the segment **timebase_unverified** and block claims of exact event clock time.
- Recording speed is an explicit source-provenance field: original, confirmed derivative, unknown. Do not label accelerated export time as original survey time.
- Camera repositioning or illumination-mode changes create a **quality discontinuity**, not a new biological event. Invalidate any region drawn for the prior view, and flag windows around the transition.
- Existing Excel timestamp annotations are *prelabels*. They can be imported later only with authorisation and checked source linkage; they must never set an automatic final event state.

### Source-video playback decision (must pass early)

Modern Chromium players are not guaranteed to decode `.MTS`/AVCHD. Two implementation paths are legitimate and must be tested:

1. **Direct local playback** of verified browser-compatible streams.
2. **On-demand local preview transcode** using an approved FFmpeg build for unsupported streams. Produce bounded clips and map their start/end back to the original stream PTS. Preserve the original untouched.

Prefer path 1 where it works and path 2 where a verified preview is required. A transcoded preview is a supported media feature, **not a silent fallback**: the UI states its source and timing; failures surface explicitly. Test seek error across the clip, segment starts/ends, interlacing and orientation. Do not use a filename extension alone as proof of codec support. Do not depend on VLC or full-video conversion to make core playback work.

**Slice 1B decision (2026-10-16):** The measured Electron 44 candidate uses one bounded PyAV/FFmpeg-library VP9/WebM preview path for all imported sources. Native MPEG-2 MTS failed to load and native irregular-MP4 seeking showed the preceding marker. PyAV seeks with a uniform two-second pre-roll to a prior keyframe, then decodes forward to the first source PTS at or after the requested integer PTS. Requests outside the imported first/last decoded PTS are rejected. Interior display intervals use consecutive decoded PTS, not potentially overlapping frame durations; only the final EOF frame uses its known duration. A bounded per-frame ledger keeps exact original PTS/elapsed values separate from millisecond display time. React identifies displayed frames through `requestVideoFrameCallback`, not frame-number/FPS arithmetic.

Preview generation runs in one disposable Linux process with hard CPU/memory/file limits and a parent-owned wall deadline. Imports and previews share one atomic processing reservation. One managed clip is retained outside the repository; replacement, cancellation, startup and shutdown remove generated files. Status and content revalidate source identity/readability. Electron fetches only a fixed authenticated content route and transfers capped bytes over narrow IPC; React uses a revoked-on-replacement Blob URL with `media-src blob:` and `connect-src 'none'`. Windows hard limits and all binary packaging remain unverified; unsupported platforms fail explicitly. Full caps, fidelity limits and test evidence are recorded in the research log.

## 4. Motion-summary algorithm contract

**Start with a deterministic classical computer-vision baseline, not a bat classifier.**

- Stream decoded frames; do not hold 750 full-HD frames in memory for each 30-second window.
- Work in grayscale for change evidence. Evaluate a fixed-window reference/running background or consecutive differences against the **same synthetic positive/negative fixtures**. Choose the simpler method that preserves short weak moving targets; do not choose solely by visual appeal.
- Use minimal, recorded noise handling. Any threshold may remove genuine bats; expose settings for controlled evaluation, avoid aggressive built-in insect filtering.
- Encode **early/middle/late** motion using a documented, non-ambiguous colour legend. Cyclic frame colours alone are **not** a measure of absolute event time.
- Generate a source-context panel and a motion-only panel; overlay exact video-relative interval and quality warnings.
- Generate **one summary for every window**, including no apparent activity, plus a manifest entry. The summary does not prove the presence or absence of bats.
- Track source IDs, window PTS ranges, algorithm version, parameter hash and output checksum. Write outputs to a temporary file and commit/rename only after successful generation and DB transaction.
- Detect and flag large frame-wide changes from tripod vibration, camera re-aiming, a torch beam or dusk-to-IR illumination. Reinitialise the reference scene where appropriate, **but never erase or silently accept** the affected window as reliable.
- Video rotation, interlacing, HUD/date overlays, IR insect swarms and compression artefacts are explicit fixture scenarios. Overlay exclusion regions may be added only with a visible configuration and provenance; never hardcode camera coordinates.

**No trained model, no automatic insect exclusion and no bat count derived from raw motion masks in v1.** Motion blob tracking can be introduced as an optional later pipeline **after** summary completeness and review efficacy are tested.

## 5. SQLite domain model (minimum viable persistence)

Use Python standard-library `sqlite3` initially, foreign keys enabled, transactions for each operation and a schema version checked on startup. Do not silently reinterpret an incompatible DB. Introduce SQLAlchemy/Alembic only if evolving schema makes the additional dependencies worthwhile.

| Entity | Purpose | Required invariant |
| --- | --- | --- |
| `session` | One camera visit, display name and optional clock anchor | Source/clock provenance remains explicit |
| `segment` | One original file, metadata, checksum, sequence, continuity flag | Original segment identity never overwritten |
| `processing_run` | Parameters, algorithm version, started/completed/failed, error and progress | Partial/cancelled runs cannot claim completeness |
| `summary_window` | Segment ID, source PTS interval, image path, run ID, quality flags and status | All source frames accounted for; one complete output per planned window |
| `observation` | Zero-to-many recorded events, source time span(s), class, activity, count/uncertainty | Window does not equal event; count can be unknown |
| `review_action` | Append-only reviewer/QA decisions, before/after or revision reference | Original prelabels and independently signed decisions remain distinguishable |

Use SQLite for final state *and* append-only review history. No JSON file as a competing source of truth. The current observation/summary status is a derived projection from durable review records or a transactionally updated field; never write two conflicting sources.

An event may be reviewed across window boundaries; store its **source segment/time spans**, not just a gallery tile timestamp. Cross-segment interpretation is allowed only when continuity and corresponding source spans are explicitly established; otherwise flag it for a human rather than assigning a fictitious global timestamp.

**Review stages:** `unreviewed`, `reviewed`, `qa_pending`, `qa_reviewed`, `finalised`, with a visible disagreement/uncertainty flag. Finalisation requires a designated ecological decision maker, not merely the first review click. Local identity attribution is not enterprise authentication.

**Annotation fields:** visual category (bat/insect/bird/other/uncertain), optional activity (commuting/foraging/etc.), ecological decision (possible/confirmed emergence, re-entry, no supported emergence, precautionary, uncertain), count or unknown, original source time, notes, reviewer/QA attribution and provenance. Terms remain provisional until ecologist sign-off.

## 6. Small API surface

Proposed route families, not a promise of final endpoint naming:

| Operation | Example | Scope |
| --- | --- | --- |
| Check runtime health | `GET /health` | Backend ready, FFmpeg availability |
| Create/import session | `POST /sessions` | Validate selected source IDs and ordered segments |
| Fetch media audit | `GET /sessions/{id}` | Metadata, continuity/time warnings |
| Launch summary run | `POST /sessions/{id}/summarise` | One local job, persisted parameters |
| Poll progress | `GET /runs/{id}` | Planned/completed windows and failures |
| List windows | `GET /sessions/{id}/windows` | Time-ordered, **including quiet windows** |
| Get image/preview | `GET /media/{id}/summary`, `POST /media/{id}/preview` | Only allowlisted source IDs, bounded clips |
| Review / QA | `POST /windows/{id}/reviews`, `POST /observations/{id}/reviews` | Validated stage transitions, audit |
| Export | `GET /sessions/{id}/exports/{kind}` | Report CSV or audit CSV, explicit provisional state |

Use typed Pydantic requests/responses and a small TypeScript API client. Prefer short polling for processing progress over WebSockets. A single in-process job worker is acceptable for responsiveness; the **job state and completed windows persist** in SQLite, enabling detectable interrupted runs and safe restart.

## 7. Local security and filesystem rules

- Electron loads the expected local origin only, has `nodeIntegration=false`, `contextIsolation=true`, a narrow preload bridge and no unrestricted shell/file access exposed to React.
- Backend binds to `127.0.0.1`. Restrict origins and require a **random per-launch local token** for application API access; pass it only via the trusted Electron startup/preload boundary in packaged mode. Development mode uses an explicit local-only equivalent and never disables checks in production. Do not call this enterprise user authentication.
- Native file selection grants the backend access to **allowlisted file IDs**, not arbitrary user-controlled query paths. Validate that segment files still exist and match expected identity before reading.
- Start FFmpeg as a structured argument array without `shell=True`. Confirm bundled binary version/codec support and licence; handle timeout, cancellation and process cleanup.
- Keep `SQLite`, logs, private media manifests, derived images and preview clips in an app-specific authorised local data directory, never this public Git tree.
- No outbound telemetry, automated model download or external video upload. Record errors locally without leaking sensitive paths in shared diagnostics.
- Back up the SQLite database and preserve original video references. A missing source file must show an actionable error, not mark prior evidence invalid silently.

## 8. UI contract

One lightweight workspace, not the Camera_Trap full dashboard:

1. **Import:** choose session files, inspect order, metadata, clock anchor and warnings.
2. **Summaries:** start/poll processing, see completeness, time-ordered summary thumbnails and quality flags.
3. **Review:** left summary/source video; right label, activity, count, note, reviewer and QA action; next/previous/next-unreviewed keyboard navigation.
4. **Export:** ecology-oriented rows matching an approved workbook template; separate technical/audit export.

Keep all-window review progress stable even when filters change, as in the Camera_Trap verification approach. An event summary is *not* the same review denominator as all windows. Empty windows must be explicitly reviewed to count as reviewed.

## 9. Non-goals and upgrade points

Defer: thermal, audio/Kaleidoscope integration, species ID, learned detector, GPU, automatic emergence sign-off, automatic cross-camera individual deduplication, central server, remote GCC authentication, multi-tenant hosting and generic reporting engines.

**Upgrade only on evidence:** if motion summaries fail to improve time or visibility, adjust the summary method or stop. Add blob tracking only if it improves adjudicated event recall or review efficiency; add learned bat recognition only if sufficient licensed frame labels and measured need exist. Do not scaffold these before they are needed.
