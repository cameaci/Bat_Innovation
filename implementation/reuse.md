# Reuse and dependency audit

Reviewed: 2026-10-19. Source: [cameaci/Camera_Trap](https://github.com/cameaci/Camera_Trap) and upstream project documentation already in the [research register](../docs/02-source-register.md). The immutable Slice 2A source revision and dependency artifacts are recorded below.

## Reuse policy

**Reuse a verified small function/component when its dependencies and semantics fit. Adapt a proven interaction pattern when direct copying imports too much code. Write bat-specific logic independently.** A public MIT repository is not automatically authority to publish WSP-owned work elsewhere: confirm ownership and preserve the source licence and attribution for any copied portions. No source code was copied at the planning stage or for Slice 0. Its lifecycle/IPC and stack choices reuse patterns only; exact inspected source hashes and dependency versions are in the [Slice 0 audit](../docs/11-slice-0-development.md).

For each candidate record: exact path and licence, transitive dependencies, external I/O, what remains applicable, necessary changes, and a minimal regression test. Prefer one maintained implementation to two diverging local forks.

## Inspected Camera_Trap code

| Source (verified path) | Actually does | Decision | Reason / tests |
| --- | --- | --- | --- |
| [`frontend/src/components/verify/VerifyDetailShell.tsx`](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/VerifyDetailShell.tsx) | Shared modal frame, image/details/actions layout and next/previous navigation | **Adapt small component** after rights check | Reasonably bounded UI composition; replace camera-trap content with motion summary/source video; test keyboard navigation and accessibility |
| [`frontend/src/components/verify/shortcuts.ts`](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/shortcuts.ts) | Small typed shortcut descriptors and platform modifier names | **Candidate direct small reuse** after rights check | Isolated utility; verify platform modifier behavior |
| [`frontend/src/lib/download.ts`](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/lib/download.ts) | Tiny browser Blob download helper | **Candidate direct small reuse** after rights check | No domain coupling; test filenames, CSV encoding and correct cleanup |
| [`frontend/src/components/verify/StatusBadgeCluster.tsx`](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/StatusBadgeCluster.tsx) | Overlaid confirmed/flagged/favourite badges | **Adapt style, not semantics** | Bat review needs unreviewed/reviewed/QA/finalised, not a `favorite` proxy for QA |
| [`frontend/src/components/verify/VerifyView.tsx`](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/VerifyView.tsx) | Rich filtered event gallery and detail modal | **Pattern only** | Imports many camera-trap APIs, taxonomy, query/state and event-specific components. Reimplement only gallery, filtering and next-unreviewed |
| [`frontend/src/components/verify/useLabelsProgress.ts`](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/useLabelsProgress.ts) | Review completion denominator, careful filter behavior | **Pattern only** | Count **all windows** correctly; no species/detection denominator |
| [`frontend/src/components/verify/EventCountPanel.tsx`](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/EventCountPanel.tsx) | Confirm count and human overrides with keyboard actions | **Pattern only** | Camera-trap MaxN/species cohorts are not emergence event counts; implement explicit nullable event count |
| [`frontend/src/components/verify/VideoPlayer.tsx`](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/VideoPlayer.tsx) | Browser video player with camera-trap detection overlays | **Pattern only** | `.MTS` playback/timebase support is not established by the component; build and test source-specific preview contract |
| [`frontend/src/pages/ExportPage.tsx`](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/pages/ExportPage.tsx) | Consistent download actions for CSV/XLSX and other formats | **UI pattern only** | Do not import maps, export scopes or CamtrapDP from Camera_Trap |
| [`electron/src/main.ts`](https://github.com/cameaci/Camera_Trap/blob/main/electron/src/main.ts) | Starts/stops FastAPI, manages Electron lifecycle, dialogs and errors | **Adapt startup lifecycle** | Its many model/setup-specific features make full copying excessive. Keep one backend, one window, safe shutdown |
| [`electron/src/preload.ts`](https://github.com/cameaci/Camera_Trap/blob/main/electron/src/preload.ts) | Narrow contextBridge for selected Electron APIs | **Adapt narrow IPC** | Only file selection and necessary desktop actions, not backup/model-management features |
| [`backend/app/db/base.py`](https://github.com/cameaci/Camera_Trap/blob/main/backend/app/db/base.py) | SQLite SQLAlchemy connection management, WAL and foreign keys | **Reuse DB discipline, not full ORM** | Stdlib sqlite3 plus a small schema is lighter; test atomic writes, foreign keys, schema incompatibility |
| [`backend/app/models/audit_log.py`](https://github.com/cameaci/Camera_Trap/blob/main/backend/app/models/audit_log.py) | Append-only audited before/after change model | **Adapt record concept** | Small `review_action` table without full audit framework; never overwrite approval history |
| [`backend/app/core/subprocess_group.py`](https://github.com/cameaci/Camera_Trap/blob/main/backend/app/core/subprocess_group.py) | Process-group launching for cancelable descendants | **Conditional small helper** | Use only if FFmpeg cancellation on Windows requires process-tree control; verify lifecycle integration and copied notice |
| [`CONVENTIONS.md`](https://github.com/cameaci/Camera_Trap/blob/main/CONVENTIONS.md) | Fail loudly, type hints, KISS/DRY/YAGNI, local conventions | **Adopt principles** | Codified in root [AGENTS.md](../AGENTS.md); do not replicate unrelated process requirements |
| [`LICENSE`](https://github.com/cameaci/Camera_Trap/blob/main/LICENSE) | MIT licence with 2026 WSP copyright and third-party notices | **Verify rights before reuse** | Do not assume Bat Innovation is already licensed MIT or publish internal project code without authorisation |

**Do not copy:** full 919-entry repository tree; species taxonomy, MegaDetector, SpeciesNet, model library, pretrained weights, spatial dashboards, camera-trap observation semantics, all API routers, migrations, maps, embeddings, WebSocket manager, or existing CI pipelines by default.

## External libraries: use stable primitives, not bespoke equivalents

| Need | Selected primitive | Explicit scope | Rejected premature addition |
| --- | --- | --- | --- |
| Media inspection and preview | [FFmpeg / ffprobe](https://ffmpeg.org/) as versioned local executable | Codec probe, stream timestamps, bounded preview clips, optional orientation/deinterlace | Handwritten media parser, mandatory VLC bridge, giant full-recording transcodes |
| Frame decoding with original PTS | [PyAV 19.0.1](https://github.com/PyAV-Org/PyAV), existing dependency | Sole source pixels/PTS path for import, preview and summaries; Linux synthetic validation does not establish Windows or redistribution readiness | Custom timestamp parsing and dual unsynchronised decode pipelines |
| Pixel operations | [NumPy 2.4.2](https://github.com/numpy/numpy/tree/v2.4.2) | Signed grayscale differences, threshold/gain, temporal maxima and spatial max pooling | Custom Python pixel loops, OpenCV's additional codec stack, optical flow, YOLO/torch |
| Summary PNG and labels | [Pillow 12.1.1](https://github.com/python-pillow/Pillow/tree/12.1.1) | Bounded two-panel PNG, standard text drawing and built-in bitmap font | Custom PNG encoder/font or operating-system font lookup |
| Local API/schema validation | FastAPI with built-in Pydantic ecosystem | Small set of local routes and typed request/response data | GraphQL, API gateway, distributed queue |
| Durable reviews | Python `sqlite3` | Transactions, constraints, schema version, small tables | Separate DB server, heavy migration stack now |
| UI | React + TypeScript + Vite | 1 workspace, review panels, native file selection via Electron | Whole Camera_Trap frontend, maps, global state library or form stack by default |
| Desktop | Electron and narrow preload bridge | Windows shell/installer, loopback app and lifecycle | Python-only throwaway GUI that later needs a rewrite |
| Simple chart/overlay | CSS/SVG/canvas built into browser | Summary thumbs, labels, optional roost polygon later | New annotation framework before clear need |

### Dependency and binary licence review

Before introducing each dependency or bundling FFmpeg, record exact version, package/binary URL, code and binary licence, bundled codec configuration, network behavior and distribution terms. **FFmpeg licensing can differ by build and codecs. PyAV is published under a BSD-style licence, while its binary wheels may bundle FFmpeg with separate terms.** Verify exact versions and packaged binaries. Camera_Trap licence text does not cover independent new dependencies. Avoid shipping model weights in v1.

### Slice 3A inspection and decision

At the same immutable Camera_Trap commit `176451c272628f4f8e38633db747cb427d587072`, inspected `VerifyDetailShell.tsx`, `useLabelsProgress.ts`, `EventCountPanel.tsx`, `models/audit_log.py`, `models/event_observation.py` and `db/base.py`. The [Slice 3A report](../docs/13-slice-3a-validation.md#source-first-design) records their exact blob IDs and licence notices. Navigation, an all-window denominator and attributed audit concepts are pattern-only reuse. Count-zero hiding, AI/human count merging, taxonomy and cascade deletion do not fit provisional source-PTS observations. No Camera_Trap code was copied; no new dependency, lockfile or binary was added. Existing Bat Innovation `SummaryWindows`, `SourcePreview`, narrow IPC, SQLite transactions and standard triggers supply the implementation. Publication authority and binary redistribution gates remain open.

### Slice 2A inspection and decision

Camera_Trap was inspected at [`176451c272628f4f8e38633db747cb427d587072`](https://github.com/cameaci/Camera_Trap/tree/176451c272628f4f8e38633db747cb427d587072). Its [video iterator](https://github.com/cameaci/Camera_Trap/blob/176451c272628f4f8e38633db747cb427d587072/backend/app/ml/inference/video_iter.py), [best-frame selection](https://github.com/cameaci/Camera_Trap/blob/176451c272628f4f8e38633db747cb427d587072/backend/app/ml/best_frame.py), [scoring](https://github.com/cameaci/Camera_Trap/blob/176451c272628f4f8e38633db747cb427d587072/backend/app/ml/inference/scoring.py) and [filmstrip service](https://github.com/cameaci/Camera_Trap/blob/176451c272628f4f8e38633db747cb427d587072/backend/app/services/filmstrip_service.py) produce selected thumbnails using OpenCV/Pillow and frame indices. The filmstrip's `frame_number / frame_rate` time and best-effort skipped files cannot provide exact, complete PTS-window coverage. Its [output preview](https://github.com/cameaci/Camera_Trap/blob/176451c272628f4f8e38633db747cb427d587072/backend/app/ml/postprocessing_outputs/output_preview.py) counts classification-output placement; it is not a motion image generator. These remain **pattern-only** references. No Camera_Trap code was copied for Slice 2A; its MIT/WSP and Peter van Lunteren notices do not establish publication authority for a new copy.

NumPy's versioned [ufunc primitives](https://github.com/numpy/numpy/blob/v2.4.2/numpy/_core/code_generators/ufunc_docstrings.py) and Pillow's standard image/text APIs implement the required pixel and artifact operations without a second decoder or custom native/image/font code. The generated-fixture spike compared consecutive and fixed-reference differences on the same weak-target/noise inputs and measured native NumPy against Python pixel loops. This supports two pinned dependencies rather than adding OpenCV or retaining slow bespoke loops; the [Slice 2A validation report](../docs/12-slice-2a-validation.md) records measurements and exact installed-wheel provenance. Runtime remains offline; installation is a development setup step, not an application download feature.

Before coding, five roles challenged the design:

| Role | Resulting constraint |
| --- | --- |
| IR computer-vision engineer | Preserve weak small changes before spatial max pooling; compare both simple baselines and retain noise/hotspot motion without bat-specific suppression. |
| Ecological reviewer | Keep quiet, failed and quality-flagged windows visible; colored change pixels make no bat, count or absence claim. |
| Desktop/QA engineer | Persist the plan before decoding; test exact PTS boundaries, restart, cancellation and worker-start failure while preserving import/preview. |
| Security/licensing engineer | One reserved Linux worker, hard resource limits, managed UUID artifacts, capped ID-only transfer and explicit dependency/binary notice review. |
| Maintainer | Keep stdlib SQLite and existing lifecycle patterns; use NumPy/Pillow primitives instead of another framework, decoder or custom font/encoder. |

The development wheels have additional bundled-library terms. Their hashes, notices and font usage are recorded once in the [validation report](../docs/12-slice-2a-validation.md#dependency-artifacts-and-licences). Windows execution and binary redistribution clearance remain unverified; no dependency binary or generated media is committed.

## How to avoid writing redundant code

1. Borrow proven **UX behavior** rather than complicated pages.
2. Keep one `SourcePlayer` and one source-timestamp mapper, shared by gallery and QA.
3. Keep a single backend data model for review/edit/QA/export. The frontend never keeps a second authoritative event record.
4. Reuse browser-standard controls for playback and the existing UI primitive layer only for components actually used.
5. Store simple window completion and persisted jobs in SQLite, not a new process orchestration platform.
6. Use existing FFmpeg probing/transcoding rather than implementing AVCHD handling in Python.
7. Keep a documented **do-not-copy** list to prevent transitive dependency growth.

## Reuse acceptance checks

Before bringing over any file: (a) compare the current source version and its imports, (b) verify copyright, licence/notice and authorisation, (c) delete unrelated behavior, (d) make its API domain-neutral or bat-specific as appropriate, (e) add tests for video/QA semantics, and (f) verify that the resulting file set is smaller than wholesale reuse.

A pattern-only decision is **not a workaround**; it is a deliberate choice to preserve behavior without importing invalid camera-trap assumptions.
