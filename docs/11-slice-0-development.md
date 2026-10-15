# Slice 0 development shell

This foundation displays authenticated backend readiness, lists recording sessions and saves synthetic session metadata in SQLite. Reopening the app reads the same database. It does not import or review videos or produce ecological results.

## Run locally

Use Node 24, npm and Python 3.12. The existing backend requires `ffmpeg` and `ffprobe` on `PATH` even though this slice does not decode media. Install a locally approved build; this change does not download or distribute either executable. Check `node --version`, `python --version`, `ffmpeg -version` and `ffprobe -version` first.

From the repository root on Windows PowerShell:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements-dev.txt
$env:BAT_PYTHON = (Resolve-Path .\.venv\Scripts\python.exe).Path
npm ci
npm run setup:electron
npm run dev
```

On Linux/macOS:

```sh
python -m venv .venv
.venv/bin/python -m pip install -r backend/requirements-dev.txt
npm ci
npm run setup:electron
export BAT_PYTHON="$PWD/.venv/bin/python"
npm run dev
```

`npm ci` installs the locked JavaScript packages. Electron 44 requires the separate `npm run setup:electron` step to download and install its platform runtime; the npm package has no automatic postinstall download. Complete that setup before launching or running desktop tests. The installed runtime is then available offline.

`npm run dev` builds the UI and Electron TypeScript, then opens Electron. Rebuild/reopen after editing; there is no Vite development server or hot reload. A standalone browser preview reports that the desktop bridge is unavailable.

The default database is `data/bat_innovation.sqlite3` under Electron's application-specific user-data folder, outside the checkout. Closing the window preserves it. For an isolated synthetic check, set `BAT_APP_DATA_DIR` to an absolute directory outside the repository before launching; shell state then lives in its `shell/` subdirectory. `BAT_PYTHON` selects an executable, and optional `BAT_API_PORT` selects a valid loopback port. Without that override the shell selects a free loopback port. These are trusted launcher settings, never renderer inputs. Do not configure or save `BAT_API_TOKEN`; Electron creates it.

Create a synthetic session, refresh or reload, quit, and reopen with the same data directory. The saved row must remain. A failed startup or request displays an explicit error. Refresh retries a health check; prerequisite/startup failures require fixing the cause and reopening. Closing the final window quits Electron and waits for its owned backend to stop.

## Verification commands

```sh
python -m pytest backend/tests -q
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Activate the Python environment containing the pinned backend requirements before running `python -m pytest`, or invoke that environment's interpreter directly. Keep `BAT_PYTHON` set to the same interpreter for the Node and Electron tests. The Electron end-to-end tests require the platform runtime installed by `npm run setup:electron` and a graphical desktop; on a Linux test host with Xvfb, use `xvfb-run -a npm run test:e2e`. Do not disable Electron's sandbox for normal development. Actual command results and environment-specific launch options are recorded in [the research log](07-research-log.md).

## Origin and process decision

Both development and eventual packaging use built static assets at `app://bat/index.html`. There is one renderer origin and no renderer HTTP API client. The preload exposes only `health()`, `listSessions()` and `createSession({display_name, camera_ref})`. The main process verifies the sending window, main frame and exact document URL before handling IPC.

The main process calls only the existing `/api/health` and `/api/sessions` endpoints on `127.0.0.1`. It generates 32 random bytes per launch with Node's cryptographic RNG, passes the hexadecimal token through the child environment and adds `X-Bat-Token` to requests. The token is absent from frontend assets, bridge results, configuration files and logs. Backend authentication and CORS behavior are unchanged; no CORS relaxation is required because a browser does not make these requests.

The renderer has context isolation, sandboxing and web security enabled, with Node integration disabled. CSP disallows network connections, frames and forms. Navigation, new windows, permissions and downloads are denied. The custom protocol serves only the built entry page and generated JS/CSS assets. No renderer API accepts filesystem paths, commands, URLs, ports or tokens.

The shell owns one non-shell Python child, waits for authenticated readiness and stops that child on quit. It never reuses or kills a process discovered by port. A port reservation race or occupied override fails explicitly. App closure sends termination, with a bounded force-kill fallback, and waits for the child to close.

The shell checks configured data directories before creating shell state, resolving existing symlink ancestors to reject paths leading into the checkout. Invalid or unwritable configuration produces an explicit startup error.

## Source inspection and reuse

The reference was inspected at Camera_Trap commit [`176451c272628f4f8e38633db747cb427d587072`](https://github.com/cameaci/Camera_Trap/commit/176451c272628f4f8e38633db747cb427d587072), not inferred from older descriptions:

| Source | Git blob SHA | Decision |
| --- | --- | --- |
| [`electron/src/main.ts`](https://github.com/cameaci/Camera_Trap/blob/176451c272628f4f8e38633db747cb427d587072/electron/src/main.ts) | `8f6eb5df74d97ab694310f583c876366be9c27e5` | Pattern only: own a backend process, await readiness, isolate renderer and await shutdown. |
| [`electron/src/preload.ts`](https://github.com/cameaci/Camera_Trap/blob/176451c272628f4f8e38633db747cb427d587072/electron/src/preload.ts) | `fec5ace3a341c069fc01584a918a36b49d6c11d0` | Pattern only: operation-specific contextBridge methods; omit its filesystem, model and application APIs. |
| [`electron/package.json`](https://github.com/cameaci/Camera_Trap/blob/176451c272628f4f8e38633db747cb427d587072/electron/package.json) | `7c15257355aaea30b1ee8b4273759aa59cb8243b` | Reuse Electron/TypeScript/Playwright choices; omit builder, store and release workflow. |
| [`frontend/package.json`](https://github.com/cameaci/Camera_Trap/blob/176451c272628f4f8e38633db747cb427d587072/frontend/package.json) | `a97180ce35a05c484d8affa09f896915458b529c` | Reuse React/TypeScript/Vite choices; omit routing, state, styling, forms, maps and ML dependencies. |
| [`LICENSE`](https://github.com/cameaci/Camera_Trap/blob/176451c272628f4f8e38633db747cb427d587072/LICENSE) | `46c3a220a513a5cd9d467a8bbf0a43a5e7bb4976` | Public MIT terms identify WSP, 2026, and a third-party notice for Peter van Lunteren, 2025. |

All added application code is independently authored; no Camera_Trap file or source snippet was copied. The published MIT licence was verified, but publication/ownership authority and Bat Innovation's project licence have not been independently confirmed. This change does not claim that approval or grant a new project licence. Future code copying must resolve the repository's authorisation requirement and retain all applicable copyright and permission notices.

The five-role review before coding found: no computer-vision algorithm is needed; ecological wording must describe a foundation; desktop QA must exercise actual SQLite persistence and process cleanup; security/licensing require a token-free renderer and pattern-only reuse; maintainability favors built-in HTTP/process APIs and no extra framework. Those constraints define this slice.

## Dependency and binary licence audit

Exact npm package versions and integrity hashes are recorded in the root `package-lock.json`. The reason for each direct dependency is limited to the selected stack and real UI integration tests:

| Package | Version | Package licence | Use |
| --- | --- | --- | --- |
| [`react`](https://registry.npmjs.org/react/19.2.9), [`react-dom`](https://registry.npmjs.org/react-dom/19.2.9) | 19.2.9 | MIT | Renderer. |
| [`vite`](https://registry.npmjs.org/vite/7.3.7) | 7.3.7 | MIT | Static UI build; no runtime development server. |
| [`typescript`](https://registry.npmjs.org/typescript/5.9.3) | 5.9.3 | Apache-2.0 | Strict UI, shell and test typechecking. |
| [`electron`](https://registry.npmjs.org/electron/44.7.2) | 44.7.2 | MIT | Local development desktop runtime. |
| [`@playwright/test`](https://registry.npmjs.org/@playwright/test/1.64.1) | 1.64.1 | Apache-2.0 | Real Electron/React/API/SQLite integration tests. |
| [`@types/node`](https://registry.npmjs.org/@types/node/24.10.1) | 24.10.1 | MIT | Node 24 types. |
| [`@types/react`](https://registry.npmjs.org/@types/react/19.2.5) | 19.2.5 | MIT | React types. |
| [`@types/react-dom`](https://registry.npmjs.org/@types/react-dom/19.2.3) | 19.2.3 | MIT | React DOM types. |

Package metadata was checked against the [npm registry](https://registry.npmjs.org/) on 2026-10-15. Electron 44.7.2 requires Node >=22.12 for installation; Vite 7.3.7 supports Node ^20.19 or >=22.12; Playwright 1.64.1 requires Node >=20. Node 24 meets those declared constraints. These are dependency compatibility checks, not Windows runtime validation. Updated patch versions were selected within the React 19.2 and Vite 7 lines; the TypeScript 5.9 compiler follows the reference stack.

Upstream terms: [React](https://github.com/facebook/react/blob/main/LICENSE), [Vite](https://github.com/vitejs/vite/blob/main/LICENSE), [TypeScript](https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt), [Electron](https://github.com/electron/electron/blob/main/LICENSE), [Playwright](https://github.com/microsoft/playwright/blob/main/LICENSE), [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/LICENSE).

The lockfile records 87 registry package entries, including optional platform variants: 77 MIT, 5 Apache-2.0, 3 ISC, 1 BSD-2-Clause and 1 BSD-3-Clause. Exact versions, package tarball URLs, integrity hashes and declared licences are recorded per entry. MIT/BSD/ISC copyright and permission notices and applicable Apache licence/NOTICE files must accompany redistributed portions; this is not permission to remove upstream notices.

The explicit `npm run setup:electron` command downloads the platform runtime; installing the Electron npm package alone does not. The Linux x64 development artifact is [`electron-v44.7.2-linux-x64.zip`](https://github.com/electron/electron/releases/download/v44.7.2/electron-v44.7.2-linux-x64.zip). That runtime includes Chromium, Node and other components with separate terms: retain its supplied `LICENSE` and `LICENSES.chromium.html` in any later distribution. Package MIT metadata alone is not a complete binary redistribution audit. This slice ships no installer, Python binary, FFmpeg binary, codecs or model weights. The existing Python pins are unchanged. Transitive package licences remain with their installed packages; a distributable notice bundle, exact platform binary and codec review belongs to Slice 5.

Dependency installation needs approved registry/GitHub access. Application runtime performs no external downloads, telemetry, update checks or cloud calls.

## Limits

Windows development execution, clean-machine installation, signing, installers and binary redistribution are unverified and remain in Slice 5. Packaged startup is explicitly refused until a vetted Python runtime is configured. The current Linux end-to-end harness passes `--no-sandbox` for its container launch, so its renderer-isolation checks do not verify Chromium's operating-system sandbox. Normal quit and signal cleanup can be tested; a forced operating-system kill or power loss cannot run Electron quit handlers. There is no media picker, ingestion, decoding, timeline, motion analysis, review/QA, report, species ID or cloud functionality in this change. Tests use synthetic metadata only.


## PR #2 review refinement: safe startup diagnostics (2026-10-15)

The independent code review identified a specific usability defect: Electron previously reported a generic startup error when an existing SQLite file had an unsupported schema or was unreadable. The correction keeps the implementation small and avoids brittle traceback parsing:

- \`DatabaseSchemaError\` identifies unsafe/unrecognised schema versions without altering the file.
- The Python entry point writes one fixed redacted code, \`BAT_STARTUP_ERROR:database_schema\` or \`BAT_STARTUP_ERROR:database_unreadable\`, and exits before starting the server.
- Electron recognises only these fixed codes and its existing missing-media-tool diagnostic, then displays actionable text. It does not expose tracebacks or private paths.
- A real \`BackendRuntime\` integration regression test seeds future-schema and unversioned SQLite databases and asserts the original file bytes remain identical and the child process exits.

**Validation performed independently:** The exact GitHub Python sources (\`backend/app/main.py\`, \`backend/app/store.py\`, \`backend/app/__main__.py\`) and existing \`backend/tests/test_foundation.py\` were copied into an isolated local test directory; their Git blob SHA values matched this PR. \`python -m pytest backend/tests -q\`: **6 passed**. Three additional real \`python -m backend.app\` subprocess cases (future-schema, unversioned and corrupt SQLite) each exited with code 1, produced the expected fixed startup code, emitted no traceback or private data-directory path, and left database bytes unchanged. Six isolated Node tests for the updated diagnostic mapping also passed.

**Limit:** The complete TypeScript/Vite and Electron integration test suites were **not rerun independently** for these corrections because the local environment has no installed npm/Electron dependencies and cannot fetch them. The original Codex-reported Linux test results apply to the earlier commit only. Windows execution and default Chromium OS sandbox remain unverified. These limitations must not be presented as passing tests.
