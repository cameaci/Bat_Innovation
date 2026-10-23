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
    return result


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m backend.tests.tracking_fixtures TEMPORARY_DIRECTORY")
    print(json.dumps({name: str(path) for name, path in generate_tracking_media(Path(sys.argv[1])).items()}))
