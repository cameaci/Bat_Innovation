# 04 - Data governance, access and deployment controls

Last reviewed: 2026-10-15  
Status: proposed research safeguards, not a legal or WSP policy determination.

## Public repository classification

The GitHub repositories `cameaci/Bat_Innovation` **and** `cameaci/Camera_Trap` were verified as **public** using GitHub metadata on 2026-10-15. Treat all committed Markdown as publicly accessible. It is not an authorised storage location for WSP or client confidential material.

**Do not commit:** original or derived client videos; images, crops or screenshots from client surveys; private spreadsheets; survey coordinates; internal paths; project identifiers; names of clients or confidential sites; contracts; credentials; internal-only policies; model weights trained on restricted data; sensitive ecological locations; or unapproved dataset extracts.

Public papers, public URLs, general methods, generic templates and clearly labelled non-confidential design proposals are appropriate. The referenced Camera_Trap repository is also publicly accessible and contains an MIT licence with a WSP copyright notice; any substantial reuse remains subject to internal ownership, publication and dependency-rights checks. **Non-public vendor demonstrations, meeting transcripts, pricing, screenshots and inferred proprietary internals must not be reproduced in this public repository without permission.** Publicly documented capabilities may be linked and independently summarised.

## Distinct approvals required

1. **Access:** authorised access to original footage and related records.
2. **Provenance:** confirmation of project, survey date, camera, file identity, frame rate, resolution, recording timebase and any transformations.
3. **Ecological QA:** approved event definitions, label authority and final reviewer sign-off.
4. **Research-use rights:** written confirmation that the proposed processing, training, testing, retention and sharing are permitted by the relevant contracts and data owners.
5. **IT/security:** approval of the execution environment, software dependencies, network behaviour, storage and access controls.
6. **External data/software licences:** independent review of dataset terms, source-code licences, model-weight licences and third-party services.
7. **Privacy screening:** original footage and derived summaries may contain people, vehicles, buildings and identifying details. Determine appropriate minimisation, redaction or access restrictions and whether a data-protection impact assessment is required.
8. **Repository IP:** confirm code and documentation ownership, publication rights and licence intent before adding application code to a public repository.

Approval to **view or analyse for project delivery** does not by itself prove permission to **train a reusable AI model**. Similarly, code being open source does not grant rights over footage or model weights.

## Suggested internal data register (store privately, not here)

| Field | Purpose |
| --- | --- |
| Internal dataset ID | Pseudonymous stable identifier |
| Data owner and custodian | Accountability |
| Project and contract clearance reference | Documented reuse scope |
| Camera/survey metadata | Modality, dates, location and equipment |
| Original file identity and checksum | Traceability |
| Original-speed and timestamp evidence | Timing validity |
| QA authority and adjudication record | Label provenance |
| Permitted operations | Review, model training, inference, retention, export |
| Environment and access permissions | Security |
| Retention/deletion obligations | Lifecycle control |

## Processing restrictions

- Run sensitive experiments only in an authorised organisational environment after the above gates are met.
- Confirm access restrictions for cross-team or cross-border reviewers; a local prototype does not automatically authorise network sharing.
- Prefer offline execution, controlled storage, least-privilege access and dependency pinning.
- Disable unapproved telemetry and automatic uploads; verify whether tools download model weights or send diagnostics.
- Do not use public hosted annotation, AI, storage or video services for client data without explicit approval.
- Separate development examples from customer data; use synthetic or suitably licensed public material for open demonstrations.
- Do not publish benchmark examples, model weights or outputs that may expose restricted survey content.

## Release gates

**Gate 0 - Public research and clean-code prototyping:** public literature, shareable source code, synthetic fixtures and appropriately licensed public examples. No client media or unauthorised internal data.

**Gate 1 - Authorised internal feasibility:** documented source access, proposed use rights, environment/security approval, privacy screening and accountable ecological reviewer. Technical metadata audit of client files begins only with these permissions.

**Gate 2 - Controlled evaluation dataset:** validated original-file mapping and original-speed provenance, adjudicated labels, representative positive/negative sampling, defined retention and access controls. Required before claiming measured accuracy or beginning a benchmark.

**Gate 3 - Pilot:** locked benchmark, predefined metrics, ecological acceptance criteria, legal/security review and rollback process.

**Gate 4 - Operational deployment:** repeatable QA, monitoring for missed events and drift, incident response, model/change control, and approved reporting practice.

Current documented status: **Gate 0 only**, including public/synthetic application design. This is not a claim that WSP lacks approvals elsewhere; they have not been established in this public research record.

## Useful public references

- [Bat Conservation Trust - NVA technical guide](https://www.bats.org.uk/resources/guidance-for-professionals/bat-emergence-surveys-with-night-vision-aids-a-technical-guide)
- [CVAT Community self-hosting and licence notes](https://github.com/cvat-ai/cvat)
- [MegaDetector model-specific licences](https://github.com/microsoft/MegaDetector/blob/main/docs/model_zoo.md)

## Practical boundary for a lean prototype

A public repository may contain source code and generic synthetic tests; the executable can still run **locally and offline**. Client footage, time-sync material that may show people/phones, derived summaries, reviewer names, local paths, JSONL logs and exports must remain in authorised storage and be excluded from Git. The initial local Electron/React UI is **not** an authentication system. FastAPI must listen on loopback only; do not expose local projects or videos on a network port. Real footage testing follows the applicable gates; internal policy implementation details belong in private organisational records.
