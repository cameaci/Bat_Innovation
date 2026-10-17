"""Exact source-time window planning and versioned motion parameters."""

from __future__ import annotations

from fractions import Fraction
from hashlib import sha256
from importlib.metadata import version
import json

MAX_WINDOWS = 2000
ALGORITHM_VERSION = "consecutive-gray-v1"


def rational(value: Fraction | int) -> dict[str, str]:
    number = Fraction(value)
    return {"num": str(number.numerator), "den": str(number.denominator)}


def fraction(value: dict[str, str]) -> Fraction:
    return Fraction(int(value["num"]), int(value["den"]))


def parameters(window_seconds: int = 30) -> dict:
    if type(window_seconds) is not int or not 1 <= window_seconds <= 120:
        raise ValueError("Window duration must be an integer from 1 to 120 seconds")
    return {
        "algorithm_version": ALGORITHM_VERSION,
        "window_seconds": window_seconds,
        "threshold": 3,
        "gain": 16,
        "pixel_method": "native-diff-then-max-pool",
        "max_width": 640,
        "max_height": 360,
        "phase_basis": "actual-window-source-time-thirds",
        "phase_colours": ["cyan", "yellow", "magenta"],
        "brightness_delta": 12,
        "framewide_fraction": "1/4",
        "gap_examples_limit": 64,
        "toolchain": {name: version(package) for name, package in
                      (("numpy", "numpy"), ("pillow", "Pillow"), ("pyav", "av"))},
    }


def parameter_hash(values: dict) -> str:
    canonical = json.dumps(values, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return sha256(canonical.encode("ascii")).hexdigest()


def window_index(pts: int, first_pts: int, time_base: Fraction, window_seconds: int = 30) -> int:
    """A frame on an internal boundary belongs only to the following window."""
    if time_base <= 0 or pts < first_pts or window_seconds <= 0:
        raise ValueError("Invalid original PTS or source timebase")
    return int(((pts - first_pts) * time_base) // window_seconds)


def plan_source(metadata: dict, window_seconds: int = 30) -> list[dict]:
    """Partition a source; an unknown duration retains a NULL-ended final tail."""
    if type(window_seconds) is not int or not 1 <= window_seconds <= 120:
        raise ValueError("Window duration must be an integer from 1 to 120 seconds")
    time_base = fraction(metadata["time_base"])
    first_pts, last_pts = int(metadata["first_pts"]), int(metadata["last_pts"])
    if time_base <= 0 or first_pts > last_pts:
        raise ValueError("Source metadata has invalid original PTS")
    first, last = first_pts * time_base, last_pts * time_base
    end = fraction(metadata["end_time"]) if metadata["end_time"] is not None else None
    if end is not None and end <= last:
        raise ValueError("Known source end must follow its last decoded PTS")
    count = (int(-(-(end - first) // window_seconds)) if end is not None else
             window_index(last_pts, first_pts, time_base, window_seconds) + 1)
    if not 0 < count <= MAX_WINDOWS:
        raise ValueError(f"The plan exceeds the {MAX_WINDOWS}-window resource limit")
    result = []
    for index in range(count):
        start = first + index * window_seconds
        stop = min(start + window_seconds, end) if end is not None else (
            start + window_seconds if index < count - 1 else None)
        result.append({
            "index": index,
            "start_pts": rational(start / time_base),
            "end_pts": rational(stop / time_base) if stop is not None else None,
            "start_time": rational(start),
            "end_time": rational(stop) if stop is not None else None,
            "elapsed_start": rational(start - first),
            "elapsed_end": rational(stop - first) if stop is not None else None,
        })
    return result
