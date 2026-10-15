# 10 - Camera_Trap architecture reference

Reviewed: 2026-10-15  
Reference: [cameaci/Camera_Trap](https://github.com/cameaci/Camera_Trap) (default branch: `main`)  
Purpose: inspect the **actual current codebase** and reuse its proven application patterns without copying its size or unrelated features.

## Correction to the previous review

An earlier version of this document described a root-level Gradio `app.py` and claimed that QA/QC and a top-level licence could not be verified. **That description does not match the current repository.** Direct inspection of the current GitHub tree and source shows an Electron/React/FastAPI/SQLite desktop application, explicit verification workflows, and a top-level MIT `LICENSE` carrying a WSP copyright notice. The earlier architecture recommendation based on Gradio is withdrawn.

## Verified current implementation

| Layer / feature | Evidence in the public repository | Pattern relevant to Bat Innovation |
| --- | --- | --- |
| Windows desktop shell | [`electron/src/main.ts`](https://github.com/cameaci/Camera_Trap/blob/main/electron/src/main.ts) and [`electron/package.json`](https://github.com/cameaci/Camera_Trap/blob/main/electron/package.json) | Electron opens the application and manages the local Python backend lifecycle; a Windows installer is built with electron-builder |
| User interface | [`frontend/package.json`](https://github.com/cameaci/Camera_Trap/blob/main/frontend/package.json), [frontend conventions](https://github.com/cameaci/Camera_Trap/blob/main/frontend/FRONTEND_CONVENTIONS.md) | React + TypeScript + Vite, reusable UI components and consistent presentation |
| Python backend | [`backend/app/main.py`](https://github.com/cameaci/Camera_Trap/blob/main/backend/app/main.py) | FastAPI endpoint layer calling Python application / processing functions |
| Local persistence | [`backend/app/db/base.py`](https://github.com/cameaci/Camera_Trap/blob/main/backend/app/db/base.py) | SQLite with locally persisted project, file and verification state; Camera_Trap uses SQLAlchemy and Alembic, but Bat Innovation may start with a smaller schema |
| Verification gallery | [`VerifyView.tsx`](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/VerifyView.tsx), [`VerifyDetailShell.tsx`](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/VerifyDetailShell.tsx) | Filtered cards, detail viewer, next/previous navigation and review controls |
| Review completeness | [`useLabelsProgress.ts`](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/useLabelsProgress.ts) | Counts verified items against the full relevant review universe. Bat Innovation must similarly account for every video summary window |
| Human count correction | [`EventCountPanel.tsx`](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/EventCountPanel.tsx) | Human-confirmed counts and notes, with a confirmation action. Camera-trap event counts are **not** automatically equivalent to emergence counts |
| Exports | [`ExportPage.tsx`](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/pages/ExportPage.tsx), [export backend](https://github.com/cameaci/Camera_Trap/blob/main/backend/app/api/crud/export.py) | Local CSV/XLSX exports based on persisted user corrections |
| Packaging / offline behavior | [User guide](https://github.com/cameaci/Camera_Trap/blob/main/wsp/docs/USER_GUIDE.md) | Installer, application data folder and local analysis after initial setup. **Do not assume every dependency is bundled or fully offline on first start** |
| Conventions / rights | [`CONVENTIONS.md`](https://github.com/cameaci/Camera_Trap/blob/main/CONVENTIONS.md), [`LICENSE`](https://github.com/cameaci/Camera_Trap/blob/main/LICENSE) | Type hints, explicit errors, minimalism, DRY and tests; MIT licence with WSP copyright and third-party notices |

Both `Camera_Trap` and `Bat_Innovation` were confirmed **public** through GitHub repository metadata on 2026-10-15. The Camera_Trap licence is not automatically the licence or copyright policy for Bat Innovation. Check ownership and approval before substantial code transfer.

## What to reuse

**Application pattern**

```text
Electron desktop window
          |
React + TypeScript review interface
          |
FastAPI on local loopback interface
          |
Small Python video-processing and review functions
          |
Local SQLite + local derived summaries + original videos in place
```

**Specific product conventions**

- One coherent review gallery, keyboard next/previous and next-unreviewed, full-size preview, fast confirmation.
- Persisted review status and user corrections. Report reviewed counts, not just generated detections.
- Distinguish raw automated proposals from human decisions. Keep source media unchanged.
- One export function used consistently by the UI and tests, with report versus audit data separated.
- Clear error messages, typed interfaces, straightforward module boundaries, no duplicated business logic.
- Local application data outside the source tree and a small set of targeted tests.
- Reuse styling and UI interaction ideas; assess rights before copying concrete components or branding.

## What not to copy

Camera_Trap has a large, mature feature set and many more files than Bat Innovation needs. Do **not** import its model catalogue, SpeciesNet / MegaDetector workflows, embedding similarity search, training code, maps, dashboards, wildlife taxonomy, model installers, cloud integrations, extensive database migrations, or giant dependency set merely because they exist.

A bat NVA **recording session** is also not a camera-trap deployment, and a 30-second summary window is not automatically a bat event. Keep the bat domain model small and explicit rather than renaming camera-trap entities.

## QA/QC: reuse the pattern, not the ecological conclusion

The reference app demonstrably has human label confirmation, count correction, verified-progress indicators and exports that use review decisions. It does **not** by itself establish the required bat-survey **independent ecology QA / final roost sign-off policy**. Bat Innovation should use the same review interaction style, but define a small ecology-specific decision flow:

1. `unreviewed`
2. `reviewed` by the first reviewer
3. `qa_pending` or `qa_reviewed`
4. `finalised` by the designated ecological approver

Observation, ecological decision, count and review status are separate fields. Store identity and a simple change history. A local reviewer-name field does not amount to enterprise authentication.

## Lean implementation translation

Mirror the **three existing application layers** with only the features needed now:

```text
Bat_Innovation/
  backend/
    app/
      main.py          # minimal FastAPI routes
      video.py         # ffprobe, sessions, segment and clock mapping
      motion.py        # streaming window summaries and quality flags
      reviews.py       # persistence and review/QA transitions
      exports.py       # reporting and audit CSV
      db.py            # small SQLite schema/access
    tests/
  frontend/
    src/
      App.tsx
      components/      # gallery, player, review panel
  electron/
    src/main.ts        # minimal desktop shell, when packaging
  docs/                # research and decisions
```

A single developer can build and test the processing and review layers before packaging with Electron. Start with `sqlite3` or a small SQL layer; migrate to an ORM and migrations **only if schema changes make them worthwhile**. Do not introduce Redis, queues, a central database, auth service or microservices for a single-user local app.

This is a **proposed layout**. No application source files are committed to Bat Innovation yet.

## Direct references

- [Camera_Trap README](https://github.com/cameaci/Camera_Trap/blob/main/README.md)
- [Camera_Trap conventions](https://github.com/cameaci/Camera_Trap/blob/main/CONVENTIONS.md)
- [Camera_Trap frontend conventions](https://github.com/cameaci/Camera_Trap/blob/main/frontend/FRONTEND_CONVENTIONS.md)
- [Camera_Trap review gallery](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/VerifyView.tsx)
- [Camera_Trap event count editor](https://github.com/cameaci/Camera_Trap/blob/main/frontend/src/components/verify/EventCountPanel.tsx)
- [Camera_Trap user guide](https://github.com/cameaci/Camera_Trap/blob/main/wsp/docs/USER_GUIDE.md)

See [09 - IR-first application architecture](09-ir-first-architecture-draft.md).
