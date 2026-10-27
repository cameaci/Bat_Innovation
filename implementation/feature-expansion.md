# Feature expansion plan: tracks, gates, counts, thermal and audio

Status: **E1-E7 implemented (Linux-verified, not yet built or run on Windows); E0 and E8 need the owner.** Project-owner decision 2026-10-22. Reviewed 2026-10-22.

This plan adds a second layer to the existing reviewer: tracks, counting gates, trajectories, heatmaps, an activity timeline, highlight review, rendered thermal video and synchronised full-spectrum audio. It follows the owner's research summary of three reference demos and UK survey practice (BCT 4th-edition guidelines, CIEEM reporting guidance), recorded in the [research log](../docs/07-research-log.md). Read [AGENTS.md](../AGENTS.md), [design.md](design.md) and [plan.md](plan.md) first.

## 1. Purpose and invariants

**Automatically organise and propose evidence; keep ecological interpretation human.**

```text
original video -> motion candidates -> tracks -> gate crossings -> candidate events
               -> ecologist review -> independent QA -> provisional export
```

Invariants for every milestone:

- The all-window gallery stays the review denominator. Tracks and candidates never hide a window and never set a window decision. Hiding apparently quiet intervals is not allowed until event recall is validated and the ecological owner approves it.
- Counts keep three separate layers: **algorithm**, **reviewer-adjusted** and **QA-approved**. Every correction is audited with actor, time, rationale and the basis revision.
- A track is not an individual and a count of tracks is not a count of bats ([evaluation framework](../docs/05-evaluation-framework.md)). A crossing is an event proposal, not proof of roost use ([technical approaches](../docs/03-technical-approaches.md)).
- Derived data (candidates, tracks, crossings, heatmaps, spectrograms, heterodyne clips) is reproducible from the untouched originals plus versioned, hashed parameters. Human actions are append-only.
- The stack, offline rule, loopback token, narrow bridge and worker containment (Linux rlimits, Windows Job Objects) are unchanged. No trained model, GPU, cloud service or queue.
- Every storage step is one `BEGIN IMMEDIATE` transaction that requires the previous version. It joins the fresh-database chain in `backend/app/main.py` and the single "Upgrade storage" action in `frontend/src/survey.tsx`.

## 2. Scope

| Priority | Features |
| --- | --- |
| P1 (this plan) | Persistent tracks, trajectory overlay, line/rectangle/polygon gates, directional counts in three layers, activity timeline, heatmaps, highlight/block review with loop, speed and frame step, rendered thermal modality, WAV import with manual sync, spectrogram and retunable heterodyne, export v2 |
| P2 (listed, not pre-built) | ByteTrack evaluation for dense scenes (needs a detector), two-anchor audio drift correction, annotated video export, GeoPackage (only with a real pixel-to-world calibration) |
| P3 | Learned bat detector, raw radiometric thermal and vendor SDKs, acoustic species identification, 3D trajectories |

Still out: automatic roost conclusions, species identification from video, finalisation without a designated ecological decision maker, cross-camera individual deduplication.

## 3. Findings that shape the plan (checked 2026-10-22)

- **Norfair 2.3.0** (latest, April 2025) is BSD-3-Clause but requires `numpy<2.0.0` and `rich<15`; this repository pins `numpy==2.4.2`. Its dependency `filterpy` 1.4.5 is a 2018 source-only release that installs matplotlib. Installing it with `--no-deps` would be a workaround. The tracking spike therefore includes a small in-house association step.
- **`opencv-python-headless` 5.0.0.93** is Apache-2.0, but its wheels bundle a second FFmpeg build.
- **The pinned PyAV 19.0.1 wheel decodes WAV** (`wav` format; `pcm_s16le`, `pcm_s24le`, `pcm_s32le`, `pcm_f32le`), so audio can reuse the existing contained decode approach.
- **`scripts/collect_notices.py`** lists Python distributions and bundled npm packages but not native libraries vendored inside wheels (SciPy's OpenBLAS/libgfortran, OpenCV's FFmpeg). New dependencies need explicit notice coverage.
- **Five exact-version checks break at schema v6:** `qa_store.require_schema`, `qa_store.upgrade`, `qa.py` (QA schema check), `export_jobs.py` (export schema check) and `csv_export.snapshot` (hardcoded 5). They must become version-tuple checks.
- **`workers.MODULES`** is a fixed allowlist; each new worker is added there. Workers accept only `.mp4`/`.mts` with exactly one video stream.
- **The summary worker** has one 1 GiB / 300 s CPU / 600 s wall budget for a whole run, and one `activity_lock` serialises import, preview, summaries and export.
- The open Slice 3 box "zoom and frame-step" in [plan.md](plan.md) overlaps E5; it is cross-referenced, not counted twice.

Reuse points: `media.decoded_frames()`, `motion.Evidence`, `windows.parameters()`/`parameter_hash()`, the preview manifest `frames[]` (exact displayed-frame PTS ledger), `reviews._receipt`, `csv_export.clock()`, the append-only `review_store`/`qa_store` pattern, `SummaryJobs` as supervisor pattern, `summary_fixtures.encode_frames()` for ground-truth fixtures and `frontend/src/sourceFrame.ts` for displayed-frame mapping.

## 4. Milestones

One vertical slice at a time: production behaviour and tests in the same change, then the [definition of done](plan.md#definition-of-done-for-every-slice). Estimates are engineering person-days for someone familiar with the repository; they exclude participant time and approvals.

### E0 - Foundation hardening (no schema change, 6-10 d plus owner actions)

- Merge the Windows beta and interface branch (PR #20).
- Build the Camera_Trap-style interface on native Windows and run the [docs/18 acceptance checklist](../docs/18-windows-beta.md).
- Rebuild PyAV/FFmpeg without x264/x265, keeping H.264, HEVC and MPEG-2 decoders, libvpx VP9 encoding and PCM decoding. Rerun the media, preview and summary suites and the 59 visible-marker preview checks.
- Owner actions: project ownership and licence, approval of the binary inventory.
- **Exit:** checklist rows recorded; the rebuilt wheel gives identical exact-PTS and pixel results.
- **Stop:** if the rebuild changes PTS or pixels or loses VP9, keep the current wheel and its notice.

### E1 - Rendered thermal modality (schema v6, 3-5 d)

- `segment.modality` (`active_ir` or `rendered_thermal`) and `modality_provenance`. Declared by the user at import, never inferred; fixed once a run references the segment. Existing rows become `active_ir` with provenance "recorded by the IR-only version".
- Replace the five exact-version checks with version tuples.
- Frames are converted to luminance as today; flags `rendered_thermal_display` and `palette_luma_not_temperature`. Visible, configured exclusion regions for HUD and temperature scales follow [design.md](design.md) section 4.
- Exact label **"Rendered thermal - no radiometric temperature analysis"** in the summary footer, window dialog and exports. Thermal is reported as a separate stratum, never mixed into the IR score.
- Tests: v5 -> v6 upgrade and rollback; export at v6; synthetic white-hot, black-hot and false-colour fixtures; radiometric containers refused with an explicit error.
- **Stop:** if false-colour luminance loses the synthetic target, support white-hot and black-hot only, with an explicit flag.
- Not done: temperature values, palette detection, `.seq`/`.csq`/R-JPEG files.

### E2 - Persistent tracks and trajectory overlay (schema v7, 12-18 d)

- **Spike (at most 3 d, recorded in the research log).** Compare: OpenCV headless background subtraction plus `connectedComponentsWithStats`; NumPy frame differences plus `scipy.ndimage.label`; each with Norfair (only if the pins resolve without workarounds) or an in-house association step (constant-velocity prediction plus `scipy.optimize.linear_sum_assignment`, bounded gap). Measure ID switches, fragmentation, centroid error, false tracks on noise, throughput at 1080p and 640x360, wheel size, licence chain and lines of code. Choose the smallest set that passes.
- **A separate tracking run**, not part of the summary worker: the summary evidence and its CPU budget stay protected, retuning never invalidates summaries or review evidence, and a tracking failure never revokes summary completeness. One contained worker per segment, sharing `activity_lock`; its decode is checked against each summary window's `pts_digest`.
- New modules: `tracks.py` (pure candidate extraction and association), `track_worker.py` (added to `workers.MODULES`), `tracking_jobs.py` (supervisor following `SummaryJobs`), `tracking_store.py`.
- UI: a Tracks card on the Process page; an "n tracks (unverified)" badge on window cards; an SVG trail over the original video in the window dialog (viewBox in source pixels, 1-3 s trail, current frame from the existing displayed-PTS mapping); a track list with start/end PTS, duration and flags.
- Fixtures (`encode_frames` plus ground-truth JSON): single crossing, two crossing paths, stop-and-go, exit at the frame edge, one-frame dropout, insect-like jitter near the light, frame-wide flash, split at a segment boundary, tiny low-contrast target.
- **Exit:** simple targets keep one ID; dropouts within the gap limit do not split a track; noise produces no track above the minimum length; the trail is frame-accurate in an end-to-end test; window coverage is unchanged.
- **Stop:** if no dependency set fits the pins and licences, use the in-house association. If CPU cannot be bounded, track at reduced resolution and record the position error. If the synthetic paths are not recovered, do not start E3.

**Known limitation (tested):** a slow, uniform target can appear as two parallel edge tracks, because candidates come from frame-to-frame change. A running background avoids that but leaves a ghost of anything present in the first frame; it was tried and rejected for `tracks-v1`.

### E3 - Gates and three-layer counts (schema v8, 12-18 d)

- `gates.py` (pure geometry), `count_store.py`, a gate editor (SVG over the summary reference frame, with direction arrows) and a counts panel showing Entered, Exited and Net per layer.
- Gate kinds: line (A->B, B->A), rectangle and polygon (outside->inside, inside->outside). Coordinates are source pixels plus frame size.
- **Hysteresis:** a point is confirmed on side A at signed distance >= +h and on side B at <= -h (areas use point-in-polygon plus distance to the boundary >= h). A crossing is recorded when the confirmed side changes, at the first PTS on the new side. A finite line counts only between its endpoints.
- Gates belong to a session. A gate's valid span ends at the first `framewide_change` or frame-size change; extending it needs an explicit reconfirmation ([technical approaches](../docs/03-technical-approaches.md): re-aimed cameras invalidate saved regions).
- Crossings are derived and recomputed on a gate edit without re-decoding, with gate revision and track parameter hash as provenance.
- Count layers: the reviewed count needs a rationale when it differs from the algorithm count; QA approves one specific reviewed revision and goes stale when the reviewer edits; the same normalised actor cannot do both.
- Tests: both directions for line, rectangle and polygon; jitter within the band gives zero crossings; a back-and-forth track counts two; invalidation after a scene change; audit survives restart.
- **Stop:** if jitter double counts or invalidation is missed, counts are not shown.

### E4 - Export v2 (no schema change, 4-6 d)

- `bat-provisional-csv-v2`, keeping both v1 CSVs unchanged. New files: `tracks.csv` and `tracks.json` (compact points), `gates.json`, `gate-events.csv`, `counts.csv` (three layers, stale flags, revisions).
- The manifest records run IDs, parameter hashes, gate revisions and modality. Every exported event traces to source hash, segment and PTS. Size limits fail explicitly; nothing is truncated. A re-run never double counts.
- Update `electron/src/export_saver.ts` and the bridge validators in `electron/src/backend.ts`.

### E5 - Highlight and block review (schema v9, 7-10 d)

- The preview request gains `clip_start_pts` and `clip_seconds`: the event range plus configurable pre-roll and post-roll, clamped to the segment, with the event range kept separately in the manifest.
- Frame, byte, CPU and wall limits (including Electron's `MAX_PREVIEW_BYTES`) are raised only to values measured on noisy lossless VP9 fixtures. A clip at the limit offers an explicit "next part".
- Player: loop between in and out points; 0.25x, 0.5x, 1x, 1.5x and 2x; frame stepping seeks to the middle of the next manifest frame, confirms it with `requestVideoFrameCallback` and reports a mismatch. Keys: Space, `,` and `.`, 1-5, L, N ("No bat + next").
- An event queue lists tracks and crossings in time order. `candidate_review` is append-only (bat, not_bat, uncertain), with the clip manifest as its receipt. "No bat + next" never changes a window decision.
- Covers the open Slice 3 "zoom and frame-step" box by cross-reference.
- **Stop:** if clip size or frame stepping fails, keep 2 s clips and disable frame stepping.

### E6 - Activity timeline and heatmaps (no schema change, 5-8 d)

- Timeline: one SVG lane per segment in recording order, with window bins, crossing markers and reviewed observations. Gaps and unknown continuity stay visible breaks, never compressed. Clicking opens the window dialog at the exact source PTS.
- Heatmaps: a bounded grid in source coordinates for three modes (first point of each track, all track points, reviewer-confirmed events), drawn on a canvas over the reference frame and labelled "track points, not individuals".
- Tests: a timeline marker seeks within one decoded frame; grid totals equal the included points; the labels are present.

### E7 - Audio: WAV, sync, spectrogram, heterodyne (schema v10, 11-17 d)

- WAV import through the native picker and allowlisted file IDs; SHA-256 checked before and after every read; the original is never written. PyAV with a `wav` format whitelist and PCM codecs only; compressed audio is refused; multichannel files need an explicit channel.
- `audio_source` records sample rate, frame count and a user-declared `source_mode` (full_spectrum, heterodyne, frequency_division, unknown). Only full-spectrum audio is retunable; the others are shown as recorded with an axis caveat.
- `audio_anchor` (append-only) pairs one video segment PTS with one audio sample: `audio_time = video_time + b`. A visible "drift not corrected" warning remains until P2.
- `audio_worker` (added to `workers.MODULES`), on demand and bounded: a spectrogram PNG for the clip span (SciPy STFT, hashed fixed parameters, axis to Nyquist) and a heterodyne clip (multiply by cos(2 pi f t), Butterworth SOS low-pass, `resample_poly` to 48 kHz, 16-bit WAV) in managed scratch.
- UI: a spectrogram strip under the video with a playhead driven by the displayed frame PTS; audio synced at 1x and muted at other speeds; a tuning control from 15 to 120 kHz; an anchor setter; audio coverage on the timeline.
- Tests (synthetic): a 45 kHz tone at 384 kHz with a click at a known sample lands in the right spectrogram row and time; tuning to 40 kHz yields 5 kHz; the anchor maps to the right video time; non-full-spectrum retuning, compressed files and missing audio give explicit refusals or gaps.

### E8 - Validation and user study (gated, part of Slice 6, not estimated)

- Preconditions: data rights and the applicable approvals; an independently adjudicated reference set (two reviewers blind to algorithm output, adjudicated disagreements, frozen labels, separate tuning and test clips); metrics approved by the ecological owner.
- Design: counterbalanced within-subject comparison of A (full manual review), B (all-window summaries) and C (expanded app, plus audio where relevant), using matched but different sessions. 8-12 practising UK bat ecologists as a formative group; the final sample size follows a pilot.
- Measures from the [evaluation framework](../docs/05-evaluation-framework.md): event recall and precision, false alerts per hour, review minutes per source hour, missed emergence/re-entry, traceability, survey-level conclusion agreement and count agreement per gate, direction and layer. Secondary: ID switches, anchor error, throughput. Report per scenario: IR, dark IR, rendered thermal, sparse and dense emergence, multiple entrances, insects/rain/foliage, illumination change, camera movement, split recordings and audio sync.
- **Research proposals, not approved thresholds** (AGENTS.md forbids invented acceptance criteria): event recall >= 0.98 before any quiet interval may be hidden; precision around 0.80; directional count error <= 5% in sparse scenes; median review time reduced by >= 40%.

**E0-E7 total: about 60-92 person-days**, consistent with the research estimate of 60-95.

## 5. Data model

| Schema | Additions |
| --- | --- |
| v6 | `segment.modality`, `segment.modality_provenance` |
| v7 | `tracking_run` (summary run, algorithm version, parameters, hash, state); `tracking_segment` (state, error, stats); `track` (run, segment, first/last PTS, point count, bbox, compressed points with format tag and SHA-256) |
| v8 | `gate`, `gate_span`, append-only `gate_event`; derived `gate_crossing` (unique per tracking run, gate revision, track and PTS); `count_window` projection with append-only `count_event` |
| v9 | `candidate_review` projection with append-only events |
| v10 | `audio_source`; append-only `audio_anchor` |

Track points are zlib-compressed records of PTS, x, y and area. A track never spans two segments. Per-run and per-track caps fail with an explicit `tracking_limit`; nothing is silently capped.

## 6. Dependencies and licences

Engineering assessment of published terms, not legal advice.

| Item | Position |
| --- | --- |
| SciPy | Preferred for association and audio DSP. BSD-3-Clause; review bundled OpenBLAS and libgfortran |
| OpenCV headless | Candidate. Apache-2.0; carries a second FFmpeg; decided by the E2 spike |
| Norfair | Candidate only if the pins resolve. BSD-3-Clause; currently `numpy<2` and filterpy |
| ByteTrack | P2. MIT |
| Shapely | Only if polygon geometry outgrows a small function. BSD-3-Clause |
| pyogrio/GDAL | P2. Audit the native binary chain |
| Ultralytics | Do not use without a commercial licence (AGPL-3.0) |
| BatDetect2 | Do not use for business work without permission (CC BY-NC 4.0) |
| BatCount code | Prior art only; licence not established |
| HeatSeek | Prior art only; its requirements pull in ultralytics and roboflow |
| ThermalTracker | Design reference; permissive licence, legacy stack |
| TrackBats, ThruTracker | Commercial benchmarks, not dependencies |

Every new dependency is pinned, listed in [docs/11](../docs/11-slice-0-development.md), covered by `scripts/collect_notices.py` including native libraries inside its wheel, and verified on Windows wheels before use.

## 7. Feature expansion tracker

Separate from the fixed 44/70 tracker in [plan.md](plan.md); the two are never added together. Baseline 2026-10-22: **0/27**; now **22/27**. Change the denominator only with owner approval.

| Milestone | Checked / total |
| --- | ---: |
| E0 Foundation hardening | 0 / 3 |
| E1 Rendered thermal | 3 / 3 |
| E2 Tracks | 4 / 4 |
| E3 Gates and counts | 4 / 4 |
| E4 Export v2 | 2 / 2 |
| E5 Highlight review | 3 / 3 |
| E6 Timeline and heatmaps | 2 / 2 |
| E7 Audio | 4 / 4 |
| E8 Validation | 0 / 2 |

- [ ] E0: interface built and docs/18 checklist run on native Windows.
- [ ] E0: GPL-free PyAV/FFmpeg build passes the exact-PTS, pixel and preview regressions.
- [ ] E0: project ownership, licence and binary inventory decided by the owner.
- [x] E1: v6 modality storage with explicit upgrade and version-tuple checks.
- [x] E1: rendered thermal label and flags in summaries and the review UI (the export column arrives with E4).
- [x] E1: thermal palette fixtures and radiometric refusal tested.
- [x] E2: dependency spike recorded and selection made.
- [x] E2: contained tracking run (one worker per run, segments committed atomically) with persisted tracks.
- [x] E2: frame-accurate trajectory overlay and track list.
- [x] E2: ground-truth fixtures pass, including dropout, crossing and noise cases.
- [x] E3: gate editor with line, rectangle and polygon and direction labels.
- [x] E3: hysteresis crossings recomputed on edit, invalidated on scene change.
- [x] E3: algorithm, reviewer and QA count layers with audit.
- [x] E3: counts panel showing Entered, Exited and Net per layer.
- [x] E4: v2 export files with provenance and explicit size failures.
- [x] E4: export traceability and no-double-count tests.
- [x] E5: event clips with pre/post roll and measured limits.
- [x] E5: loop, speed and manifest-verified frame stepping.
- [x] E5: event queue with append-only candidate review and receipts.
- [x] E6: activity timeline with visible gaps, opening the exact window (crossings are listed on the Counts page, not on the timeline).
- [x] E6: three heatmap modes with "not individuals" labelling.
- [x] E7: WAV import with source mode and integrity checks.
- [x] E7: manual sync anchor with drift warning.
- [x] E7: spectrogram strip synced to the displayed frame.
- [x] E7: retunable heterodyne for full-spectrum sources only.
- [ ] E8: reference set and metrics approved by the ecological owner.
- [ ] E8: user study reported per scenario.

## 8. Risks and stop conditions

| Milestone | Risk | Response |
| --- | --- | --- |
| E0 | Native interface failure; rebuild changes PTS/pixels or loses VP9 | Fix before E1; keep the current wheel and notice |
| E1 | False-colour luminance hides targets | White-hot and black-hot only, flagged |
| E2 | Dependency pins, CPU budget, paths not recovered | In-house association; reduced resolution; do not start E3 |
| E3 | Jitter double counts; scene change not detected | Counts stay hidden |
| E4 | Size limits | Explicit failure, never truncation |
| E5 | Clip size; frame-step mismatch | Keep 2 s clips; disable frame stepping |
| E6 | Heatmap read as absence or individuals | Labels and end-to-end checks |
| E7 | High sample rates; clock drift; anchor unavailable | Bounded derivatives; drift warning; unsynchronised audio is labelled, never given an invented offset |
| All | Event recall not proven | Windows are never hidden |

## 9. Phase 2: individual tracking and the Watch workspace

Owner request 2026-10-24 after testing E1-E7 on real footage: the review experience failed. A camera disturbance produced 164 crossings to confirm one by one, `tracks-v1` follows pixel change rather than bats, every view is a separate clip of at most 12 s, and the heatmap does not move with the video. Phase 2 fixes the experience first and fits the architecture to it. No new dependencies (NumPy and SciPy only); no trained models.

- **Watch**: one page with continuous playback of a lossy playback copy (VP9, 960x540) per segment, three synchronised views of the same frame (Bats: red ring, ID and heading per track; Flight map: green-yellow-red density building up to the playhead; Count: gate with live IN/OUT/NET), a survey timeline, smart speed and event jumps. Exact-frame verification from the original stays one key away.
- **tracks-v2**: centred temporal median background, target size and polarity, detection area and exclusion zones, closing to merge wings and body, constant-velocity Kalman association with a size term, tracklet joining and per-track quality (coherent, uncertain, noise). Disturbances are classified as camera moved, lighting change or glitch.
- **Calibration**: a 10 s test run with an overlay and statistics before the whole survey is tracked.
- **Counts**: a camera move ends the gate's valid span and asks for one reconfirmation; only coherent tracks feed the algorithm proposal; uncertain crossings go to a one-key event reel; the reviewer accepts the gate total with one action once nothing is unresolved.
- **Review effort**: windows watched end to end in the playback copy at no more than 4x and without coherent tracks can be marked "no activity seen" together.

Quality and size rules are parameters, not approved thresholds (E8).

Phase 2 tracker (separate from the 22/27 above): **7/7**.

- [x] W1: playback copy, `bat-media` scheme and Watch with the Bats view.
- [x] W2: tracks-v2 engine with scene events and range test mode.
- [x] W3: calibration drawer with test run.
- [x] W4: gate validity spans, quality-aware counts, reconfirm and accept.
- [x] W5: flight map, split/single panes and survey timeline.
- [x] W6: event reel, smart speed, watched-window receipts and retired pages.
- [x] W7: export v3, docs and frozen smoke.

## 10. Phase 3: catching up with the reference tools

Owner approval 2026-10-27. The plan, measured findings and tracker are in [phase3.md](phase3.md).
