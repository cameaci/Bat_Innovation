# 07 - Research log

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
