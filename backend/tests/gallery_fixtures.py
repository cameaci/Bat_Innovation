"""Small real-decoder sources for gallery and displayed-PTS regression tests."""

from __future__ import annotations

import json
from pathlib import Path
import sys

import numpy as np

from backend.tests.summary_fixtures import encode_frames, generate_summary_media


def generate_gallery_media(directory: Path) -> dict[str, Path]:
    sources = generate_summary_media(directory)
    quiet = np.full((48, 64), 48, dtype=np.uint8)
    long_times = [value for index in range(240) for value in (index * 30000, index * 30000 + 29960)]
    sources["quiet_240"] = directory / "gallery-240-windows.mp4"
    encode_frames(sources["quiet_240"], [quiet] * len(long_times), long_times)
    sources["vfr_65"] = directory / "gallery-vfr-65.mp4"
    times = [0, 75, 240, 640, 1000, 5000, 29960, 30000, 59960, 60000, 64960]
    encode_frames(sources["vfr_65"], [quiet] * len(times), times, origin_ms=9000)
    sources["earlier_9"] = directory / "gallery-earlier-pts.mp4"
    encode_frames(sources["earlier_9"], [quiet, quiet], [0, 8960], origin_ms=1000)
    return sources


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m backend.tests.gallery_fixtures TEMPORARY_DIRECTORY")
    print(json.dumps({name: str(path) for name, path in generate_gallery_media(Path(sys.argv[1])).items()}))
