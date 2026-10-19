# Slice 3A manual review validation

Scope: [Issue #9](https://github.com/cameaci/Bat_Innovation/issues/9), based on independently reviewed Slice 2A merge `2e091358fb1a169c9c7e34f9ce5a5dd89dd0f5f2`. This is a local first-review candidate. No classification, species/roost conclusion, second-review QA, export, cloud feature or Slice 4 work is included.

## Source-first design

Camera_Trap was inspected at immutable commit `176451c272628f4f8e38633db747cb427d587072`: `VerifyDetailShell.tsx` (blob `523bdc9d9774f7ce6227714ac909d257c5687e1b`), `useLabelsProgress.ts` (`d01072df84aef6a094da3393d8036b9bcc39ebe0`), `EventCountPanel.tsx` (`230a46aca5ab9ef501a8657986079a37c4416bad`), `models/audit_log.py` (`4b57f35839bf60039229b43d0096431399c30e71`), `event_observation.py` (`7a301b3dc2b9f2caf2cf2d4d1c06b4ca5dbc8a3b`) and `db/base.py` (`a81ed0e64925cfbde9d69640d54b99a7cb765e62`). Paths are under its frontend verification components or backend app. Its MIT licence (blob `46c3a220a513a5cd9d467a8bbf0a43a5e7bb4976`) carries WSP 2026 and Peter van Lunteren 2025 notices. Navigation/progress/audit concepts were reused as patterns only; no source code was copied and no copying-right assumption was introduced. Count-zero hiding, detector confidence, AI/human count coalescing, taxonomy and cascade deletion were rejected for this contract. No dependency or lockfile change was needed.

Before coding, IR vision review required no bitmap/browser-time conversion into source evidence; ecological review required explicit provisional human decisions and unknown counts; desktop QA required stale-edit, restart and native close checks; security/licensing review required bounded ID-only requests and enforced audit immutability; maintenance review kept the existing list, player and standard SQLite without another framework.

## Review and provenance contract

Every selected-run window starts explicitly unreviewed, including quiet, failed and incomplete windows. Viewing, navigation, zero motion and saving an observation never complete review. Only a deliberate, attributed action sets `reviewed_with_observations` or `reviewed_no_discernible_event`. The former requires saved observations; the latter requires none. An unable-to-assess annotation stays unresolved. A locally entered reviewer label provides attribution, not authentication.

Each provisional observation has a stable ID, one imported segment and one exact half-open integer source-PTS span, visual category, optional activity, nullable integer count, uncertainty and notes. Unknown is null, never an invented zero. Validation uses exact Fraction comparisons against the immutable segment and selected window; no FPS, player seconds, image position or inferred survey clock is used. Interior fractional window boundaries are not rounded. An unknown final endpoint is not invented: annotations conservatively end no later than the last known decoded PTS, and an unknown-ended window cannot be completed. Multi-window/multi-segment spans remain outside 3A.

Completion requires a currently available, known finite source interval and a ready source-preview receipt matching segment, source SHA, timebase and actual source PTS within that window. The UI obtains the receipt from the existing loaded source player. Keep that preview open until saving the decision. A two-second preview is a navigation aid; its existence does not prove the human assessed the entire interval. That responsibility remains explicit. A failed image-less summary can be manually assessed using a valid original; unavailable/changed originals, empty gaps and unknown ends cannot be silently cleared.

Review progress uses all planned windows and the durable expected count, with distinct reviewed, unresolved, quality-flagged, failed and incomplete counts. A missing ledger row does not shrink the denominator. Decisions bind to run/window/source/parameter provenance; new summary runs start with independent unreviewed state. Historical decisions remain recorded after invalidation, while their effective state and progress become unresolved with a re-verification warning.

## SQLite and audit integrity

The explicit transactional v3 to v4 migration creates two tables: `review_event` contains append-only event deltas, and `review_window` is their current projection. Observation lists are bounded SQLite JSON columns, not a parallel JSON-file database. A mutation checks an optimistic window revision under `BEGIN IMMEDIATE`, appends the actor/UTC/action/previous/new values and affected source span, then updates the projection in that same transaction. Stale saves return a conflict and retain the UI draft. Observation create/edit/delete resets completion to unreviewed in its own attributed event. Deletion retains its prior values in history.

SQLite triggers reject event UPDATE, DELETE and conflicting INSERT OR REPLACE. Tests replay event deltas and compare the resulting observations, decision and revision with the projection after reopen. A two-writer race yields one committed action and one conflict; rollback appends neither half of a change. Migration rollback preserves prior tables/provenance and removes partial new schema. This is application audit integrity, not tamper-proof storage: a database owner can change the database or schema.

Two derived processing fields on `summary_window`, `evidence_revision` and `evidence_warning`, latch availability transitions separately from human review history. This closes the case where identical PNG bytes or metadata are restored after invalidation: restoration must not automatically revive an old reviewed decision. Epoch transitions are atomic and survive restart; repeated unchanged validation has a read-only fast path. They never overwrite historical terminal processing errors, human review revisions or audit events. A new explicit verified decision is needed to bind the new epoch. Unreviewed-window polling does not perform epoch writes.

## Boundaries and draft protection

Four narrow review operations extend the existing authenticated loopback API, plus a trusted boolean draft-state IPC call. Exact fields, UUIDs, integer PTS, actor/category/count types and revision bounds are checked in Electron and Python. Actions are capped at 8 KiB before server JSON parsing; observations at 100 per window; notes at 2000 characters; actor/activity at 120; history pages at 50 actions. No renderer-supplied media path, image URL or SQL is accepted. Original media stays unchanged.

The existing selected-window view adds previous, next and next-unreviewed buttons, an observation editor, explicit review actions and audit inspection. Drafts block refresh/run/window/session changes and processing controls. Same-window preview remains available without discarding the editor. Polling, stale conflicts, source invalidation and backend errors preserve draft values. Native close, quit and reload ask Keep editing or Discard draft; the backend is stopped only after the window actually closes. A renderer beforeunload guard covers queued dirty IPC. Saved audit/projection survives restart. Abrupt renderer/OS termination cannot run confirmation and unsaved in-memory drafts are not crash-recoverable.

## Final local validation

Validated 2026-10-19 on Linux, on `codex/slice-3a-manual-review` from `2e091358fb1a169c9c7e34f9ce5a5dd89dd0f5f2`. The PR records the immutable final commit SHA. Python used the existing `/workspace/work/bat-venv`; no dependency or lockfile changed. Versions: Python 3.12.14, pytest 9.0.2, PyAV 19.0.1, NumPy 2.4.2, Pillow 12.1.1, Node 24.19.0, npm 11.9.0, TypeScript 5.9.3, Vite 7.3.7, Electron 44.7.2 and Playwright 1.64.1.

| Exact command from the repository root | Result | Exit |
| --- | --- | --- |
| `source /workspace/work/bat-venv/bin/activate` then `python -m pytest backend/tests -q` | 201 passed, 1 existing warning, 26.86s | 0 |
| `npm run typecheck` | React, Electron and test TypeScript passed | 0 |
| `BAT_PYTHON=/workspace/work/bat-venv/bin/python npm test` | 32 passed, 0 failed/cancelled/skipped, 7378.728209 ms; Vite/Electron builds passed | 0 |
| `DISPLAY=:99 BAT_PYTHON=/workspace/work/bat-venv/bin/python npm run test:e2e` | 14 passed, 1.5m; Vite/Electron builds passed | 0 |
| `git diff --check` | No whitespace errors | 0 |

The display was a local Xvfb `:99` server (`-screen 0 1280x800x24 -nolisten tcp`), stopped after testing. All suites ran locally; no GitHub Actions was invoked. The existing Starlette/AnyIO deprecation and Playwright colour-environment warning were retained. A resumed session lost the first full E2E command's terminal output, although its persisted Playwright status was passed; the full suite was rerun above to capture the exact count and exit.

New coverage comprises 37 review-store cases, 20 real FastAPI/SQLite review cases, 3 Node integration cases and 3 Electron scenarios, alongside all previous regressions. Store tests enforce append-only UPDATE/DELETE/REPLACE rejection, replay deltas against reopened state, inject transactional failure, and verify one winner/one conflict for concurrent writes. API tests cover 30/30/5 and nonzero/VFR source windows, fractional boundaries, failed/image-less and unknown-ended intervals, exact spans, unchanged source SHA, independent runs and restoration requiring another human action. Electron exercises zero/one/many observations, edits, unknown counts, real source-preview loading, progress and audit reopening. It keeps the draft through stale conflicts and native Keep editing on close/reload/quit, then stops the actual backend with SIGSTOP and kills it with SIGKILL during Save; PTS, actor and notes remain visible, and only committed actions survive reopening.

Post-suite process inspection found zero live backend, import, preview or summary module processes. The proposed change contains 29 text source/test/documentation files. No tracked media, images, databases, generated artifacts, environment files, credentials or `work/` contents are included. Dependencies, lockfiles, original decoding/motion algorithms and the manual-only workflow are unchanged.

## Remaining technical limits

Windows execution/resource enforcement, representative camera-original AVCHD compatibility, physical native picker interaction, Chromium OS sandbox and PyAV/FFmpeg/NumPy/Pillow binary redistribution remain unverified. Linux Electron tests use Xvfb and test-only `--no-sandbox`; only native dialog results are substituted, while decoding, API, image and database operations remain real. No production installer or binary distribution is delivered.

Original speed, rotation/interlace fidelity, full-survey performance and ecological sensitivity remain unverified. Source and published-image integrity are rechecked; hashing reviewed images during selected-run polling is bounded by existing output quotas but large-run latency is not benchmarked. The existing ENOSPC fixture injects an actual image-write failure rather than filling a mounted volume; physical power loss is untested. This manual first-review audit is provisional and supports no automated absence, species, count or roost conclusion.
