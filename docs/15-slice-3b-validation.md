# Slice 3B gallery and source-time navigation

Scope: the user's Slice 3B Practical Manual Review Gallery and Source-Time Navigation request, 2026-10-19. Base: latest `main`, `99656a3fa3b9d0bf85ee9a362bdace41b85db58e`, after merged Slice 3A and Windows feasibility PR #12. Branch: `codex/slice-3b-review-gallery`; immutable final SHA and exact results are recorded in the PR. No Slice 4 or Windows packaging/processing change.

## Source-first design and review

Inspected existing `SummaryWindows`, `ReviewPanel`, `SourcePreview`, media wiring, authenticated binary transport and tests before coding. Camera_Trap was inspected at `176451c272628f4f8e38633db747cb427d587072`: `VerifyView.tsx` blob `674505c296b6ea7f2557c5b1fd84624443fd3214`, `VerifyDetailShell.tsx` `523bdc9d9774f7ce6227714ac909d257c5687e1b`, `shortcuts.ts` `91dd7f5ce52a4953a4e935a0cad3eb14e6c24774`, `useLabelsProgress.ts` `d01072df84aef6a094da3393d8036b9bcc39ebe0`, and licence `46c3a220a513a5cd9d467a8bbf0a43a5e7bb4976`. Pagination/navigation and filter-independent progress are pattern references only; no code is copied. Its hide-empty default, query/domain layers, Radix and icon dependencies are not adopted. Existing MIT/WSP/Peter van Lunteren notices do not establish new copying/publication or binary distribution approval.

Pre-code review covered five roles: vision required the existing exact frame ledger rather than FPS/time conversion; ecology required explicit provisional decisions and every quiet/failed interval; desktop QA required mounted drafts, safe shortcuts and real restart/error paths; security/licensing required fixed authenticated IDs/byte limits and one binary reservation; maintenance kept React state, existing APIs and zero new dependencies. No backend API, schema, audit mutation or decoder change was needed.

## Gallery and navigation

The existing workspace now has 12-card pages in saved processing-run segment/window order. Separate source PTS origins and filenames never create a global survey clock or continuity. Each card retains a run/global position, local segment window, source segment/name/ID, exact rational segment-relative interval, processing/review state, observation count and quality/source errors. Quiet, zero-motion, failed and incomplete windows have explicit accessible cards/placeholders.

All windows is the default. Unreviewed, Reviewed, Contains observations, Quality flagged, Failed/incomplete and Requires re-verification derive only from saved headers and effective review state. Filters/page changes never alter SQLite or the backend's all-window reviewed/total/unreviewed/quality/failure denominator. Selection remains explicit even outside the current page/filter, and an observation save cannot silently select another window when its old card leaves the filter.

Previous, Next and Next unreviewed traverse every run window, independently of the filter; Next unreviewed wraps to another unresolved window. Return to gallery moves focus/scroll without unmounting inspection or resetting the page/filter. Left/Right, U and G work only within the focused inspection region. Inputs, textareas, selects, buttons, links, disclosure summaries, media controls, editable content and interactive ARIA roles are excluded, as are modified, composing, repeated or already-handled events. No shortcut saves or completes review.

Dirty/saving drafts block window, run, page, filter, refresh, processing and gallery-return actions. The editor stays mounted through polling, backend failures and conflicts. Same-window source preview remains available to an open draft; other-window navigation remains blocked. Existing explicit discard, saved reviewer restoration and native close/reload/quit confirmation remain intact.

## Exact displayed-source PTS

The optional buttons copy the exact currently displayed source PTS into the observation's start or exclusive-end field. They consume only the existing `requestVideoFrameCallback` to verified preview-frame-ledger mapping. No second decoder, new FPS mapping, timestamp increment or fabricated frame-step control is added.

The UI-only receipt includes preview/window/segment IDs, original SHA, timebase and original PTS. `BigInt` cross-products compare source/window rational bounds without Number rounding, including values beyond 2^53. A missing/mismatched receipt, out-of-window frame, unavailable source or invalid bound is ineligible. Seeking, cancellation, clip replacement, failure and unmount clear the mapping. A verified frame callback delivered during a paused seek is retained until `seeked`; its existing preview interval and the settled player position can reject a stale candidate, never calculate or choose source PTS. Without an actual mapped callback, copying remains disabled. An exclusive end excludes the displayed frame, and no final-frame duration is inferred. Unknown-ended source previews retain their existing fail-closed behavior. Backend span validation remains authoritative.

Copying changes the draft only. It does not save an observation, change reviewer/decision/revision, append audit history or mark a window reviewed. The two-second preview remains a navigation aid rather than proof of full-interval human assessment. Original-speed, rotation/interlacing and independent clock-anchor warnings are retained.

## Bounded resources and freshness

No image endpoint, thumbnail database or cache service is added. Lazy IntersectionObserver reads use the existing authenticated, checksum/source-validated PNG route. Cards display scaled PNGs; these are not separately encoded thumbnail derivatives. Only the current page (at most 12 cards) and selected full inspection image retain image URLs; previous pages are released, not cached indefinitely.

One small renderer scheduler serializes both PNG and WebM reads, preserving the main process's existing single binary-transfer boundary. Preview/selected-image reads have priority over queued thumbnails. At most 16 reads wait; queued obsolete reads are removed, while cancellation of an in-flight read cannot free the reservation before its real transfer settles. Components ignore obsolete results and revoke their Blob URLs on replacement, filter/page/run change, invalidation and unmount.

At most 12 thumbnail URLs, one inspection image and one source clip are retained: 14 media URLs. Existing 4 MiB PNG/8 MiB WebM caps bound retained Blob payload to at most 60 MiB. This is a payload/object bound, not a renderer RSS cap: transient IPC copies, decoded image/video surfaces, React state and browser garbage collection add memory. A complete manifest still loads once per selected run, bounded by existing backend run/window limits; pages do not request full manifests independently.

Active processing polls every second. Terminal manifests refresh every 30 seconds while visible, on explicit Refresh, after saved actions and after review-storage upgrade. Known image failures coalesce revalidation instead of fetching a full manifest for each bad card. Reads and review decisions independently validate original evidence; source preview keeps its existing live validation. Availability changes elsewhere can take up to the visible 30-second refresh interval to appear in a finished gallery. The UI states this freshness policy; error/refresh paths retain unsaved edits.

## Synthetic evidence and limitations

The gallery tests use actual PyAV import/processing, FastAPI, SQLite and Electron. Eight mixed windows include differing segment PTS origins, exact VFR endpoints, quiet and incomplete evidence. A negative-only temporary SQLite trigger forces a real processing commit failure, leaving a visible failed row and allowing retry; successful media/API/database operations are not substituted. Native dialog results and negative conditions are injected as in existing tests.

A sparse two-hour source contains 480 tiny synthetic frames with explicit times, processed normally into 240 real 30-second window images. All 20 pages are exercised; original IPC handlers and Blob methods are observed without changing results. This tests gallery scale, queue/lifetime bounds and no per-page manifest requests, not full-rate two-hour video throughput or ecological sensitivity. Its sparse 30-second spacing can exceed the existing 10-second seek pre-roll guard for an interior preview: that remains an explicit failure, never a bypass. Successful source-time copying is tested on the separate irregular-PTS fixture and original marker regressions.

Existing review decisions, source hashes, exact span validation, unknown counts, append-only events, stale conflicts, independent runs, source invalidation/re-verification and restart persistence remain in the complete suites. Pure renderer tests exercise queue cancellation/priority/caps/error release and exact rational/identity bounds; they do not stand in for real media integration.

Windows execution, camera-original compatibility, physical native picker, normal Chromium OS sandbox and binary redistribution remain unverified. Windows preview/summary and packaged-runtime rejection are unchanged. Cross-segment/multi-window observation spans, zoom/frame-step, second-review QA, exports, classification and ecological conclusions remain outside this increment. Unsaved in-memory drafts are protected during normal operation, not abrupt OS/renderer loss. No client data or generated artifact is committed.

## Local validation environment

Linux x86_64, Python 3.12.14, pytest 9.0.2, PyAV 19.0.1, NumPy 2.4.2 and Pillow 12.1.1. Node 24.19.0/npm 11.9.0; the unchanged lockfile pins TypeScript 5.9.3, React 19.2.9, Vite 7.3.7, Electron 44.7.2 and Playwright 1.64.1. The existing Python environment was activated with `source /workspace/work/bat-venv/bin/activate`; Node/Electron tests selected the same interpreter through `BAT_PYTHON`. Xvfb supplied local display `:99`. No GitHub Actions or hosted CI was invoked.

The first full Electron run returned 16 passed/1 failed, exit 1: actual VFR seek pixels were correct but the newly added seeking guard discarded their only paused-frame callback. A narrow lifecycle correction retains the actual mapped candidate until `seeked`, bound to its live clip/generation and validated against the existing preview interval. The focused original-marker test then passed (1 test, 23.6s, exit 0). The final gallery test also checks exact known-fixture PTS through forward, reverse and repeated paused seeks before explicit Save. No timeout, success mock, decoder, processing guard or timestamp derivation was substituted.

| Exact command from repository root | Final result | Exit |
| --- | --- | --- |
| `python -m pytest backend/tests -q` | 201 passed, 1 existing warning in 27.46s | 0 |
| `npm run typecheck` | React, Electron and Playwright test TypeScript passed | 0 |
| `BAT_PYTHON=/workspace/work/bat-venv/bin/python npm test` | 43 passed, 0 failed/cancelled/skipped/todo; 7704.824787 ms | 0 |
| `DISPLAY=:99 BAT_PYTHON=/workspace/work/bat-venv/bin/python npm run test:e2e` | 17 passed in 1.7m | 0 |
| `git diff --check` | Passed after source/test/documentation updates | 0 |

Vite (37 modules) and Electron `tsc` builds passed inside both npm test commands. Python retains the existing Starlette/AnyIO deprecation warning; Playwright retains the colour-environment warning. The final test tree adds 11 Node cases and three real Electron scenarios to the merged baseline. Existing independent-run, stale-conflict, reviewer-discard, append-only audit, exact marker/PTS and interruption regressions remain successful.

Final 240-window scale observation: all 20 pages reached, peak binary transfers **1**, peak live Blob URLs **7**, created **74**, revoked **74**, live after unmount **0**, reservation collisions **0**. These observed counts vary with viewport/lazy intersection; enforced/tested bounds remain one active read and at most 14 retained media URLs. There is no claim of a renderer RSS benchmark or representative-camera throughput. Full manifests are not independently requested by page changes.

Post-suite inspection found **zero live backend/import/preview/summary module processes**; the owned Xvfb process was stopped. The 21 changed source/test/documentation files are text only. No media, image, database, environment file, credential, binary, generated output or `work/` content is included. Production requirements, lockfile, Electron/backend runtime source, v4 schema and workflows are unchanged. The PR records the immutable final SHA and clean working-tree status after commit/push. Independent review is required before merge.
