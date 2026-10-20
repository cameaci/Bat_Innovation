# Implementation plan

Reviewed 2026-10-20. Status: **Slices 0, 1A, 1B, 2A, 3A and 3B are merged; Slice 4A is independently reviewed and merged; Slice 4B1 provisional CSV exports are a review candidate. Early Windows beta Stage A is a feasibility report, not an installer; native Windows, distribution and ownership checks remain open**. This is a dependency-ordered sequence, not a promise of dates. The application is built in **small vertical slices**, each delivering observable behavior and tests. No workarounds or speculative infrastructure.

## Principles of execution

- Do not start with the model, heatmaps, dashboards, server hosting, tracking or Windows installer.
- Every slice must prove an end-to-end path through the necessary layers: source or fixture -> backend -> persistent output -> user-visible result -> test.
- Use the [reuse audit](reuse.md) before implementing frontend/backend utility behavior. Prefer small portable pieces; avoid importing camera-trap domain logic.
- Each slice has a **go/no-go** check. If it fails, correct the relevant design and rerun the tests rather than proceeding with a patch that hides it.
- Gate 0 allows development with generated synthetic or suitably licensed public videos. Real client video and any formal PoC need the applicable data permissions, IT/security and ecological reference approvals.

## Slice 0 - Foundation and reality checks

**Progress (2026-10-15):** The existing Python/FastAPI/SQLite backend is retained unchanged. React and the minimal Electron development shell now exercise authenticated health, session creation and persistence across reload/reopening against the real backend. Linux verification passed 6 Python tests, strict TypeScript checks, Vite build, 13 backend/shell integration assertions and 3 Electron end-to-end tests. See [development and reuse notes](../docs/11-slice-0-development.md) and [research log](../docs/07-research-log.md). Windows execution, packaging and project ownership/publication decisions remain unverified.

- [x] Create original Python FastAPI startup with explicit data directory and per-launch token requirement, plus a local session API.
- [x] Create SQLite v1 session schema and refuse unknown/unversioned databases without silent migration.
- [x] Add local-data `.gitignore` exclusions and backend dependency pins.
- [x] Run six Python tests and real loopback HTTP smoke test on the available Linux development environment.
- [x] Integrate React and Electron and exercise persistent sessions on Linux.
- [ ] Validate Windows development and packaging assumptions.

**Goal:** make the codebase reliably runnable with the selected stack before feature work.

- [ ] Confirm ownership/publication and reuse conditions for Camera_Trap components and planned source code.
- [ ] Verify compatible Windows Python, Node and Electron versions, plus local packaging policy. Pin versions and lock dependencies.
- [x] Create the minimal `backend/`, `frontend/`, and `electron/` layout from [design.md](design.md); avoid importing the full Camera_Trap app.
- [x] Use the existing FastAPI `/api/health` endpoint and a minimal React interface that displays actual backend readiness.
- [x] Add a small SQLite schema/version check and an app-specific local user-data folder; generated/private data must be gitignored.
- [x] Verify Slice 0 local API/IPC restrictions and explicit failures for missing configuration or media prerequisites. Renderer connections and popups are blocked; no runtime downloader is added.
- [x] Add real React -> narrow Electron IPC -> local API -> SQLite tests, including reload/reopen, rejected token, unavailable backend and cleanup.
- [x] Document exact dependency licences and Electron binary notice obligations. Reference reuse is pattern only; no source code was copied. Binary redistribution review remains in Slice 5.

**Exit:** clean install and typecheck/tests pass on the development machine; app connects to a single local backend; an explicit failing dependency displays a useful error. No model downloads or hidden external calls. **Linux functional exit verified.** Windows checks and ownership/publication decisions above remain open; this is not a packaged or production-ready video reviewer.

## Slice 1 - Source-video fidelity spike (first technical risk)

**Slice 1A progress (2026-10-15):** [Issue #3](https://github.com/cameaci/Bat_Innovation/issues/3) implements native import and metadata/PTS inspection against the merged Slice 0 app. PyAV 19.0.1 is the sole production decoder after exact decoded-pixel/PTS comparison with FFmpeg on three generated fixtures. Existing databases require the explicit UI action for the transactional schema 1 -> 2 transition. Imported sources remain untouched; full batches, exact timestamp boundaries, explicit segment order, continuity and optional clock provenance persist in SQLite. Cancellation and progress are visible. See the [research log](../docs/07-research-log.md) for actual commands, licensing evidence and unverified Windows/runtime behavior. No playback/seek or summary feature is claimed.

**Review revalidation (2026-10-16):** At `574c340`, all four required suites passed locally after the PR #4 corrections: 37 Python tests, strict TypeScript, 16 Node tests and 5 Electron E2E tests. Global source uniqueness, unreadable-source classification, unsaved timeline protection and unknown final-frame duration are covered. No further application fix was needed; GitHub Actions was not used. This preceded the independent review and merge of PR #4; Slice 1B progress is recorded below.

**Slice 1B progress (2026-10-16):** PR #4 subsequently merged as `a6fe013`; [issue #5](https://github.com/cameaci/Bat_Innovation/issues/5) now adds bounded source previews on that baseline. The pre-code Electron proof rejected native MPEG-2 MTS playback and an inaccurate native irregular-MP4 seek; 14 PyAV-derived VP9/WebM clips passed all 59 visible-marker checks, including a later keyframe and final single frames. One PyAV source decode/PTS path supplies both the display frames and exact source mapping. The player uses that mapping rather than a browser timer/FPS conversion. Local validation passed 76 Python tests, strict TypeScript, 21 Node checks and 9 Electron E2E tests. No hosted CI was used. PR #6 was subsequently independently reviewed and merged as `bdd52222b0763cebb843f4cc7f8625b0a260828c`, including the preview thread-start cleanup regression. Slice 2A starts from that merged baseline. See the [research log](../docs/07-research-log.md) for limits, commands and measured evidence.

**Goal:** accurate original-video seeking and segmented session import, not a decorative UI.

- [x] Create tiny synthetic CFR and variable-timebase media; at least one AVCHD/MTS-like transport-stream sample and one MP4 sample. Synthetic .ts output does not prove every camera-specific .MTS works.
- [x] Compare FFmpeg decoded pixels/PTS with PyAV using the same generated CFR, nonzero-origin MTS and irregular MP4 frames. Choose PyAV 19.0.1 for one authoritative decode/PTS path; no nominal-FPS timeline or second ffprobe frame pipeline.
- [x] Verify Python >=3.12 and actual Windows wheel availability; inspect code and bundled codec licence evidence. **Windows execution and binary redistribution remain unverified**, with concrete bundled-codec concerns recorded below and in the research log.
- [x] Inspect container, streams, codec, decoded boundaries, exact timebases/rates, dimensions, rotation and interlaced-frame flags through PyAV. Field order remains explicitly unknown where the API does not expose it; unsupported/malformed sources fail clearly.
- [x] Extend the Slice 0 Electron development shell with a **native source-file selector**. Do not simulate large-video import by pushing complete files through a browser upload or accepting arbitrary filesystem paths over HTTP.
- [x] Import **ordered source segments** into a recording session. Record a checksum, exact sequence and explicit `contiguous / gap / unknown` status. Do not assume filenames prove continuity.
- [x] Preserve exact source PTS and segment-relative elapsed boundaries, plus a separate optional UTC anchor bound to a segment ID and its first decoded PTS with provenance. Unknown continuity never creates global session elapsed time or an invented clock.
- [x] Add an explicit, tested schema 1 -> 2 transition that preserves existing sessions and review tables, rolls back failures and never upgrades silently on startup.
- [x] Implement source-PTS navigation within one selected segment, exact segment-elapsed labels and a separately attributed saved clock anchor. Segments are never joined automatically.
- [ ] Implement event/session-clock mapping with defensible continuity and original-speed provenance; preview-relative time is not survey time.
- [x] Implement original-media verification with a bounded player on synthetic Linux media. Compare native browser playback with **on-demand FFmpeg-library preview clips** by actual marker/seek and start/end-boundary tests. Choose one PyAV-derived VP9/WebM path; no extension-based native fallback.
- [ ] Preserve original-speed provenance and flag derivatives of unknown speed.
- [x] Validate import cancellation, missing/changed sources, corrupt/truncated streams, unavailable codecs, unknown/nonmonotonic PTS, explicit gap provenance and short final segments. Playback-specific boundary validation remains in the next increment.

**Exit:** a user can select and inspect multi-part media, click a source timestamp and see the correct source content in the local UI. Clip start and duration are asserted against known synthetic marker frames; original sources are unchanged. Unsupported input yields a clear error.

**Slice 1A limit:** technical import/PTS gate passed on synthetic Linux media. PyAV code is BSD-3-Clause, but the exact wheels bundle separately licensed FFmpeg/codecs; the Windows wheel contains GPL-licensed x264/x265 despite an LGPL FFmpeg self-report. Binary redistribution is uncleared. No representative Canon XA, Sony AX53 or Nightfox original was examined.

**Slice 1B limit:** bounded preview/seek gate passed on generated Linux MP4 and MPEG-TS media only. Preview generation currently requires Linux hard process limits; Windows returns an explicit unsupported-limits state. Display clips are silent yuv420p derivatives, may be resized, and use millisecond display timing with at most 0.5 ms quantisation per frame. Exact original PTS remain separate. Rotation is not applied and interlaced content is not deinterlaced; warnings remain visible. Unknown final-frame duration blocks previews instead of inventing an end. Representative camera originals, Windows runtime, physical native-picker interaction, Chromium OS sandbox and all binary redistribution/packaging remain unverified.

**Stop condition:** if accurate preview seeking cannot be demonstrated, resolve the media design before motion-image work.

## Slice 2 - Complete IR motion-summary baseline

**Slice 2A progress (2026-10-16):** [Issue #7](https://github.com/cameaci/Bat_Innovation/issues/7) adds an explicit schema 2 -> 3 upgrade, exact per-segment window plan, streaming consecutive grayscale differences, atomic two-panel PNGs, durable interruption/cancellation records and a minimal all-window inspection list. The [validation report](../docs/12-slice-2a-validation.md) records synthetic coverage, weak-motion evidence, actual local tests and limits. PR #8 was subsequently independently reviewed, locally revalidated and merged as `2e091358fb1a169c9c7e34f9ce5a5dd89dd0f5f2`. Ecological quality hardening and Windows execution remain open.

**Goal:** produce a reviewer-ready image for every source-time window.

- [x] Build a streaming 30-second (configurable) window iterator per segment; emit final partial windows; prove no dropped or overlapping source coverage.
- [x] Implement and compare the simplest motion-mask candidates on generated weak/fast moving targets and known noise. Start with frame differencing or a simple OpenCV background method, record parameters, and choose on validation evidence.
- [x] Build a two-panel motion summary: reference image and motion evidence with a documented early/middle/late colour legend.
- [x] Flag rather than silently erase significant camera shake/re-aiming, day-to-IR switching, sharp illumination changes and unusable image/codec conditions. Reset background only as an explicit logged operation.
- [ ] Support per-camera exclusion masks only when configured and labelled; no secret hard-coded HUD masking or global insect deletion.
- [x] Store `processing_run` parameters and the complete `summary_window` manifest in SQLite; write images atomically. Interrupted processing is marked incomplete and can be safely restarted without duplicate windows.
- [x] Provide progress and a reproducible processing error record with segment and window identity.

**Exit:** every valid window produces exactly one summary or an explicitly failed record. Given a two-hour continuous recording and 30-second windows, expect 240 coverage records, not necessarily 240 successfully rendered images when errors occur. The UI cannot claim complete if any planned window is missing.

**Stop condition:** if tiny moving targets are not visible in controlled tests, adjust the evidence method or document a blocker; do not tune until they disappear from the benchmark.

## Slice 3 - Camera_Trap-style review interface

**Goal:** make the first fully useful ecological workflow, without automated bat classification.

**Slice 3A progress (2026-10-19):** [Issue #9](https://github.com/cameaci/Bat_Innovation/issues/9) adds explicit per-run/window first-review decisions, zero-to-many provisional observations with exact single-segment source-PTS spans, local reviewer attribution and an explicit transactional schema 3 -> 4 upgrade. Append-only audit events and their projection commit atomically with stale-save conflicts. All planned windows remain in progress; invalidated evidence retains history and requires a new human verification. The existing list/player gains the form, audit inspection and previous/next/next-unreviewed controls. Dirty edits survive polling, conflicts and backend interruption; normal close/reload requires confirmation. See [validation and limitations](../docs/13-slice-3a-validation.md). PR #10 was subsequently independently reviewed, locally revalidated including discarded-actor restoration, and merged as `b4fd13c4325475b413e2072eb539ce00d9a18579`. Fuller gallery/keyboard work and multi-span observations remain Slice 3B; Slice 4 has not begun.

**Slice 3B progress (2026-10-19):** The practical manual-review gallery request extends the merged v4 form/player without backend, schema, dependency or Windows safeguard changes. Twelve-card chronological pages retain all quiet/failed/incomplete windows, seven filters preserve the full denominator, scoped keyboard/navigation protect mounted drafts, and optional displayed-PTS copying uses the existing verified frame ledger. Shared bounded PNG/WebM reads and explicit terminal-run freshness avoid eager full-resolution loading and per-page manifest requests. See [local validation, scale evidence and limits](../docs/15-slice-3b-validation.md). This was independently reviewed and squash-merged as `2f0332cdd1734691ee9ffb1be6fa275b2c8bb660`; multi-span observations and zoom/frame-step remain outside the increment.

- [x] Build a summary gallery and time-ordered list in React. Show **all** windows by default, including apparently empty and quality-flagged windows.
- [x] Inspect the reference app's navigation/keyboard patterns and licence; independently implement the small scoped interaction without copying source or adding dependencies.
- [x] Add seven filters and bounded 12-card pages without changing the all-window review denominator.
- [x] Select a summary and open its source preview at original PTS; retain relative time, separate clock provenance and exact displayed-PTS draft helpers.
- [ ] Add zoom and frame-step only when playback support can prove exact behavior; outside this gallery increment.
- [x] Allow multiple provisional observations within one window, each with one exact original source-PTS span.
- [ ] Allow a single observation to cite multiple source spans when continuity is validated (separate future follow-up, outside this gallery increment).
- [x] Store provisional visual category, optional activity, uncertain/unknown counts and notes. A movement trace never automatically becomes a confirmed bat.
- [ ] Add authorised ecological interpretations separately from provisional visual observations (Slice 4).
- [x] Implement next/previous, next-unreviewed and an all-window reviewed-progress denominator. A quiet window requires an **explicit reviewed/no discernible event** decision to count as reviewed.
- [x] Persist every saved action in local SQLite with append-only attribution; reopening reproduces the same review state. Unsaved in-memory drafts are protected on normal navigation/close, not abrupt OS failure.

**Exit:** a reviewer can complete a sample recording, resume after restarting the app, locate an event on the original source and identify unreviewed/flagged intervals without data loss. No species model or cloud storage is involved.

## Early Windows beta feasibility gate

**Progress (2026-10-19):** Slice 3A PR #10 was independently reviewed, locally revalidated and merged as `b4fd13c4325475b413e2072eb539ce00d9a18579`. [Issue #11](https://github.com/cameaci/Bat_Innovation/issues/11) brings forward a narrow feasibility gate without beginning Slice 4 or wholesale Slice 5. No native Windows environment is attached, so Stage B stops. The [report](../docs/14-windows-beta-feasibility.md) records exact source blockers, a hash-pinned availability-only Windows wheel candidate, native procedures/owners and distribution obligations. Runtime source and existing fail-closed guards are unchanged.

- [x] Inventory packaged rejection, backend/worker paths, import containment, native filesystem/SQLite assumptions and current test limitations.
- [x] Inspect official Windows x64 artifact availability, exact wheel hashes and bundled licence/native-library evidence; distinguish publisher-only runtime checksums from verified wheel bytes.
- [x] Specify the smallest candidate offline layout and native Job Object/storage/cancellation tests without claiming a working build.
- [ ] Approve codec/runtime distribution terms, complete notices/source material and a private channel.
- [ ] Allocate native Windows 10/11 x64 lab machines and verify fixed offline boot without bypassing packaged rejection.
- [ ] Demonstrate bounded import/preview/summary, process-tree cleanup, file confinement/publication and restart on native Windows before enabling media.
- [ ] Validate real native dialog, normal Chromium sandbox, clean install/update/uninstall and preservation of originals/review database.

**Stop:** no usable Windows beta until native boot, safe media processing and approved binary distribution pass. Linux tests, cross-target wheel downloads and static inspection do not close native gates.

## Slice 4 - Minimal ecological QA and exports

**Goal:** preserve actual review authority and produce useful reporting artefacts.

**Slice 4A progress (2026-10-20):** [Issue #14](https://github.com/cameaci/Bat_Innovation/issues/14), based on Slice 3B merge `2f0332cdd1734691ee9ffb1be6fa275b2c8bb660`, adds explicit v4 -> v5 storage, separate append-only QA decisions, observation-linked suggestions and protected gallery/panel navigation. Three optimistic baselines and existing source/PNG/preview validation prevent stale agreement; disagreement remains visible in history. The [report](../docs/16-slice-4a-validation.md) records local synthetic regression evidence and constraints. Independently reviewed and squash-merged as `d9660c79dabec3740855e74ae99f5847620bab76`; no ecological finalisation.

- [x] Implement separate explicit first-review and second-review actions with local attribution, rationale, revisions, disagreement/clarification and retraction history.
- [x] Reject identical normalized first/QA labels and stale QA/first-review/evidence revisions; keep failed/incomplete/all planned windows in separate QA coverage.
- [x] Add transactional rollback-tested schema v4 -> v5, exact observation references, source/PNG/preview validation and restart/kill recovery without rewriting first review.
- [x] Add a small QA panel, visible retained disagreement, next-QA-pending navigation and mutual draft/close protection.
**Slice 4B1 progress (2026-10-20):** [Issue #16](https://github.com/cameaci/Bat_Innovation/issues/16) adds two separate provisional CSVs and a schema/count/snapshot manifest from one read-only v5 snapshot. Exact plans reconstruct missing coverage rows; stale decisions stay unresolved and all planned windows remain the denominator. Native ID-only export/save, reversible text protection, bounded worker/streams, atomic fresh-folder publication and draft protection are covered by local synthetic tests. See [validation and constraints](../docs/17-slice-4b1-validation.md). One unmerged independent-review candidate. No approved ecology template, signoff, Windows packaging or ecological finalisation.

- [x] Export provisional manual observations and an every-planned-window technical audit CSV from one immutable database snapshot, with exact PTS, capped history references and separate review/QA status.
- [x] Protect all text cells reversibly; parse both CSVs, preserve numeric/canonical provenance and test deterministic ordering, clocks, stale evidence, concurrent saves and publication failures.
- [x] Save completed provisional bundles through narrow authenticated IPC/native selection with bounded resources, cancellation, restart cleanup and dirty-draft locks.
- [ ] Obtain a versioned qualified-ecology-owner-approved output template and header/mapping rubric before canonical ecology output or final ecological release.
- [ ] Implement final adjudication/finalisation under designated ecological authority (Slice 4B); unresolved disagreement cannot silently become `finalised`.
- [ ] Keep observations, ecological interpretations and review status in separate fields. Include commuting, foraging, possible or precautionary emergence, re-entry and uncertainty without forcing unsupported counts.
- [ ] Export **two separate artefacts** from one authoritative DB: ecology-oriented CSV (mapped to an approved spreadsheet template), plus a technical audit CSV/JSON containing source PTS, file checksums, warnings, processing run and review history.
- [ ] Support explicit "provisional" and "finalised" output states. Report export must not label unfinished review as final.
- [x] Test stable provisional column order, text/CSV escaping, clock offsets and round-trip of saved decisions with formula protection for every text cell; canonical ecological template compatibility remains gated above.

**Exit:** an independent reviewer can disagree, resolve or leave unresolved an event; outputs preserve provenance. No double counting occurs from duplicated summary windows, segments or re-running an analysis.

## Slice 5 - Windows packaging and resilience

**Goal:** a reproducible local install, not new infrastructure.

- [ ] Implement minimal Electron startup, local backend process management, restrictive preload and native file selection using the actual Camera_Trap pattern.
- [ ] Use an app-specific user-data directory; bundle or explicitly install a vetted FFmpeg binary and required Python runtime without first-run internet dependency. Check codec and binary licences.
- [ ] Ensure API uses loopback, restricted origin and safe file-ID-based access. Test invalid path, port conflict, rejected IPC calls and shutdown cleanup.
- [ ] Test start, analyse, cancel, reopen, resume, export and uninstall behavior on a clean Windows VM/workstation. Original videos are never deleted by uninstall.
- [ ] Create a concise user/technical guide and lock dependency versions for repeatable builds.

**Exit:** packaged application runs offline, starts and closes cleanly, and reproduces core workflow results. Do not declare a Windows installer ready based on a dev-browser test alone.

## Slice 6 - Authorised ecological pilot (gated)

**Goal:** determine whether the app is **useful and acceptably safe**, not prove AI superiority.

- [ ] Verify original media access/rights, permitted local environment, privacy screening, data custodian and qualified ecological sign-off.
- [ ] Audit representative **original-speed IR** sources, codec metadata, file splits, clock offsets and source/annotation mapping.
- [ ] Import existing spreadsheet annotations as **unverified prelabels** only when rights and mapping are established.
- [ ] Independently adjudicate the **union** of human and app candidates; audit selected quiet intervals and disagreements.
- [ ] Pre-register ecological lead's acceptance criteria for missed emergence/re-entry, false alerts/hour (if candidate alerts are used), survey-level roost conclusions, peak-count agreement and review time.
- [ ] Compare full-video manual review to all-window summary-assisted review, including QA and rechecking time. Sample across different cameras, weather/lighting conditions and survey types.
- [ ] Stop, refine or expand based on [tests.md](tests.md), not a vendor claim or isolated success screenshot.

**Exit:** signed pilot report with raw numerator/denominator, confidence/limitations, missed-event analysis, review-time measurements, decisions and release recommendation. No automatic operational approval is implied.

## After the first successful pilot (not pre-built)

Only if supported by measured benefit: motion blobs and tracking (OpenCV/Norfair), roost-zone entry/exit suggestions, better insect rejection, cross-camera review, model training, acoustic synchronisation or thermal support.

## Dependency graph

```text
Rights + minimal stack
          |
Local media/PTS + usable source preview
          |
Complete streaming window summaries
          |
Review gallery + persistent decisions
          |
QA and two exports
          |
Offline Windows installer
          |
Authorised independent ecological validation

Gate 1 rights/environment and Gate 2 adjudicated benchmark
can progress in parallel with synthetic code development,
but must be satisfied before claims based on client footage.
```

## Definition of done for every slice

- Production behavior works on a positive and a negative case.
- Unit/integration tests pass and no test result is invented.
- Source video unchanged and evidence traceable to original segment + timestamp.
- Errors are visible and unprocessed windows are counted, not silently skipped.
- No uncontrolled network, client data in source control or dependency/licence surprises.
- Code is materially smaller and easier to reason about than copying Camera_Trap wholesale.
- The relevant docs and open decisions have been updated without redundant prose.
