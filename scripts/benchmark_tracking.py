"""Benchmark a tracker version against scenes with exact ground truth (Phase 3 X2). Not part of the app.

Usage: python scripts/benchmark_tracking.py [--algorithm tracks-v2] [--scene NAME ...] [--raw] [--json OUT]

Each synthetic scene from `backend/tests/scenes.py` is encoded and decoded through the same codec path as test
fixtures (unless --raw), tracked in-process, and its gate crossings are matched to the true crossings by direction
within plus or minus 5 frames. Reported per scene: true crossings, the algorithm proposal (coherent tracks) as
recall and precision, the size of the uncertain queue a person would review, non-noise tracks per true bat
(fragmentation), false non-noise tracks per minute on scenes without bats, and frames processed per second.
Numbers describe synthetic scenes only; they are not ecological accuracy.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import av  # noqa: E402
import numpy as np  # noqa: E402

from backend.app import gates, tracks  # noqa: E402
from backend.tests import scenes  # noqa: E402
from backend.tests.summary_fixtures import encode_frames  # noqa: E402

TOLERANCE_FRAMES = 5


def through_codec(scene: scenes.Scene) -> list[np.ndarray]:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / f"{scene.name}.mp4"
        encode_frames(path, scene.frames, scene.times_ms)
        with av.open(str(path)) as container:
            return [frame.to_ndarray(format="gray") for frame in container.decode(container.streams.video[0])]


def match(found: list[tuple[int, str]], truth: list[tuple[int, str]], tolerance_ms: int) -> int:
    """Greedy one-to-one matching in time order; returns the number of matched crossings."""
    used = [False] * len(found)
    matched = 0
    for when, direction in truth:
        best = None
        for index, (at, which) in enumerate(found):
            if used[index] or which != direction or abs(at - when) > tolerance_ms:
                continue
            if best is None or abs(at - when) < abs(found[best][0] - when):
                best = index
        if best is not None:
            used[best] = True
            matched += 1
    return matched


def evaluate(scene: scenes.Scene, algorithm: str, raw: bool) -> dict:
    frames = scene.frames if raw else through_codec(scene)
    settings = {**tracks.DEFAULT_SETTINGS, **scene.settings}
    analyzer = tracks.analyzer(algorithm, frames[0].shape[1], frames[0].shape[0], scenes.FPS, 0.001, settings)
    started = time.monotonic()
    for at, image in zip(scene.times_ms, frames):
        analyzer.feed(at, image)
    found, events, stats = analyzer.finish()
    elapsed = time.monotonic() - started
    proposal, uncertain = [], []
    for track in found:
        if track.quality == "noise":
            continue
        crossed = gates.crossings([(p[0], p[1], p[2]) for p in track.points], scene.gate)
        (proposal if track.quality == "coherent" else uncertain).extend(crossed)
    truth = [(scene.times_ms[frame], direction) for frame, direction in scene.truth()]
    tolerance = TOLERANCE_FRAMES * 1000 // scenes.FPS
    matched = match(proposal, truth, tolerance)
    real = [track for track in found if track.quality != "noise"]
    minutes = len(frames) / scenes.FPS / 60
    return {"scene": scene.name, "true_crossings": len(truth), "proposed": len(proposal), "matched": matched,
            "recall": round(matched / len(truth), 3) if truth else None,
            "precision": round(matched / len(proposal), 3) if proposal else None,
            "uncertain_queue": len(uncertain), "tracks": len(real), "bats": len(scene.bats),
            "tracks_per_bat": round(len(real) / len(scene.bats), 2) if scene.bats else None,
            "false_tracks_per_min": round(len(real) / minutes, 1) if not scene.bats else None,
            "events": {kind: sum(event.kind == kind for event in events) for kind in ("camera_moved", "lighting_change", "glitch")},
            "fps": round(len(frames) / elapsed, 1)}


def table(rows: list[dict]) -> str:
    columns = ["scene", "true_crossings", "proposed", "matched", "recall", "precision", "uncertain_queue", "tracks_per_bat",
               "false_tracks_per_min", "fps"]
    lines = ["| " + " | ".join(columns) + " |", "|" + " --- |" * len(columns)]
    for row in rows:
        lines.append("| " + " | ".join("-" if row[column] is None else str(row[column]) for column in columns) + " |")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--algorithm", default=tracks.ALGORITHM_VERSION)
    parser.add_argument("--scene", action="append")
    parser.add_argument("--raw", action="store_true", help="skip the encode/decode round trip")
    parser.add_argument("--json", type=Path)
    args = parser.parse_args()
    available = scenes.scenarios()
    names = args.scene or list(available)
    rows = [evaluate(available[name], args.algorithm, args.raw) for name in names]
    print(f"Algorithm {args.algorithm}; tolerance plus or minus {TOLERANCE_FRAMES} frames; synthetic scenes only.\n")
    print(table(rows))
    if args.json:
        args.json.write_text(json.dumps({"algorithm": args.algorithm, "rows": rows}, indent=2))


if __name__ == "__main__":
    main()
