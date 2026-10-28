"""Synthetic moving-target videos with known paths for tracking and gate tests (never real media)."""

from __future__ import annotations

import json
from pathlib import Path
import sys

from backend.tests.summary_fixtures import encode_frames
from backend.tests.test_tracking import scenario


def generate_tracking_media(directory: Path) -> dict[str, Path]:
    directory.mkdir(parents=True, exist_ok=True)
    result = {}
    for name in ("two_dots", "crossing"):
        path = directory / f"tracking-{name.replace('_', '-')}.mp4"
        encode_frames(path, scenario(name), [index * 40 for index in range(20)])
        result[name] = path
    from backend.tests.test_counts import moved_camera_frames
    moved = moved_camera_frames()
    result["moved_camera"] = directory / "tracking-moved-camera.mp4"
    encode_frames(result["moved_camera"], moved, [index * 40 for index in range(len(moved))])
    from backend.tests.test_tracking import frame, path
    dots = path((4, 40), (3, 0), 40)
    # Seen in only half of its frames: an uncertain track for the review reel.
    gappy = [frame([dots[i]] if i % 2 == 0 or i > 36 else []) for i in range(40)]
    result["gappy"] = directory / "tracking-gappy.mp4"
    encode_frames(result["gappy"], gappy, [index * 40 for index in range(40)])
    result["quiet"] = directory / "tracking-quiet.mp4"
    encode_frames(result["quiet"], scenario("noise"), [index * 40 for index in range(20)])
    from backend.tests.test_audio import tone
    result["tone_wav"] = tone(directory / "detector-45khz.wav")
    from backend.tests.test_calls import wav

    result["call_wav"] = wav(directory / "detector-calls.wav", seconds=1.0, calls=(0.2, 0.5), guano="GUANO|Version: 1.0\nTimestamp: 2026-08-10T21:00:00+01:00\n")
    return result


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m backend.tests.tracking_fixtures TEMPORARY_DIRECTORY")
    print(json.dumps({name: str(path) for name, path in generate_tracking_media(Path(sys.argv[1])).items()}))
