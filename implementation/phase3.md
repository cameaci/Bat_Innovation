# Phase 3 plan: catching up with ThruTracker, TrackBats, O-GEO and UltraVision (X1-X10)

Status: **approved by the project owner 2026-10-27**; implementation in progress (tracker in section 12). Defaults taken for the open decisions in section 11: VP9 WebM video, PDF report only, sunset typed by the user, free-text species with suggestions, sample check at 1x or slower with a 0.5 s matching tolerance. The owner may change any of them.

## 0. Summary

**What we learned.** Four other tools were studied from the owner's shared videos, ThruTracker's full 3.0 user guide and paper, TrackBats' public site, pricing and articles, and a 2025 review of thermal emergence counting.

- ThruTracker (local desktop app, Python since 3.0):
  - Detection: target diameter, sensitivity 1-7, polarity, max density, target speed, size and brightness exclusions.
  - Setup: a 60-frame test clip.
  - Display: a box per detection, trails drawn as dots, a circle where a track crosses the gate, and burnt-in Entered / Exited / Inside counters.
  - Outputs and review: overlay and tracks-only videos, an emergence-rate graph, and track classification with categories and group selection.
- TrackBats (hosted, deep-learning detector):
  - Counting: counting polylines, several exits per video, and re-entries subtracted.
  - Outputs: a highlights video, a track table synced with the video and a track map, a first-detection heatmap, flow metrics, a GeoPackage, a metrics CSV and a Word evidence report.
- O-GEO:
  - A rectangle around the roost hole, a box on every bat and a filled circle at each crossing.
  - An Entered / Exited / Net board.
- DarkFlight UltraVision:
  - An enhanced view next to the standard one. The background is dimmed and moving targets leave bright trails: green when warmer than the background, blue when colder.
  - GPS millisecond timestamps.
  - Two synchronised bat detectors.

**Why our app failed on the owner's test video (measured, section 3).** There are four separate causes:

1. **Display.** The Watch page loads tracks in 30 s chunks with a 500-track cap, and noise counts toward the cap. Above the cap it shows nothing at all.
2. **Detection.** A fixed grey-level threshold fires on textured stone and on camera gain jumps. On the O-GEO clip that gives up to 126 detections in one frame, 384 tracks in 11.5 s and 188 uncertain crossings, where O-GEO's own counter shows 29.
3. **Association and counting.** In the ThruTracker mass-emergence scene (about 500 exits in 4.8 s), tracks-v2:
   - proposes only 28 coherent exits;
   - leaves 1,025 uncertain crossings for a person to review;
   - fragments each bat into an estimated four tracks.
4. **Speed.** The same 4.8 s took about 5 minutes to process (about 60 times slower than real time). Association is a Python double loop and tracklet joining is quadratic.

The downloaded clips also repeat about a third of their frames, which a fixed-step motion model handles badly.

**What we will build.** The order puts visible value first, measurement before tuning, and the engine before polish:

| # | Milestone | What the owner sees |
| --- | --- | --- |
| X1 | Show what the tracker found | Boxes or dots and coloured trails, crossing circles, a big Entered / Exited / Net / Inside board, camera or elapsed clock, and no blank screen when there are many tracks |
| X2 | Measure before tuning | Realistic synthetic scenes with ground truth, a benchmark report, and an in-app **sample check** that compares a short manual count with the algorithm |
| X3 | tracks-v3 engine | Noise-adaptive detection, gain-jump and repeated-frame handling, a flow prior and band counting for dense emergences, and real-time-class speed |
| X4 | Guided setup | Click a bat to set size, polarity and threshold; a noise map with suggested exclusions; roost presets; gate placement warnings; reusable site templates |
| X5 | Enhanced view | An UltraVision-style "motion boost" view (polarity colours, fading trails, dimmed background) next to or instead of the standard view |
| X6 | Track table and group decisions | A sortable track list synced with the video and an all-tracks map with start points; select a group (for example "starts at the hole") and label it exit, entry, fly-by, foraging or not a bat; species and comments entered by a person |
| X7 | Multi-exit counting and emergence profile | Several gates shown and counted at once, a polyline gate, an exits-per-minute and cumulative-net chart under the video, first, peak and last emergence, and an optional sunset reference |
| X8 | Deliverables | An overlay video and a highlights video with burnt-in counters and a PROVISIONAL watermark, figure PNGs and a PDF evidence report |
| X9 | Audio | Several detectors per survey, proposed sync from file timestamps, call-activity marks linked to the tracks on screen, and a species label entered by a person |
| X10 | Windows and real-footage validation | Owner-gated runs of X1-X9 on native Windows and on authorised footage |

**What stays ours.** These are things none of the other tools offer, and they are not traded away:

- Originals are never changed, and every frame is mapped to its exact source time.
- Every recorded window remains in the review.
- Counts keep three audited layers (algorithm, reviewer and QA), and nothing is final.
- Watched-window receipts.
- The app runs offline.

**What we will not do:**

- No trained models (no YOLO, no Ultralytics) and no acoustic species identification.
- No cloud.
- No new runtime dependency unless the owner approves it (one optional candidate is python-docx, see section 8).
- No automatic final counts.

## 1. Sources studied

| Source | What it is | Used for |
| --- | --- | --- |
| Shared folder: ThruTracker demo (17.9 s, four FLIR scenes, the last about 1 s) | Screen recording of ThruTracker overlay videos | Overlay style; reference counters (scene 1 ends at Entered 6 / Exited 504, the cave at Inside 6 / Entered 1 / Exited 76, the tower at Entered 15 / Exited 77) |
| Shared folder: O-GEO clip (11.5 s, 862x910) | O-GEO output on a church facade; the same video as the owner's failed test | Overlay style; reference counter Entered 5 / Exited 24 / Net +19 at the end |
| Shared folder: UltraVision clip and image | Side-by-side "Standard Sensitivity" and "UltraVision"; GPS timestamps; two detectors | Enhanced-view design; audio layout |
| Shared folder: two screen recordings and one image of TrackBats | The branded TrackBats interface and, probably, an earlier version of it | Track table, track plot, heatmap, report and outputs |
| [ThruTracker user guide](https://www.thrutrackeranalytics.com/user-guide) (3.0, 2026) | Official manual | Settings, test clip, gates, outputs and classification (section 2.1) |
| ThruTracker paper (Corcoran et al., bioRxiv 2021) | Method paper | MOG2 background subtraction, blob detection, Kalman plus Hungarian assignment, a 0.6-7.1 % error against humans, up to 103 bats/s, and bats of 1.9-5.2 px |
| [TrackBats](https://trackbats.com/en/): site, pricing and four articles | Vendor material | Multi-exit lines, highlights video, outputs and acoustic coupling roadmap (section 2.2) |
| Ahlberg, Kuczynska and Kloepper 2025, J. N. Am. Bat Res. SI1:46-58 | Practitioner perspective on thermal emergence counts | Users must understand "how targets are tracked, counted, lost"; validating against manual counts of segments; keeping the counting box for year-to-year replication; no default settings work everywhere |

Not available:

- The LinkedIn posts themselves are behind a login wall and were not read.
- Two of the owner's links (activities 7485332337283559425 and 7455968029768679424) have no matching file in the folder.
- No public documentation was found for O-GEO or DarkFlight UltraVision, so their entries come from the videos only.
- The test videos the owner mentioned are not in the folder yet (it still holds seven files).

Data rule: the shared media stay in the session scratchpad. No frame, clip or crop is committed; only text findings and numbers are.

## 2. Feature inventory: what they do and how

### 2.1 ThruTracker 3.0

**Detection settings.**

- **Target diameter.** Click the video to see a reference circle. The diameter also sizes a Gaussian filter that "reduces noise and isolates closely spaced animals".
- **Multiple sizes.** A minimum and a maximum circle.
- **Sensitivity 1-7.** The default is 4, and 1 is for the faintest targets.
- **Suppress background.** On by default. It filters noise from static parts of the scene.
- **Polarity.** Lighter, darker or both.
- **Max density.** 1-5, 6-20 or 20+ "Extreme". The two dense modes "assume that bats move in one direction within a given area of the screen". Extreme turns background suppression off.
- **Advanced.** Exclusion size (minimum diameter), exclusion brightness (pick from frame; drops dim wingtips, reflections and fly-bys), variable size tracking, and target speed (default 3).

**Setup.**

- A test clip of 60 frames by default, played at 50 % with the gate, the frame number and an in-frame track counter.
- A "Bg_sub" high-contrast view.
- Settings are saved as one configuration file per camera view, which can be imported into other projects.
- Batch processing of several videos.

**Gates.**

- A rectangle (with ranges from each edge) or a polygon. A bat counts once it is "detected inside the gate and then outside it".
- Counts are entries, exits, boundary crosses and Inside. A negative net is allowed.
- The guide gives advice on gate placement: keep the gate 5-10 % from the frame edge and place it across the flight path.

**Outputs.**

- A track overlay (a box per detection and a trail of circles, with configurable count and thickness).
- A gate overlay video, and a tracks-only video with a 0.1 s buffer.
- Colourised output (inferno, iron, turbo or grey).
- Detection and track CSVs, figures, review clips of about 15 s, and review images per track.
- A "suspicious" folder for videos with unusual activity (a person or camera shake).
- An emergence-rate graph (exits per frame and the cumulative count).

**Classification.**

- Two modes: "Load tracks", one by one with the arrow keys, and "View all tracks", with group selection by position, start or end.
- Categories Star, Good, Bad, Uncertain, Exit, Entry and Fly-by, plus custom labels 4-9.
- Comments, and a review video of only the tracks shown.

**Guidance.** Roost-type and species guides, a camera placement sandbox, training datasets and quizzes.

**Platform.** Local only, with no cloud or telemetry. Windows and macOS. Annual licence.

### 2.2 TrackBats

**Detection.**

- A deep-learning detector "trained specifically on bats" (vendor claim). It works with RGB, thermal and IR video.
- Size filter in the Expert tier.

**Counting.**

- A counting polyline drawn across the exit before processing, and several lines in one video ("multi-exit survey").
- Each crossing is stored with its direction and timestamp. Re-entries are subtracted to give the net.
- Flow metrics in bats per second or per minute, and the peak emergence time relative to sunset.

**Review.**

- A "Tracks detected" card showing confirmed, rejected and to-review counts.
- A table with columns Track, First seen, Duration, Detections, Species/ident (free text) and Decision (accept or reject).
- "Click a row to seek the video to that track's first frame".
- Buttons: Show all tracks, Confirm all pending, Reset decisions.
- A track plot (Plotly) over the frame, with one colour per track, a white circle at the first detection, direction arrows and a tooltip.
- Behaviour tags: transit, foraging and commuting.

**Outputs.**

- A highlights video ("only the frames containing detections are kept"), with a yellow source-time label and boxes.
- A metrics CSV per second, track data as a GeoPackage, a track summary PNG and a detection heatmap PNG (a KDE of first-detection points with contours).
- A .docx evidence report (count, emergence curve, heatmap and track screenshots), and "Download all".

**Roadmap.** Acoustic coupling: synchronised detector audio, attribution to on-screen tracks by time and position, and an AI species classifier.

**Platform.** Hosted upload with results within 72 h, in four tiers (one free).

### 2.3 O-GEO (from the video only)

- A yellow rectangle around the roost hole and a cyan square on each detected bat.
- A filled magenta circle when a bat crosses the rectangle.
- A bottom band reading "Entered: N  Exited: N  Net: +N".

### 2.4 DarkFlight UltraVision (from the video and image only)

- The standard thermal image (inferno palette) shows bats as faint stroboscopic trails.
- "UltraVision" desaturates and dims the scene and paints moving targets as bright trails lasting about 2-3 s: green when warmer than the background, blue when colder (a bat in front of a warm wall).
- Distant bats that are barely visible in the standard view become clear dotted lines.
- A burnt-in GPS clock with milliseconds ("2026-08-10 21:08:13.584 BST (GPS)").
- Two detectors: one at the camera and one near the roost, with a waveform and call timeline under the video.

### 2.5 Matrix

| Capability | ThruTracker | TrackBats | O-GEO | UltraVision | Bat Innovation now | Milestone |
| --- | :-: | :-: | :-: | :-: | --- | --- |
| Per-bat marker on video (box, dot or diamond) | yes | yes | yes | trails | red ring, ID, heading (tracks only) | X1 |
| Trail as dots, per-track colour | yes | yes | - | yes | one red trail colour | X1 |
| Circle at the crossing point | yes | yes | yes | - | text flash "+1 OUT" | X1 |
| Big Entered / Exited / Net board | yes | report | yes | - | small IN/OUT/NET box | X1 |
| Inside (occupancy) count | yes | - | - | - | no | X1 |
| Burnt-in clock | camera | source time | - | GPS ms | no | X1 |
| Noise-adaptive detection, gain-jump handling | partly (suppress background) | learned | ? | ? | fixed grey-level threshold | X3 |
| Dense emergence (hundreds per frame) | yes (direction prior) | claimed | ? | - | unusable (section 3.2) | X3 |
| Target speed, size range, brightness floor | yes | size filter | ? | - | target size only | X3, X4 |
| Test clip before processing | yes (60 frames) | - | ? | - | yes (10 s) | keep, X4 |
| Click to measure a bat | reference circle | - | - | - | reference circle | X4 |
| Background-subtracted or enhanced view | Bg_sub | - | - | yes | no | X5 |
| Configuration per camera view, reusable | yes | - | - | - | per survey only | X4 |
| Track table synced with the video | load tracks | yes | - | - | event reel (uncertain only) | X6 |
| All-tracks map with start points | yes | yes | - | - | flight map density | X6 |
| Group selection and categories | yes | accept/reject, species text | - | - | bat / not bat per item | X6 |
| Several gates at once (multi-exit) | one gate | yes | one | - | several gates, one shown | X7 |
| Polyline gate | polygon | yes | rectangle | - | line, rectangle, polygon | X7 |
| Emergence-rate or profile chart | yes | yes | - | - | survey timeline only | X7 |
| Overlay video export | yes | yes | yes | yes | no | X8 |
| Tracks-only / highlights video | yes | yes | - | - | no | X8 |
| Report document | - | .docx | - | - | CSV bundle only | X8 |
| Per-second / per-minute metrics | figures | CSV | - | - | no | X7, X8 |
| GeoPackage | - | yes | - | - | deliberately not (no calibration) | not planned |
| Audio: several detectors, call timeline | - | roadmap | - | yes | one WAV, manual sync, spectrogram, heterodyne | X9 |
| Manual-count validation in the app | review clips | manual review | - | - | no | X2 (sample check) |
| Exact source time per frame, original verification | - | - | - | GPS clock | **yes** | keep |
| All windows stay accessible, watched receipts | - | - | - | - | **yes** | keep |
| Three audited count layers with QA | - | - | - | - | **yes** | keep |
| Offline | yes | no | ? | ? | **yes** | keep |

## 3. Measured: tracks-v2 on the reference clips

Scratchpad runs on 2026-10-27, Linux, 4 cores, using the repository's `tracks.Analyzer` and `gates.crossings`. The clips are screen recordings or re-encodes with the other tools' overlays burnt in, so their counters are **those tools' outputs, not ground truth**. The numbers show failure modes, not accuracy.

### 3.1 O-GEO clip (the owner's test video)

The other tool's count is 5 in and 24 out. The gate is the same rectangle around the hole. Settings: target 12 px, sensitivity 12, both polarities.

| Variant | Tracks (coherent / uncertain / noise) | Detections per frame | Crossings in / out: coherent | Crossings in / out: uncertain |
| --- | --- | --- | --- | --- |
| tracks-v2 as shipped | 384 (19 / 218 / 147) | 12.9 (bursts of 99-126) | 2 / 1 | 84 / 104 |
| + gain and offset compensation | 324 (14 / 173 / 137) | 11.1 | 1 / 3 | 80 / 97 |
| + noise-adaptive threshold (4 x local MAD) | 277 (12 / 162 / 103) | 12.4 | 1 / 1 | 85 / 89 |
| + threshold 6 x MAD | 126 (4 / 69 / 53) | 6.1 | 0 / 0 | 48 / 58 |
| + repeated-frame skip | 225 (4 / 161 / 60) | 13.0 | 0 / 0 | 62 / 68 |

Findings:

- **Detections arrive in bursts.** The bursts fall in frames 103-106, 160-178, 259-280 and 309-310. Brightness jumps at frames 162, 236, 258 and 284 match them, which points to camera gain changes.
- **The texture is noisy.** Temporal noise (MAD) is about 3 grey levels on the sky and 10-12 on textured stone. One fixed threshold cannot suit both.
- **There is a persistent hot spot at the hole.**
- **Frames repeat.** About 32 % of consecutive frames are near repeats (p99.9 difference of 6 or less), from frame-rate conversion.
- **No single tweak fixes the count.** Each change trades one failure for another; for example, skipping repeated frames makes tracks look "gappy" to the quality rule, so coherent tracks fall to 4. The engine needs a coherent redesign that is tuned against ground truth (X2, X3).

### 3.2 ThruTracker scene 1 (mass emergence, frames 0-144, 4.8 s)

ThruTracker's counter in this span went from Exited 4 to 504, so about 500 exits and 5 entries. Our line sits on ThruTracker's gate edge. Settings: target 8 px, lighter, dense.

| Variant | Tracks (coherent / uncertain / noise) | Detections per frame | Exits / entries: coherent | Exits / entries: uncertain | Time |
| --- | --- | --- | --- | --- | --- |
| tracks-v2 as shipped | 2,572 (115 / 1,528 / 929) | 261 | 28 / 11 | 576 / 449 | about 5 min |
| + compensation + adaptive threshold | 3,106 (199 / 1,854 / 1,053) | 317 | 45 / 23 | 607 / 519 | about 5 min |
| + repeated-frame skip | 2,638 (33 / 1,878 / 727) | 308 | 5 / 1 | 552 / 438 | about 5 min |

Findings:

- **The algorithm proposal (coherent only) undercounts about 18-fold.** The uncertain queue holds 1,025 crossings.
- **Many backward crossings are recorded.** 449 uncertain entries show tracks jumping between neighbours (zigzags).
- **Tracks fragment.** There are about 4 tracks per bat. In the first second alone there were 826 tracks with up to 418 alive at once.
- **It is very slow.** A cProfile of 30 frames shows 0.9 frames/s:
  - 75 % of the time is in `_associate` (a Python double loop over about 420 tracks and 260 detections);
  - 20 % is in `join_tracklets` (all pairs, with a median per call).
- **This scene is exactly what ThruTracker's dense modes target.** They assume one flow direction per area of the screen.

### 3.3 What the owner saw in the recording

- **The display bug.** `tracks_between(..., limit=500)` raises `track_limit` for a 30 s chunk, and noise tracks count toward the limit. So `useTracks` loaded nothing and no ring was drawn.
- **Over-sensitive settings.** With sensitivity 4 and Dense, 205 tracks and 87 uncertain events came from the first window alone.

## 4. Principles for Phase 3

1. **Transparent counting** (ThruTracker's "no black boxes"; Ahlberg et al. 2025). The user can see every count's track, the crossing point, the points on both sides, and why a track was uncertain or lost.
2. **Measure, then tune.** No algorithm change is accepted without the X2 benchmark. Numbers are reported, not invented thresholds (AGENTS).
3. **Evidence rules unchanged:**
   - Originals stay untouched and every frame keeps its exact PTS.
   - Counts stay provisional, in three layers.
   - No window is hidden.
   - Rendered outputs (videos, figures, report) are labelled derived and provisional and carry their parameter hashes.
4. **People decide ecology.**
   - Labels, species and categories come from reviewers; the app suggests geometry, never species.
   - Bulk actions are single audited actions over an explicit selection (like the accepted one-action count).
5. **Small stack.**
   - NumPy, SciPy and Pillow on the backend; canvas on the frontend; Electron built-ins (`printToPDF`) for the report.
   - The FFmpeg in the existing PyAV wheel encodes VP9.
   - No OpenCV, no new runtime dependency without approval.
6. **Each milestone is one vertical slice** with tests and docs, usable on its own.

## 5. Milestones

Estimates are engineering person-days, as in the earlier plans, and exclude owner time.

### X1 - Show what the tracker found (no schema change, 4-6 d)

Goal: the Watch page looks and reads like the reference tools on the same data, and never goes blank.

**Display fix.**

- `GET /api/tracking/{run}/tracks` gains:
  - `include_noise` (default false);
  - a **points budget** instead of a 500-track cap;
  - `ordered=quality`.
- The response carries `shown` and `total`. When the budget is exceeded, the coherent tracks closest to the playhead come first, and the UI shows a banner: "Showing 412 of 905 tracks in these 10 s (display limit); export and counts include all."
- `CHUNK_MS` becomes 10 s. The current chunk and the next one are prefetched.
- Explicit, never silent: the full set stays in counts and exports.

**Marker styles.** A Bats-view menu offers:

- **Rings** (today).
- **Boxes** (O-GEO / TrackBats): a box sized to the detection.
- **Dots** (ThruTracker): a small diamond at the current detection and a dotted trail of the last N detections.

Other marker rules:

- Each track gets a stable colour from a colour-blind-safe palette of 8 hues.
- Line style shows quality: solid for coherent, dashed for uncertain.
- ID labels hide automatically above 25 visible tracks (configurable) to avoid clutter.

**Crossing circles.**

- A filled circle in the track's colour sits at the exact crossing point: the gate segment intersected with the track segment between the two confirmed points.
- It fades over 1.5 s and has a small arrow (in or out).
- Uncertain crossings are hollow and amber.

**Count board.**

- A bottom band like ThruTracker and O-GEO, at least 20 px tall at 1080p, one row per active gate:
  `Gate A  Entered 6  Exited 504  Net +498  Inside 3  (pending 12) - PROVISIONAL`.
- `C` toggles between the band and the compact corner box.
- Values are cumulative up to the displayed frame, as `soFar()` computes today.
- **Inside** applies to rectangle and polygon gates: confirmed non-noise tracks whose current position is inside at the displayed PTS. Coherent and uncertain are shown separately.
- The board labels Inside as "tracks inside now" so it is never read as bats in the roost. It is a display value and is not exported.

**Clock.**

- When the survey has a recording clock anchor (the existing session `clock_anchor`, declared with its provenance), the top-right corner shows, for example, "21:08:17.550 (declared clock)". It uses the same arithmetic as `csv_export.clock()`.
- Otherwise it shows "elapsed 00:03:40.22".
- The frame number goes beside it.
- The clock is never invented: no clock means elapsed time only.

**Tests.**

- Crossing-point interpolation (unit).
- The budget path returns `total > shown` and the banner appears (end to end).
- Noise is hidden by default and shown with the toggle.
- On the `crossing` fixture a circle appears at the gate on the crossing frame, and Inside counts on a rectangle fixture.
- A screenshot review on dense synthetic data (from X2, or a simple generated fixture).

**Exit.** The owner's O-GEO test shows markers and a board instead of a blank video.

**Stop.** None expected. If 10 s chunks cost too much IPC, keep 30 s chunks with the budget.

### X2 - Measure before tuning: scenes, benchmark, sample check (schema v14, 6-9 d)

Goal: every later algorithm change has numbers. Users can check the app against their own count, which is the practice the 2025 review recommends.

**Realistic synthetic scenes** (`backend/tests/scenes.py`). The generator is deterministic and seeded, and writes exact ground truth (per-bat paths and expected gate crossings).

Factors, combinable:

- **Backgrounds:**
  - a flat sky with a gradient;
  - fractal "stone" texture;
  - "foliage" that sways;
  - water with reflections.
- **Camera artefacts:**
  - sensor noise;
  - encoder compression;
  - gain and offset steps (AGC);
  - shutter freezes (repeated frames, NUC);
  - frame-rate conversion (duplicated frames);
  - a slow drift and a one-off camera shift.
- **Target appearance:**
  - motion blur (comets);
  - warm and cold polarity;
  - sizes 2-30 px.
- **Bat behaviour:**
  - trickle, burst (100+ per second), swirl at the exit, re-entries;
  - merges and occlusion;
  - a hot static spot with a bat that hangs and then leaves.

The fixture encoder must follow the E0 GPL-free wheel. If libx264 goes, fixtures switch to VP9 or MPEG-4 Part 2.

**Benchmark** (`scripts/benchmark_tracking.py`, not shipped in the app).

- It runs a tracker version over scene sets and over local annotated real clips; those live outside the repository, under a path given on the command line.
- It matches crossings to the truth by direction within plus or minus a tolerance (frames).
- It reports, per scenario:
  - recall and precision per direction;
  - count error;
  - uncertain-queue size;
  - false tracks per minute on bat-free scenes;
  - fragmentation (tracks per true bat);
  - frames per second.
- Outputs are JSON and a Markdown table. Results go into the research log as numbers only.

**Sample check (in the app, Counts tab).**

1. The reviewer chooses a span (2 minutes by default) and plays it at 1x or slower. Faster rates stop the check with a message.
2. They press `[` for entry and `]` for exit each time a bat crosses the gate. The displayed-frame PTS of each press is recorded.
3. The app matches presses to algorithm and reviewer-layer crossings within plus or minus 0.5 s (a parameter, shown) and lists matched, missed by the algorithm and extra in the algorithm, each with a jump link.
4. The result is an append-only receipt with actor, span, playback rate, presses and the algorithm revision, stored in `sample_check` (schema v14).
5. It is shown in the Counts panel and exported: "Sample check 21:10-21:12: you 47 exits, algorithm 45, 44 matched".
6. The check never changes a count. The receipts also become real-footage ground truth for X3 tuning.

**Tests.**

- The scene generator is deterministic (same seed, same bytes and truth).
- The benchmark reproduces the section 3 failure modes on synthetic stone, AGC and dense scenes.
- Sample check: matching logic (unit); the receipt is refused above 1x; v13 to v14 upgrade and rollback; end to end on the `crossing` fixture.

**Exit.** A baseline report for tracks-v2 on every scenario is committed to the research log.

### X3 - tracks-v3: detection and association for real footage (no schema change; new algorithm version, 12-18 d)

Goal: on the X2 benchmark, v3 must beat v2 on recall, uncertain-queue size and speed without losing precision. Runs stay versioned; v2 runs remain readable and exportable.

**Detection.**

1. **Repeated frames.**
   - A frame whose pooled image matches the previous one within the noise floor is marked repeated and skipped for association.
   - Motion uses the real PTS difference: the Kalman filter works in px/s with dt from PTS, which also covers variable frame rates.
   - Quality rules use the effective frame rate.
   - Statistics report "repeated frames N (x %), effective rate y fps".
2. **Gain and offset compensation.**
   - A robust per-frame fit of the image to the background over the detection area, using only cells that were background in the previous frame. A dense flock can fill enough of the sky to shift plain quantiles, so the fit excludes it.
   - Steps are recorded as `gain_jump` scene events. They are shown, never silently absorbed.
3. **Noise-adaptive threshold.**
   - Per-cell temporal noise is the MAD of the median samples (x1.4826), max-filtered 3x3 and floored at the frame's median noise.
   - Foreground score: z = difference / noise, in the chosen polarity.
   - "Sensitivity" becomes a **contrast threshold in noise units**. The range and default are chosen on X2 and versioned (ThruTracker uses 1-7, default 4).
   - The old grey-level meaning is not reused under the same name.
4. **Matched filter.**
   - A Gaussian of sigma about target/4 on z before thresholding (ThruTracker's target-diameter filter).
   - It raises small faint bats above speckle and joins wings to the body.
5. **Hysteresis segmentation.**
   - Seeds at z >= T, grown at z >= T/2 (`ndimage.label` plus seed membership). This keeps faint wings without admitting faint noise.
6. **Size range and contrast floor.**
   - Minimum and maximum diameter, and an optional minimum peak z (ThruTracker's exclusion size and brightness).
7. **Persistent spots.**
   - Cells that stay foreground longer than a set time are a static spot. Detections fully inside one cannot start tracks, and the noise map (X4) shows them.
   - A bat hanging at the hole and then leaving no longer leaves a ghost track.

**Association.**

8. **Speed limit.** "Target speed" in target diameters per frame (the default is chosen on X2) caps the gate radius from the first step. Today the initial velocity sigma admits a jump of about 400 px.
9. **Two-stage matching** (the ByteTrack principle without a learned detector):
   - Strong detections are matched to confirmed tracks first; leftover tracks then take weak detections (T/2 to T).
   - Weak detections never start a track.
   - A tentative track needs three detections with consistent motion, not just any three.
10. **Flow prior for dense scenes.**
    - A smoothed grid of recent confirmed-track velocities. A new detection is born with the local flow velocity instead of zero, so its first match lands on the right neighbour.
    - This is what ThruTracker's dense modes assume, but here it is estimated rather than fixed to one direction.
    - Where local velocities disagree (swirling at a cave mouth), the prior falls back to an unknown velocity within the speed limit.
11. **Merges** (only if the X2 benchmark shows merges as a main error source).
    - One detection with roughly the combined area of two predicted tracks may be shared by both until they separate. Both tracks are marked `merged` and are uncertain only if the merge outlasts a limit.
12. **Fast candidate search.**
    - `scipy.spatial.cKDTree` pairs within the gate radius, a sparse cost matrix, and `linear_sum_assignment` per connected component.
    - Tracklet joining also uses the KD-tree on end and start points, with no median per call.
    - Target: real time or better at 640x360 analysis for 300 detections per frame, measured and reported on the developer machine and on the owner's Windows laptop.

**Counting rule.**

13. A crossing requires **m confirmed points on each side** (m = 2 by default, recorded in the gate algorithm version), which is ThruTracker's "inside, then outside".
    - With fewer points it is an uncertain crossing that needs review, never a silent count.
    - Hysteresis stays.
14. **Band counting for dense mode.** In the gate's band (twice the target size each side), detections are linked frame to frame along the flow prior, and a crossing counts when a short linked chain straddles the line with m points per side. In streams where long tracks break, short chains are reliable. The full tracks still exist for display.
    - A gate counts with one method per run (track crossings or band counting), recorded in the gate algorithm version, so nothing is counted twice.

**Quality classes.**

- Classes are recomputed with effective-frame-rate gap ratios plus smoothness (turn rate), speed consistency and mean z.
- The class `static` is added for stationary targets.

**Tests.**

- Every existing tracking fixture.
- X2 scenarios: AGC steps (no burst of tracks), stone texture (false tracks per minute), repeated frames (one coherent track per bat), dense burst (recall and fragmentation), hanging bat (no ghost), merge and split, camera shift (scene event still raised).
- Performance: a dense synthetic scene runs at least in real time at the analysis size, or the measured rate is reported and a stop condition applies.

**Exit.** A benchmark table v2 versus v3 in the research log, with v3 better on the dense and texture scenarios and not worse elsewhere. The O-GEO and ThruTracker reference clips are rerun as an informal comparison.

**Stop.**

- If v3 is not better on the benchmark, v2 stays the default and v3 ships only as an opt-in "experimental".
- If dense real-time is not reached, dense mode warns with an expected processing time before starting.

### X4 - Guided setup (schema v15 for templates, 6-9 d)

Goal: a first-time user gets usable settings in about two minutes, and an expert can replicate a site setup year to year.

**Click a bat.**

- On a paused frame, a click measures the blob under the cursor against the background: diameter, polarity and peak z.
- It proposes target size, polarity and a contrast threshold just under the measured z. All values stay visible and editable.
- Clicking two or three bats proposes a size range.

**Test run feedback.** The 10 s test gains:

- detections as small diamonds and tracks as dotted trails (the X1 styles);
- "repeated frames" and "gain jumps" warnings;
- a **noise map**: where detections that never became coherent tracks clustered;
- **suggested exclusion zones**: convex outlines of noise clusters away from the gate, each with "Exclude" and "Ignore". Nothing is applied without a click.

**Roost presets.**

- Presets: bat box, building, tree, cave entrance, bridge and very large emergence.
- Each sets starting values (polarity, density and speed) and shows the matching gate tip from the guidance, for example "draw the gate just below the exit, across the drop-out path".
- Presets are starting values, never validated thresholds.

**Gate checks.** These warnings show before counting:

- the gate is closer than a set margin to the frame edge (a bat must be seen on both sides);
- most test-run tracks run parallel to the gate;
- the gate overlaps an exclusion zone or a static spot.

**Site templates.**

- A template saves the detection area, exclusions, gates and settings with the reference frame.
- When it is applied to a new survey, an overlay blink of the template frame against the new one shows whether the camera view still matches.
- The geometry is not re-fitted automatically, and a mismatch keeps gates paused until reconfirmed.
- Templates export and import as JSON, with no media inside.

**Tests.**

- Blob measurement on fixtures (size within one analysis cell; correct polarity).
- Suggested exclusions never cover the gate band.
- Template round trip.
- Applying a template creates gates that need reconfirmation when the frame size differs.

### X5 - Enhanced view, "motion boost" (no schema change, 6-9 d)

Goal: faint and fast bats become obvious while playing at 2-4x. This is the UltraVision effect, made deterministic and traceable.

**Rendering, in the playback-copy worker.** For each frame:

- background from the same centred median as tracks-v3;
- z from the per-cell noise;
- a persistence trail `T = max(T * decay, z)` for each polarity, with a 1-3 s half-life set in the UI;
- output: the background dimmed to about 35 % and desaturated, warmer or lighter trails in orange or green, colder or darker in blue (the colours are part of the parameter hash).

**Delivery.** A spike of at most 1 d chooses between:

- (a) a **stacked copy**: the standard and enhanced views side by side in one VP9 frame (1920x540), with a single decode and exact sync. The Player crops halves into the panes.
- (b) a separate enhanced copy with the same frame map, selected by a Standard/Enhanced toggle.

(a) is preferred for the side-by-side layout, (b) for disk use; the spike measures encode time and size on the long test video.

**Rules.**

- The enhanced view is labelled "Enhanced (derived display, not evidence)".
- Exact-frame verification still opens the original.
- Watched-window receipts record which view was watched.

**Tests.**

- A faint synthetic target below the standard view's visible contrast appears as a trail in the enhanced output (pixel test).
- Polarity colours are correct.
- The frame map is identical to the standard copy.
- Sync is exact in stacked mode (end to end).

**Stop.** If encoding doubles the copy time beyond what the owner accepts, render the enhanced copy on demand per window only.

### X6 - Track table, all-tracks map and group decisions (schema v16, 7-10 d)

Goal: review by list and by map, as in TrackBats and ThruTracker's "view all tracks", without losing the audit.

**Track table** (a new Tracks tab).

- Columns:
  - track number;
  - first seen (camera clock or elapsed);
  - duration;
  - points;
  - quality;
  - crossings (gate and direction);
  - category;
  - species (free text);
  - comment;
  - decision.
- It sorts and filters, for example to "uncertain" or "crossed gate A".
- Clicking a row seeks to the track's first frame and highlights it; hovering a track on the map highlights its row.
- Keyboard: up and down to move, plus decision keys.

**All-tracks map.**

- Every track over the reference frame, in its colour, with a hollow circle at the start point and direction arrows (the TrackBats image).
- A start-point density mode finds exit points (TrackBats' first-detection heatmap; reuses the flight-map grid).

**Group selection.**

- Draw a box or lasso on the map, or filter the table, then apply a category to the selection in **one audited action** listing the track IDs.
- Categories: exit, entry, fly-by, foraging, not a bat, uncertain, plus up to six custom labels per survey.
- Species is free text with suggestions from a UK species list. It is never inferred.

**Storage.** `track_label` is append-only (actor, time, tracks, category, species, comment, basis revision), with a projection per track. Count layers are unchanged: labels inform the reviewer, and the reviewer layer still changes only through count actions.

**Tests.**

- A group label stores one event with every ID.
- Undo is a new event.
- Labels survive restart and export.
- Row click seeks to the exact first PTS.

### X7 - Multi-exit counting, emergence profile and flow metrics (schema v17 for gate colour and order, 6-9 d)

**Several gates at once.**

- All active gates are drawn and counted together, each with its own colour and board row (Exit A, Exit B and so on).
- Per-gate review stays separate.
- Totals across gates in one video are shown only as a sum, labelled "sum of gates (a bat may cross several)".
- Counts are never combined across cameras automatically (AGENTS).

**Polyline gate.** A line with up to 8 vertices. A crossing on any segment counts once per track pass, with the hysteresis and m-points rule.

**Emergence profile.** A chart under the timeline:

- exits per minute (up) and entries per minute (down) per gate;
- the cumulative net as a line;
- markers for first exit, peak minute and last exit;
- optional sunset.

Clicking the chart seeks there.

**Sunset.** The user types a sunset time, or enters the site's latitude and longitude (stored locally only), and the NOAA solar formula computes it with no network. The method is shown.

**Flow metrics.** Bats per second and per minute for the algorithm, reviewer and QA layers. Peak rate and time after sunset go in the export.

**Tests.**

- Two gates count independently.
- Polyline crossings at a vertex count once.
- Profile bins add up to the counts.
- The sunset formula is checked against a published table to within 1 minute.

### X8 - Deliverables: overlay video, highlights, figures and PDF report (schema v18 for render jobs, 9-13 d)

**Overlay video** (contained render worker, Job Objects; VP9 WebM, the existing encoder).

- It uses the X1 marker style, gates, crossing circles, the count board and clock, and a fixed corner watermark "PROVISIONAL - algorithm and review state at export, not final counts".
- The settings hash and export ID appear on a title card.
- Two variants:
  - **full** (the whole survey, or one video);
  - **highlights**: only spans with tracks, plus pre-roll and post-roll; each skipped span is replaced by a 1 s card "skipped 03:12 with no tracker output - not verified absence".
- Long renders show progress and can be cancelled. A failure is explicit, never a partial file.

**Figures.** PNG files drawn with Pillow:

- the emergence profile;
- all tracks with start points;
- start-point density.

All figures are labelled with layer and state.

**PDF evidence report** (an HTML template rendered by Electron `printToPDF`; no new dependency). Contents:

- survey and segment list (hashes, durations, clocks);
- gates with snapshots;
- counts per gate and layer, with QA state;
- sample-check results;
- the watched-window coverage and the all-window review denominator;
- the profile and figures;
- settings and versions;
- limitations (the AGENTS wording);
- the "provisional" banner.

The report is stored in the export bundle.

**Tests.**

- Overlay frames match the source frames one to one (frame count and PTS map).
- The watermark is present.
- Highlights cards list every skipped span with exact durations.
- The PDF contains every section and the provisional banner.
- Size and time limits fail explicitly.

### X9 - Audio: several detectors, proposed sync, call activity (schema v19, 8-12 d)

**Several audio sources per survey.**

- Each source has its own anchors and a label ("detector at camera", "detector at roost").
- Each gets a lane under the video with an energy envelope and a spectrogram on demand.

**Proposed sync.**

- The proposal reads the GUANO `Timestamp` (written by Wildlife Acoustics, Pettersson, Elekon and others) or a filename timestamp, and the video's camera clock.
- It is shown as a **proposed** anchor "from file clocks (unverified)" and needs one confirmation.
- A helper finds a sharp broadband transient (a clap or tone) near the proposed offset to refine it.
- Without confirmation, audio stays labelled unsynchronised (E7 rule).

**Call activity.**

- Band energy (15-120 kHz by default, adjustable) against a rolling noise floor, with a minimum duration. This gives call marks on the lane and the timeline.
- "Tracks on screen during this call" is listed. A track gets a "call during visibility" flag in the table.
- No species is inferred; species stays the reviewer's free text (TrackBats' classifier is out of scope).

**Tests.**

- GUANO parsing on synthetic files.
- A proposed anchor stays unconfirmed until the user acts.
- A synthetic call train is detected at the right times.
- Linking returns exactly the tracks alive at those times.
- Heterodyne and spectrogram behaviour is unchanged.

### X10 - Windows and real-footage validation (owner-gated)

- Build and run X1-X9 on native Windows (docs/18 checklist rows for each).
- Run the benchmark and sample checks on authorised footage: the owner's test files, once uploaded, and real `.MTS` originals.
- Record only numbers and text, never media.
- E8 (independent ecological validation) remains the gate for any accuracy claim.

## 6. Order, dependencies and effort

```text
X1 -> X2 -> X3 -> X4 -> X5 -> X6 -> X7 -> X8 -> X9 -> X10
            X3 needs X2 (no tuning without numbers); X4 and X5 reuse the v3 background and noise model;
            X8 needs X1 (overlay styles) and X7 (profile); X9 is independent after X1 (clock).
```

| Part | Milestones | Effort |
| --- | --- | --- |
| Phase 3a: catch up on what users see and the engine | X1-X5 | 34-51 d |
| Phase 3b: review, counting and deliverables | X6-X8 | 22-32 d |
| Phase 3c: audio | X9 | 8-12 d |
| Total | | 64-95 d |

The phases are separated so the owner can stop after 3a and judge. X1 alone fixes the blank screen.

## 7. Data model (proposed; each step is one transaction with upgrade and rollback tests, as before)

| Schema | Additions |
| --- | --- |
| v14 | `sample_check` (append-only: run, gate, actor, span, rate, presses, algorithm revision) |
| v15 | `site_template` (name, frame size, reference frame hash, geometry and settings JSON) |
| v16 | `track_label` (append-only) and its projection |
| v17 | `gate.colour`, `gate.position`, polyline kind |
| v18 | `render_job` (kind, parameters, hash, state, output path in managed storage) |
| v19 | `audio_source.label`, several sources per segment, `audio_anchor.provenance` (manual, file_clock_proposed, confirmed) |

tracks-v3 needs no schema change. Its parameters and the new scene event kinds (`gain_jump`, repeated-frame statistics) live in the existing versioned JSON.

## 8. Dependencies

- No new runtime dependency is planned. SciPy (`cKDTree`, `ndimage`, `optimize`), NumPy, Pillow and PyAV/FFmpeg (VP9) cover X1-X9, and Electron covers the PDF.
- Optional, owner decision: `python-docx` (MIT) if a Word report is required in addition to PDF. It would be pinned and noticed like the others.
- Not used: OpenCV (a second FFmpeg in its wheel), Ultralytics (AGPL), BatDetect2 (non-commercial), trained detectors.

## 9. Risks and stop conditions

| Risk | Response |
| --- | --- |
| v3 is not better on real footage | X2's sample check gives real ground truth early; v2 stays default; v3 opt-in |
| Dense scenes are still too slow | A warning with the expected time; band counting only; analysis at lower resolution with the error recorded |
| Overlays clutter dense scenes | Auto-hide labels; dots style; a cap on drawn trails with a banner |
| The enhanced copy doubles encode time and disk | Per-window on-demand rendering |
| Overlay video in WebM is not accepted by clients | Owner decision; MP4 needs an H.264 encoder, which conflicts with the GPL-free E0 build |
| Unreliable camera and detector clocks | Always "proposed, unverified" until confirmed |
| Scope: ten milestones | Each one ships alone; the owner may stop after 3a |

## 10. Review of this plan (AGENTS step 3)

**Bat IR computer-vision engineer.**

- A MAD from nine samples is noisy, so it is max-filtered and floored. The X2 benchmark decides whether a longer running estimate is needed.
- Gain fits exclude foreground cells.
- The flow prior falls back where flow is multi-modal.
- Merge handling waits for evidence.
- Band counting and track counting never both count one gate.

**Ecological reviewer.**

- Every rendered count says provisional and shows the pending items.
- "Inside" is labelled as tracks, not bats.
- Highlights videos mark skipped spans as "not verified absence".
- Labels never change counts.
- Species is entered by a person.
- The sample check is a check, not a correction.

**Desktop and QA engineer.**

- The stacked copy, overlay renders and PDF generation are measured on the owner's Windows laptop (X10) before being the default.
- Long renders show progress, cancel cleanly and fail explicitly.
- One key map is defined for the new keys before X1 ships. No new key overlaps an existing one (Space, comma, full stop, arrows, 1-6, V, B, N, D, U, M, Esc).

**Security and licensing engineer.**

- Template JSON and GUANO metadata are untrusted input: size-limited, schema-checked, with no paths.
- The report HTML escapes every user string and loads nothing remote.
- No new runtime dependency without approval. OpenCV, Ultralytics and BatDetect2 stay out.

**Maintainer.**

- Ten milestones, each shippable alone; the owner can stop after 3a.
- Inside is computed in the display only.
- Counts stay computed in one place (the backend), as today.
- Three marker styles reuse one drawing function with parameters.

## 11. Owner decisions needed

1. Approve the order X1 to X10 (or reorder), and the 3a / 3b / 3c split.
2. Sensitivity changes meaning in tracks-v3 (noise units instead of grey levels). Approve, with v2 runs kept as they are.
3. Overlay and highlights video format: VP9 WebM (no new codec) or MP4 (needs a licensed H.264 path).
4. Report: PDF only (no new dependency), or also DOCX (python-docx, MIT).
5. Sunset: typed time only, or computed from site coordinates stored locally.
6. Species field: free text, or a fixed UK species list plus "other".
7. Sample check: approve it as a new receipt type and confirm the 1x limit and the plus or minus 0.5 s matching tolerance as starting parameters.
8. Upload the test videos mentioned (the folder still has the seven reference files), preferably originals without other tools' overlays.

## 12. Phase 3 tracker

Separate from the 22/27 expansion tracker and the 7/7 Phase 2 tracker. Each box is ticked in the commit that completes it, so an interrupted session resumes at the first open box.

- [x] X1: display budget (noise hidden, points budget, banner), marker styles, crossing circles, count board with Inside, clock.
- [x] X2: synthetic scene generator and benchmark script with a tracks-v2 baseline in the research log.
- [x] X2: sample check (schema v14) with receipt, comparison and export.
- [x] X3: tracks-v3 detection (repeated frames, gain compensation, noise-adaptive threshold, matched filter, hysteresis, persistent spots).
- [x] X3: tracks-v3 association (speed limit, two-stage, flow prior, KD-tree) and the m-points crossing rule, with a v2/v3 benchmark.
- [x] X4: guided setup (click to measure, noise map and suggested exclusions, presets, gate checks).
- [x] X4: site templates (schema v15).
- [x] X5: enhanced view (schema v16, toggle rather than stacked copy).
- [x] X6: track table, all-tracks map and group labels (schema v17, export v4).
- [x] X7: multiple gates at once, polyline gate, emergence profile and typed sunset (schema v18).
- [x] X8: overlay and highlights video (schema v19).
- [ ] X8: figures and PDF report.
- [ ] X9: several audio sources, proposed sync, call activity (schema v20).
- [ ] X10: Windows and real-footage validation (owner).
