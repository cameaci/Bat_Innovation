"""Small streaming grayscale-change evidence, with original source-time colours."""

from __future__ import annotations

from fractions import Fraction
from hashlib import sha256
from io import BytesIO
import textwrap

import numpy as np
from PIL import Image, ImageDraw, ImageFont, PngImagePlugin

from . import windows

COLOURS = ((0, 255, 255), (255, 255, 0), (255, 0, 255))
MAX_WIDTH, MAX_HEIGHT = 640, 360
MAX_NATIVE_WIDTH, MAX_NATIVE_HEIGHT = 4096, 2160


def max_pool(values: np.ndarray, step: int) -> np.ndarray:
    """Keep tiny native change peaks instead of averaging them out during resize."""
    return np.maximum.reduceat(np.maximum.reduceat(
        values, np.arange(0, values.shape[0], step), axis=0),
        np.arange(0, values.shape[1], step), axis=1)


class Evidence:
    """One reference and three bounded evidence planes; never a list of frames."""

    def __init__(self, interval: dict, time_base: Fraction, parameters: dict,
                 metadata: dict) -> None:
        self.interval, self.time_base, self.parameters = interval, time_base, parameters
        self.start = windows.fraction(interval["start_time"])
        self.end = windows.fraction(interval["end_time"]) if interval["end_time"] else None
        self.width, self.height = int(metadata["width"]), int(metadata["height"])
        if not 0 < self.width <= MAX_NATIVE_WIDTH or not 0 < self.height <= MAX_NATIVE_HEIGHT:
            raise ValueError("summary_limit")
        self.step = max(1, -(-self.width // MAX_WIDTH), -(-self.height // MAX_HEIGHT))
        shape = (-(-self.height // self.step), -(-self.width // self.step))
        self.planes = np.zeros((3, *shape), dtype=np.uint8)
        self.reference: np.ndarray | None = None
        self.frame_count = self.comparison_count = self.gap_count = 0
        self.first_pts: int | None = None
        self.last_pts: int | None = None
        self.max_spacing = Fraction(0)
        self.gaps: list[dict] = []
        self.digest = sha256()
        self.flags: set[str] = {"source_speed_unverified", "derived_grayscale_evidence"}
        if self.end is None:
            self.flags.add("unknown_end_unassessable")
        if metadata.get("rotation"):
            self.flags.add("rotation_not_applied")
        if metadata.get("rotation") is None:
            self.flags.add("rotation_unverified")
        if metadata.get("interlaced"):
            self.flags.add("interlaced_not_deinterlaced")
        if metadata.get("field_order") is None:
            self.flags.add("field_order_unverified")

    def add(self, gray: np.ndarray, pts: int, previous: np.ndarray | None) -> None:
        if gray.shape != (self.height, self.width) or gray.dtype != np.uint8:
            raise ValueError("unsupported_codec")
        timestamp = pts * self.time_base
        if timestamp < self.start or (self.end is not None and timestamp >= self.end):
            raise ValueError("coverage_mismatch")
        if self.reference is None:
            self.reference = gray.copy()
            self.first_pts = pts
        self.last_pts = pts
        self.frame_count += 1
        self.digest.update(f"{pts}\n".encode("ascii"))
        if previous is None:
            return
        if previous.shape != gray.shape:
            raise ValueError("unsupported_codec")
        self.comparison_count += 1
        difference = np.abs(gray.astype(np.int16) - previous.astype(np.int16)).astype(np.uint8)
        threshold = self.parameters["threshold"]
        fraction = np.count_nonzero(difference >= threshold) / difference.size
        if fraction >= Fraction(self.parameters["framewide_fraction"]):
            self.flags.add("framewide_change")
        if abs(float(gray.mean()) - float(previous.mean())) >= self.parameters["brightness_delta"]:
            self.flags.add("brightness_transition")
        if self.end is None:
            return  # Unknown duration cannot define early/middle/late thirds.
        # Native differences precede max pooling: a weak 2x2 source target must not
        # disappear through averaging before the evidence threshold is applied.
        reduced = max_pool(difference, self.step)
        intensity = np.where(reduced >= threshold,
                             np.minimum(reduced.astype(np.uint16) * self.parameters["gain"], 255), 0).astype(np.uint8)
        duration = self.end - self.start
        phase = min(2, int(3 * (timestamp - self.start) / duration))
        np.maximum(self.planes[phase], intensity, out=self.planes[phase])

    def spacing(self, previous_time: Fraction, previous_duration: Fraction | None,
                timestamp: Fraction) -> None:
        """Record only declared-duration gaps intersecting this exact window."""
        if timestamp < self.start or (self.end is not None and previous_time >= self.end):
            return
        self.max_spacing = max(self.max_spacing, timestamp - previous_time)
        # Irregular PTS spacing alone does not establish absent recorded imagery.
        if previous_duration is None:
            return
        start = max(self.start, previous_time + previous_duration)
        end = min(timestamp, self.end) if self.end is not None else timestamp
        if start >= end:
            return
        self.gap_count += 1
        self.flags.add("declared_timestamp_gap")
        if len(self.gaps) < self.parameters["gap_examples_limit"]:
            self.gaps.append({"start": windows.rational(start), "end": windows.rational(end)})
        else:
            self.flags.add("gap_examples_truncated")

    def stats(self) -> dict:
        return {"frame_count": self.frame_count, "first_pts": str(self.first_pts) if self.first_pts is not None else None,
                "last_pts": str(self.last_pts) if self.last_pts is not None else None,
                "pts_digest": self.digest.hexdigest(),
                "motion_pixels": int(np.count_nonzero(np.max(self.planes, axis=0))) if self.end is not None else None,
                "comparison_count": self.comparison_count, "gap_count": self.gap_count,
                "max_spacing": windows.rational(self.max_spacing) if self.frame_count else None,
                "gaps": self.gaps, "phase_pixels": [int(np.count_nonzero(plane)) for plane in self.planes] if self.end is not None else None,
                "preview_pts": str(self.first_pts) if self.first_pts is not None else None}

    def motion_rgb(self) -> np.ndarray:
        result = np.zeros((*self.planes.shape[1:], 3), dtype=np.uint8)
        for phase, colour in enumerate(COLOURS):
            for channel, value in enumerate(colour):
                if value:
                    np.maximum(result[:, :, channel], self.planes[phase], out=result[:, :, channel])
        return result

    def png(self, segment_id: str, parameter_hash: str) -> bytes:
        """Deterministic labelled PNG; source filenames and paths never enter pixels."""
        if self.reference is None or self.end is None:
            raise ValueError("unknown_end" if self.end is None else "no_decoded_frames")
        if not self.comparison_count:
            self.flags.add("insufficient_comparison_frames")
        width, height = self.planes.shape[2], self.planes.shape[1]
        panel_width, panel_height = max(320, width), max(180, height)
        canvas_width = panel_width * 2
        # The bundled bitmap font is fixed-width and needs no system font files.
        font = ImageFont.load_default_imagefont()
        columns = (canvas_width - 8) // 6

        def wrap(labels: list[str]) -> list[str]:
            return [line for label in labels for line in textwrap.wrap(
                label, width=columns, break_long_words=True, break_on_hyphens=False)]

        start = windows.fraction(self.interval["elapsed_start"])
        stop = windows.fraction(self.interval["elapsed_end"])
        source_interval = f"[{windows.fraction(self.interval['start_pts'])}, {windows.fraction(self.interval['end_pts'])})"
        header = wrap([f"Segment {segment_id} | window {self.interval['index']}",
                       f"Exact segment elapsed [{start}, {stop}) s | original PTS {source_interval}"])
        panel_top = 8 + len(header) * 14 + 18
        footer_top = panel_top + panel_height + 6
        footer = wrap(["Evidence is not proof of presence or absence; verify the unchanged original.",
                       "Flags: " + ", ".join(sorted(self.flags)),
                       f"{windows.ALGORITHM_VERSION} | parameters SHA256 {parameter_hash}"])
        canvas_height = footer_top + 18 + len(footer) * 14 + 4
        if canvas_height > 1024:
            raise ValueError("summary_limit")
        image = Image.new("RGB", (canvas_width, canvas_height), (20, 20, 20))
        context = Image.fromarray(self.reference).resize((width, height), Image.Resampling.BOX).convert("RGB")
        image.paste(context, (0, panel_top))
        image.paste(Image.fromarray(self.motion_rgb()), (panel_width, panel_top))
        draw = ImageDraw.Draw(image)
        for index, label in enumerate(header):
            draw.text((4, 4 + index * 14), label, font=font, fill="white")
        draw.text((4, panel_top - 15), "Source context (first window frame)", font=font, fill="white")
        draw.text((panel_width + 4, panel_top - 15), "Motion evidence; colour overlap can mix", font=font, fill="white")
        for index, (label, colour) in enumerate(zip(("Early", "Middle", "Late"), COLOURS, strict=True)):
            left = 4 + index * 90
            draw.rectangle((left, footer_top, left + 10, footer_top + 10), fill=colour)
            draw.text((left + 15, footer_top), label, font=font, fill="white")
        draw.text((284, footer_top), "Thirds of this source-time window", font=font, fill="white")
        for index, label in enumerate(footer):
            draw.text((4, footer_top + 18 + index * 14), label, font=font, fill="white")
        provenance = PngImagePlugin.PngInfo()
        for key, value in {"motion_origin": f"{panel_width},{panel_top}", "source_segment_id": segment_id,
                           "window_index": str(self.interval["index"]), "segment_elapsed": f"[{start}, {stop})",
                           "source_pts": source_interval, "parameters_sha256": parameter_hash,
                           "quality_flags": ",".join(sorted(self.flags))}.items():
            provenance.add_text(key, value)
        output = BytesIO()
        image.save(output, format="PNG", compress_level=6, optimize=False, pnginfo=provenance)
        return output.getvalue()
