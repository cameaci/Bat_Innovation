# 10 - Camera_Trap architecture reference

Reviewed 2026-10-15. The detailed component-by-component assessment and reuse rules live in [implementation/reuse.md](../implementation/reuse.md).

## Verified reference

The public [cameaci/Camera_Trap](https://github.com/cameaci/Camera_Trap) repository uses an **Electron desktop shell, React + TypeScript frontend, FastAPI Python backend and SQLite storage**. The source also contains human verification, count correction, review-progress and export workflows. Its root [MIT licence](https://github.com/cameaci/Camera_Trap/blob/main/LICENSE) carries a WSP copyright notice.

Direct references:
- [Desktop lifecycle](https://github.com/cameaci/Camera_Trap/blob/main/electron/src/main.ts) and [secure preload](https://github.com/cameaci/Camera_Trap/blob/main/electron/src/preload.ts)
- [Frontend dependencies](https://github.com/cameaci/Camera_Trap/blob/main/frontend/package.json), [verification gallery](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/VerifyView.tsx) and [shared detail shell](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/VerifyDetailShell.tsx)
- [Count correction](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/EventCountPanel.tsx), [review progress](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/useLabelsProgress.ts) and [export UI](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/pages/ExportPage.tsx)
- [FastAPI entry point](https://github.com/cameaci/Camera_Trap/blob/main/backend/app/main.py), [SQLite configuration](https://github.com/cameaci/Camera_Trap/blob/main/backend/app/db/base.py), [audit log](https://github.com/cameaci/Camera_Trap/blob/main/backend/app/models/audit_log.py)
- [Coding conventions](https://github.com/cameaci/Camera_Trap/blob/main/CONVENTIONS.md) and [user guide](https://github.com/cameaci/Camera_Trap/blob/main/wsp/docs/USER_GUIDE.md)

An earlier note incorrectly described Camera_Trap as a Gradio app. Direct inspection of the live \`main\` branch disproved this; that recommendation was withdrawn.

## Decisions for Bat Innovation

**Reuse** the desktop/API pattern, narrow file-picker IPC, small UI utilities where rights permit, gallery/navigation/verification ergonomics, persistent human corrections and report exports.

**Do not copy** the full app, camera-trap species/MaxN semantics, large model library, maps, training stack, database migrations, all routers or heavyweight UI dependencies. A bat event is not the same thing as a camera-trap event, and manual verification does not automatically confer ecological sign-off.

The complete file-level **copy/adapt/pattern-only/reject** decision, associated licence conditions and regression tests are in [implementation/reuse.md](../implementation/reuse.md). The intended lean design is in [implementation/design.md](../implementation/design.md).
