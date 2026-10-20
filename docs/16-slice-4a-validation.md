# Slice 4A independent second-review QA

Scope: [Issue #14](https://github.com/cameaci/Bat_Innovation/issues/14). Base: latest `main`, `2f0332cdd1734691ee9ffb1be6fa275b2c8bb660`. One unmerged review candidate. No exports, ecological finalisation or Windows changes.

## Inspection and pre-code design review

Read project instructions, implementation/design/testing/reuse, evaluation, scope and Slice 3B evidence. Inspected the existing review store, evidence epoch/fingerprint/receipt validator, authenticated routes, strict IPC, gallery and dirty-close handling. Camera_Trap `176451c272628f4f8e38633db747cb427d587072` audit model (`4b57f35839bf60039229b43d0096431399c30e71`), progress hook (`d01072df84aef6a094da3393d8036b9bcc39ebe0`) and MIT licence (`46c3a220a513a5cd9d467a8bbf0a43a5e7bb4976`) were inspected directly. Patterns only; no copied code, new dependency or publication-right assumption.

Five-role challenge before coding: vision requires unchanged original PTS/preview receipts, not a new decoder; ecology requires separate provisional QA, all-window denominators and retained disagreement, never finalisation; desktop QA requires mutual draft locks, restart/conflict tests and normal close protection; security/licensing requires ID-only bounded payloads/history, identical normalized actor rejection and unchanged Windows guards; maintenance requires two small persistence/service modules and one React panel, reusing existing evidence validation and SQLite transactions.

Design: explicit transactional v4 -> v5 creates separate QA event/projection tables. Every explicit save/update/retraction appends UTC/actor, exact run/window/source binding, first-review/evidence baseline and before/after values under optimistic QA, first-review and evidence revisions. Suggestions reference an existing immutable observation ID and its last edit revision; source PTS/first-review rows remain untouched. Evidence restoration cannot revive prior QA because the existing durable evidence epoch is included. Different local labels do not prove different people. Failed/unknown-ended/unavailable evidence cannot be agreed clear. Drafts remain mounted and both stages block each other's edits/navigation while dirty.

## Implemented contract

- Explicit `POST /api/qa/upgrade` alone upgrades an existing v4 database. Existing upgrades remain idempotent on v5; startup does not migrate. QA tables have foreign keys and event UPDATE/DELETE/conflicting REPLACE guards. Event/projection writes share one `BEGIN IMMEDIATE` transaction.
- Each action requires a nonblank local label, exact expected QA/first-review/evidence revisions and explicit confirmation. Agreement, disagreement and clarification require a current valid first review and complete finite evidence. Agreement/disagreement additionally require the existing current original-preview receipt. Written rationale is required for disagreement, clarification, unassessable notes and retraction. Retraction appends a pending projection and keeps all earlier events.
- Actor comparison uses Unicode NFKC, collapsed whitespace and case folding against the current first-review actor. This rejects identical labels, not impersonation. Local labels are attribution, not authentication or proof of independence.
- Suggestions are optional on disagreement/clarification. They cite an existing observation UUID and last create/edit event revision in this same window, retaining an original-observation snapshot including exact source PTS. Nullable count means unknown; suggested category/count/note remain explicitly provisional. Neither the first observation nor its history is changed.
- QA events store UTC, actor, run/window/segment/source SHA/timebase/interval/parameter binding, first-review/evidence baseline, old/new values and revision. First-review edits or observed source/PNG invalidation make previous QA stale. Existing evidence epochs prevent identical restoration silently reviving agreement. First review must be explicitly verified again where needed before a fresh QA action. New runs start with independent histories.
- Current QA counts partition **all planned windows** into agreed, disagreed, needs clarification, pending and unassessable. Stale is an additional unresolved flag, not extra denominator credit. Missing planned rows contribute pending coverage. First-review progress stays separate. A retained-disagreement marker remains visible even after later QA changes; historical disputes are never deleted or treated as formal adjudication.
- The small selected-window panel shows current/historical status, rationale, suggestion and paginated audit, plus explicit Save/Retract/Discard. Next QA pending traverses chronological windows whose current QA is not agreed, including disagreement, clarification and unassessable states, independently of gallery filters. Viewing, preview opening, filtering and navigation cannot save QA.
- First/QA drafts lock each other's editing and all window/run/session/filter/refresh navigation; same-window source preview remains available. Drafts remain mounted through backend errors and optimistic conflicts. Explicit discard restores the saved QA label; normal close/reload/quit uses the existing native Keep editing/Discard guard. No authoritative timestamp is computed in React.

The four new Electron functions are `upgradeQA`, `getWindowQA`, `saveQA` and `qaHistory`. Existing trusted-frame checks enforce exact argument counts. Fixed UUID routes, strict allowlists, 8 KiB UTF-8 action caps, bounded fields and 50-event cursor pages preserve the authenticated loopback boundary. Known failures use fixed renderer messages. No filesystem path, token, generic fetch or new media worker is exposed.

## Verification and refinements

The new Python cases exercise real SQLite and API operations; successful decoding, evidence validation and persistence are not mocked. Only negative OS/DB conditions and the physical picker/confirmation return are injected. Cases include:

- Explicit migration preservation/idempotence and complete DDL rollback on failure; existing v4 review/import/summary operations still work on v5.
- Immutable event replay, before/after continuity, update/delete/replace refusal, transactional projection-write failure and pagination. A real child is killed by a test-only SQLite trigger after its event INSERT but before its projection UPDATE; reopening recovers the prior state, `integrity_check` is `ok`, and a subsequent production write succeeds.
- One winner/one rejection under simultaneous SQLite writers and simultaneous real HTTP requests. QA/evidence/first-review stale revisions reject without QA history changes; a shared active-operation rejection is HTTP 409 and retains drafts.
- Normalized identical actors, rejected unconfirmed/malformed/oversized UTF-8 input, authentication, UUID/cursor/path boundaries, unavailable/foreign preview, wrong observation/window/edit revision and failed/incomplete/unknown-ended coverage.
- Original nonzero-origin MTS and VFR MP4 timebase/PTS/interval bindings, a weak noisy moving target retaining early/middle/late evidence, source/PNG identity invalidation/restoration, independent runs and restart persistence. QA never alters source bytes, PNG bytes or first-review events.
- Real Electron decision/suggestion/retraction/history/restart flows; no QA on inspection; no first-review mutation; explicit same-label rejection; source-change stale status and all-window totals. Dirty tests cover both stages, text controls/scoped keys, close/reload/quit cancellation, a concurrent first-review action and real SIGSTOP/SIGKILL backend loss during QA Save.

Focused validation found duplicate sibling React keys resetting panel state during draft locking. Distinct `review:<window>` and `qa:<window>` keys fix the underlying lifecycle problem; both-stage draft assertions now pass. The v5 summary-start guard was also extended through the existing supported-schema tuple. A reference-validation fixture initially exceeded the existing sparse-video pre-roll limit; two short real synthetic sources now isolate that reference test without changing the guard. Original sparse-limit regression coverage remains intact. Malformed suggested-category objects are rejected without string coercion. No timeout relaxation, simulated successful media response or Windows exception was added.

The existing 240-window/20-page gallery scale test now explicitly upgrades to v5 and verifies 0/240 QA agreed with every window pending. It continues to check serialized real binary reads, bounded Blob lifetimes and complete cleanup. This is a sparse UI regression, not a full-rate camera-survey or renderer RSS benchmark. No new image endpoint/cache/dependency is added; Slice 3B bounds and freshness policy remain unchanged.

## Final local commands and results

Linux x86_64; Python 3.12.14, pytest 9.0.2, PyAV 19.0.1, NumPy 2.4.2, Pillow 12.1.1. Node 24.19.0/npm 11.9.0; unchanged lockfile pins React 19.2.9, TypeScript 5.9.3, Vite 7.3.7, Electron 44.7.2 and Playwright 1.64.1. Activated `source /workspace/work/bat-venv/bin/activate` before pytest; Node/Electron selected the same interpreter through `BAT_PYTHON`. Xvfb supplied local display `:99` with test-only `--no-sandbox`; this does not verify Chromium's normal OS sandbox.

| Exact command from repository root | Final result | Exit |
| --- | --- | --- |
| `python -m pytest backend/tests -q` | 244 passed, 1 existing warning in 50.72s | 0 |
| `npm run typecheck` | React, Electron and test TypeScript passed | 0 |
| `BAT_PYTHON=/workspace/work/bat-venv/bin/python npm test` | 45 passed; 0 failed/cancelled/skipped/todo; 11063.964245 ms | 0 |
| `DISPLAY=:99 BAT_PYTHON=/workspace/work/bat-venv/bin/python npm run test:e2e` | 19 passed in 2.1m | 0 |
| `git diff --check` | Passed after final source/test/documentation updates | 0 |

Vite (38 modules) and Electron `tsc` builds passed inside both npm suites. The existing Starlette/AnyIO deprecation and Playwright colour-environment warnings remain visible. New coverage adds 43 Python cases, two Node tests and two real Electron scenarios; the prior suites remain passing. The final full Electron rerun includes the last strict suggestion-field validation refinement, not only the earlier focused pass. No GitHub Actions or hosted CI was invoked.

Final v5 sparse scale observation: 240 real windows, all 20 pages reached, 0/240 agreed and 240 pending before human actions, peak binary transfers **1**, peak live Blob URLs **3**, created/revoked **45/45**, live after unmount **0**, reservation collisions **0**. Lazy-intersection counts vary with viewport/timing; enforced bounds remain one active binary read and at most 14 retained media URLs. No RSS/full-rate performance claim follows.

Post-suite inspection found **zero live backend/import/preview/summary processes**. The owned Xvfb was stopped. The 29 intended source/test/documentation files are text only; no generated media/image/database, credentials, environment file, binary, installer or `work/` output is included. Requirements, npm lockfile, workflows, decoder/worker code and Windows platform safeguards are unchanged. The PR records the final immutable SHA and clean working-tree status after commit/push. Leave unmerged for independent technical review.

## Remaining limitations

Synthetic Linux development validation only. Native Windows execution, representative camera originals, physical native picker/confirmation interaction, normal Chromium OS sandbox and PyAV/FFmpeg/binary redistribution remain unverified. Windows hard-limit and packaged-runtime rejection are unchanged. This slice adds no installer, classifier, ecological conclusion, formal final signature, report/audit export or Slice 4B work.

Different labels cannot prove independent people or ecological authority. Append-only protection is an application/SQLite integrity property, not protection from a database owner replacing the file or dropping triggers. Unsaved memory-only drafts cannot survive abrupt renderer/OS loss. A current two-second preview receipt proves source linkage, not that someone watched a whole interval. Existing source-speed, rotation/interlacing and unknown-clock warnings remain; segments are not joined and final-frame durations are not invented.

Terminal gallery availability can lag the existing visible 30-second refresh interval; explicit reads/saves independently revalidate evidence. Full manifests and saved-evidence validation retain existing bounds; large QA histories/full-rate survey performance, physical power loss and full mounted-disk behavior are not benchmarked. No ecological sensitivity, production-readiness or Windows acceptance claim is made.
