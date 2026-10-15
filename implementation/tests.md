# Testing and ecological evaluation

Reviewed: 2026-10-15. Status: **Slice 0 synthetic session tests pass on Linux; media and ecological tests below remain planned**. Quality requirements are part of implementation, not a later add-on.

## Testing layers

| Layer | Automated or human? | Core check |
| --- | --- | --- |
| Python unit | Automated | Segment/PTS mapping, window coverage, motion-mask behavior, camera-change flags, SQL transactions, exports |
| API integration | Automated | Bad input, source allowlist, SQLite round trip, interrupted run, review transition, media preview status |
| React unit/component | Automated | Gallery includes quiet windows, navigation, status and count forms, unreviewed totals |
| Desktop smoke | Automated/manual on Windows | Electron startup/shutdown, packaged binaries, local preview, offline operation, process cancellation |
| Ecological benchmark | Independent human adjudication | Emergence/re-entry visibility, missed events, survey-level conclusions, counts and time savings |

Use ordinary `pytest`, minimal frontend test tooling and focused Electron smoke tests, following existing Camera_Trap choices only where they keep dependency count low. CI should run synthetic fixtures and never fetch private WSP data or model weights.

## Synthetic fixtures: small and deterministic

Generate short monochrome video fixtures with known source timestamps and moving shapes. They are **software regression fixtures**, not realistic substitute bat validation data.

| Fixture | Expected assertion |
| --- | --- |
| Stationary dusk image, no moving object | A summary window still exists; may be reviewed as quiet; not labelled verified no bats automatically |
| Tiny, fast, low-contrast moving shape | Motion trail remains visible with a documented parameter set, or test identifies method weakness |
| Moving insect-like shape near an IR hotspot | Candidate motion not silently removed by bat-specific shape filter |
| Abrupt global brightness shift / daylight-to-IR cut | Window quality flag and background reset/re-initialisation are visible |
| Tripod translation / camera re-aim | Stability warning; old roost region requires reconfirmation |
| Dynamic on-screen timestamp / torch beam | Noise effect measured; optional explicit masks/quality warnings |
| Portrait/rotated, interlaced and blurred source | Metadata inspection and controlled handling or explicit unsupported warning |
| Segment shorter than 30s, arbitrary-length final segment | Last partial window is generated; no missing coverage |
| Two source segments with an unknown gap | No fictional continuous survey timestamp is manufactured |
| Event across window or known-contiguous segment boundary | Source spans remain traceable; no automatic double count |
| Variable presentation timestamps | Video seek and event timestamps match actual PTS, not nominal fps arithmetic |
| Re-encoded or accelerated derivative | Provenance marked; no unsupported real-world clock claim |
| Corrupt/truncated media, missing file, unsupported codec | Failed status and actionable error, no successful summary record |
| Simulated process kill, disk full, cancellation | Atomic writes, persisted incomplete status, clean restart or explicit repair request |
| Unreviewed/quiet/uncertain/QA disagreement | Correct state transitions and stable review completeness denominator |
| Note beginning with spreadsheet formula character | Safe spreadsheet export without dropping or misrepresenting the note |
| Personal-data-looking or site-location metadata in local outputs | Excluded from public artefacts; no upload/telemetry |

**Synthetic tests cannot establish a zero missed-bat rate.** An ecologist-approved set of real original-speed IR clips is necessary for event-level sensitivity.

## Media truth tests

For playback/seek, create clearly identifiable visual marker frames at predetermined PTS values. Test:
- source stream timebase versus nominal fps;
- direct playback and, where needed, FFmpeg-generated preview clips;
- seek accuracy around segment starts/ends and representative interior points;
- re-opened session after source file moved/modified;
- continuity status when source segments have gaps.

Do not mark an `.MTS` input as supported merely because a synthetic `.ts` container decoded. Confirm representative camera originals under Gate 1. Record the supported codecs, not just extensions.

## Window coverage invariant

For each segment, the union of successfully processed and **explicitly failed/flagged** interval records must account for every planned segment interval, including the final partial interval. Planned and completed counts are distinct.

A processing run may be `complete` only if all planned windows have valid, traceable outputs and no unresolved fatal error. A window with a camera-change flag still exists and remains reviewable; a window whose image could not be produced must be shown as a failure requiring source-video review.

Use coverage tests rather than assuming `duration / 30` is an integer or that every nominal 25-fps frame exists.

## Human review QA tests

- One window can contain zero, one or many distinct observations.
- One observation may cite more than one original-time range; deduplicate only when an ecologist establishes one event.
- An imported workbook row is `prelabel`, not `finalised`.
- Initial review and independent QA can disagree; the disagreement remains visible until a qualified final reviewer resolves it.
- A reviewer can explicitly mark a quiet window as reviewed; an automatically empty summary cannot mark itself reviewed.
- Review edits have an append-only audit record and survive application restart.
- Export uses **current adjudicated values** and includes provenance; uncertain/provisional records are unmistakably labelled.
- Progress = reviewed windows / all in-scope windows, with denominator unaffected by a "show only unreviewed" filter.

## Ecological acceptance test (after data access and reference QA)

Use independent review of the **union** of manually detected, QA-discovered and app-assisted candidate events. Human manual labels are not an infallible reference. Apply the approved label rubric to genuinely unreviewed intervals.

Primary outcome measures:
1. **Missed emergence/re-entry events**, with case reviews and event recall.
2. **Survey-level conclusion agreement**: roost/feature presence interpretation and the implications of a missed single event.
3. **Count agreement**: peak/emergence count where supportable; unknown stays unknown.
4. **Total review effort**: gallery scanning, source-video checking, QA, corrections and exports versus existing review.
5. **Traceability and window completeness**: exact source seek, timing, provenance and audit history.

For a future candidate detector also measure false alarms/hour and precision. A summary-image approach should measure **visible event coverage** and reviewer misses rather than mislabel image panels as object detections.

The qualified ecological owner must set an allowable missed-event margin, confidence level and any review-time goal **before** acceptance. No numeric safety threshold is imposed by this research repository. As an illustration only, zero misses among `n` independent positive events gives an approximate 95% upper bound of `3/n`; site/session clustering and reference uncertainty invalidate a naive interpretation of that bound.

## Slice 0 commands and evidence

Run from the repository root with the backend Python environment selected:

```sh
python -m pytest backend/tests -q
npm run typecheck
npm run build
npm test
npm run test:e2e
```

The root lockfile pins workspace dependencies. `npm run typecheck` includes React, Electron and Playwright test TypeScript. `npm test` builds, then runs Node's real backend integration suite. `npm run test:e2e` builds, then exercises the real Electron/React/API/SQLite path. No API responses are mocked.

On the Linux development host, 6 Python tests, strict TypeScript checks, Vite build, 13 Node integration assertions and 3 Electron tests passed after a clean npm install. The end-to-end tests check live readiness, create/list, persistence after reload and reopening, token regeneration, terminated/missing backend errors, narrow bridge behavior and backend process cleanup. The Node suite additionally tests real HTTP 401 responses and filesystem/configuration boundaries. See [setup and limits](../docs/11-slice-0-development.md) and [command outcomes](../docs/07-research-log.md).

Electron tests currently use Linux `/proc` and `ps`, and launch with `--no-sandbox` inside the test container. Windows execution and Chromium's operating-system sandbox are unverified. Imported media, packaging, offline clean-machine Windows behavior and ecological benchmarks remain later-slice checks.
