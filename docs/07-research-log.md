# 07 - Research log

## 2026-10-15 - PR #2 startup diagnostics review refinement

**Finding:** The Electron shell originally lost useful SQLite startup errors and returned a generic unavailable message. A previous raw stderr-text matching proposal was replaced during review because it would couple the shell to Python traceback wording.

**Change:** Introduced a specific \`DatabaseSchemaError\` in persistence, explicit redacted \`BAT_STARTUP_ERROR\` codes at the Python entry point, narrow Electron mapping and real startup regression tests for existing incompatible SQLite files. Neither raw Python tracebacks nor local file paths are sent to the renderer. No generic error framework, alternate database or workaround was introduced.

**Independent checks:** Exact Git blob SHA verification for the three Python source files and original foundation tests, 6/6 pytest tests, three actual Python startup subprocess scenarios (future-schema, unversioned and corrupt SQLite) with correct exit code, unchanged file bytes and safe code-only stderr, plus six isolated Node diagnostic-mapping checks.

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
