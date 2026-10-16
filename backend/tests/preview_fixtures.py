"""Generate original-PTS-labelled synthetic video in temporary directories only."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys


WIDTH, HEIGHT = 384, 180
FONT = {
    "0": "11111100011000110001100011000111111",
    "1": "00100011000010000100001000010001110",
    "2": "11110000010000111111100001000011111",
    "3": "11110000010000101110000010000111110",
    "4": "10001100011000111111000010000100001",
    "5": "11111100001000011110000010000111110",
    "6": "01111100001000011111100011000111111",
    "7": "11111000010001000100010000100001000",
    "8": "11111100011000111111000010000111111",
    "9": "11111100011000111111000010000111110",
    "P": "11110100011000111110100001000010000",
    "T": "11111001000010000100001000010000100",
    "S": "01111100001000001110000010000111110",
    "/": "00001000100001000100010000100010000",
    " ": "00000000000000000000000000000000000",
}

CASES = {
    "cfr_mp4": {"filename": "marker-cfr.mp4", "denominator": 12800, "origin": 0, "step": 512,
                "indices": tuple(range(8))},
    "nonzero_mts": {"filename": "marker-nonzero.mts", "denominator": 90000, "origin": 129600, "step": 3600,
                    "indices": tuple(range(8))},
    "irregular_mp4": {"filename": "marker-irregular.mp4", "denominator": 12800, "origin": 0, "step": 512,
                      "indices": (0, 1, 3, 4, 5, 7)},
    "short_mp4": {"filename": "marker-short.mp4", "denominator": 12800, "origin": 0, "step": 512,
                  "indices": (0, 1, 2)},
    "long_mp4": {"filename": "marker-long.mp4", "denominator": 12800, "origin": 0, "step": 512,
                 "indices": tuple(range(80))},
}


def marker_rgb(index: int, pts: int, denominator: int) -> bytes:
    """Visible exact PTS label plus a robust eight-bit index for canvas assertions."""
    level = 24 + (index % 8) * 24
    frame = bytearray(bytes((level, level, level)) * (WIDTH * HEIGHT))
    for bit in range(8):
        value = 220 if index & (1 << bit) else 20
        for y in range(50, 80):
            for x in range(10 + bit * 20, 28 + bit * 20):
                offset = (y * WIDTH + x) * 3
                frame[offset:offset + 3] = bytes((value, value, value))
    for position, letter in enumerate(f"PTS {pts} / {denominator}"):
        glyph = FONT[letter]
        for row in range(7):
            for col in range(5):
                if glyph[row * 5 + col] != "1":
                    continue
                for dy in range(3):
                    for dx in range(3):
                        x, y = 5 + position * 18 + col * 3 + dx, 120 + row * 3 + dy
                        if x < WIDTH:
                            offset = (y * WIDTH + x) * 3
                            frame[offset:offset + 3] = b"\xff\xff\xff"
    return bytes(frame)


def generate_marker_media(directory: Path) -> dict[str, Path]:
    directory = directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    variants = {
        "cfr_mp4": ["-c:v", "libx264", "-video_track_timescale", "12800"],
        "nonzero_mts": ["-c:v", "mpeg2video", "-f", "mpegts"],
        "irregular_mp4": ["-vf", "select=not(eq(n\\,2)+eq(n\\,6))", "-fps_mode", "passthrough",
                          "-c:v", "libx264", "-video_track_timescale", "12800"],
        "short_mp4": ["-frames:v", "3", "-c:v", "libx264", "-video_track_timescale", "12800"],
        "long_mp4": ["-c:v", "libx264", "-g", "10", "-keyint_min", "10", "-sc_threshold", "0",
                     "-video_track_timescale", "12800"],
    }
    paths: dict[str, Path] = {}
    for name, case in CASES.items():
        path = directory / case["filename"]
        pixels = b"".join(marker_rgb(index, case["origin"] + index * case["step"], case["denominator"])
                          for index in range(max(case["indices"]) + 1))
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "rawvideo",
            "-pixel_format", "rgb24", "-video_size", f"{WIDTH}x{HEIGHT}", "-framerate", "25", "-i", "pipe:0",
            *variants[name], "-pix_fmt", "yuv420p", str(path),
        ], input=pixels, check=True, capture_output=True, timeout=30)
        paths[name] = path
    return paths


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python backend/tests/preview_fixtures.py TEMPORARY_DIRECTORY")
    print(json.dumps({name: str(path) for name, path in generate_marker_media(Path(sys.argv[1])).items()}))
