# 09 - IR-first application architecture decision

Updated: 2026-10-15  
Status: **selected architecture, not implemented**. The authoritative engineering specification is [implementation/design.md](../implementation/design.md); this document records the decision without duplicating it.

## Decision

Build a **small offline Windows desktop app** using the same basic layers as [Camera_Trap](https://github.com/cameaci/Camera_Trap):

\`\`\`text
Electron desktop window and native file selection
            |
React + TypeScript review interface
            |
Local FastAPI and Python video-processing code
            |
SQLite review state + derived local summaries
            |
Original active-IR video, unchanged
\`\`\`

A minimal Electron development shell is required for safe native file selection during the first media-fidelity test. Distributable Windows packaging comes later. A **single local backend and one job at a time** suffice for v1.

## First workflow

1. Import one camera recording session with **ordered original segments**, without assuming gap-free continuity.
2. Inspect source media and obtain actual frame presentation timestamps. Verify \`.MTS\` and \`.MP4\` playback and original-speed provenance.
3. Generate a **time-ordered motion image for every configured time window**, including quiet and low-quality intervals.
4. Review summaries in a Camera_Trap-style gallery, seek to original-video evidence and record observations.
5. Carry out explicit first review, separate QA correction and final ecological approval.
6. Export workbook-compatible ecological rows and a **separate technical audit**.

Tracking and roost-region possible-emergence hints are future options, **not required for the first useful version**.

## Critical invariants

- **Time:** original PTS, segment-relative time, optional session time and optional survey clock must not be conflated. Phone-clock offsets and source-file continuity require provenance.
- **Scene:** tripod footage may shift. Camera movement, day-to-IR switching and illumination changes must be flagged; a roost region is invalid after a viewpoint change until reconfirmed.
- **Biology:** a motion pixel is not a bat; a tracked object is not automatically an individual or roost emergence.
- **Review:** every summary window is accessible, and unreviewed does **not** mean negative. Source-linked spreadsheet annotations are **prelabels**, not final ground truth.
- **Quality:** human and app evidence may disagree; ecological sign-off and survey-level conclusions have separate owners.
- **Data:** original footage and generated derivatives remain in authorised local storage. No cloud API, public media upload or automatic model training.

**Thermal and acoustic processing are explicitly out of v1.** Multi-camera individual reconciliation and enterprise shared hosting are deferred until a documented need and permitted deployment model exist.

## Implementation and evaluation

- [Agent/developer working rules](../AGENTS.md)
- [Implementation index](../implementation/README.md)
- [Technical design and data contracts](../implementation/design.md)
- [Camera_Trap reuse audit](../implementation/reuse.md)
- [Sequenced delivery plan](../implementation/plan.md)
- [Testing and ecological evaluation](../implementation/tests.md)
- [Design review and refinement](../implementation/review.md)
- [Data governance and gates](04-data-governance.md)

Gate 0 permits clean-code and synthetic/licensed-public test work. Access-controlled original footage requires applicable permissions and privacy/security review; a performance benchmark also needs adjudicated ecological reference data. No acceptance threshold or WSP pilot approval has been established.
