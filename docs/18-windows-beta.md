# 18 - Windows internal beta

Status: **built and smoke-tested on one native Windows 11 machine; the owner installed and opened the first installer (screen recording, 2026-10-22). The Camera_Trap-style interface (2026-10-22) has not yet been built or run on Windows.** Reviewed 2026-10-22. Every row of the acceptance checklist below is "Not run" except where a result is stated.

## Owner decisions (2026-10-21)

- The Windows media gates (import, preview, summaries, export) are opened for an **internal beta** under Job Object limits. This replaces "fail closed until every W1-W7 procedure passes" in the earlier feasibility report. The remaining risks are listed under known limits and are accepted for the beta only.
- The installer is published as an **unsigned GitHub pre-release**. The owner is responsible for the codec licence obligations in the notice below.
- Scope is the existing workflow. Exports stay **PROVISIONAL**. There is no finalisation, no approved ecology template and no ecological validation.

## Install and use

1. Download `Bat-Innovation-Setup-<version>.exe` and `SHA256SUMS.txt` from the release and compare the hash.
2. Run the installer. It is per-user and needs no administrator rights. Windows SmartScreen will warn because the build is unsigned: choose "More info", then "Run anyway".
3. Start **Bat Innovation**. Data lives in `%LOCALAPPDATA%\Bat Innovation\data`. Original videos stay where they are and are never copied, moved or deleted. Uninstalling keeps the data folder and your originals.
4. Workflow:
   - **Surveys:** "New survey" creates one recording session (a name and the camera). Each survey card shows its videos, windows and review progress.
   - **Process:** "Add videos" selects the original `.MTS`/`.MP4` files. Check their order (arrows) and save. "Generate motion summaries" plans every time window; thumbnails appear as each window finishes and can be opened at once. Review and original-video previews unlock when processing ends.
   - **Review:** every window is a card. Filters (not reviewed, with observations, flagged, failed or incomplete, needs re-check, QA pending) never change the progress count. Opening a card shows the motion summary and plays two seconds of the original video from the window start. Enter your name once, then choose "No activity seen" (key N) or "Add observation" (key O); pause the video on a frame and use "Use current frame as start/end". Arrow keys move between windows and U jumps to the next unreviewed one. A decision is only saved after the original preview of that window is ready. A second person can add a QA decision under "Second review (QA)".
   - **Export:** tick the provisional confirmation, "Export provisional CSVs", then "Save provisional CSV bundle..." to choose a folder.
   - An older data folder shows one "Upgrade storage" button; nothing is upgraded without that click.

To try the app without real footage, generate a synthetic infrared-style clip with `python scripts/make_test_video.py <output.mp4>` (needs PyAV, for example the build environment `.build\venv\Scripts\python.exe`). Save it outside the repository and the app data folder. It has three 30 s windows: moving dots in the first two and none in the last. The motion-evidence image of the first window shows two trails, the last window none.

The app is offline: it downloads nothing at runtime and only talks to its own loopback API with a per-launch token.

## Build (native Windows 10/11 x64)

Prerequisites: Python 3.12 x64, Node.js 22.12 or newer. Then, from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
```

The script creates `.build\venv`, installs the pinned requirements, builds the UI and shell, freezes the backend with PyInstaller (`backend/bat-backend.spec`), **runs `scripts/smoke_backend.py` against the frozen exe** (synthetic video: import, preview, summaries, export), collects licence notices (`scripts/collect_notices.py`), packages the NSIS installer with electron-builder and prints its SHA256. A failing smoke test stops the build.

The `Build Windows installer` workflow runs the same script on `windows-2022` (manual dispatch, or a `v*` tag publishes a pre-release). Tests that need a Windows Job Object run there too, with FFmpeg installed for the synthetic fixtures. Run `pytest` natively with a non-venv interpreter (for example Conda or python.org): a venv `python.exe` launcher starts a second process and would violate the one-process Job Object limit.

## How processing is contained on Windows

Each import, preview, summary and export runs in one disposable worker process (the same executable re-entered with `--worker <name>`, restricted to four names). The backend launches it suspended inside a fresh Job Object (`backend/app/winjob.py`), then resumes it. The worker refuses to start decoding unless the job's limits are in force.

| Operation | Memory | CPU time | Wall clock | Processes |
| --- | --- | --- | --- | --- |
| Import (provisional) | 1 GiB | 1800 s | 3600 s | 1 |
| Preview | 1 GiB | 20 s | 25 s | 1 |
| Summaries | 1 GiB | 300 s | 600 s | 1 |
| Export | 1 GiB | 15 s | 32 s | 1 |

The job is killed when the backend exits, and the backend exits when the desktop shell exits (`BAT_PARENT_PID`). Requests and responses travel as size-checked JSON files in a private temporary folder. Output budgets (image, run, global and export sizes) are the same logical limits as on Linux.

## Known limits

- **Disk is not bounded by the Job Object.** Logical output budgets and a free-space check before summaries apply, but a full disk during a preview or export fails with an explicit error rather than being prevented. Summaries reserve metadata space by writing it up front.
- Job memory and CPU limits are enforced with measurable overshoot (earlier native tests saw about 7% memory and up to a few times the CPU limit), which is why the wall-clock deadline is independent.
- The shell stops the backend by terminating it. A summary run interrupted this way is recorded as interrupted on the next start; this recovery path was exercised on Linux only.
- An owner death between suspended process creation and job assignment can leave a suspended worker. This window is tiny and was not closed.
- Import budgets are provisional and unmeasured on real media.
- Rotation is not applied and interlaced video is not deinterlaced; warnings stay visible. Camera originals from the Canon XA, Sony AX53 and Nightfox cameras have not been tested.
- Windows reparse points (junctions) are refused in managed folders, but full NTFS ACL and mapped or synced drive behaviour is untested.
- The motion summary is evidence for human review. A blank-looking summary is not proof that no bat was present, and no ecological performance has been measured.

## Licence and redistribution notice

Do not describe the installer as simply BSD or MIT. It bundles the PyAV wheel, whose FFmpeg and codec libraries include **x264 and x265 (GPL-2.0-or-later or separate commercial terms)**, although the FFmpeg libraries self-report LGPL-3.0-or-later. The application does not use these encoders, but they are present in the shipped binaries. `notices/NOTICE.txt` in the install folder lists every Python component with its licence files and points to the PyAV and `pyav-ffmpeg` sources. The release publisher must provide the corresponding source and notices where required. A cleaner alternative is a PyAV/FFmpeg build without GPL encoders, which would need a fresh decode, VP9 encode and exact-PTS verification. Build-time tools (PyInstaller with its bootloader exception, electron-builder) are not shipped. Electron's own `LICENSE.electron.txt` and `LICENSES.chromium.html` are installed beside the executable. Code ownership and the licence of this project's source are still undetermined.

## Verified so far

**Camera_Trap-style interface (2026-10-22, Linux only):** 375 backend tests pass (45 skipped, Windows-only); strict TypeScript passes; 58 Node tests pass; the rewritten Electron end-to-end suite passes (20 passed, 1 skipped), covering survey persistence, import and ordering, live summary output, exact-PTS preview, review and QA audit, draft protection, filters at 240-window scale and the export bundle. `scripts/collect_notices.py` now also lists the bundled JavaScript packages and the Camera_Trap notice. Not yet rebuilt or run on Windows.


On Linux, in this repository's development environment (Python 3.13 here, 3.12 is the build target): 374 backend tests pass (44 skipped, Windows-only), including the new worker-launch tests whose Windows branch runs against a fake supervisor; strict TypeScript passes; 58 Node tests pass; the Electron end-to-end suite passes (20 passed, 1 skipped). A **PyInstaller-frozen Linux build** passes `scripts/smoke_backend.py` (health, import, preview, 2 of 2 summary windows, export covering every planned window, original video unchanged). An electron-builder Linux `dir` package started with `app.isPackaged` true, ran the frozen backend from `resources/backend`, served the UI from `resources/frontend`, showed backend and storage ready, and left no backend process after closing. The frozen build caught a real defect, missing package metadata for the toolchain versions recorded with each run, now fixed in the spec. Reading the export save code for Windows also found two POSIX-only steps (directory fsync, rename over an empty directory), now made platform-aware.

**Native Windows evidence (owner's machine, Windows 11 build 26200, Python 3.12.10, from the pasted `build-windows.ps1` output; not independently reproduced):** the script completed end to end. The frozen `bat-backend.exe` passed `scripts/smoke_backend.py` with synthetic media (health, schema upgrades, import, preview, 2 of 2 summary windows, provisional export covering every planned window, original unchanged), so import, preview, summaries and export ran as Job Object workers on Windows. electron-builder produced `Bat-Innovation-Setup-0.1.0.exe` (SHA256 `db07072a43232a171c7febbf20c92bc5bc44e94165741724602486e6be987562`, unsigned). The first smoke run exposed a real Windows defect, a false `changed_source` because `fstat().st_ctime_ns` differs from `stat()` for the same file; the owner fixed it with `st_birthtime_ns` and a Windows regression test (see the research log). Build warnings seen and not acted on: PyInstaller "Hidden import tzdata not found", `npm audit` reports 8 moderate issues in build tooling, electron-builder notes the missing icon, description and author.

Not verified: the full backend test suite on Windows (only `test_media.py` is reported), the installed application (NSIS install, launch, native file picker, offline behaviour), process cleanup after closing during a summary run, SmartScreen behaviour and uninstall.

## Acceptance checklist (run on a Windows machine with networking disabled after install)

Record the Windows build, the installer SHA256 and the result of each row. A skipped or partially run row is a failure.

| # | Check | Result |
| --- | --- | --- |
| 1 | `pytest backend/tests -rs` passes with no Windows tests skipped | Not run |
| 2 | `scripts\build-windows.ps1` completes, including the frozen smoke test | Passed on the owner's Windows 11 machine (reported output) |
| 3 | Install, start: health ready, no outbound connection attempts | Not run |
| 4 | Real file picker imports a synthetic `.mp4` and `.MTS`; SHA256 of each original is identical before and after | Not run |
| 5 | Preview shows the marker frame at the selected original PTS | Not run |
| 6 | Summaries cover every planned window, including the final partial one | Not run |
| 7 | Review and QA decisions persist after closing and reopening | Not run |
| 8 | Export folder contains both CSVs and the manifest, labelled PROVISIONAL | Not run |
| 9 | Close the app during a summary run: no worker or backend process remains, next start shows the run as interrupted | Not run |
| 10 | Uninstall keeps the data folder and the originals | Not run |
