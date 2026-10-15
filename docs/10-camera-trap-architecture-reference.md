# 10 - Camera_Trap architecture reference

Reviewed: 2026-10-15  
Reference repository: [cameaci/Camera_Trap](https://github.com/cameaci/Camera_Trap)  
Purpose: reuse **practical design patterns**, not the codebase or its camera-trap models.

## Verified repository observations

The GitHub repository was **public** when checked on 2026-10-15. Its default branch was `main`.

| Inspected item | What is actually present | Design consequence for Bat Innovation |
| --- | --- | --- |
| [app.py](https://github.com/cameaci/Camera_Trap/blob/main/app.py) | Single Gradio Blocks app with tabs for single image, batch image, folder separation and single video; processing functions are called directly from UI controls; `demo.launch(share=False)`. | Use a **small local Gradio app** with direct Python processing calls. Avoid a separate front-end, API server or cloud tier in v1. |
| [app.py batch processing](https://github.com/cameaci/Camera_Trap/blob/main/app.py) | Batch image inference, JSON output, configurable model/threshold inputs. | Preserve explicit run parameters and structured local outputs. Video-window summaries replace camera-trap image inference. |
| [wildlife_classifier.py](https://github.com/cameaci/Camera_Trap/blob/main/wildlife_classifier.py) and [speciesnet_adapter.py](https://github.com/cameaci/Camera_Trap/blob/main/speciesnet_adapter.py) | Optional model-specific adapters isolate inference behind a simple interface. | Keep model integration **optional**. Do not install or architect around learned detectors until they earn their place in testing. |
| [species_postprocessing.py](https://github.com/cameaci/Camera_Trap/blob/main/species_postprocessing.py) | Small pure functions, including explicit handling of `Unknown` outputs. | Keep event labels and decisions explicit and small; uncertainty is never silently turned into a negative. |
| [tests](https://github.com/cameaci/Camera_Trap/tree/main/tests) | Targeted tests for classifiers, adapters, preprocessing and dataset validation. | Write a few focused tests around frame/time mapping, session segments, image generation, review persistence and exports. |
| [requirements.txt](https://github.com/cameaci/Camera_Trap/blob/main/requirements.txt) | Pinned but substantial ML/detection dependencies, Gradio and OpenCV. | **Do not inherit** the full dependency list. Start with Gradio, OpenCV, NumPy and an FFmpeg/ffprobe installation; add dependencies only when needed. |

### Limit of the comparison

The inspected `app.py` and repository searches **did not establish a completed manual annotation, second-reviewer or ecological QA sign-off workflow**. Therefore Bat Innovation will implement only the **minimal explicitly defined** review and QA states it needs, rather than claiming to reuse an existing complete QA system. No claim is made that the original repository contains no QA/QC anywhere outside the inspected files.

The reference repository includes historical demo material, generated assets, cache files and model-weight binaries in its Git tree. **Do not reproduce that repository footprint**. Bat Innovation should ignore all raw/derived footage, images, survey data, caches and weights by default.

No clear top-level README or licence file was found in the checked tree. Reuse of third-party and reference-repository code is subject to a separate rights check. This architecture review **does not authorise code copying**.

## Reuse versus avoid

**Reuse as patterns**
1. Gradio Blocks as the local operator interface.
2. Direct and testable Python callbacks rather than a service mesh.
3. A single input -> processing -> visualisation -> structured export workflow.
4. Optional processing adapters with clear function contracts.
5. Small focused tests instead of large framework infrastructure.

**Avoid**
1. Bringing across MegaDetector, SpeciesNet, YOLO, PyTorchWildlife, training scripts or camera-trap-specific datasets for a motion-summary MVP.
2. Large one-file implementations as they grow; keep just a few short modules with clear responsibilities.
3. Multiple web services, message queues, orchestration platforms or shared databases before a real multi-user requirement.
4. Checking binary weights, recordings, generated images, `__pycache__`, exported reports or private configuration into the repository.
5. Mistaking inference confidence thresholds for independent ecological QA sign-off.

## Resulting lightweight implementation shape

```text
Bat_Innovation/
  app.py                   # local Gradio interface / user callbacks
  video.py                 # session, segments, timestamps, decode, quality flags
  motion.py                # summary-window processing; optional blobs/tracks later
  reviews.py               # reviewer notes, QA decisions, append-only history
  exports.py               # report-ready CSV and separate technical audit export
  requirements.txt
  .gitignore
  tests/
    test_video.py
    test_motion.py
    test_reviews.py
    test_exports.py
  docs/                    # research, architecture and decisions
```

This is a **proposed code structure**, not a claim that these source files already exist. An additional module is justified only if one of these files becomes difficult to maintain.

## User experience inherited in spirit

Local input selector -> analysis settings -> run -> time-ordered results -> review / QA -> download exports.

For Bat Innovation, the central result is a **time-window motion-summary gallery tied to the original video**, not species predictions. The app should open an original-time clip for verification; tracking overlays are secondary.

See [09 - IR-first architecture](09-ir-first-architecture-draft.md).
