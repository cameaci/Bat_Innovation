"""Generate tiny synthetic media outside the repository; never store binary fixtures."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys


def generate_media(directory: Path) -> dict[str, Path]:
    directory = directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    fixtures = {"cfr_mp4": directory / "cfr.mp4", "nonzero_mts": directory / "nonzero.mts",
                "irregular_mp4": directory / "irregular.mp4", "short_mp4": directory / "short.mp4"}
    source = ["-f", "lavfi", "-i", "testsrc2=size=96x64:rate=25:duration=0.32"]
    variants = {
        "cfr_mp4": ["-c:v", "libx264"],
        "nonzero_mts": ["-c:v", "mpeg2video", "-f", "mpegts"],
        "irregular_mp4": ["-vf", "select=not(eq(n\\,2)+eq(n\\,6))", "-fps_mode", "passthrough", "-c:v", "libx264"],
        "short_mp4": ["-frames:v", "3", "-c:v", "libx264"],
    }
    for name, path in fixtures.items():
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                        *source, *variants[name], "-pix_fmt", "yuv420p", str(path)],
                       check=True, capture_output=True, timeout=30)
    return fixtures


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python backend/tests/media_fixtures.py TEMPORARY_DIRECTORY")
    print(json.dumps({name: str(path) for name, path in generate_media(Path(sys.argv[1])).items()}))
