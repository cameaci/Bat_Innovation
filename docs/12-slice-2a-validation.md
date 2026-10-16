# Slice 2A validation

Reviewed: 2026-10-16. Scope: synthetic local development evidence for [issue #7](https://github.com/cameaci/Bat_Innovation/issues/7). This is not ecological acceptance, Windows validation or installer redistribution clearance.

## Source reuse and dependencies

The [reuse audit](../implementation/reuse.md#slice-2a-inspection-and-decision) records the immutable Camera_Trap sources, pattern-only decision and five-role design challenge. No Camera_Trap source code was copied. Existing PyAV 19.0.1 remains the sole source decoder and original PTS authority. NumPy 2.4.2 supplies native array operations; Pillow 12.1.1 supplies standard PNG and text drawing. Neither dependency adds runtime downloads, telemetry or network processing. No OpenCV, classifier, model weights or new worker framework was added.

## Dependency artifacts and licences

The following are the **actual installed Linux CPython 3.12 wheels**. Their downloaded SHA-256 values were checked against PyPI metadata; installed wheel metadata, licence files and all bundled shared libraries matched these artifacts byte for byte. This identifies the local toolchain and does not validate another platform's wheel.

| Package | Exact artifact | SHA-256 |
| --- | --- | --- |
| NumPy 2.4.2 | [numpy-2.4.2-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl](https://files.pythonhosted.org/packages/f5/c6/a18e59f3f0b8071cc85cbc8d80cd02d68aa9710170b2553a117203d46936/numpy-2.4.2-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl), 16,619,782 bytes | `9e35d3e0144137d9fdae62912e869136164534d64a169f86438bc9561b6ad49f` |
| Pillow 12.1.1 | [pillow-12.1.1-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl](https://files.pythonhosted.org/packages/ff/79/6df7b2ee763d619cda2fb4fea498e5f79d984dae304d45a8999b80d6cf5c/pillow-12.1.1-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl), 7,041,540 bytes | `7aac39bcf8d4770d089588a2e1dd111cbaa42df5a94be3114222057d68336bd0` |

NumPy's main licence is BSD-3-Clause; its package SPDX expression also includes 0BSD, MIT, Zlib and CC0-1.0 components. This wheel includes OpenBLAS/LAPACK under BSD variants, GCC `libgfortran` under GPL-3.0-or-later with GCC Runtime Library Exception 3.1, and `libquadmath` under LGPL-2.1-or-later. Preserve the wheel's `numpy-2.4.2.dist-info/licenses/` notices when distributing it; do not describe the entire binary as BSD-only.

Pillow's code uses MIT-CMU terms, with PIL/Secret Labs/Fredrik Lundh and Pillow/Jeffrey A. Clark contributor notices. The wheel includes separate notices for AOM, Brotli, bzip2, dav1d, FreeType, HarfBuzz, LCMS2, libavif, libjpeg, liblzma, libpng, libtiff, libwebp, libyuv, OpenJPEG, Raqm, X libraries, zlib and zstd in `pillow-12.1.1.dist-info/licenses/LICENSE`. FreeType offers FTL/GPL alternatives; FTL distribution requires attribution. Preserve these supplied notices rather than treating the wheel as MIT-only.

Summary labels use Pillow's standard `ImageFont.load_default_imagefont()` bitmap font, without an operating-system font path, separate font package or download. No font data was copied into this repository. Pillow also ships an embedded Aileron subset for a different default-font API; this application does not select it. Its presence in a future bundled wheel remains part of the packaging notice review.

These unchanged packages were installed for local development only. **Redistribution of the selected Windows/runtime binaries is not cleared.** Existing PyAV/FFmpeg codec and redistribution limitations also remain open; this slice does not bundle or publish dependency wheels, codec binaries or an installer.

## Source time and coverage

The baseline is `main` at independently reviewed Slice 1B merge `bdd52222b0763cebb843f4cc7f8625b0a260828c`. An explicit transactional SQLite v2 -> v3 action creates `processing_run` and `summary_window`; startup accepts existing v1/v2/v3 without silently upgrading. Source metadata, global source uniqueness, ordering, continuity and separate clock-anchor behavior remain intact.

Each segment starts its own exact half-open partition at its first decoded PTS. Fractions retain source tick boundaries even when a 30-second boundary lies between integer ticks. A frame exactly on an internal boundary belongs to the following window. No segment joins, FPS arithmetic or survey-clock inference are used. The complete plan is committed before a worker starts. Metadata-only 7200-second coverage produces 240 windows; generated 65-second and 9-second recordings produce 30/30/5 and 9-second intervals respectively.

If the final frame duration is unknown, full windows before the final PTS bucket remain finite and the final bucket has a NULL end. The tail keeps its decoded PTS/count and an explicit `unknown_end` incomplete record; it has no image or invented time-colour values. A known interval with no decoded frames has `no_decoded_frames`, rather than a quiet image. A single decoded frame has reference context and an explicit insufficient-comparison warning. Every interval stays in the list.

PTS spacing alone is not a missing-imagery test for VFR. When a positive decoded frame duration ends before the next PTS, the declared-duration gap is intersected with every affected window, including empty ones. Counts and maximum spacing remain available. Up to 64 gap examples per window are stored privately, with an explicit truncation flag beyond that bound; two examples and their stored/total counts cross IPC. The 2000-window maximum manifest is tested against the 4 MiB JSON transfer cap. Interval coverage never establishes continuous recorded imagery between frames.

## Evidence method

`consecutive-gray-v1` uses absolute consecutive native-resolution grayscale differences, threshold 3 intensity levels and gain 16, without morphology, background resets, exclusion masks or insect suppression. NumPy computes the difference before spatial max pooling to at most 640x360. Pooling preserves weak peaks but can enlarge their apparent spatial extent; motion pixels are not object areas or animal counts. The previous source frame carries across a window boundary within one segment, so a boundary change is retained at the current frame's PTS. It never carries across source segments.

Each known finite window accumulates independent cyan, yellow and magenta maxima in the first, second and final thirds of its actual source-time interval, including short partial windows. Overlap can combine colours. Left-hand context is the first decoded frame in that window; right-hand evidence is a derived change image, not a bat trajectory. PNG labels include exact elapsed and PTS bounds, literal colour legend, algorithm, parameter hash and warnings. Parameters include the decoder/numerical/image versions and have a canonical SHA256.

Frame-wide changes affecting at least one quarter of native pixels and mean-brightness jumps of at least 12 levels add quality warnings while retaining the evidence. These are documented technical thresholds, not approved ecological acceptance thresholds. Codec/grayscale conversion, original speed, rotation and interlace uncertainty remain visible. Quiet means only “No motion evidence above threshold.” No presence, absence, species, activity or ecological decision is inferred.

## Durability and resource contract

One summary worker shares the existing import/preview reservation. Linux parent-death protection and hard limits are installed before native decoder/array/image imports: 1 GiB address space, 300 CPU seconds, 128 MiB per-file size and zero core dumps. The supervisor enforces 600 seconds wall time and reaps the worker before cleaning or releasing the reservation. Decoder and OpenBLAS/OMP thread counts are one. Unsupported platforms fail closed with `summary_limits_unavailable`.

Bounds are 4096x2160 native input, 640x360 per output panel, 4 MiB per PNG, 1,000,000 decoded frames, 64 segments and 2000 windows per run, 128 MiB images per run and 512 MiB retained images. A separately bounded 8 MiB preallocated metadata reserve is released after worker termination so an image ENOSPC failure can still record terminal SQLite state. Successful historical images are retained; quota exhaustion is an explicit failure, never silent eviction. Reruns get distinct run/window IDs and do not overwrite previous success. A configured resource limit can interrupt a long or demanding recording; planning a two-hour source is not a two-hour processing-performance claim.

Images are written exclusively to backend-owned UUID paths using an exclusive temporary file, flush/fsync, atomic rename and SQLite checksum/size publication. Unreferenced artifacts and partial files are removed after reaping and on restart. Recovery marks unfinished work interrupted/incomplete, verifies recorded images and preserves prior traceability. Source identity is checked before and after decoding and again before derived content is delivered; the worker also rehashes original bytes. Missing, unreadable and changed originals are separate errors. Selected image bytes must match PNG signature, size and SHA256.

Electron exposes six fixed summary operations with strict UUID/field/integer validation, authenticated loopback routes and capped binary transfer. Source/image paths and the launch token stay in trusted processes. Only the selected image is transferred as a Blob. Both CSPs permit Blob images; renderer network access remains blocked. The all-window view retains failed, incomplete, quiet and quality-flagged rows, source preview targets, exact provenance and unsaved timeline protection. This is a list with bounded selected-image inspection, without Slice 3 review forms or ecological labels.

## Controlled coverage and visibility evidence

Reproduce the decoder/pixel comparison with `python -m pytest backend/tests/test_summary_motion.py -q -s` (16 passed, exit 0). The test prints exact source-time target measurements and the following active-frame-pixel totals from the same decoded H.264 MP4 inputs. A consecutive change records both appearance and disappearance; these totals are neither events nor animals.

| Generated fixture | Consecutive difference | Fixed first-frame reference |
| --- | ---: | ---: |
| Stationary | 0 | 0 |
| +/-1 intensity noise | 2,879 | 2,947 |
| Weak one-frame 2x2 targets | 24 | 12 |
| Weak targets plus noise | 2,903 | 2,959 |
| Insect-like 5x5 targets | 150 | 75 |
| Brightness jump | 6,144 | 73,728 |
| Camera translation/re-aim | 3,173 | 38,076 |

Both candidates retain all 4/4 target pixels at exact segment elapsed 11/10, 111/10 and 211/10 seconds. In the noisy consecutive case, minimum decoded target differences are 5/6/5 and panel peaks are 128/144/128. Insect-like targets retain 25/25 pixels in each phase. Consecutive differencing was selected because scene/brightness changes do not remain active against the initial reference for every later frame. The threshold was not raised to suppress noise: codec conversion creates visible activations even with +/-1 source noise; the consecutive noise-only peak is 2.815755% of native pixels in one comparison.

Tests inspect the encoded PNG at the known target coordinates and assert source-time colours, rather than checking only an internal mask. A real nine-second partial-window worker image retains all three time phases. Native 1920x1080 2x2 low-contrast changes survive max pooling. A separate actual limited worker test with five full-HD frames measured **0.282 seconds, 91,304 KiB peak RSS and an 8,415-byte PNG**, preserving nonzero phase pixels `[1, 3, 4]`. This is a tiny synthetic run, not a throughput, long-recording or field-sensitivity benchmark; rerun measurements vary by host load.

Coverage checks include metadata-only 7200 seconds -> 240 windows; real 65 seconds -> 30/30/5; real 9 seconds -> one partial; nonzero-origin MTS, irregular MP4, noninteger PTS boundaries, single-frame sources, unknown endpoints, an empty middle window and independent segments with unknown continuity. Per-window counts and newline-delimited original-PTS digests reconcile to every decoded frame exactly once. Source SHA256 stays unchanged. Deterministic PNG bytes are asserted within the declared toolchain. Generated examples are temporary and are not included in Git.

## Remaining limits

Windows execution and resource enforcement, representative Canon XA/Sony AX53/Nightfox and other camera-original AVCHD compatibility, physical native-picker operation, Chromium's OS sandbox, production packaging and PyAV/FFmpeg/NumPy/Pillow binary redistribution remain unverified. Windows summary/preview processing fails closed. Electron automation runs locally under Xvfb with test-only `--no-sandbox`; only the OS dialog return is substituted, while API, decoding, images and SQLite remain real.

ENOSPC is injected at an actual image-write operation in a real decoding worker; a genuinely full mounted filesystem and physical power-loss durability were not tested. CPU/address-space/file limits and actual parent-death, kill, cancel, timeout and reap behavior are tested. Persistent histories are capped at 256 runs per session without evicting evidence; large-history latency and full-survey processing performance are not benchmarked. Hardware/storage failure can require restoring writable storage before SQLite recovery can record an interrupted run. Resource limits deliberately leave explicit unfinished intervals.

These fixtures establish technical coverage and visibility only. They establish no bat-event recall, ecological absence, species identity, animal count, roost conclusion or field suitability. Authorised original-speed recordings, independent ecological reference review and agreed acceptance thresholds remain required. Exclusion masks, review/QA forms, exports, Slice 3 and cloud features are outside this increment.

## Final local command results

Debian 13 Linux x64; Python 3.12.14, PyAV 19.0.1, NumPy 2.4.2, Pillow 12.1.1, host FFmpeg/ffprobe 7.1.5, Node 24.19.0/npm 11.9.0, TypeScript 5.9.3, Vite 7.3.7, Electron 44.7.2 and Playwright 1.64.1. Python direct dependencies are pinned in `backend/requirements.txt`; the existing npm lockfile is unchanged. Activate the selected Python environment, set `BAT_PYTHON` to its executable and run a local Xvfb display (`DISPLAY=:99`) for Electron.

| Exact command from repository root | Result | Exit |
| --- | --- | ---: |
| `python -m pytest backend/tests -q` | 139 passed, 1 existing Starlette/AnyIO deprecation warning in 19.65s | 0 |
| `npm run typecheck` | Strict React, Electron and Playwright test TypeScript passed | 0 |
| `npm test` | 29 passed, 0 failed/skipped; 5408.857404ms | 0 |
| `npm run test:e2e` | 11 passed, 0 failed/skipped; 1.0m | 0 |
| `git diff --check` | No whitespace errors | 0 |

Both npm test commands include successful Vite and Electron builds. Python comprises all 77 previous tests plus 62 summary tests: 20 store/planning, 16 motion/worker, 17 supervisor/fault/resource and 9 API integration cases. Electron covers native-selection IPC through real import, preview, summary images, durable manifest reopening, source invalidation and unsaved-edit guards. Playwright reports the inherited `NO_COLOR`/`FORCE_COLOR` warning. Neither warning was suppressed.

No GitHub Actions or hosted CI was used. Only synthetic fixtures were processed. The scope audit contains source, tests, dependency pins and necessary documentation, with no media, images, SQLite files, credentials, environment files or generated artifacts. Final commit identity and the unmerged review URL are recorded in the PR.
