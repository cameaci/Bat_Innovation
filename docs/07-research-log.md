# 07 - Research log

## 2026-10-28 - Phase 3 X5: enhanced view

**Implementation:** an enhanced playback copy (schema v16 adds `proxy.kind`, standard or enhanced) is rendered on request per video by the playback-copy worker with the same frame map as the standard copy. Each frame shows the scene dimmed to 35 % grey with lighter-than-scene movement as fading orange trails and darker-than-scene movement as blue trails (1 s half-life). The background is a median of nine samples a quarter second apart, the noise per pixel the smaller of the deviation from that median and the successive differences, the contrast measured in noise units after a light Gaussian; camera gain drift up to 10 grey levels is fitted on quiet pixels and undone, and a frame where more than 3 % of the image changes at once (a lighting jump, a keyframe, a camera move) adds nothing to the trails. All constants are versioned as `enhance-v1`. Watch has an Enhanced (E) toggle that keeps the source time, labels the view as a derived display, offers to prepare a missing enhanced copy, and records the view in watched-window receipts. Verify still opens the original.

**Verified:** backend tests that a 3 px target of contrast 14 on noise 2 leaves an orange trail (and a blue one at -14) while the static scene stays grey, that a +40 lighting jump does not flood the view (the test fails without the guard), the enhanced copy's frame map and the v15 to v16 upgrade; an end-to-end test that prepares and switches to the enhanced view. On the O-GEO reference clip (a screen recording, so compressed twice) the coloured share of the frame fell from a median of 8 % to 1.6 % with the guard, and the remaining colour is mostly on the flight paths. **Not verified:** real camera originals; very dense emergences where flying bats alone cover more than 3 % of the frame (those frames would add no trail); encode time on Windows. The side-by-side stacked copy of the plan was not built: the view is a toggle (plan option b), which halves the disk use.

## 2026-10-28 - Phase 3 X4: guided setup and site templates

**Implementation:** the Setup tab offers roost-type presets (bat box, building, tree, cave entrance, bridge, very large emergence) that set polarity, activity and target speed and show the matching gate tip from published guidance; they are starting values. After a 10 s test, clicking a bat on the paused frame measures the detection under the click (area, contrast in noise units, lighter or darker) and offers its size, polarity and a threshold of half its contrast (at most 7). The test reports repeated frames, gain jumps, frames over the activity limit and static spots, and proposes exclusion rectangles where detections kept appearing without a non-noise track (drawn in amber, applied only by Exclude). The Counts tab warns when a gate runs along the frame edge, lies along the main flight direction of the loaded tracks, or passes through an excluded zone. Site templates (schema v15) store a view's settings and gates by name, export to and import from a JSON file (no media), refuse another frame size instead of rescaling, and place gates that carry the template ID and stay paused ("comes from a site template") until reconfirmed. A seek to the time already on screen now keeps the displayed frame (it used to clear the overlay).

**Verified:** backend tests for detection measures, noise-cluster suggestions, template save, import refusals, frame-size refusal, the template pause and reconfirmation, retirement and the v14 to v15 upgrade; Node tests for measurement, the threshold suggestion, gate warnings, footage warnings and the declared clock; end-to-end tests for presets, click-to-measure and applying it, and saving and applying a template. **Not verified:** whether the presets and warnings help on real footage; Windows file dialogs.

## 2026-10-28 - Phase 3 X3: tracks-v3

**Method (NumPy and SciPy only):** repeated frames (pooled maximum difference of 2 grey levels or less) stay in the scene model but are skipped by tracks, and motion uses the real time between frames; a per-frame gain and offset fit on quiet cells absorbs camera gain drift up to 10 grey levels (larger changes are left to the disturbance rules) and counts the steps; contrast is the Gaussian-smoothed difference (sigma a quarter target) divided by each cell's own noise of that statistic, taken as the smaller of two robust temporal estimates (deviation from the median, which ignores a slow target, and successive differences, which ignore a lighting step) and the largest within 5 cells; targets are local maxima of that contrast, measured on the unsmoothed difference above half their peak after a closing that joins wings and body; cells foreground for 2 s are a static spot that cannot start tracks. Association is a Kalman filter in pixels per second with a hard target-speed limit, KD-tree candidates, two-stage assignment (weak detections only extend confirmed tracks), births with the local flow of recent tracks, tracks ended when predicted outside the frame, KD-tree tracklet joining, and quality classes at the effective frame rate using the track's extent. Settings: `threshold` (contrast in multiples of local noise, default 7, chosen on the benchmark so bat-free stone gives no tracks) replaces the grey-level `sensitivity`, and `target_speed` (target sizes per frame, default 4) is new. Gate crossings of tracks-v3 runs need two points on each side (`gate-hysteresis-v2-m2`).

**Benchmark (synthetic, proposal = coherent tracks, v2 in brackets):** sky trickle 12/12 matched (8), stone 12/12 (0), gain steps 12/12 (0), repeated frames 8/8 (8), cold bats 9/9 (0), fast blur 9 matched of 12 proposed (9 of 9), bat-free stone 0 false tracks, resting bat 1/1, dense stream 142 of 149 with 3 uncertain (95 with 56 uncertain). About 30-45 frames/s at 320x240 in this container, slower than v2 on sparse scenes.

**Reference clips (informal; other tools' counters, overlays burnt in):** ThruTracker's mass emergence (about 500 exits): 198 coherent exits and 473 uncertain crossings in 35 s (v2: 28 and 1,025 in about 5 minutes). O-GEO church (29 crossings): no coherent and 50 uncertain crossings (v2: 3 and 188).

**Known limitations:** a target much smaller than the set target size and moving slowly is blurred into the background median; fast blurred bats can split into two crossing tracks; real-footage counts are still far from the reference tools on these clips, so the sample check and authorised footage (X10) decide further tuning.

## 2026-10-27 - Phase 3 X2: sample check

**Implementation (schema v14):** in the Counts tab, "Check a sample from here" switches to 1x (smart speed off) and records `[` (entry) and `]` (exit) at the displayed frame. "Finish and compare" sends the presses with a playback-copy receipt whose single interval must span the whole check at 1x or slower; the backend matches presses to the gate's coherent crossings of the same kind within 0.5 s (nearest first) and stores matched, missed by the algorithm, extra in the algorithm and the undecided crossings in the span, append-only in `sample_check`. Checks never change a count. They are listed with jump links and summarised in the export manifest (`sample_checks`).

**Verified:** backend tests for the matching, refusals (faster than 1x, partly watched span, presses outside the span), append-only storage, unchanged counts and the v13 to v14 upgrade with rollback; an end-to-end test counts a clip by hand and sees the comparison. **Not verified:** whether 0.5 s suits real footage and human key timing; reviewer effort.

## 2026-10-27 - Phase 3 X2: synthetic scenes and the tracks-v2 baseline

**Method:** `backend/tests/scenes.py` generates deterministic 320x240, 25 fps scenes with exact paths and gate crossings (the truth uses the app's own gate rule): a sky trickle with re-entries, the same over fractal stone whose temporal noise grows with texture, camera gain steps, repeated frames, dark bats on a warm wall, fast blurred bats, a bat resting at the exit, bat-free stone and a dense stream of 150 bats in 4 s. `scripts/benchmark_tracking.py` encodes and decodes each scene through the fixture codec, tracks it in-process and matches crossings by direction within plus or minus 5 frames.

**Baseline, tracks-v2 (proposal = coherent tracks):**

| scene | true crossings | proposed | matched | uncertain queue | frames/s |
| --- | --- | --- | --- | --- | --- |
| sky_trickle | 12 | 8 | 8 | 0 | 176 |
| stone_trickle | 12 | 0 | 0 | 0 | 194 |
| gain_steps | 12 | 0 | 0 | 0 | 179 |
| repeated_frames | 8 | 8 | 8 | 0 | 151 |
| cold_bats | 9 | 0 | 0 | 0 | 157 |
| fast_blur | 9 | 9 | 9 | 0 | 192 |
| empty_stone | 0 | 0 | 0 | 0 | 173 |
| resting_bat | 1 | 1 | 1 | 0 | 167 |
| dense_stream | 149 | 98 | 95 | 56 | 56 |

**Findings:** on texture every frame exceeds the component limit, so v2 drops every frame and finds nothing (the O-GEO failure); re-entering bats are classed as noise because start and end lie close together; the dense stream loses a third of its crossings. These are synthetic numbers for comparing versions, not accuracy on real footage.

## 2026-10-27 - Phase 3 X1: show what the tracker found

**Problem:** with many tracks the Watch page went blank: a 30 s chunk over 500 tracks (noise included) raised `track_limit` and nothing was drawn.

**Implementation (no schema change):** the tracks endpoint returns a page `{tracks, shown, total, noise_hidden}`: noise is left out unless asked for, a points budget replaces the track cap, coherent tracks come first, and a cut chunk shows "Showing x of y tracks (display limit); counts and exports include all". Chunks are 10 s. Markers come in three styles (boxes like O-GEO and TrackBats, dots with a dotted trail like ThruTracker, and the earlier rings), each track in its own Okabe-Ito colour, uncertain dashed, labels left out above 25 visible tracks. A filled circle marks where each crossing met the gate (hollow amber while undecided) for 1.5 s. The count board is a band along the bottom of the video (gate, Entered, Exited, Net, Inside for area gates as "tracks now", undecided, PROVISIONAL), a corner box or off (C). The declared recording clock (or elapsed time) and the frame number are drawn on the video.

**Verified:** backend test for the budget, ordering, hidden noise and reported cut; Watch and counting end-to-end tests including style switching and the board key; checked by eye on a synthetic screenshot. **Not verified:** readability on real dense footage and on Windows.

## 2026-10-27 - Phase 3 research: reference tools and tracks-v2 on their clips

**Question:** why do ThruTracker, TrackBats, O-GEO and DarkFlight UltraVision look and count better than this app on the owner's examples, and what should be built?

**Sources:** the owner's shared clips of those tools (kept outside the repository), the ThruTracker 3.0 user guide and 2021 paper, the TrackBats site, pricing and four articles, and Ahlberg, Kuczynska and Kloepper 2025 (J. N. Am. Bat Res. SI1:46-58). LinkedIn posts were not accessible.

**Measured (scratch runs of the repository tracker; the tools' counters are their outputs, not ground truth):** on the O-GEO church clip tracks-v2 produced 384 tracks in 11.5 s and 188 uncertain crossings against O-GEO's 29, with detection bursts of 99-126 per frame at camera gain jumps and temporal noise of about 3 grey levels on sky and 10-12 on stone. On ThruTracker's mass-emergence scene (about 500 exits in 4.8 s) it proposed 28 coherent exits, left 1,025 uncertain crossings and took about 5 minutes (0.9 frames/s; 75 % association, 20 % tracklet joining). About a third of frames in both clips repeat. Gain compensation, a noise-adaptive threshold or repeated-frame skipping alone did not fix the counts.

**Decision (owner, 2026-10-27):** Phase 3 X1-X10 approved; see [implementation/phase3.md](../implementation/phase3.md).

## 2026-10-26 - Phase 2 closing check (W7)

**Verified on Linux:** backend 433 tests passed (45 skipped), Node 58 tests, Playwright 27 end-to-end tests passed (1 skipped), including Watch, calibration, counting and reel. The frozen PyInstaller backend (296 MB) passed the extended smoke test: import, preview, summaries, tracking, a tracking test run that stores nothing, the playback copy with its frame map, export and an unchanged original. Export schema v3 was introduced with W4.

**Not verified:** native Windows build and installer for any Phase 2 change; real camera originals (tracking quality, camera-move classification, playback-copy size and encode time); reviewer workload and count accuracy against adjudicated footage (E8); LinkedIn sources (not accessible).

## 2026-10-26 - Phase 2 W6: event reel, smart speed and watched-window receipts

**Problem:** too many human checks: every track was a candidate on the Events page, every crossing needed Confirm, and every window needed its own lossless preview before a decision.

**Implementation (no schema change; receipts are JSON):** a Review tab beside the Watch player.
- The event reel queues only undecided uncertain crossings of the chosen gate and undecided uncertain tracks, in survey order. Each loops from 1 s before to 1.5 s after at normal speed with its track highlighted; B bat, N not a bat, D opposite way (crossings), U skip, Esc stop; the next event follows.
- Smart speed plays at the chosen speed and drops to normal speed within 1 s of a tracked target or crossing.
- Viewing is recorded from presented frames: an interval grows while frames follow during playback (allowing the frames a fast rate skips, and the last frame at the end), closes on a seek, and records the fastest speed. A window is "watched" when one interval at 4x or slower spans its first to last frame. "Mark k watched windows: no activity seen" (M) saves those windows that are unreviewed and have no stored non-noise tracks, all or nothing, with a playback-copy receipt (copy ID, frame-map SHA-256, intervals that start and end on copy frames, maximum speed); the backend re-checks every condition. Track decisions in the reel use the same receipt. The original-preview receipt remains valid everywhere.
- The Events page, the Review page timeline and the static heatmap (route and bridge included) are removed; their work is done on Watch.

**Verified:** backend tests for the all-or-nothing marking (too fast, partly watched, windows with tracks, already reviewed) and a track decision with a playback receipt; an end-to-end test that the reel asks only about one uncertain track and that a quiet video played end to end is marked in one step. **Not verified:** reviewer workload on real surveys (E8); whether 4x is the right limit for real footage (owner decision, not a validated threshold).

## 2026-10-26 - Phase 2 W5: three synchronised views, a flowing flight map and the survey timeline

**Owner request:** individual tracking, a red-yellow-green flight map that moves with the video, and the count, all on one screen.

**Implementation:** the Watch player shows three views of the same displayed frame side by side (one decoder; the other panes repaint the presented frame on their own canvas): Bats (rings, numbers, heading arrows, trails), Flight map and Count (gate, IN/OUT/NET board, crossing flashes). V switches to one large view with view chips. The flight map uses 10 s bins of track points per grid cell from the backend (noise tracks left out), summed up to the playhead plus the live points of the current bin, blurred and coloured green to yellow to red on a log scale, labelled "Track points, not individuals"; "Map: whole video" shows all points. A survey timeline lays all videos end to end in proportion to duration: tracks per window, crossings (in down, out up, undecided amber), crossings per minute, camera moves, reviewed windows, hatched gaps where videos are not marked contiguous, and the playhead; clicking seeks across videos.

**Verified:** backend test for bins that build up over time and exclude noise; end-to-end test for the three views, the single-view switch and the timeline. Checked by eye on a synthetic screenshot. **Not verified:** readability on long real surveys and on small laptop screens; rendering cost with many tracks.

## 2026-10-26 - Phase 2 W4: gate validity spans, quality-aware counts and one-action acceptance

**Problem:** the owner saw 164 crossings to review after one frame-wide change: E3 kept deriving crossings after a scene change and only marked them, against its own design ("the span ends at the change, reconfirm").

**Implementation (schema v13):** a gate is valid from its creation until the tracker's first classified camera move, and from the start of each later video not marked contiguous; each such point is one paused span with one action, "Reconfirm gate" (same geometry) or "Redraw" (a geometry for the moved scene), stored append-only per tracking run and gate revision. No crossings are derived in a paused span. Crossings inherit track quality: coherent ones form the algorithm proposal and count in the reviewer layer unless rejected (with a reason); uncertain ones wait for Bat, Not a bat or Opposite (no reason needed, that is the question asked); noise tracks never produce crossings. "Accept count" is one audited reviewer action, refused while anything is unresolved; QA by a different person requires an accepted count. Provisional export schema v3 adds track quality and metrics, crossing quality, paused spans, the reviewer state and the tracking settings and scene events in the manifest. The Counts page is folded into the Watch Counts tab: live IN/OUT/NET at the playhead on the video and beside it, a flash for each crossing, paused gates in grey.

**Verified:** backend tests show a camera move gives exactly one paused span and no crossings after it until reconfirmed, a redrawn geometry is used after the move, uncertain crossings stay out of the algorithm layer, acceptance and QA ordering, and append-only storage; an end-to-end test draws a gate on Watch, sees one paused span, the live tally, reconfirms, accepts and passes QA by a second person. **Not verified:** how often real footage produces false camera-move classifications; whether real split files are usually contiguous.

## 2026-10-26 - Phase 2 W3: tracking setup and a 10 s test on the footage

**Question:** how does a reviewer choose tracking settings that suit their footage before processing a whole survey (the ThruTracker test-clip principle)?

**Implementation:** a Setup tab beside the Watch player: target size with a red reference circle placed by clicking a bat, sensitivity, light/dark polarity, expected activity, drawn search areas and excluded zones (polygons in source pixels), and advanced gap, join and minimum-track values. "Test 10 s from here" runs the contained worker over the displayed range without storing anything and loops it with accepted (green) and size-rejected (grey) detection boxes, rings for the test tracks and a summary of stable, uncertain, noise, size-rejected and joined counts. "Looks good - track whole survey" starts the run with exactly those settings, which are stored and hashed with the run. A frame shown just after a seek is now kept until the seek completes, so stepping never loses the source time.

**Verified:** an end-to-end test draws an excluded zone over one of two synthetic targets, sees one stable track in the test, tracks the survey and finds the stored settings and one ring at the displayed frame. **Not verified:** suitable settings for real camera originals; they need the owner and representative footage.

## 2026-10-26 - Phase 2 W2: tracks-v2 individual tracking

**Question:** can the tracker follow each bat as one object, without new dependencies, and tell a camera move from a lighting change?

**Method (after BatCount and ThruTracker principles, NumPy and SciPy only):** block-mean pooling to a grid on which the target is about three cells wide; a centred temporal median background of nine samples a quarter second apart (processed with about one second of lookahead); foreground by polarity and sensitivity inside the detection area and outside exclusion zones; a closing of about a quarter target to join wings and body; size limits of 0.25 to 4 target diameters; a constant-velocity Kalman filter with Mahalanobis plus log-size cost, gated at chi-square 13.8 and assigned optimally; three hits to confirm; tracklet joining across losses up to 1 s along the predicted path; quality classes coherent, uncertain and noise. A disturbance (a quarter of the searched area changing) is a tracker gap; once the scene settles, its brightness-normalised residual against the scene before decides camera moved (tracks end, a new epoch starts) or lighting change; a disturbance gone after at most two frames is a glitch. Schema v12 stores quality, metrics and scene events. A calibration test run over at most 12 s of one segment returns detections and tracks without storing anything.

**Verified (synthetic):** two targets keep their IDs; flapping wings and body give one track; a 15-frame loss is joined; the slow uniform square that split under tracks-v1 is one track; crossing paths keep their direction; sensor noise and a one-pixel insect give no tracks; polarity, exclusion zones and the detection area restrict detection; a one-frame flash is a glitch; a brightness step is a lighting change with the track continuing; a 6 px scene shift is a camera move with tracks ended; 30 dense targets stay within limits. About 37 frames per second for 1080p in this container excluding decoding. **Not verified:** real camera originals, real wing-beat appearance, accuracy against adjudicated counts (E8). Short static ghosts can appear right after a lighting change near the start of a clip; they are classed as noise and hidden. All settings are starting values, not validated thresholds.

## 2026-10-26 - Phase 2 W1: playback copies and the Watch page

**Question:** how can reviewers watch a whole survey continuously, with tracks drawn on every frame, without loosening source-time traceability?

**Sources:** the owner's report on the failed review experience (164 per-crossing confirmations, 12 s clips, a static heatmap), and a public scan of UK and published tools: Wildlife Imaging Systems (motion summary images, WISARD reviewer), Geckoella POPO (ecologist-verified ML review, IR only), Thermal Vision Ecology (FLIR Research Studio flight-path tracking), EchoSight (annotated thermal review), ThruTracker (target size and polarity, exclusion zones, a test clip before full processing, overlay video with gate counts) and BatCount 2023 (local temporal median background, ROI, polarity; 50.8-94.8 % accuracy by site). LinkedIn could not be accessed. A 25 fps minimum for night vision footage in the BCT 2026 guide was seen only in secondary sources and is unverified.

**Decision (owner, 2026-10-24):** a lossy playback copy per segment may be watched for review; exact-frame verification from the original stays one action away. Recorded in AGENTS.md.

**Implementation:** `proxy_worker` re-verifies the original by SHA-256, decodes every frame and writes VP9/WebM (crf 34, realtime, keyframe every 30 frames) fitted to 960x540, plus a `prx1` sidecar mapping each copy frame (whole milliseconds from the first source PTS) to its exact source PTS. Schema v11 adds `proxy`. Copies are prepared one at a time in the background after a summary run completes and do not take the shared media lock, so previews and tracking stay available. Electron serves a ready copy only as `bat-media://proxy/<uuid>` (byte ranges forwarded to the loopback API with the token); the CSP allows that scheme for media only. The Watch page maps every presented frame through `requestVideoFrameCallback` (within 0.5 ms) to its source PTS and draws tracks on a canvas: a red ring, `#ID`, heading arrow and 1 s trail. Playback continues into the next video.

**Measured:** worst-case synthetic 1080p with per-pixel noise encoded at about 22 frames per second including decode, at about 12 Mbit/s (real footage with less noise is expected to be smaller; not measured on camera originals).

**Verified:** exact frame map and 206 range responses, changed-original and integrity refusals, upgrade and rollback (backend tests); continuous playback, rings at the displayed frame, speed, frame step, next-video continuation and refusal of a malformed `bat-media` URL (Electron end-to-end). **Not verified:** native Windows, real camera originals, disk use on long surveys.

## 2026-10-23 - Feature expansion E1-E7 closing check

**Frozen build:** a Linux PyInstaller onedir build with SciPy (296 MB) passed `scripts/smoke_backend.py`, which now also upgrades expansion storage and runs tracking: health, schema upgrades, import, preview, 2 of 2 summary windows, tracking, provisional export and unchanged original.

**Tracker limitation found by the smoke video:** its slow (1 px per frame) uniform square produced two tracks, its leading and trailing edges, because candidates come from frame-to-frame change. A running-background variant gave whole silhouettes but smeared a ghost of anything present in the first frame into the track, so it was rejected; `tracks-v1` keeps the causal double difference and the split is now a tested, documented limitation. Bats usually move several body lengths per frame, where it does not occur.

**Still open:** E0 (native Windows build and acceptance checklist of the new interface and workers, GPL-free PyAV build, ownership and licence) and E8 (ecological validation with an adjudicated reference set and owner-approved metrics). No ecological performance is claimed.

## 2026-10-23 - Feature expansion E7: full-spectrum audio beside the video

**Design:** schema v10 adds `audio_source` (native selection of `.wav` only, SHA-256 and file identity, declared recording type: full spectrum, heterodyne, frequency division, time expansion or unknown, and one channel) and append-only `audio_anchor_event`. A contained `audio_worker` (1 GiB, 120 CPU s, 150 s wall, shared activity lock) inspects the WAV through the pinned PyAV with a `wav`-only format whitelist and PCM codecs only, and derives on demand, for the loaded video clip, a spectrogram PNG (SciPy, Hann 512/256, 80 dB range, 0 to Nyquist) or a digital heterodyne clip (mix with the tuning tone, 8th-order Butterworth 8 kHz low-pass with zero phase, `resample_poly` to 48 kHz, 16-bit). The original is re-hashed before reading and never written. One anchor pairs a displayed video frame with an audio time: `audio_time = video_time + b`, floored to a whole sample, valid for the anchored video only; drift is not corrected and the UI and export manifest say so (`drift_corrected: false`). Only full-spectrum sources can be retuned; others are shown as recorded. The Process page has an Audio card; the window dialog has an audio strip with the spectrogram, a playhead from the displayed frame, a tuning field and "Listen (heterodyne)" that plays the clip at 1x beside the video. The export manifest lists each audio source with its anchor.

**Verified (Linux):** backend 416 passed, 45 skipped, including a synthetic 45 kHz tone at 384 kHz landing in the expected spectrogram row, a 40 kHz tuning giving 5 kHz, refusal before an anchor, outside-audio and stale-anchor refusals, append-only anchors, no retuning of a heterodyne recording, refusal of a non-WAV file, a fake `.wav` and a duplicate, and audio provenance in the export manifest (an intermittent failure seen once in E6 and once here did not reproduce in three further full runs and is not identified); 58 Node tests; Electron end-to-end 25 passed, 1 skipped, including adding a WAV, anchoring, showing the spectrogram and starting the heterodyne monitor.

**Not verified:** real bat-detector recordings (GUANO metadata is not read), long multi-hour WAVs (full decode on inspection and on each derivation from the start), drift over long surveys, audio-video sync accuracy on real cameras, Windows.

## 2026-10-23 - Feature expansion E6: activity timeline and heatmaps

**Design:** the Review page shows one timeline lane per original video in recording order, built from the existing run windows and per-window track counts: bar height is candidate tracks, a dot marks recorded observations, failed or incomplete windows are shaded, and the continuity between videos (contiguous, gap or unknown) is written between lanes rather than compressed. Clicking a window opens it in the dialog. A heatmap endpoint returns a 64-column grid in source coordinates for the first point of each track, all points, or tracks a reviewer marked as bat (empty until a person decides); it is drawn with active gate outlines and labelled as track points, not individuals, with an empty area not being proof of absence. No schema change.

**Verified (Linux):** backend 412 passed, 45 skipped, including all heatmap modes and the confirmed mode staying empty without a decision (one earlier full run had one intermittent failure that did not reproduce on rerun and was not identified); 58 Node tests; Electron end-to-end 24 passed, 1 skipped, including timeline items, opening a window from the timeline and two heatmap modes.

**Not verified:** gate crossings on the timeline, heatmaps over a real reference frame, very long recordings, Windows.

## 2026-10-23 - Feature expansion E5: highlight and block review

**Design:** the original preview accepts 2 s clips (unchanged limits) or 6 s and 12 s blocks. Frame, decoded-frame and CPU limits scale with the length, the wall deadline scales from the existing 25 s, and longer clips may use up to 32 MiB (measured: 12 s of the 640x360 noisy synthetic IR clip is 4.4 MB lossless VP9; 2 s is 0.8 MB). The renderer adds clip length, playback speed (0.25x to 2x), loop and previous/next frame. Frame stepping seeks to the middle of the neighbouring frame of the preview manifest and the displayed source PTS is still confirmed by the existing frame callback, never an FPS estimate. Keys in the window dialog: Space, comma and full stop, L, 1-5. Schema v9 adds append-only `candidate_event` (bat, not a bat, uncertain) on a track. Each decision needs a receipt: a ready preview of the same unchanged segment whose frames overlap the track's PTS span. The Events page shows each candidate in a 6 s block starting 1 s before it, with its trail, and "Not a bat + next" (N). Candidate decisions never change window review or the all-window progress. The preview section no longer shrinks under the new gate panel, which had covered its controls.

**Verified (Linux):** backend 411 passed, 45 skipped, including clip-length bounds, receipt refusal without a covering preview, optimistic conflicts and append-only triggers; 58 Node tests; Electron end-to-end 24 passed, 1 skipped, including an events spec with a 6 s block, a verified next-frame step, 0.25x speed and "not a bat + next".

**Not verified:** clip sizes for full-HD noisy IR originals, audio in highlight blocks (E7), zoom, Windows.

## 2026-10-23 - Feature expansion E4: provisional export v2

**Design:** `bat-provisional-csv-v2` keeps the observation and audit CSVs (the audit gains `modality`) and adds `provisional-tracks.csv` (one row per track of the latest complete tracking run of the exported summary run, with run, parameter hash, source SHA-256 and a points SHA-256; points stay in the database and API) and `provisional-counts.csv` (per gate revision: every derived crossing with its reviewer action, hand-added crossings, and one total row each for the algorithm, reviewer and QA layers, the QA totals empty unless a current approval exists). Without a finished tracking run both new files contain headers only and the manifest says `tracking: null`. The same read-only snapshot, row and byte limits, text encoding, worker containment and atomic native save apply; the Electron saver now validates five files. Track points are not exported in CSV because a long track would exceed the 64 KiB row limit.

**Verified (Linux):** backend 409 passed, 45 skipped, including a v2 export with two tracks, crossings and the three count layers and a header-only export without tracking; 58 Node tests with the five-file saver; Electron end-to-end 23 passed, 1 skipped, including the native save of all five files.

**Not verified:** spreadsheet import of the new files by ecologists, Windows.

## 2026-10-23 - Feature expansion E3: gates and three-layer counts

**Design:** schema v8 adds `gate` (current revision), append-only `gate_event` and append-only `count_event` (reviewer and QA layers, triggers refuse update and delete). Gates are drawn on the original preview frame in the window dialog (line, rectangle or polygon, source pixels, named A/B sides, entering direction, hysteresis band). Crossings are not stored: they are derived from stored tracks and one gate revision (`gate-hysteresis-v1`) with deterministic keys, so editing a gate recomputes them without decoding and makes earlier reviews history only. A point is confirmed on a side only outside the hysteresis band; a line crossing also needs the path to cross the drawn segment, so passing beyond its ends is not counted. Crossings in or after a window flagged `framewide_change` are shown but excluded from the algorithm count, because the camera may have moved since the gate was drawn. Segments with a different frame size are reported as not evaluated. The Counts page shows the algorithm, reviewer-adjusted (only reviewed or hand-added crossings) and QA-approved layers separately; a reason is required to reject, flip, change a count or add a missed crossing; QA must be a different normalised name and goes stale when reviews or the gate change. Every new backend error code got a fixed bridge message, since the bridge never forwards backend text.

**Verified (Linux):** backend 407 passed, 45 skipped, including both line directions, jitter inside the band, back-and-forth tracks, line ends, area entry and exit, degenerate gates, v7 -> v8 rollback, the three layers with audit, conflicts, same-actor refusal, QA staleness, gate edits and append-only triggers, and scene-change exclusion; 58 Node tests; Electron end-to-end 23 passed, 1 skipped, including a spec that draws a gate by clicking source pixels and reviews and QA-approves counts.

**Not verified:** counts on real emergences, dense or occluded scenes, gates on cameras that move slowly without a frame-wide change, Windows.

## 2026-10-23 - Feature expansion E2: tracks

**Spike decision:** OpenCV and Norfair were not added. Norfair 2.3.0 requires `numpy<2` (the repository pins 2.4.2) and its `filterpy` dependency is a 2018 source-only release; `opencv-python-headless` would ship a second FFmpeg build next to PyAV's. SciPy 1.18.1 (BSD-3-Clause, cp312 Linux and Windows wheels) gives connected components (`ndimage.label`) and optimal assignment (`optimize.linear_sum_assignment`) and is needed for audio filtering anyway. The first tracker version produced a second "ghost" track per target, because a plain consecutive difference also marks where the target was one frame earlier. It now uses a causal double difference (a pixel counts only when the current frame differs from both previous frames), recorded as `"difference": "causal-double"` in the hashed parameters (`tracks-v1`).

**Design:** schema v7 adds `tracking_run` and `track` (compressed `trk1` point records with SHA-256). Tracking is a separate contained run over a finished summary run (`track_worker`, 1 GiB, 600 CPU s, 900 s wall, shared activity lock), so summary evidence and its budget are untouched; sources are re-hashed and must equal the summary snapshot. Frames with a frame-wide change or more than 64 candidates are counted as gaps, never guessed. Each segment's tracks commit in one transaction. The Process page has a Tracks card, window cards show "n tracks (unverified)" and the window dialog lists the window's tracks and draws 2 s trails over the original preview up to the displayed source PTS.

**Verified (Linux):** backend 395 passed, 45 skipped, including two targets keeping one track each, a two-frame dropout not splitting a track, crossing paths keeping their directions, sensor noise giving no tracks, a frame-wide flash treated as a gap, a target leaving the frame, point integrity, v6 -> v7 rollback, changed-source refusal and a real worker run; 58 Node tests; Electron end-to-end 22 passed, 1 skipped, including a tracking spec. The frozen smoke script now also runs tracking but was not rerun in this step.

**Not verified:** ID retention on real bats, dense or occluded scenes, rain and insects near lights, real thermal footage, throughput on long full-HD recordings, Windows.

## 2026-10-23 - Feature expansion E1: rendered thermal modality

**Design:** schema v6 adds `segment.modality` (`active_ir` or `rendered_thermal`) and `modality_provenance`, declared in the Process page "Video type" select at import and never inferred. Existing segments are recorded as `active_ir` with provenance "recorded by the IR-only version". Summary evidence for thermal segments carries `rendered_thermal_display` and `palette_luma_not_temperature`, and the PNG footer, video rows, window cards and dialog show "Rendered thermal - no radiometric temperature analysis". Motion is still computed from display luminance; no temperature is derived. The five exact schema-5 checks became version tuples, and one explicit `/api/storage/upgrade` route (bridge `upgradeStorage`) runs all expansion steps after the QA schema, each in its own transaction, from the existing single "Upgrade storage" button.

**Verified (Linux):** backend 385 passed, 45 skipped, including white-hot, black-hot and false-colour moving-target fixtures, v5 -> v6 upgrade, idempotence and rollback, refusal of thermal import before the upgrade, refusal of an unknown modality and of a `.seq` radiometric file, and a thermal summary run carrying the flags; strict TypeScript; 58 Node tests; Electron end-to-end 21 passed, 1 skipped, including a new thermal spec.

**Not verified:** real thermal camera exports, palettes with HUD overlays (exclusion regions are not implemented yet), Windows.

## 2026-10-22 - Feature expansion research and owner scope decision

**Decision (project owner):** after using the beta, the owner supplied a research summary of three reference demos and asked for an implementation plan. All its P1 features are in scope as review aids: persistent tracks, counting lines and gates with directional counts, trajectory overlays, heatmaps, an activity timeline, highlight/block review (loop, 0.25x-2x, frame stepping, "no bat + next"), rendered thermal video and full-spectrum WAV synchronisation with spectrogram and retunable heterodyne. This supersedes the 2026-10-15 "thermal and acoustic out of v1" and "tracking after the pilot" decisions. The fixed 44/70 tracker is unchanged; the [feature expansion plan](../implementation/feature-expansion.md) has its own tracker (0/27).

**Research summary (owner-supplied, not independently re-run here):** the demos showed live entered/exited/net counters at a gate, detections around a directional line with an activity-per-second chart and a first-detection density heatmap, and a thermal-style review block with trajectories, exact frame position, playback speed, looping and a synchronised spectrogram with a heterodyne tuned to 48 kHz. The demo algorithms were not available; only visible behaviour is reproduced. The research maps these outputs to emergence-survey questions in the BCT 4th-edition guidelines (access points, numbers, timing, flight-lines, recorded and reviewed night-vision footage) and to CIEEM reporting expectations (methods, software, limitations and raw data/metadata). BCT's 2026 night vision aids guide is a paid resource; only its public description was used. Its proposed metrics (event recall >= 0.98 before hiding quiet intervals, precision about 0.80, sparse-scene count error <= 5%, review time reduced by >= 40%) are recorded as proposals only; the ecological owner must approve thresholds before acceptance testing. The research's downloadable files were not available to this session; the plan was written from the pasted text.

**Checked during planning:** Norfair 2.3.0 (latest, April 2025) is BSD-3-Clause but requires `numpy<2.0.0` and `rich<15`, conflicting with the pinned `numpy==2.4.2`; its dependency `filterpy` 1.4.5 is a 2018 source-only release that installs matplotlib. `opencv-python-headless` 5.0.0.93 is Apache-2.0 and bundles its own FFmpeg. The pinned PyAV 19.0.1 wheel decodes WAV (`pcm_s16le`, `pcm_s24le`, `pcm_s32le`, `pcm_f32le`). Ultralytics (AGPL-3.0) and BatDetect2 (CC BY-NC 4.0) are unsuitable without separate licences; HeatSeek is MIT but requires ultralytics and roboflow. Five exact schema-version-5 checks must become version tuples before v6. The tracking spike (E2) therefore compares OpenCV, `scipy.ndimage` and a small in-house association step before any dependency is added.

**Not verified:** no feature code was written; no tracker, gate, thermal or audio behaviour has run. Vendor and demo claims are not performance evidence.

## 2026-10-22 - Camera_Trap-style interface and one-step storage for new data

**Decision (project owner):** after a screen recording of the first installed beta, the owner asked for the Camera_Trap interface adapted to the bat workflow, with live output while processing, and WSP branding as in Camera_Trap. The recording showed why: one long engineering page, four separate "Upgrade ... storage" buttons on a fresh install (the review form stayed hidden until all were clicked), and a preview that needed a typed integer PTS before any decision could be saved.

**Design:** Tailwind and shadcn-style components, layout and theme adapted from Camera_Trap `176451c` (MIT, WSP; see `frontend/src/components/ui/NOTICE`). Hash-routed Surveys, Process, Review and Export pages; a window dialog with the motion summary, an automatically started original preview, the review form, collapsed QA and technical details (exact PTS, hashes, parameters). Native `<dialog>`, `<select>` and checkbox replace Radix to keep `style-src 'self'`. The bridge, API, evidence rules and preview receipt are unchanged. New data folders are created at schema v5 in one step; existing databases still need an explicit "Upgrade storage" click, which runs the missing transactional steps in order. Branding: Camera_Trap's WSP red theme only. The WSP logo file is not added to this public repository because publishing a trademark asset here is not cleared; a local, uncommitted build-time asset is possible if the owner wants it.

**Defects found by the rewritten end-to-end tests:** (1) saving a review or QA action while the automatic preview was encoding returned `review_busy`/`qa_busy`; saves now wait up to about 5 s for that lock (the same bounded wait already used for `preview_busy`) and then show the error. (2) The Review page QA line omitted unassessable windows, so its counts did not add up to the total. (3) The export card did not expose its region role. A media test reloaded before the UI had cleared a saved timeline draft; the test now waits for the saved state.

**Verified (Linux only):** backend 375 passed, 45 skipped (Windows-only), including a new-database and no-op-upgrade test; strict TypeScript; 58 Node tests (upgrade-path tests now start from an explicit v1 database); Electron end-to-end 20 passed, 1 skipped, with review/preview specs repeated three times without failure; the notice collector lists 11 bundled npm packages.

**Not verified:** the new interface on native Windows or in a rebuilt installer; usability with ecological reviewers; representative camera originals. No ecological performance is claimed.

## 2026-10-21 - Windows source identity timestamp correction

The frozen Windows smoke test exposed a false `changed_source` result on an unchanged synthetic MP4: Windows `stat().st_ctime_ns` reported creation time, while `fstat().st_ctime_ns` differed for the open handle. `_identity` now uses Python 3.12's stable `st_birthtime_ns` when available, retaining the existing `ctime_ns` storage key and POSIX behavior. The Windows regression test compares path and open-handle identities.

**Verified on Windows 11:** the regression test passed; all 19 `test_media.py` tests passed; a rebuilt frozen backend passed synthetic import, preview, both summary windows, provisional export coverage, and source-unchanged checks. This does not validate representative camera originals, ecological performance, installer distribution, or release approval.

## 2026-10-21 - Internal Windows beta: packaging and Windows worker containment

**Decision (project owner):** open the Windows media gates for an internal beta under Job Object limits, publish an unsigned pre-release, keep exports provisional and defer finalisation. Details and accepted risks are in [18 - Windows internal beta](18-windows-beta.md).

**Design:** one shared `backend/app/workers.py` (command resolution for source and frozen runs, request/response files, junction-aware link checks, reserve and directory-sync helpers). Linux subprocess paths are unchanged. Windows runs each worker through the existing `winjob.run`, and the worker verifies its own job limits (`winjob.enforced`). A single PyInstaller executable re-enters itself with `--worker <name>` for four whitelisted modules. Electron resolves the frozen backend and built UI from `process.resourcesPath` when packaged and keeps data in `%LOCALAPPDATA%`.

**Verified (Linux only):** backend 374 passed and 44 skipped; new worker tests including the Windows branch against a fake supervisor; strict TypeScript, 58 Node tests and the Electron end-to-end suite (20 passed, 1 skipped); a frozen Linux build passes the new end-to-end smoke test; an electron-builder Linux `dir` package ran with `app.isPackaged` true and stopped its frozen backend on close. The smoke test found missing package metadata in the frozen build (versions recorded with each summary run) and the spec now includes it. Old tests that asserted "Windows is refused" now assert "unsupported platform is refused".

**Not verified:** any native Windows execution, the frozen `.exe`, the installer, SmartScreen, the native picker and uninstall. The PowerShell build script and the workflow have not been executed. No ecological performance, real camera original or licence clearance is claimed.

**Changed files:** `backend/app/{workers,winjob,imports,preview,preview_worker,summary_jobs,summary_worker,summary_store,export_jobs,export_worker,contained_import,__main__}.py`, `backend/run_backend.py`, `backend/bat-backend.spec`, `electron/src/{main,backend,export_saver}.ts`, `electron/package.json`, `scripts/*`, `.github/workflows/build-windows.yml`, tests and docs.

## 2026-10-21 - PR 19 independent Linux review and corrections

Verified the requested remote head `f7e5b910594e7e47d105adb6c18620c1797b6691`. Before editing, reproduced worker error path disclosure and acceptance of contradictory PTS, a negative timebase and wrong metadata types. Reuse the existing read-only PyAV metadata contract and fixed error mapping, not another decoder or dependency. Review of Microsoft's CreateProcessW, Job Object limit/termination and WaitForSingleObject contracts also identified unchecked wait/exit results and nonfinite/overflowing limit inputs. Corrections are restricted to these boundaries, bounded JSON serialization and regression tests. Logical JSON limits do not cap worker scratch/disk use. The interval between suspended creation and job assignment is not covered by kill-on-job-close on abrupt owner death; this remains a native acceptance blocker, not a claim of complete containment.

Pre-code five-role check: vision requires exact internally consistent source PTS and unchanged read-only inspection; ecology requires no media or release acceptance claim; desktop QA requires cancellation/failure cleanup and explicit Linux skips for native tests; security/licensing requires fixed messages and fail-closed native API results without downloads; maintenance keeps the existing worker design, guard and seven-slice plan at 44/70. No upstream code is copied. Native Windows API tests cannot run on this Linux host; the final commands, counts, skips and cleanup evidence will be recorded on PR 19.

## 2026-10-21 - Issue 11 W4 disposable-worker process containment (disabled)

Native Windows 11 experiments showed a Job Object can contain synthetic Python worker trees. Added `winjob.py` (suspended start, verified limits and assignment, wall deadline, cancellation, kill-on-close) and `contained_import.py` (bounded request/response, strict validation, no path leakage) with text-only native tests. Windows import, preview, summary and export stay fail-closed; ordinary requests cannot reach the new code. Memory and CPU limits overshoot, disk and scratch capacity is not bounded, and no real media was decoded. The 44/70 plan count is unchanged.

## 2026-10-21 - PR #18 Windows import safety correction

**Review and design before code:** At reviewed `cde09db089c82ce74fda5438986836b73170e0a7`, removing the obsolete media-CLI startup gate makes unbounded import reachable on Windows. Reuse the existing preview/summary/export platform-guard pattern and sanitized API/desktop error mapping. Put `import_limits_unavailable` rejection first in `ImportJobs.start`, before selected-file validation, locks/job state or worker creation. Keep Linux import behavior and all other guards unchanged. No new abstraction, dependency, decoder, schema or upstream copied code.

**Five-role check:** Vision preserves the sole original-PTS decoder and Linux fixtures; ecology makes no media-readiness or release claim; desktop QA checks direct authenticated requests, picker error display and zero side effects; security/licensing requires a backend boundary and fixed redacted message, without installing binaries; maintenance adds one local guard and focused tests. Platform simulation tests run on Linux and cannot establish native Windows acceptance. The seven-slice plan stays byte-for-byte unchanged at 44/70, Slice 5 at 0/5 and Slice 6 at 0/7. Focused Linux execution: `python -m pytest backend/tests/test_import.py -q` passed 21 tests with one existing Starlette/AnyIO warning in 2.49s, exit 0; `npm run typecheck` passed, exit 0. The final complete-suite counts, corrected SHA, cleanup and draft/unmerged status are recorded on PR #18 after execution.

## 2026-10-20 - Issue 11 minimal startup readiness correction

**Base and scope:** `fix/issue-11-startup-readiness` from verified remote/local `main` at `6370bb0ac37cb03a7d5eeb1359354145c35d2242`. No dependency, lockfile, schema, workflow, media algorithm, resource guard or packaged-runtime change. No new slice; progress stays 44/70, Slice 5 0/5 and Slice 6 0/7.

**Audit/design/review:** Current production `media.py` imports PyAV; preview, summary and export subprocesses launch Python modules, not FFmpeg/ffprobe executables. Only `Settings`/`create_app` imposed the obsolete CLI gate. Electron repeated that advice and React claimed CLI availability. Existing FFmpeg commands in `media_fixtures.py`, `preview_fixtures.py`, `test_media.py` and `test_preview.py` remain untouched. Reuse existing authenticated health, storage initialization and bridge validation; no Camera_Trap source is copied. The five-role pre-code check preserves the sole source/PTS decoder (vision), avoids ecological/media readiness claims (ecology), exercises CLI-free persistence and rejection (desktop QA), retains redaction/token/SQLite/platform safeguards (security/licensing), and removes dead settings rather than adding a readiness framework (maintenance).

**Behavior:** Remove the PATH gate and dead settings/error mapping. Health returns only `status: ok` and `storage: ready`; the UI says `SQLite storage ready.` Startup import failures are not swallowed. Health is not an import/codec/worker capability inventory: dependencies loaded only by workers remain subject to their existing operation failures. Tests reject missing av/FastAPI/Pydantic/pydantic-core/Uvicorn, injected PyAV ImportError/OSError, invalid configuration, and unsupported/unversioned SQLite without file mutation. Empty-PATH health/session restart tests preserve token rejection and persistence.

**Executed on native Windows:** Windows 11 Enterprise x64 build 26200, existing project Conda Python 3.12.15, Node 24.19.0/npm 11.17.0, Electron 44.7.2. With `$Python = "$env:LOCALAPPDATA\miniforge3\envs\bat-innovation\python.exe"`, `& $Python -B -m pytest backend/tests/test_foundation.py -q`: **14 passed, 1 existing Starlette/AnyIO warning in 4.93s**, exit 0. `npm run typecheck`: passed, exit 0. `npm run build --workspace electron`: passed, exit 0. With `BAT_PYTHON` set to `$Python`, `node --test --test-name-pattern='real backend without media CLI' electron/tests/backend.test.cjs`: **1 passed, 0 failed/cancelled/skipped in 3063.515ms**, exit 0. `npm run build`: Vite/Electron passed, exit 0. An in-memory Playwright Electron probe launched the existing development shell without `--no-sandbox`, checked storage-only IPC/UI health and sandbox/contextIsolation/nodeIntegration settings, created a synthetic session, verified it after reload, closed the app and removed temporary data: passed, exit 0. No video was selected, opened or decoded and no media worker was launched. The existing Linux shell E2E now asserts the narrowed visible status, but was not run here.

**Final focused refinement:** Resolve a command-name Python interpreter to its absolute executable before clearing PATH in the Node regression. With the project environment prepended to PATH and `BAT_PYTHON=python`, `node --test --test-name-pattern='real backend without media CLI|invalid startup configuration|missing Python produces|incompatible SQLite databases' electron/tests/backend.test.cjs`: **14 passed, 0 failed/cancelled/skipped in 6257.8927ms**, exit 0. `git diff --check`: passed, exit 0. Editor diagnostics for the touched source/tests are clear.

**Outstanding verification:** `python -m pytest backend/tests -q`, `npm test` and `npm run test:e2e` are not run: no Linux host is attached, WSL is not installed and Docker is unavailable. Do not run these media suites on Windows as a substitute. TypeScript passed on Windows, not Linux. A WSL inventory command displayed an installation prompt; it was cancelled and returned an elevation-required diagnostic. No installation/elevation retry or download was performed. Linux full suites and independent review remain required before merge. The workflow is manual-only; no Actions invocation, packaging or binary distribution. Existing user Python is not the embedded CPython 3.14.8 candidate; W1 runtime/licensing/staging, media containment, offline packaging and ecological acceptance remain open.

## 2026-10-20 - Slice 4B1 post-review manifest and draft validation

Fetched PR #17 through reviewed `ce14b04097215fc82cee6b5dd2c07cdb203e6a1d`. Real Node export verifies the separate two-CSV disk manifest, three-entry authenticated transport envelope, CSV hashes/lengths and transport-only manifest SHA. Nine locally injected staged-manifest inconsistencies reject publication and remove stages/reservations/intents. The harness stays ignored; successful media/SQLite/download operations are real.

Initial Electron execution found 19 passed/1 failed, exit 1: the disabled Export UI became observable before passive dirty-state notifications reached main, so an immediate IPC export was accepted. The smallest correction uses existing React layout effects for summary-to-media propagation and media-to-main notification before paint, preserving API/data contracts. The existing real Electron export test now checks immediate rejection for first-review, QA and timeline drafts. See the [post-review report](17-slice-4b1-validation.md#post-review-local-validation) for the pre-code five-role check and exact commands. No backend, schema, dependency, lockfile, workflow or Windows-safeguard change.

Final local results: **281 Python passed, 1 existing warning in 68.66s; TypeScript passed; 55 Node passed in 11723.359662 ms; 20 Electron E2E passed in 2.6m; diff check passed**, all exits 0. Focused real Node regression 1 passed; expanded Electron export 1 passed; ad hoc nine-case rejection check 1 passed, all exits 0. Process sampling observed 273 backend/workers, zero remaining; final module scan is empty and owned Xvfb stopped. Exact final SHA and clean-tree status are recorded in the unmerged PR. No generated/client data, credential, database or scratch artifact is committed. No GitHub Actions, ecological finalisation or Windows packaging. Windows, physical picker/Excel, camera originals, ecological/template approval and binary redistribution remain unverified.

## 2026-10-20 - Slice 4B1 safe provisional CSV exports

**Scope/baseline:** [Issue #16](https://github.com/cameaci/Bat_Innovation/issues/16), new `codex/slice-4b1-provisional-exports` branch from latest `main` at independently reviewed Slice 4A merge `d9660c79dabec3740855e74ae99f5847620bab76`. One unmerged review candidate. No ecological finalisation/template or Windows work. [Validation report](17-slice-4b1-validation.md) records schemas, history retrieval, resource bounds and limits.

**Inspection/design:** Camera_Trap download helper at `176451c272628f4f8e38633db747cb427d587072` (blob `712f375e1dbdbbc54aac351b6efbb5833e8e0651`) is a pattern reference, not copied. Whole-Blob renderer downloads do not meet this contract. Reuse exact source plans, evidence validation and immutable histories with stdlib SQLite backup/csv/Fraction, Node streams and native dialogs. Five-role review precedes production edits. No dependencies, licence notices, schema, workflow or platform-safeguard changes.

**Decisions:** One read-only authoritative v5 snapshot supplies separate provisional observations and every-planned-window technical audit, plus a small manifest. Reconstructed missing windows remain explicit; invalid/extra coverage fails. Numeric PTS/rationals stay canonical, every text cell is reversibly apostrophe/backslash encoded and canonical row JSON preserves types. History endpoints carry immutable snapshot revision caps. Same-segment evidenced clock anchors are the only basis for survey UTC. Source/PNG checks are read-only, bracketed, and checked against live evidence/coverage versions before publication. WAL permits simultaneous human writes with old snapshot revisions retained; rollback journalling returns explicit busy/retry. The private copy alone uses DELETE mode to prevent snapshot sidecars in published output. Recorded unavailable QA now derives a stale flag without requiring an export-time epoch mutation.

**Publication/bounds:** One Linux worker and one delivery; 2,000 planned windows/64 sources; each CSV 50,000 rows, 8 MiB, 64 KiB per row; manifest 64 KiB; snapshot 64 MiB; worker 30s wall/32s supervision, 15s CPU, 1 GiB address space, 64 MiB per file and parent-death protection. Native main streaming verifies MIME/length/hash with backpressure and a 30s transfer deadline, saving fixed files in a fresh atomic bundle after an atomic durable recovery intent. Renderer passes IDs only. Dirty first/QA/timeline drafts block export. Cancel, failure, quit/restart and injected full-disk/rename failures retain no falsely successful partials.

**Final local results:** `python -m pytest backend/tests -q` using `/workspace/work/bat-venv/bin/python`: **281 passed, 1 existing warning in 51.39s**; `npm run typecheck`: **passed**; `BAT_PYTHON=/workspace/work/bat-venv/bin/python npm test`: **55 passed, 0 failed/cancelled/skipped/todo, 11568.101763 ms**; `DISPLAY=:99 BAT_PYTHON=/workspace/work/bat-venv/bin/python npm run test:e2e`: **20 passed in 2.2m**; `git diff --check`: **passed**. All exits **0**, Vite/Electron builds passed, no hosted CI. The final 240-window gallery recorded peak binary reads 1, peak Blob URLs 3, created/revoked 45/45 and zero retained after unmount. Staged audit: 28 intended text files, no generated/client data, databases, credentials, binaries, environment files or scratch logs. The PR records final SHA and clean-tree status and stays unmerged.

**Limits:** Synthetic Linux/Xvfb only; physical picker, Microsoft Excel execution, native Windows and packaging, representative originals, ownership/binary redistribution and ecological acceptance remain unverified. Local labels are attribution. Histories require retaining the authoritative DB/backup; exports are not a standalone full-database archive. Whole-database/row/byte caps explicitly reject larger cases. No full-volume/power-loss or peak-RSS benchmark; filesystem availability can change after the explicit checks. Approved ecological headers/mappings require a separate qualified-owner design gate.

## 2026-10-20 - Slice 4A independent second-review QA

**Scope/base:** [Issue #14](https://github.com/cameaci/Bat_Innovation/issues/14), `codex/slice-4a-second-review-qa` from latest `main` at independently reviewed Slice 3B squash merge `2f0332cdd1734691ee9ffb1be6fa275b2c8bb660`. One focused unmerged technical-review candidate. The [report](16-slice-4a-validation.md) records exact source blobs, semantics, local commands, evidence and limitations. No Slice 4B, ecological finalisation/export, Windows guard or packaging work.

**Inspect/design/review:** Directly inspected Camera_Trap audit model/progress hook/MIT licence at `176451c272628f4f8e38633db747cb427d587072`; pattern references only, no copied code or added dependency. Five-role pre-code review required exact original-source linkage, separate provisional QA, complete denominators, retained disagreement, bounded authenticated requests and draft/close protection. Reused the existing evidence epoch/fingerprint/preview validator, SQLite transaction discipline and typed ID-only Electron bridge rather than another worker/service.

**Decisions:** Explicit v4 -> v5 adds `qa_event` and `qa_window`. Confirmed human actions append separate agreement/disagreement/clarification, unassessable notes and retractions with UTC/actor, before/after values, immutable run/window/source/PTS binding and optimistic QA/first-review/evidence revisions. First records and images are never edited by QA. Suggestions cite the current observation UUID and last edit revision, retain its original span, and allow unknown counts. NFKC/whitespace/case-normalized identical first/QA labels reject; distinct labels do not prove different humans. Source/PNG invalidation or first-review edits make old QA stale; restoration does not silently revive agreement. All planned intervals remain in separate QA counts; no administrative state becomes ecological finalisation. Historical disagreement remains visibly marked after subsequent QA changes.

**Refinements and integrity evidence:** A duplicate sibling React key initially reset panel state while propagating dirty locks; distinct stage/window keys fix the cause. Both stages now lock the other editor and navigation, retain drafts through conflicts/backend loss and use native Keep editing/Discard on normal close/reload/quit. A v5 summary-start check now uses the existing supported-schema tuple. Sparse interior preview-limit failures remain enforced; short real sources isolate observation-reference tests. SQLite event replay, DDL/write rollback, UPDATE/DELETE/REPLACE protection, concurrent real HTTP/DB writers and a real SIGKILL between event/projection writes verify recovery. Original MTS/VFR PTS, weak-noisy early/middle/late evidence, exact suggestions, source/PNG restoration, independent runs and restart are covered without successful-media mocks.

**Final local results:** Activated the existing Python environment; `python -m pytest backend/tests -q`: **244 passed, 1 existing warning in 50.72s**; `npm run typecheck`: **passed**; `BAT_PYTHON=/workspace/work/bat-venv/bin/python npm test`: **45 passed, 0 failed/cancelled/skipped/todo, 11063.964245 ms**; `DISPLAY=:99 BAT_PYTHON=/workspace/work/bat-venv/bin/python npm run test:e2e`: **19 passed in 2.1m**; `git diff --check`: **passed**. All exits **0**. Vite/Electron builds passed; no GitHub Actions. Final v5 240-window/20-page evidence: 240 pending/zero agreed before explicit actions, peak binary reads **1**, peak Blob URLs **3**, created/revoked **45/45**, zero retained after unmount and zero reservation collisions. The owned Xvfb was stopped; no live backend/import/preview/summary process remained. Twenty-nine intended text files contain no generated/client media, database, environment file, credential, binary or scratch output. Dependencies, lockfile, workflows and Windows guards are unchanged. The PR records final SHA and clean-tree status and remains unmerged.

**Limits:** Synthetic Linux only. Labels are local attribution, not authenticated independent identities. No ecological finalisation/export or Slice 4B. Native Windows, representative camera originals, physical picker/confirmation, normal Chromium sandbox and binary redistribution remain unverified. Unsaved drafts cannot survive abrupt renderer/OS loss; a two-second receipt proves linkage, not whole-window human assessment. Terminal availability can lag 30 seconds. Sparse gallery bounds do not establish RSS, full-rate performance or ecological sensitivity; full-volume/power-loss and large-history benchmarks remain open.

## 2026-10-19 - Slice 3B practical manual-review gallery and source-time navigation

**Scope and baseline:** The user's Slice 3B request, new `codex/slice-3b-review-gallery` branch from latest `main` at `99656a3fa3b9d0bf85ee9a362bdace41b85db58e`, after independently reviewed Slice 3A and Windows feasibility PR #12. One focused unmerged review candidate. The [validation report](15-slice-3b-validation.md) records exact source hashes, local commands, bounds and remaining limitations. No backend API, schema, audit mutation, dependency, lockfile or Windows guard change; no Slice 4 work.

**Inspect/design/review:** Inspected Camera_Trap `176451c272628f4f8e38633db747cb427d587072` gallery, detail shell, shortcuts, progress hook and MIT licence. Reused interaction patterns only; no source is copied and existing publication/distribution gates remain open. Five-role pre-code review required all-window visibility, exact original PTS, mounted dirty drafts, authenticated bounded reads and minimal existing React/API composition.

**Decisions:** Twelve-card chronological pages and seven filters preserve the backend's full review denominator. Quiet, failed, incomplete and invalidated windows remain reachable. Navigation follows the saved run order, not cross-segment PTS or filenames. Scoped keys exclude interactive controls. Exact displayed-PTS helpers copy only a verified preview-frame-ledger receipt into a draft; they never save, infer frame duration or complete review. All PNG/WebM reads share one active transfer with 16 queued slots, preview priority and obsolete-read cancellation. Page/filter/unmount cleanup releases Blob URLs. Terminal runs refresh every visible 30 seconds and on explicit refresh/save/schema upgrade; active runs retain sequential one-second polling. Evidence reads/saves independently revalidate originals.

**Integration corrections:** Full validation exposed the review-storage upgrade no longer immediately refreshing finished-run progress after reducing polling; adding the existing `reviewEnabled` effect dependency fixes it. A paused VFR seek also showed Chromium can deliver its actual frame callback before `seeked`, then deliver no second callback. Dropping every callback while seeking therefore cleared a correct source label indefinitely. The fix retains only a verified ledger-mapped candidate until the seek settles; preview position may reject stale candidates, never derive source PTS. Exact bidirectional paused-seek assertions retain source-marker coverage and no implicit audit/save. The first full Electron run recorded 16 passed/1 failed, exit 1, before this correction; final results below supersede it. The sparse scale fixture's real interior `preview_limit` remains an asserted error; no process/seek guard is bypassed.

**Final local results:** With the existing Python environment activated, `python -m pytest backend/tests -q`: **201 passed, 1 existing warning in 27.46s**; `npm run typecheck`: **passed**; `BAT_PYTHON=/workspace/work/bat-venv/bin/python npm test`: **43 passed, 0 failed/cancelled/skipped/todo, 7704.824787 ms**; `DISPLAY=:99 BAT_PYTHON=/workspace/work/bat-venv/bin/python npm run test:e2e`: **17 passed in 1.7m**; `git diff --check`: **passed**. All exits **0**; Vite/Electron builds passed. No hosted CI was used. Final 240-window/20-page observation: peak binary reads **1**, peak Blob URLs **7**, created/revoked **74/74**, live after unmount **0**, reservation collisions **0**. The owned Xvfb process was stopped; no live backend/import/preview/summary module process remained. Twenty-one intended text files contain no generated media, database, environment file, credential, binary or scratch output. The PR records final SHA/clean-tree status and remains unmerged.

**Limits:** Synthetic Linux only; sparse gallery scale is not full-rate throughput, RSS or ecological validation. Theoretical retained media payload is at most 60 MiB/14 URLs, plus transient IPC copies/browser decode memory. A complete manifest remains bounded by current backend limits; finished-run availability may take 30 seconds to refresh. Windows execution, camera originals, physical picker, normal Chromium sandbox and binary redistribution remain unverified. Abrupt termination can lose unsaved memory-only drafts; two-second previews do not establish whole-window assessment. Multi-span observations, zoom/frame-step and Slice 4 QA/exports remain outside this increment.

## 2026-10-19 - Early Windows beta feasibility, Stage A only

**Scope and base:** [Issue #11](https://github.com/cameaci/Bat_Innovation/issues/11), new `codex/windows-beta-feasibility` branch from latest `main` at independently reviewed Slice 3A merge `b4fd13c4325475b413e2072eb539ce00d9a18579`. The [feasibility report](14-windows-beta-feasibility.md) contains the gated capability/code/evidence/native-procedure/owner/action matrix. Only Linux x86_64 is attached: **zero native Windows gates exercised**. Issue #11's stop condition applies; no Stage B package, installer, native acceptance or binary distribution is claimed. The PR records the final SHA and remains unmerged. No Slice 4 work.

**Decisions:** This is documentation and text artifact evidence only. Keep packaged-runtime rejection, loopback/token/IPC/CSP boundaries and preview/summary Linux-only limits unchanged. Import is a separate native full-decode thread with cooperative cancellation and remains an unproven safe-beta blocker. Windows Node termination cannot establish graceful backend/descendant cleanup. Additional blockers include POSIX reserve/publication APIs, junction/reparse confinement, default roaming app-data, native SQLite file locking and the Linux-specific acceptance harness. No WAL mode is configured; do not report WAL as implemented. The unused PATH ffmpeg/ffprobe startup prerequisite is a narrow future health/UI/readiness correction, not a reason to ship unnecessary CLI binaries.

**Source-first and platform evidence:** Inspected current Electron/backend/worker paths, the prior binary inventory, Camera_Trap `176451c272628f4f8e38633db747cb427d587072` main blob `8f6eb5df74d97ab694310f583c876366be9c27e5`, and official Electron/Node/Python/Microsoft/SQLite documentation. The candidate design uses real CPython modules outside ASAR and a fixed resource-root resolver; no reference code or new framework is copied. A Windows Job Object design must assign suspended children before native work, enforce CPU/committed-memory/process bounds and kill/reap owned trees. Hard scratch capacity remains separate; neither free-space polling nor job I/O throttling substitutes for it. The report specifies actual native fault/marker/locking/installer procedures without pretending they ran.

**Artifact evidence and licences:** Official CPython 3.12.14 is source-only, so it is not an available Windows runtime equivalent to local Linux. Standard-GIL CPython 3.14.8 x64 is an availability candidate only. [Artifact records](../implementation/windows-beta/artifacts.json) and [hash-pinned wheel inputs](../implementation/windows-beta/wheels-cp314-win_amd64.txt) freeze 16 official PyPI wheels for the six unchanged production pins. Downloaded bytes match published hashes; all 16 applicable Windows dependency edges were separately checked. Static PE/native-library and licence inspection identified PyAV FFmpeg/x264/x265 composition, NumPy numerical/GCC/Microsoft runtime terms, Pillow's composite notices and pydantic-core's native payload. CPython and Electron Windows ZIP hashes are publisher metadata only; neither ZIP was executed or byte-verified. Direct Python.org shell release-page access returned proxy 403; official research metadata was used without bypassing policy. No binary redistribution approval exists, especially for the PyAV codec composition. No wheel/EXE/DLL, installer or media is committed.

**Local verification of unchanged application:** Activated `/workspace/work/bat-venv/bin/activate`; `python -m pytest backend/tests -q`: **201 passed, 1 existing warning in 30.72s**; `npm run typecheck`: **passed**; `BAT_PYTHON=/workspace/work/bat-venv/bin/python npm test`: **32 passed, 0 failed/cancelled/skipped/todo, 8015.698546 ms**; `DISPLAY=:99 BAT_PYTHON=/workspace/work/bat-venv/bin/python npm run test:e2e`: **14 passed in 1.5m**; `git diff --check`: **passed**. All exits **0**. Vite/Electron builds passed; local Xvfb was stopped and zero live backend/import/preview/summary module processes remained. Existing Starlette/AnyIO and Playwright colour-environment warnings were retained. These are Linux regressions, not Windows acceptance. No GitHub Actions/hosted CI.

**Reproducibility check:** The report records both original cross-target acquisition and the executed frozen `pip download --require-hashes --no-deps` command with target options. The frozen command returned exactly 16 wheels, exit 0. Independent validation matched original/frozen bytes to official metadata, all 16 lock entries, six production pins, 16 Windows marker edges and Electron published checksum text, exit 0. Installed Linux dependencies, production requirements, npm lockfile, source/tests and workflows remain unchanged.

**Next gate:** Allocate native Windows lab machines and resolve codec/build/distribution policy first. Then make narrow reviewed changes for truthful startup prerequisites and bounded native inspection/process/storage handling, prove the fixed offline runtime and real source-time operations, and validate clean install/update/uninstall with preserved originals/SQLite. Keep media disabled where limits are unavailable. Approve notices/source-compliance material and a private delivery channel before offering a usable beta. Native Windows, representative camera originals, physical picker/sandbox, signed trust, full-survey and ecological acceptance all remain open.

## 2026-10-19 - Slice 3A explicit first review and provisional observation audit

**Scope and baseline:** [Issue #9](https://github.com/cameaci/Bat_Innovation/issues/9), new branch `codex/slice-3a-manual-review` from latest `main` at independently reviewed Slice 2A merge `2e091358fb1a169c9c7e34f9ce5a5dd89dd0f5f2`. One focused PR, left unmerged. Its validation entry records the immutable final HEAD for this source/test/log tree. No Slice 4, second-review QA, ecological conclusion, classifier, export or cloud work.

**Inspect and review before coding:** Camera_Trap was read at `176451c272628f4f8e38633db747cb427d587072`, including its detail shell, labels-progress hook, count editor, observation/audit models and SQLite base. Exact blobs and MIT/WSP/Peter van Lunteren notices are in the [Slice 3A report](13-slice-3a-validation.md#source-first-design). Navigation, denominator and audit concepts are patterns only; no code was copied. Count-zero hiding, AI/human count merging and cascading observation deletion were rejected. No dependency or lockfile change. The five-role challenge required original PTS, explicitly provisional unknown counts, all-window progress, atomic immutable history, draft/close conflicts and narrow bounded requests using the existing list/player.

**Decisions:** Explicit transactional schema 3 -> 4 adds `review_event` and `review_window`; SQLite JSON columns are bounded values within the one database. Each attributed observation create/edit/delete or review action appends an event delta and changes its projection under one optimistic-revision transaction. Triggers reject UPDATE, DELETE and conflicting INSERT OR REPLACE. Unknown count stays null. Spans use exact integer source PTS and Fraction bounds inside one selected window/segment; unknown final extent is never invented. Saving an observation resets completion; quiet/viewed/navigated windows remain unreviewed. A non-empty valid original-preview receipt is required for an explicit completed decision, while unable-to-assess remains unresolved. All planned windows, including failed/incomplete, remain in run-specific progress; reruns do not inherit decisions.

**Invalidation and drafts:** Historical decisions/events remain untouched when source, image or immutable metadata no longer match; effective progress becomes unreviewed with a conspicuous warning. Separate durable evidence epochs latch invalid/restored transitions, so restoring identical PNG bytes or metadata cannot silently revive an old reviewed state. Fresh evidence and a new explicit action are required. Epochs never erase historical terminal processing errors or human revisions. Bounded ID-only token-authenticated routes and IPC preserve private paths. Dirty drafts block destructive navigation, refresh and processing controls; polling/conflicts/backend errors retain actor, PTS and notes. Native close/reload/quit requires Keep editing or Discard draft, and backend shutdown occurs only after actual close.

**Exact final local commands and results:** With the existing Python venv activated, `python -m pytest backend/tests -q`: **201 passed, 1 existing warning in 26.86s**; `npm run typecheck`: **passed**; `BAT_PYTHON=/workspace/work/bat-venv/bin/python npm test`: **32 passed, 0 failed/cancelled/skipped, 7378.728209 ms**; `DISPLAY=:99 BAT_PYTHON=/workspace/work/bat-venv/bin/python npm run test:e2e`: **14 passed in 1.5m**; `git diff --check`: **passed**. All exits **0**. Vite/Electron builds passed within npm tests. Xvfb provided a local display and was stopped afterwards. No GitHub Actions or hosted CI was used. Existing Python deprecation and Playwright colour-environment warnings remain visible. The report records versions and the repeated full E2E run used to retain an exact exit after session resumption.

**Audit-integrity evidence:** 37 store cases and 20 real review API cases cover migration rollback, event replay after reopen, atomic rollback of event/projection, one winner/one conflict under concurrent revisions, exact nonzero/VFR/window-end bounds, zero/one/many observations, unknown counts, edit/delete history, preview receipt mismatches, missing/changed originals, image/metadata restoration, run isolation and failed/incomplete denominators. Three new Node cases preserve authentication/payload limits and restart history. Three real Electron scenarios verify source-loaded explicit decisions, re-review after restoration, reopening, stale draft retention, native Keep editing and an actual SIGSTOP/SIGKILL backend interruption during Save. Media decoding, successful API operations and SQLite persistence are real; only native dialog results and negative OS conditions are substituted. Source SHA checks remain unchanged.

**Tracked-file and cleanup audit:** 29 intended text source/test/documentation files; no footage, extracted images, credentials, environment files, local databases, generated outputs or `work/` contents staged. No dependency/lockfile or workflow changes. Post-suite inspection found **zero live backend/import/preview/summary module processes**. The PR records final commit and clean-tree status after publication; independent review is required before merge.

**Limits:** Synthetic Linux development only. Windows execution/resource enforcement, representative camera-original AVCHD, physical picker interaction, Chromium OS sandbox and binary redistribution/packaging remain unverified. Saved history is restart-safe; unsaved in-memory drafts cannot survive abrupt renderer/OS termination. Reviewer labels are local attribution, not authenticated identities; database-owner tampering is outside application audit guarantees. One span per observation is limited to its selected window/segment; multi-span/gallery/keyboard refinements remain Slice 3B. Source speed/rotation/interlace fidelity, large-history/full-survey polling latency and ecological sensitivity remain unverified. Two-second preview availability does not establish that a human assessed the full interval. Original processing limits and physical-power-loss/full-volume test limits remain. No ecological or Windows production-readiness claim is made.

## 2026-10-16 - Slice 2A exact coverage ledger and first motion evidence

**Scope:** [Issue #7](https://github.com/cameaci/Bat_Innovation/issues/7), from latest `main` at independently reviewed Slice 1B merge `bdd52222b0763cebb843f4cc7f8625b0a260828c`. One focused review candidate, left unmerged. No Slice 3, classifier, ecological decision, export or cloud work.

**Pre-code decision and evidence:** Camera_Trap thumbnail/frame-index workflows were inspected at immutable commit `176451c272628f4f8e38633db747cb427d587072` and reused as patterns only; no code was copied. The five-role review required exact Fraction coverage, visible quiet/failed intervals, Linux hard limits, private image IDs and preserved weak evidence before pooling. NumPy 2.4.2 and Pillow 12.1.1 replace slow bespoke pixel loops/custom PNG/text code; exact installed-wheel hashes, upstream/bundled licences and remaining redistribution questions are in the [reuse map](../implementation/reuse.md#slice-2a-inspection-and-decision) and [technical report](12-slice-2a-validation.md).

**Coverage and method:** Metadata-only 7200 seconds yields 240 intervals; real 65/9-second fixtures yield 30/30/5 and one 9-second window. Every decoded original PTS has one owner. Unknown final duration leaves an open incomplete tail with no invented endpoint, image or colour statistics. Declared-duration gaps are clipped into every affected window, including empty ones; VFR spacing alone is not missing-imagery evidence. Complete requires every planned output. Source SHA256 and clock/continuity provenance stay separate and unchanged.

Consecutive and fixed-reference differences were compared on the same real decoded MP4 fixtures. Both retain 4/4 pixels of weak one-frame 2x2 targets in all source-time thirds, also with noise. Consecutive differencing was selected for lower persistent brightness/scene-shift activation: 6144 versus 73728 and 3173 versus 38076 active frame-pixels. Codec noise is retained (2879 active frame-pixels on the noise-only fixture), not hidden with a threshold that erases weak targets. Tests inspect saved PNG pixels, nine-second partial-window colours and full-HD pooling. These are technical visibility checks, not ecological sensitivity.

**Durability and review corrections:** Explicit transactional schema 2 -> 3 adds immutable run parameters/source snapshots and unique window records. Atomic PNG publication, checksums, restart recovery and durable cancellation/failure retain all coverage. Import, preview and summary share one reservation, released after reaping/cleanup. An 8 MiB allocated metadata reserve supports terminal records after an image-write ENOSPC. Tests cover thread-start cleanup including secondary rollback failure, actual parent death/kill/timeout/cancel, original/image invalidation and new-run retry. A missing original at start still leaves a failed plan; independent healthy segments remain unprocessed rather than being falsely labelled missing. Both Electron CSPs allow bounded Blob images while renderer connections remain blocked. No background reset, mask or insect suppression was added.

**Final local validation:** `python -m pytest backend/tests -q`: **139 passed, 1 existing warning in 19.65s**; `npm run typecheck`: **passed**; `npm test`: **29 passed**; `npm run test:e2e`: **11 passed in 1.0m**; `git diff --check`: **passed**. All exits 0. Builds passed within the npm commands. All testing was local; no GitHub Actions. The [technical report](12-slice-2a-validation.md) contains exact versions, commands, measurements, bounds and fixture provenance. The actual limited full-HD five-frame worker retained all phases at an observed 91304 KiB peak RSS; this is not a long-survey performance benchmark.

**Limits:** Synthetic Linux development only. Windows/resource enforcement, representative camera-original AVCHD, physical picker operation, Chromium OS sandbox, ecological acceptance and binary redistribution/packaging remain unverified. ENOSPC was injected at a real worker image write, not by filling a mounted filesystem; physical power-loss and large-history/full-survey performance were not tested. Windows processing fails closed. No client data, generated media, images, databases, credentials or environment files are included. Independent review remains required before merge.

## 2026-10-16 - Slice 1B bounded original-source preview and seek

**Scope and baseline:** [Issue #5](https://github.com/cameaci/Bat_Innovation/issues/5), starting from independently reviewed Slice 1A merge `a6fe013f4e95fa56e91c8179e609720dd48b2a8b`. One source-only preview candidate is proposed for independent review, not merged. No Slice 2, motion detection, models, whole-recording conversion, hosting or ecological interpretation was started. No dependency, lockfile or database schema change was needed.

**Source-first inspection and review before implementation:** Inspected Camera_Trap commit `176451c272628f4f8e38633db747cb427d587072`: [VideoPlayer](https://github.com/cameaci/Camera_Trap/blob/176451c272628f4f8e38633db747cb427d587072/frontend/src/components/verify/VideoPlayer.tsx), blob `d8608015dfe81d6740572761cac1ac30a6d92e12`, and [filmstrip service](https://github.com/cameaci/Camera_Trap/blob/176451c272628f4f8e38633db747cb427d587072/backend/app/services/filmstrip_service.py), blob `9a2b79234b06cd3914d41f4c3f84adef6d54752e`. Their nominal-FPS timing, extra dependencies and cache/fallback behavior do not fit this source-PTS contract. Reused standard player/lifecycle patterns only; no Camera_Trap code was copied, so no new publication-right assumption or copied-code notice is introduced. Checked PyAV 19.0.1 [seek](https://github.com/PyAV-Org/PyAV/blob/v19.0.1/av/container/input.py), codec/output timebase rebasing, FFmpeg 7.1.5 timestamp/protocol/trim documentation and Electron 44 media boundaries. Bat-vision, ecological, desktop/QA, security/licensing and maintenance review required exact frame selection, separate clock provenance, bounded isolated processing, source revalidation and explicit errors before coding.

**Required pre-code playback proof:** Generated visible integer source-PTS/timebase labels and eight-bit marker bars in temporary H.264 CFR MP4, MPEG-2 MPEG-TS `.mts`, irregular H.264 MP4, short MP4 and 3.2-second GOP10 MP4. MTS starts at PTS `129600`, timebase `1/90000`, source time `36/25` seconds; it is not survey-clock time. Electron 44.7.2 / Chromium 152.0.7977.149 native playback loaded four of five originals and matched 11 of 12 checked markers. MPEG-2 MTS failed with `MEDIA_ERR_SRC_NOT_SUPPORTED`; native irregular-MP4 seeking to `.16` seconds displayed marker 3 at `.12`, instead of marker 4 at `.16`. Native playback therefore failed this gate.

Compared bounded external FFmpeg trim/setpts/VP9 clips with PyAV/FFmpeg-library VP9 clips. Each candidate displayed all **59 checked markers across 14 clips** correctly, but default CLI packet durations lost the final-frame display duration, including infinite browser duration for a single-frame clip. The selected PyAV candidate explicitly preserves interior intervals from consecutive decoded PTS and the known final EOF duration. Copying the source's potentially overlapping interior `frame.duration` values reproduced the irregular-frame seek error in the spike; no FPS estimate is used. All selected-candidate browser durations and original SHA256 checks passed, including actual Blob playback. The long-source target PTS `32768` (non-keyframe marker 64 at `2.56` seconds) decoded from PTS `5120` (`.4` seconds, after the source beginning), proving a successful noninitial keyframe seek. Uniform two-second pre-roll also avoids missing an MTS keyframe whose DTS precedes its PTS. There is no fallback scan from zero.

The isolated proof command was `DISPLAY=:100 /workspace/work/bat-venv/bin/python work/slice1b-spike/proof.py`, with `/workspace/work/xvfb/usr/bin/Xvfb :100 -screen 0 1280x800x24 -nolisten tcp`. Scratch scripts/results remain ignored under `work/`; binary inputs existed only in temporary directories. Committed marker generators and application tests below repeat the selected path against the real backend and Electron.

**Implemented contract:** React supplies an imported `segment_id` and signed-64-bit integer source PTS only. The backend seeks backward with pre-roll and decodes forward using the existing authoritative PyAV frame/PTS path. A between-frame request selects the first decoded PTS at or after it and returns an exact rational seek delta; requests before the first or after the last decoded PTS fail. The derived silent VP9/WebM clip carries exact source start/last/end, segment-elapsed bounds, imported SHA256 and a bounded per-frame mapping to millisecond display timestamps. Quantisation is at most 0.5 ms per frame; collapsed display intervals are rejected. Unknown final duration blocks previews rather than inventing a source end.

An isolated Python worker uses the existing PyAV FFmpeg encoder, without a second original decode algorithm or new executable dependency. Limits are **2 seconds, 8 MiB, 300 encoded frames, 1000 decoded frames including pre-roll, 10 seconds maximum decoded pre-roll, one decoder/encoder thread, input dimensions at most 4096x2160, output at most 960x540, 1 GiB address space, 20 seconds CPU and 25 seconds wall time**. Linux hard limits and a parent-death kill guard fail closed on unsupported platforms. Imports and previews share one atomic reservation. Only one clip is retained in managed application data outside the repository; partials and completed outputs are removed on failure/cancellation, replacement, startup and shutdown. Job records are bounded and ephemeral, not another durable queue.

Status and content validate source identity/readability; worker descriptor/path checks bracket generation. This compares stored device/inode/size/mtime/ctime and does not claim a full source rehash on every opening. Content is read with a byte cap, checked again before delivery, and served only after successful completion. Electron holds the launch token, permits fixed ID-based routes and at most one capped binary transfer, and sends bytes through narrow IPC. React creates/revokes a Blob URL; CSP permits `media-src blob:` while keeping `connect-src 'none'`. No source path, backend URL, token or generic fetch function crosses the bridge. Displayed-frame labels come from `requestVideoFrameCallback` and the exact mapping, not browser time multiplied by FPS. New/error/cancel/close/unmount states detach old content and generation IDs reject stale completions. Ready status rechecks originals every second; a failed check clears the player. Continuity remains visible, segments are not joined, and any saved original-clock anchor is separately attributed rather than propagated across segments.

**Integration refinements:** Review found and tests fixed terminal import status preceding shared-reservation release, and failed thread startup leaving a permanent running import. A real unprivileged permission E2E also exposed `ctime` changes masking unreadability as a changed source; read-access failure now takes precedence, with regression coverage. No successful media operation or backend response was mocked. Decoder-unavailable, unknown-duration and unseekable conditions use explicit negative fault injection where needed; only the OS dialog return is substituted on the successful native import path.

**Final local validation:** Debian 13 Linux x64, Python 3.12.14, PyAV 19.0.1, host FFmpeg/ffprobe 7.1.5, Node 24.19.0/npm 11.9.0, TypeScript 5.9.3, Vite 7.3.7, Electron 44.7.2 and Playwright 1.64.1. Activated `/workspace/work/bat-venv/bin/activate`, exported `BAT_PYTHON=/workspace/work/bat-venv/bin/python` and `DISPLAY=:99`, and ran a local Xvfb display. All required commands exited 0; no GitHub Actions or hosted CI was invoked.

| Exact command from repository root | Observed result |
| --- | --- |
| `python -m pytest backend/tests -q` | **76 passed, 1 warning in 8.74s** |
| `npm run typecheck` | React, Electron and test TypeScript passed |
| `npm test` | Vite build and Electron `tsc` passed; **21 Node checks passed**, 0 failed/cancelled/skipped/todo, 2807.577951ms |
| `npm run test:e2e` | Vite built 32 modules; Electron `tsc` passed; **9 Electron tests passed (50.8s)** |
| `git diff --check` | Passed |

Tests cover first/middle/last markers and explicit end rejection for all five generated sources, VFR gap selection and browser seeking, real 30000/1001 timing with nonzero millisecond quantisation despite deliberately incorrect nominal rates, source immutability and session reopening. Negative tests cover missing/unreadable/changed/corrupt sources, unavailable decoder, unseekable input and unknown final duration. Actual Linux CPU/memory/file enforcement is exercised with smaller inherited hard limits; real workers are stopped/cancelled/timed out, reaped and cleaned. Both import/preview reservation directions are tested. Electron exercises native selection -> persisted ID -> real preview -> browser pixels, permission/unknown-end errors, running cancellation and shutdown with a stopped real preview worker. The real permission E2E passed as an unprivileged Linux user; root-safe injection remains covered in Python. Node tests reject token/path/PTS misuse, oversized binary bodies and concurrent transfers. Existing Starlette/AnyIO deprecation and Playwright colour-environment warnings remain visible. Post-suite inspection found **zero** backend or preview-worker processes. The 26-file text-only audit found no forbidden tracked/unignored artifacts or credential patterns; dependency pins, lockfiles and the manual-only workflow are unchanged.

**Limits and open gates:** This is synthetic Linux development acceptance and an unmerged review candidate. Windows preview resource enforcement is not implemented: Windows currently returns `preview_limits_unavailable`; no Windows runtime, native Windows picker or installer pass is claimed. Representative Canon XA, Sony AX53, Nightfox and other camera-original AVCHD compatibility remain unverified. Physical OS picker interaction and Chromium's OS sandbox remain unverified; Linux automation uses `/proc`, `ps`, Xvfb and test-only `--no-sandbox`. Display pixels use yuv420p colour conversion and may be resized; rotation is not applied and interlaced frames are not deinterlaced, with visible warnings. Original-speed provenance and field order remain unknown where unavailable. Not every negative condition is repeated as a separate Electron UI case; unavailable-decoder/unseekable/corrupt boundaries are covered in Python. PyAV/FFmpeg wheel and binary redistribution remains uncleared, including the previously recorded codec-composition concerns. No binaries, client media, screenshots, credentials, databases or generated outputs are included, and no ecological performance or production-readiness claim is made.

---

## 2026-10-16 - PR #4 full local validation after review corrections

**Source and scope:** Fetched `codex/slice-1-media-import` and fast-forwarded to `574c340d92696bf387333d89f44cae164fdcaeef`. Read the PR review and subsequent corrections before testing. Read-only backend and frontend reviews found no further blocking defect. All four required suites passed on that exact application/test tree, so no implementation changes or dependencies were needed. This entry supersedes the pending full-suite recheck recorded below; earlier results remain historical.

**Environment:** Debian 13 Linux x64, Python 3.12.14, PyAV 19.0.1, host FFmpeg/ffprobe 7.1.5, Node 24.19.0/npm 11.9.0, TypeScript 5.9.3, Vite 7.3.7, Electron 44.7.2 and Playwright 1.64.1. Used the existing pinned requirements and npm lockfile. Activated `/workspace/work/bat-venv/bin/activate`; set `BAT_PYTHON=/workspace/work/bat-venv/bin/python` and `DISPLAY=:99`, with a local Xvfb display for Electron. No GitHub Actions or hosted CI was invoked; the existing workflow remains manual-only.

| Exact command from repository root | Observed result |
| --- | --- |
| `python -m pytest backend/tests -q` | **37 passed, 1 warning in 2.73s**; exit 0 |
| `npm run typecheck` | React, Electron and test TypeScript passed; exit 0 |
| `npm test` | Vite build and Electron `tsc` passed; **16 Node tests passed**, 0 failed/cancelled/skipped/todo, 2203.100904ms; exit 0 |
| `npm run test:e2e` | Vite build (31 modules) and Electron `tsc` passed; **5 Electron tests passed (11.3s)**; exit 0 |
| `git diff --check` | Passed |

**Review regressions exercised:** Real PyAV frames still match paired FFmpeg pixels and exact rational original PTS on generated CFR MP4, nonzero-origin MTS and irregular MP4. A real decoded short recording with only its final-frame duration replaced by `None` retains the last PTS and leaves the end unknown. Tests cover explicit SQLite migration/rollback, cross-session duplicate-source rejection and global SQLite uniqueness, missing versus unreadable originals, and unsaved reorder/clock edits blocking refresh/import/navigation until save or explicit discard. Permission errors and unavailable duration are deliberately injected negative conditions, not successful media responses.

Electron tests exercise native-selection IPC -> real authenticated backend -> PyAV -> SQLite -> React, reopen persistence, explicit import failure, token rejection/backend loss, startup failure and shutdown. Only the native OS dialog return is substituted in automation; no successful backend/media/API result is mocked. Post-suite process inspection found **zero** running `python -m backend.app` processes. The Python warning is the existing Starlette/AnyIO deprecation; Playwright reports inherited `NO_COLOR`/`FORCE_COLOR` settings. Neither warning was suppressed.

**Repository audit:** All 22 PR files are source, tests, pinned requirements, relevant documentation or the existing manual workflow. No media, screenshots, databases, credentials, environment files, generated outputs or binaries are tracked. Local command logs and generated build/test outputs remain ignored. This follow-up changes documentation only; no application rewrite, new dependency, Slice 1B or issue #5 work was started. PR #4 remains unmerged for independent review.

**Remaining limits:** Windows execution, native Windows picker, representative camera-original/AVCHD compatibility, production packaging and PyAV/FFmpeg binary redistribution remain unverified. Linux automation uses `/proc`, `ps`, Xvfb and test-only `--no-sandbox`; physical file-picker interaction and Chromium's OS sandbox are not validated. Synthetic media does not establish camera compatibility or ecological performance. Original-speed provenance and field order remain unknown where unavailable; no playback/seek capability is claimed. The wheel licensing/composition concerns below remain open.

---

## 2026-10-15 - Independent local tests with no GitHub Actions quota

**Background:** The GitHub Actions quota was reported exhausted, so the temporary Slice 1 checks workflow was changed from push/PR triggers to manual `workflow_dispatch` only. No further hosted CI is required for this independent recheck.

**Exact source matching:** Retrieved the current PR `backend/app/store.py` and `backend/tests/media_fixtures.py` through the GitHub connector, reproduced them in an isolated local directory, and verified exact Git blob SHA matches: `7e9ca29a2b508515c87a0dc6b9d6ff615a3a206c` and `0f815e91ca19ecd4e29944a3b6a84fca99baeee1`. The dependency-free `source_state` / `identity_info` function bodies were also compared with GitHub text fingerprints before extraction-based tests.

**Executed locally:** Python 3.13.5, FFmpeg 7.1.5, stdlib SQLite. `python -m pytest tests -q` on a separate, synthetic-only validation harness: **24 passed in 0.68s**. Coverage was (a) 13 real store tests for schema upgrade, rollback, cross-session duplicate identity/path/hash, transaction atomicity and timeline/clock provenance; (b) 7 real filesystem error classifications through exact extracted functions; and (c) 4 FFprobe tests with repository-exact generated MP4/MTS fixtures validating source PTS and irregular intervals.

**Boundary:** This was **not** a full run of `python -m pytest backend/tests -q`. The available local environment has no PyAV 19.0.1 and no network access to install it. Electron, React, Playwright and Vite dependencies are also absent, so full TypeScript, Node and Electron suites were not independently rerun. The earlier GitHub CI failure had six import test failures due to one stale SQLite binding; that binding was corrected in `1a864547...`. No post-fix full PyAV/import test result is claimed.

**Decision:** Keep PR #4 unmerged until the full PyAV import and Electron integration suites can be exercised in an environment with their exact dependencies. Do not silently treat the 24 focused tests as a replacement for the required acceptance gate. Original camera media, Windows, the Chromium OS sandbox, and PyAV/FFmpeg wheel redistribution also remain unverified.

---

## 2026-10-15 - PR #4 independent review and focused corrections

**Status:** Source-level refinements committed on the open Slice 1A PR branch; **not merged**. This entry records code changes, not new passing full-suite test results.

**Finding 1, source attribution:** The initial schema prevented duplicate checksums only within one session. Since the current domain model binds each original to one camera recording session, the first v2 schema now enforces global unique source path, SHA256 and stored filesystem identity, alongside per-session sequence uniqueness. The insert operation compares prior sources across all sessions, keeping session-specific position calculation. Added a test for identical originals across two sessions (same pathname and copied bytes), for a truly distinct recording, and for DB-level uniqueness.

**Finding 2, missing versus unreadable:** Existing media inventory previously converted read/metadata access failures into missing files. It now returns a distinct \`unreadable_source\` classification, checks a one-byte read of otherwise unchanged originals, and presents an actionable UI notice without revealing source paths. The regression test uses explicit permission/error injection independent of root-user chmod behavior.

**Finding 3, unsaved provenance edits:** Reordering, clock-anchor edits and continuity changes now block Refresh, adding another source and parent session navigation until saved or explicitly discarded. A small explicit Discard button restores the last saved media inventory. Electron UI regression steps test navigation-blocking, unchanged SQLite before save, explicit discard and saved clock provenance remaining unchanged.

**Verification:** Re-fetched current PR source through GitHub and checked 15 key source-to-test invariants; all 15 present. **Full tests have not been rerun for these new commits.** The available independent container does not have PyAV or the project's npm/Electron dependencies, and the current source cannot be claimed validated by Codex's original (pre-fix) 34 Python / 16 Node / 5 Electron results. Test execution in the Codex environment is required before merge.

**Next:** On the same PR branch, run \`python -m pytest backend/tests -q\`, \`npm run typecheck\`, \`npm test\` and \`npm run test:e2e\`; resolve any failing test without changing the agreed architecture. Keep Windows, original-camera AVCHD and FFmpeg/PyAV wheel redistribution gates separate and open.

---

## 2026-10-15 - Slice 1A native media import and decoded-PTS gate

**Scope and baseline:** Implemented [issue #3](https://github.com/cameaci/Bat_Innovation/issues/3) from merged Slice 0 `main` at `d8e8d2f`. This adds original-file identity, exact timestamp inspection and ordered per-camera segments. Playback/seek, preview/transcoding, summaries, motion detection, tracking, AI and reporting remain excluded.

**Decoder decision before UI:** Compared system FFmpeg 7.1.5 against PyAV 19.0.1 using generated H.264 CFR MP4, MPEG-2 transport stream with `.mts` suffix and genuinely irregular H.264 MP4. One FFmpeg invocation paired `showinfo` integer PTS/timebase with raw decoded YUV output using `-copyts` and passthrough timing; no ffprobe frame list or frame-count/FPS mapping was used. All 22 decoded pixel planes and exact rational source times matched PyAV, and original SHA256 values stayed unchanged. Choose **PyAV as the sole production pixel/PTS decoder**: it returns pixels, integer PTS and rational timebase together, avoiding CLI log parsing and separately drained raw-data/metadata pipes. No NumPy or second decode pipeline was added. Full source timestamps remain in the unchanged original; SQLite stores exact first/last/end boundaries, rates and source identity, not a large in-memory/per-frame manifest.

| Generated fixture | Source PTS and timebase | Verified source/elapsed boundaries |
| --- | --- | --- |
| CFR MP4, 8 frames | `0,512,...,3584` at `1/12800` | source `0..7/25` s; final-frame duration `1/25`, decoded elapsed end `8/25` s |
| MPEG-TS `.mts`, 8 frames | `129600,133200,...,154800` at `1/90000` | source `36/25..43/25` s; elapsed starts at zero, decoded elapsed end `8/25` s; 1.44 s is a stream origin, never a survey clock |
| Irregular MP4, 6 frames | `0,512,1536,2048,2560,3584` at `1/12800` | source `0,1/25,3/25,4/25,5/25,7/25` s; average rate `75/4` and base rate `25` cannot replace these timestamps |
| Short final MP4, 3 frames | `0,512,1024` at `1/12800` | last frame starts at `2/25` s; final end `3/25` s |

The spike's one-run decode observations were 2-5 ms for PyAV versus 78-93 ms for CLI launch+decode, only on tiny fixtures; these are not performance benchmarks. **Technical import/PTS gate: GO.** Representative Canon XA, Sony AX53 and Nightfox originals and Windows execution remain unverified. No preview/seek gate is passed by this work.

**Review and implementation:** Five-role review required original PTS and pixels from the same decoder, no inferred continuity/clock, strict ID-only IPC, atomic persistence and a minimal worker. Electron's native picker accepts only a session ID from React, owns the selected paths and sends them to a fixed token-authenticated backend endpoint. React receives public metadata and opaque IDs only. Exact argument/field checks reject path injection. Source paths and filesystem identity stay private; raw decoder and validation input text do not cross the boundary. Native-dialog failures return a fixed actionable message without forwarding private exception text. Camera_Trap's verified native-dialog/lifecycle and persistence discipline were used as patterns only; no source code was copied.

MP4/MPEG-TS demuxers are selected before probing, with local protocol whitelists and MOV external references disabled; a disguised HLS fixture makes zero network requests. Files are opened read-only. SHA256 reads 1 MiB chunks, decode streams one frame at a time, and both expose progress/cancellation. Source descriptor/path identity is checked before and after hashing/decoding and again across the complete batch. Missing, changed, corrupt/truncated, unavailable-codec and unknown/nonmonotonic-timing cases fail explicitly. Reported duration, decoded last-frame start and source end are distinct; unavailable final-frame duration yields unknown end rather than a guessed FPS interval. Interlaced-frame presence is inspected; field order remains explicitly unknown where PyAV does not expose it.

Existing schema 1 databases stay schema 1 on startup. **Upgrade media storage** is the explicit UI action for the transactional schema 1 -> 2 transition; existing sessions and other review tables remain untouched. Failed DDL rolls back. Batches commit only after every source passes; failure/cancellation adds no partial records. One in-process worker retains bounded progress records, and a running job can be rediscovered after renderer reload. Progress jobs are not durable across backend restart; incomplete batches are not committed. On reopening, identity checks compare saved size/mtime/ctime/device/inode, while the imported SHA256 remains immutable; this is not a new full content rehash.

Users can confirm ordering, leave continuity unknown or record a known gap/contiguity with provenance. Reordering resets relationship claims in the UI. No global continuous session timeline is synthesized. The optional clock anchor requires an explicit ISO timestamp with timezone and provenance, and is pinned to an immutable segment ID/first decoded PTS. Without it, real-world time stays unknown. Independent review caught numeric-string-to-epoch coercion in API validation; regression tests now require explicit ISO clock evidence. Original recording speed remains unverified and visible.

**Dependency and binary evidence:** Added only `av==19.0.1`, requiring Python >=3.12. [Exact PyPI metadata](https://pypi.org/pypi/av/19.0.1/json) confirms Linux and Windows x64/ARM64 wheels; Windows wheel availability is not execution evidence. PyAV [code licence](https://github.com/PyAV-Org/PyAV/blob/v19.0.1/LICENSE.txt) is BSD-3-Clause, blob `9db1661e7d701c7fd262ed77efc2acc3831e41a2`. The Linux wheel's PyPI SHA256 is `1bea5b6134209305199bce7627ac3d33964de2cf2b09c77d08e7f67cf8bd4170`; the inspected Windows x64 wheel SHA256 is `906fc3db09288319a75ea23ffefb59961c7dbe0d1c074601507a89de7d8593d8`.

The wheels' FFmpeg libraries self-report LGPL-3-or-later, but the inspected Windows wheel includes x264/x265 DLLs with separately verified GPL-2-or-later source terms. The [vendor FFmpeg patch](https://github.com/PyAV-Org/pyav-ffmpeg/blob/9.0.2-1/patches/ffmpeg.patch), blob `17db076523aab138f0545ade7683360b1b1b99ad`, changes configure licence classification; it does not establish new codec terms. Exact [x264 source notice](https://github.com/mirror/x264/blob/b35605ace3ddf7c1a5d67a2eb553f034aef41d55/x264.h) and [x265 4.3 notice](https://github.com/Multicorewareinc/x265/blob/4.3/source/x265.h) were checked. Do not describe the whole wheel as BSD/LGPL or cleared for redistribution. **Binary redistribution remains uncleared pending licence/composition review or a vetted build.** This source-only development change ships no wheels, codec libraries, FFmpeg executable or installer. The host Debian FFmpeg CLI is a GPL-enabled test prerequisite, not the production decoder or a bundled binary.

**Validation actually run:** Debian 13 Linux x64, Python 3.12.14, Node 24.19.0/npm 11.9.0, PyAV 19.0.1 (bundled FFmpeg libraries), host FFmpeg/ffprobe 7.1.5, React/DOM 19.2.9, TypeScript 5.9.3, Vite 7.3.7, Electron 44.7.2 and Playwright 1.64.1. Existing npm lockfile pins are unchanged; the only added direct dependency is pinned in Python requirements. All commands exited 0:

| Exact command | Observed result |
| --- | --- |
| `/workspace/work/bat-venv/bin/python -m pip install --cache-dir /workspace/work/pip-cache -r backend/requirements-dev.txt` | Requirements installed/satisfied including `av==19.0.1` |
| `/workspace/work/bat-venv/bin/python -m pytest backend/tests -q` | **34 passed, 1 warning in 2.91s**, including all 6 existing foundation tests |
| `npm run typecheck` | React, Electron and Playwright TypeScript passed |
| `BAT_PYTHON=/workspace/work/bat-venv/bin/python npm test` | Vite build and Electron `tsc` passed; **16 Node tests passed**, 0 failed/skipped |
| `DISPLAY=:99 BAT_PYTHON=/workspace/work/bat-venv/bin/python npm run test:e2e` | Vite built 31 modules in 940ms; Electron `tsc` passed; **5 Electron tests passed (11.5s)** |
| `git diff --check` | Passed |

All binaries were generated under temporary directories outside the repository. Tests compare paired decoded pixels and exact PTS, first/last/end boundaries, short final segments and audio-stream metadata; exercise real API/SQLite upgrade/reopen/reorder and null/explicit clock anchors; verify unknown continuity and documented gaps; reject unknown codecs, corrupt/truncated/missing/changed sources and arbitrary path payloads; check cancel/shutdown, atomic batches and migration rollback. Electron tests exercise picker IPC -> real local API -> PyAV -> SQLite -> React and reject extra picker path arguments. **Only the native OS dialog return is substituted in automation**; no backend/media/API response is mocked. The native OS file-picker interaction itself has not been manually validated. Originals stay byte-identical after import and reorder. Final process inspection found **zero** running `python -m backend.app` processes.

Independent source review found no unresolved blocking issue after the clock coercion fix. The Python warning is the existing upstream Starlette/AnyIO deprecation; Playwright also reports inherited colour-environment settings. Neither was suppressed or counted as a failed test.

**Limits and next gate:** Tests use Linux `/proc` and `ps`, Xvfb and test-only `--no-sandbox`; they do not validate Chromium's OS sandbox. Windows install/runtime, native Windows picker, all binary redistribution and production installers remain unverified. Synthetic MPEG-TS is not evidence of camera-specific AVCHD support. No representative original recording, WSP/client data or ecological benchmark was used. Field order, original-speed provenance and missing timing metadata remain explicit unknowns. Playback/preview/exact seeking remains the next Slice 1 increment and must pass before motion summaries. One source-only PR linked to issue #3 is proposed for independent review; no merge, release or deployment is authorised by this implementation.

---

## 2026-10-15 - Synthetic video PTS spike for Slice 1A

**Scope:** Small locally generated synthetic media only, with FFmpeg/ffprobe 7.1.5. No project/client footage was accessed.

**Method:** Created a 25 fps, three-second MPEG-4 MP4, an MPEG-2 MPEG-TS container with `.mts` extension, and a second MP4 made with an irregular frame-selection pattern while retaining presentation times. Inspected stream `time_base`, `start_time`, reported frame rates and decoded frame `best_effort_timestamp_time` with `ffprobe`.

**Observed results:**
- CFR MP4: first decoded video PTS 0.000 seconds, subsequent timestamps 0.040, 0.080, 0.120; stream timebase 1/12800.
- Synthetic MPEG-TS `.mts`: first decoded video PTS **1.440 seconds**, subsequent timestamps 1.480, 1.520, 1.560; stream timebase 1/90000. The stream PTS origin is not the survey start clock.
- Genuinely irregular-timestamp MP4: frame timestamps 0.000, 0.040, 0.120, 0.160, 0.200, 0.280, 0.320 and 0.360 seconds, with alternating 0.040 and 0.080-second intervals. `r_frame_rate` was 25/1 while `avg_frame_rate` differed. This illustrates why `frame_index / FPS` must not be the authoritative event timestamp.

**Correction made during review:** An earlier frame-drop fixture retaining every third frame produced *regular* 0.120-second intervals, despite its VFR filename. It was replaced with a genuine mixed-interval fixture before finalising this record and the Codex issue.

**Limits:** An MPEG-TS file merely named `.mts` is **not** a compatibility test for actual Canon XA / Sony AX53 / Nightfox AVCHD camera footage. PyAV was not installed, so no PyAV-versus-FFmpeg decoder comparison was performed. The synthetic clips are not bat-recognition test data.

**Decision:** Keep source presentation timestamps, segment-relative elapsed time, optional session continuity, and optional real-world clock anchor explicitly distinct. Require a measured single-decoder decision before building time-accurate motion summaries. Do not infer exact timing from nominal FPS.

**Codex handoff:** [Issue #3 - Slice 1A media fidelity](https://github.com/cameaci/Bat_Innovation/issues/3). This is a prepared implementation task, not a started Codex execution or a validated camera support claim.

---

## 2026-10-15 - PR #2 startup diagnostics review refinement

**Finding:** The Electron shell originally lost useful SQLite startup errors and returned a generic unavailable message. A previous raw stderr-text matching proposal was replaced during review because it would couple the shell to Python traceback wording.

**Change:** Introduced a specific `DatabaseSchemaError` in persistence, explicit redacted `BAT_STARTUP_ERROR` codes at the Python entry point, narrow Electron mapping and real startup regression tests for existing incompatible SQLite files. Neither raw Python tracebacks nor local file paths are sent to the renderer. No generic error framework, alternate database or workaround was introduced.

**Independent checks:** Exact Git blob SHA verification for the three Python source files and original foundation tests, 6/6 pytest tests, three actual Python startup subprocess scenarios (future-schema, unversioned and corrupt SQLite) with correct exit code, unchanged file bytes and safe code-only stderr, plus six isolated Node diagnostic-mapping checks and three Node-to-real-Python subprocess contract tests.

**Unverified:** npm/TypeScript compilation and the full Electron integration suite were not rerun for this correction, because dependencies were not installed in the independent environment. Codex's earlier reported green results were for the preceding implementation. Windows and normal OS-level Chromium sandbox behavior are still pending.

**Review conclusion:** The original blocking diagnostic design defect is addressed at source level and the Python startup contract is verified. Keep platform limitations explicit and continue to handle Windows/packaged-app checks at their planned gates.

---


## 2026-10-15 - Slice 0 React and Electron integration verified on Linux

**Scope:** Implemented the handoff's smallest synthetic session foundation. The original FastAPI/Python/SQLite backend, schema, authentication and requirements are unchanged. No second API framework or fake backend was introduced.

**Decisions and review:** Inspected the live Camera_Trap shell/preload, package manifests and MIT licence before implementation. Used its lifecycle, isolation and stack patterns only, with independently authored source. The five-role review kept computer vision and ecological interpretation out of this slice, required actual persistence and failure tests, narrowed IPC and avoided copying code with unresolved ownership authority. Exact source commit/blob hashes, package licences and setup are in [development notes](11-slice-0-development.md).

React loads the built UI at `app://bat/index.html` in both development and the eventual packaging design. Only `health`, `listSessions` and `createSession` cross the isolated preload bridge; the main process validates the sender window, main frame and exact URL. It calls fixed existing endpoints on `127.0.0.1`, adds a fresh 32-byte cryptographic token through the Python child's environment, and never sends that token to React or logs. Browser CORS is unchanged and grants no renderer API access. CSP blocks renderer connections, frames and forms; navigation, popups, downloads and permissions are denied. Spell checking is disabled to avoid dictionary downloads. There is no runtime downloader or updater.

The shell owns one child and waits for authenticated readiness and child closure on quit, with a termination/force-kill sequence. It never attaches to or kills another process by port. Default app data is outside the checkout; explicit launcher paths are validated before writing, including symlink ancestors. Tests caught and corrected an initial lexical `..` prefix boundary check and unsafe preflight ordering. Optional file selection is deferred to Slice 1, where file IDs and media provenance can be implemented together.

**Environment actually used:** Debian 13 Linux x64; Python 3.12.14; Node 24.19.0; npm 11.9.0; TypeScript 5.9.3; React/DOM 19.2.9; Vite 7.3.7; Electron 44.7.2; Playwright 1.64.1; FFmpeg/ffprobe 7.1.5 from the host. The root npm lockfile records versions/integrities and workspace dependencies. No binaries or installers are committed.

**Command outputs:** All commands below exited 0. `BAT_PYTHON` selected the Python environment with existing pinned requirements; Electron tests used `DISPLAY=:99` under Xvfb. This cloud executor required command-scoped network permission even for loopback tests.

| Command | Observed output |
| --- | --- |
| `npm ci` | `added 40 packages in 3s` |
| `npm run setup:electron` | `install-electron`, exit 0; Electron 44 requires explicit development-runtime installation |
| `python -m pytest backend/tests -q` | `6 passed, 1 warning in 0.40s` |
| `npm run typecheck` | React, Electron and test `tsc` commands all passed |
| `npm run build` | Vite 7.3.7, 30 modules, `built in 1.11s`; Electron `tsc` passed |
| `node --test electron/tests/backend.test.cjs` | `tests 13`, `pass 13`, `fail 0`, `skipped 0` |
| `npm exec -- playwright test` | `3 passed (4.9s)` against the rebuilt shell |
| `npm audit --json` | `total: 0` reported vulnerabilities at inspection time |

`npm test` and `npm run test:e2e` wrap the same build and test commands. The full `npm run test:e2e` script also passed earlier (`3 passed (5.2s)`). The Python warning is an upstream Starlette/AnyIO deprecation; no backend code was changed to suppress it. Playwright also printed an inherited colour-environment warning.

**Directly verified behavior:** Real authenticated readiness, empty/existing session reads, editable synthetic session creation, same SQLite ID after process restart, persistence after renderer reload and full Electron reopening, fresh token on each launch, real HTTP 401 for wrong tokens, explicit unavailable state after backend death, missing-Python error, no backend remaining after normal quit or startup failure, and no spawn when startup is cancelled. Configuration tests reject relative, in-checkout and symlinked data directories and invalid ports. Renderer tests verify its frozen three-function bridge, absence of Node APIs, CSP connection blocking and denied popups. A screenshot contains only the real synthetic session. Final process inspection found no running `python -m backend.app` process.

**Limits:** These Linux Electron tests intentionally use test-only `--no-sandbox` in the container; normal source configuration keeps sandboxing, context isolation and web security enabled. Chromium's operating-system sandbox, Windows startup/shutdown, clean Windows install and all packaging/installer/signing work are unverified. Packaged startup explicitly refuses to run until a vetted backend runtime exists in Slice 5. Abrupt OS kill/power loss cannot execute quit handlers. Project ownership/publication authority remains open; public MIT terms were verified, but no WSP source was copied and no new project licence was asserted. No WSP/client data, media decoding, bat detection, tracking, AI, ecological review, reports or cloud features were used or implemented.

**Review handoff:** Changes are proposed locally, not merged or released. Relevant plan checkboxes distinguish the tested Linux foundation from outstanding Windows, ownership and future media work.

---

## 2026-10-15 - Slice 0 foundation and Codex handoff

**Scope:** Implement a minimal, original-code local backend while keeping the proposed Camera_Trap-style React/Electron UI as a separate, testable integration task.

**Changes made:** Added `.gitignore`; Python backend package and explicit localhost startup; a FastAPI health and recording-session API requiring `X-Bat-Token`; standard-library SQLite v1 recording-session persistence with transactions and incompatible-schema rejection; pinned backend and development requirements; and six synthetic/API tests. No Camera_Trap source files were copied.

**Tests actually run:** On an available Linux development environment with Python 3.13 and FFmpeg/ffprobe on PATH: `python -m pytest backend/tests -q` resulted in **6 passed**; Python compilation succeeded. A real local subprocess smoke test started `python -m backend.app` on a loopback port with an ephemeral token and temporary data folder, returned HTTP 200 on authenticated health, HTTP 401 without token, and created the expected SQLite file. No Windows, npm/React, Electron or video compatibility tests were run.

**Finding and correction:** An initial FastAPI dependency declaration caused HTTP 422 instead of the intended 401 when missing a token. Replaced it with route-level `Depends(authenticate)`, reran the suite and confirmed expected behavior. SQLite connections were also made explicitly closeable and v1 initialisation transactional.

**Codex handoff:** [GitHub issue #1](https://github.com/cameaci/Bat_Innovation/issues/1) contains the ready-to-implement React/TypeScript and minimal Electron development shell task, security constraints, expected integration with the committed API and acceptance tests. **Creating a GitHub issue is not the same as launching Codex.** No Codex run or pull request has been started by this action.

**Status and limits:** Slice 0 is partial, not complete. No working user interface, video ingestion, motion analysis, real footage evaluation, Windows installer, licence/IP approval or ecological result is claimed. Gate 0 only. Local Python test results do not verify a Windows distribution.

**Next action:** Execute/review the Codex UI integration work, ensure the actual UI/API/SQLite path works, then begin the Slice 1 frame timestamp and .MTS/.MP4 source-video fidelity spike.

---

## 2026-10-15 - Implementation plan, source reuse and design review

**Objective:** Define a maintainable, low-code implementation plan for a local active-IR emergence-review application, using existing Camera_Trap concepts where suitable and excluding workarounds.

**Method:** Inspected the current public [Camera_Trap source](https://github.com/cameaci/Camera_Trap), including its [Electron process](https://github.com/cameaci/Camera_Trap/blob/main/electron/src/main.ts), [preload bridge](https://github.com/cameaci/Camera_Trap/blob/main/electron/src/preload.ts), [verify shell](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/VerifyDetailShell.tsx), [review gallery](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/VerifyView.tsx), [count editor](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/EventCountPanel.tsx), [SQLite module](https://github.com/cameaci/Camera_Trap/blob/main/backend/app/db/base.py), [audit model](https://github.com/cameaci/Camera_Trap/blob/main/backend/app/models/audit_log.py), [export UI](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/pages/ExportPage.tsx) and [licence](https://github.com/cameaci/Camera_Trap/blob/main/LICENSE). Inspected [PyAV](https://github.com/PyAV-Org/PyAV), its [README](https://github.com/PyAV-Org/PyAV/blob/master/README.md) and [licence](https://github.com/PyAV-Org/PyAV/blob/master/LICENSE.txt) as a candidate for PTS-aware decoding.

**Review and refinement:** Evaluated new UI vs complete fork vs selective reuse; flat files vs SQLite; frame-number time vs original PTS; direct browser playback vs tested local preview generation; tracking-first vs all-window summaries; simple reviewed Boolean vs independent QA states; local API and source-path restrictions; packaging order. Three passes addressed maintainability, bat-video/ecological risks, and security/delivery. Resolutions are in [implementation/review.md](../implementation/review.md).

**Decisions:**
1. Small Electron/React/FastAPI/SQLite desktop workflow, **not** a full Camera_Trap fork, cloud service or ML platform.
2. First technical task is reliable .MTS/.MP4 media and PTS seeking. Investigate PyAV against FFmpeg in a test spike before choosing one authoritative frame decoder.
3. All-window active-IR motion summaries precede individual tracking and learned detection. All reviewable windows, including empty-looking windows, remain accessible.
4. Distinct observation, QA and final ecological review states, with source-linked revisions and separate reporting/audit exports.
5. Reuse isolated source files only after appropriate licence/IP checks; otherwise reuse the verified interaction and structure rather than tightly coupled camera-trap domain code.
6. Native file selection is needed in a minimal Electron **development** shell during media testing; distributable Windows packaging follows later.

**Output:** Added root [AGENTS.md](../AGENTS.md) and the [implementation plan](../implementation/README.md), [technical design](../implementation/design.md), [reuse audit](../implementation/reuse.md), [delivery tasks](../implementation/plan.md), [test plan](../implementation/tests.md) and [review record](../implementation/review.md). Earlier architecture documents were reduced to concise decision/reference notes to avoid duplicated requirements.

**What was not done:** no app source code, dependency installation, runtime testing, original WSP video processing, verified bat-event benchmark, copyright permission or deployment approval. Development remains at Gate 0.

---

## 2026-10-15 - Correction: Camera_Trap repository inspection and lean desktop decision

**Question:** What are the real architecture, verification features and code conventions of the current public [Camera_Trap](https://github.com/cameaci/Camera_Trap) repository, and which are appropriate for a small IR emergence-review app?

**Method:** Inspected the live default-branch Git tree and the following primary-source code and docs: [README](https://github.com/cameaci/Camera_Trap/blob/main/README.md), [Electron main process](https://github.com/cameaci/Camera_Trap/blob/main/electron/src/main.ts), [frontend package](https://github.com/cameaci/Camera_Trap/blob/main/frontend/package.json), [FastAPI entry point](https://github.com/cameaci/Camera_Trap/blob/main/backend/app/main.py), [SQLite setup](https://github.com/cameaci/Camera_Trap/blob/main/backend/app/db/base.py), [verification gallery](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/VerifyView.tsx), [count confirmation](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/EventCountPanel.tsx), [export UI](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/pages/ExportPage.tsx), [conventions](https://github.com/cameaci/Camera_Trap/blob/main/CONVENTIONS.md), [licence](https://github.com/cameaci/Camera_Trap/blob/main/LICENSE), and [user guide](https://github.com/cameaci/Camera_Trap/blob/main/wsp/docs/USER_GUIDE.md).

**Correction:** The earlier draft in this research record incorrectly described the current repository as a single-file **Gradio** application without an identified QA workflow or top-level licence. **Those statements were wrong and have been withdrawn.** The current codebase is an **Electron desktop shell + React/TypeScript frontend + FastAPI Python backend + local SQLite data layer**, with interactive human label verification, count correction and reviewed-progress workflows. It has a root-level MIT licence with a WSP copyright notice.

**Decision:** Follow the existing **desktop and QA interaction patterns**, not the full product feature set. Build an IR-first, single-machine React/FastAPI/SQLite vertical slice, then add Electron packaging. Keep recording sessions, segmented files, time mapping, every-window motion summaries, original video navigation, simple reviewer/QA records and report/audit exports. Defer deep-learning models, cloud hosting, cross-camera deduplication, acoustic analysis and thermal support.

**Constraints and open issues:** Existing timestamped workbook annotations can serve as **prelabels** but are not validated reference truth; a named ecological lead must own final sign-off and performance thresholds. Gate 0 allows synthetic/licensed-public development. Use of client footage requires documented permissions and privacy/security checks; no client media or non-public internal details were committed. Both repositories were confirmed **public** through GitHub metadata; Bat Innovation's code/IP owner and licence remain open.

**Code scope:** This entry changes only Markdown; no application source was created.  
**Changed files:** README.md; docs/01-problem-and-scope.md; docs/02-source-register.md; docs/03-technical-approaches.md; docs/04-data-governance.md; docs/06-research-backlog.md; docs/07-research-log.md; docs/09-ir-first-architecture-draft.md; docs/10-camera-trap-architecture-reference.md.

---

## 2026-10-15 - Public motion-summary prior art and IR-first design revision

**Question:** Could an in-house, IR-first bat survey reviewer be useful before implementing individual-object tracking or training a bat detector?

**Method:** Checked official public product pages, the WISARD public installer-only GitHub repository, a publicly available bat survey report and related public motion-summary and tracking product descriptions. **No non-public demonstration transcript, video, screenshot or proprietary code was added to this repository.**

**Sources:**
- [Wildlife Imaging Systems - emergence service](https://www.wildlifeimagingsystems.com/services-bat-emergence).
- [WISARD software and FAQ](https://www.wildlifeimagingsystems.com/wisard-software).
- [WISARD installer-only GitHub releases](https://github.com/WildlifeImagingSystems/wisard-labeling-tool-releases).
- [2025 public bat survey report, section 4.3.4](https://docs.planning.org.uk/20250910/73/SSP14ADWH6X00/ueyziikzwnauclwd.PDF).
- [Reflex Cameras - local motion analysis](https://reflexcameras.co.uk/video-motion-analysis-service/).
- [Ecordea Roost](https://www.ecordea.com/).
- [ThruTracker user guide](https://www.thrutrackeranalytics.com/user-guide).

**Findings:**
1. Public sources document bat video review using one timestamped motion-summary image per roughly 15-60-second interval and subsequent ecological review of source footage.
2. WISARD is a review application; its FAQ says motion summaries are produced by a separate processing service, not by WISARD locally. Its GitHub release repository contains installers, **not open-source processing code**.
3. An independently published survey report describes actual use of 30-second colour motion traces and targeted original-video checking, but does not independently quantify accuracy or time savings.
4. Exact vendor algorithms and motion-colour mapping are **not established**. No algorithm has been reproduced or benchmarked here.
5. Camera stability checks and retention of all summary windows should be first-class design requirements.

**Decision:** Prefer a **complete, all-window, IR motion-summary reviewer** as the first implementation candidate. Track-level detection, roost-zone reasoning, and learned bat classifiers are optional extensions, not first-release prerequisites. Acoustic integration remains out of scope.

**Limitations:** No source video analysed, no permission or original-file availability established, no empirical recall or review-time results measured. Requirements and deployment choices remain provisional.

**Changed files:** README.md; docs/01-problem-and-scope.md; docs/02-source-register.md; docs/03-technical-approaches.md; docs/04-data-governance.md; docs/05-evaluation-framework.md; docs/06-research-backlog.md; docs/07-research-log.md; docs/08-motion-summary-prior-art.md; docs/09-ir-first-architecture-draft.md.

---

## 2026-10-15 - Repository initialization and first scoping review

**Objective:** Establish a public, English-language Markdown research record for a possible WSP in-house bat NVA video analysis workflow.

**Repository check:** `cameaci/Bat_Innovation` was found to be public and initially empty. Public documentation was therefore limited to shareable, externally sourced research and generic design notes.

**Search themes:**
- UK bat emergence survey guidance and NVA technical practice.
- Bat detection, counting and tracking from IR and thermal video.
- Open-source motion detection, tracking and annotation tools.
- Bat-related data sources and reproducibility.
- In-house deployment and model/data licence risks.

**Public sources inspected:**
- [BCT professional guidance](https://www.bats.org.uk/resources/guidance-for-professionals).
- [BCT NVA technical-guide publisher page](https://www.bats.org.uk/resources/guidance-for-professionals/bat-emergence-surveys-with-night-vision-aids-a-technical-guide).
- [Exeter infrared-video tracking research poster](https://cdn.bats.org.uk/uploads/events-training/William_Rees_NBC_Poster.pdf?v=1725643811).
- [Boston University thermal-video bat research](https://www.cs.bu.edu/faculty/betke/research/bats/).
- [2025 near-infrared bat YOLO paper](https://doi.org/10.3390/signals6030046).
- [2022 maternity-roost monitoring methods paper](https://link.springer.com/article/10.1007/s10531-022-02389-7).
- [2026 thermal multi-sensor paper](https://doi.org/10.1371/journal.pone.0352329).
- [OpenCV](https://github.com/opencv/opencv), [CVAT](https://github.com/cvat-ai/cvat), [Norfair](https://github.com/tryolabs/norfair), [MegaDetector](https://github.com/microsoft/MegaDetector).

**Initial findings (scoping-level):**
1. Bat-specific automated IR/thermal detection and tracking have credible research precedents.
2. Relevant UK professional guidance emphasises technical limitations and ecological judgement.
3. A source-reported detection score on one NIR dataset cannot be assumed to transfer to UK emergence survey recordings.
4. Model-code licences, model-weight licences, dataset rights and client footage permissions must be evaluated separately.
5. A full review of available training video and event-level annotations is still missing.

**What was not done:** no WSP footage accessed, downloaded, uploaded, analysed or validated; no original video metadata measured; no dataset rights cleared; no model trained; no performance benchmark conducted; no WSP internal approval claimed.

**Documents created:** problem/scope, source register, technical approaches, governance, evaluation, research backlog and source-review template.

**Next research action:** commission a deeper, source-backed literature/prior-art and dataset/licence review; integrate its verified findings into the source register and log after review. Do not present the initial register as exhaustive.

---

## Log entry template

### YYYY-MM-DD - Short title

**Question:**

**Sources and links:**

**Search locations / exact queries (if applicable):**

**Method:**

**Findings:**

**Limitations and uncertainty:**

**Licences/access:**

**Decision or next action:**

**Changed files:**
