"""Disposable, OS-limited worker for full-spectrum WAV evidence (feature expansion E7).

Operations: inspect an original WAV, render a bounded spectrogram PNG, or derive a heterodyne listening clip.
The original is opened read-only, re-identified by SHA-256 and never written. Outputs are derived files.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys

from . import workers

MAX_REQUEST_BYTES = 64 * 1024
MAX_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_CLIP_SECONDS = 12
MEMORY_BYTES = 1024 ** 3
CPU_SECONDS = 120
PCM = {"pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_u8"}
HETERODYNE_RATE = 48_000
HETERODYNE_BAND_HZ = 8_000
SPECTROGRAM = {"window": "hann", "nperseg": 512, "overlap": 256, "rows": 256, "max_columns": 1200, "db_range": 80}
ERRORS = {"missing_source", "unreadable_source", "changed_source", "unsupported_audio", "decode_failed", "audio_limit",
          "audio_limits_unavailable", "audio_failed", "outside_audio", "not_retunable"}

os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"


def limits(parent_pid: int) -> None:
    if sys.platform == "win32":
        workers.require_limits(ValueError("audio_limits_unavailable"))
    elif sys.platform != "linux" or not workers.linux_limits(parent_pid, MEMORY_BYTES, CPU_SECONDS, MAX_OUTPUT_BYTES):
        raise ValueError("audio_limits_unavailable")


def _open(path: Path):
    import av

    return av.open(str(path), format="wav", options={"protocol_whitelist": "file", "format_whitelist": "wav"})


def _stream(container):
    if len(container.streams.audio) != 1 or len(container.streams.video) != 0:
        raise ValueError("unsupported_audio")
    stream = container.streams.audio[0]
    if stream.codec_context.name not in PCM:
        raise ValueError("unsupported_audio")
    return stream


def inspect(path: Path) -> dict:
    from . import media

    identity = media.identity_info(path)
    with path.open("rb") as original:
        digest = media._hash_file(original, media._no_progress, media._not_cancelled)
    frames = 0
    with _open(path) as container:
        stream = _stream(container)
        rate, channels, codec = stream.codec_context.sample_rate, stream.codec_context.channels, stream.codec_context.name
        for frame in container.decode(stream):
            frames += frame.samples
    if rate < 8000 or not 1 <= channels <= 8 or frames == 0:
        raise ValueError("unsupported_audio")
    if media.identity_info(path) != identity:
        raise ValueError("changed_source")
    return {"sha256": digest, "identity": identity, "sample_rate": rate, "channels": channels, "frames": frames, "codec": codec,
            "filename": path.name}


def samples(path: Path, expected_sha: str, channel: int, start: int, count: int):
    """Exactly `count` samples of one channel from sample index `start` (float64, -1..1). Decodes from the start."""
    import numpy as np

    from . import media

    with path.open("rb") as original:
        if media._hash_file(original, media._no_progress, media._not_cancelled) != expected_sha:
            raise ValueError("changed_source")
    chunks, position = [], 0
    with _open(path) as container:
        stream = _stream(container)
        for frame in container.decode(stream):
            data = frame.to_ndarray()
            planar = data.shape[0] == stream.codec_context.channels and frame.format.is_planar
            channel_data = data[channel] if planar else data.reshape(-1, stream.codec_context.channels)[:, channel]
            end = position + len(channel_data)
            if end > start and position < start + count:
                chunks.append(channel_data[max(0, start - position):min(len(channel_data), start + count - position)])
            position = end
            if position >= start + count:
                break
    if not chunks or sum(len(chunk) for chunk in chunks) != count:
        raise ValueError("outside_audio")
    values = np.concatenate(chunks).astype(np.float64)
    name = stream.codec_context.name
    scale = {"pcm_s16le": 2 ** 15, "pcm_s24le": 2 ** 31, "pcm_s32le": 2 ** 31, "pcm_u8": 128}.get(name, 1)
    return (values - (128 if name == "pcm_u8" else 0)) / scale


def spectrogram(values, rate: int, output: Path) -> dict:
    import numpy as np
    from PIL import Image
    from scipy import signal

    _, _, power = signal.spectrogram(values, fs=rate, window=SPECTROGRAM["window"], nperseg=SPECTROGRAM["nperseg"],
                                     noverlap=SPECTROGRAM["overlap"], mode="psd")
    db = 10 * np.log10(power + 1e-20)
    top = db.max()
    scaled = np.clip((db - (top - SPECTROGRAM["db_range"])) / SPECTROGRAM["db_range"], 0, 1)
    image = Image.fromarray((255 * scaled[::-1]).astype(np.uint8))  # high frequencies at the top
    columns = min(SPECTROGRAM["max_columns"], max(1, image.width))
    image = image.resize((columns, SPECTROGRAM["rows"]), Image.Resampling.BOX)
    image.save(output, format="PNG")
    return {"frequency_max_hz": rate / 2, "columns": columns, "rows": SPECTROGRAM["rows"]}


def heterodyne(values, rate: int, tune_hz: float, output: Path) -> dict:
    """Digital heterodyne: mix with the tuning tone, keep the audible difference band, resample to 48 kHz."""
    import wave

    import numpy as np
    from scipy import signal

    if tune_hz + HETERODYNE_BAND_HZ >= rate / 2:
        raise ValueError("not_retunable")
    times = np.arange(len(values)) / rate
    mixed = values * np.cos(2 * np.pi * tune_hz * times)
    sos = signal.butter(8, HETERODYNE_BAND_HZ, btype="lowpass", fs=rate, output="sos")
    audible = signal.sosfiltfilt(sos, mixed)
    from math import gcd

    divisor = gcd(HETERODYNE_RATE, rate)
    resampled = signal.resample_poly(audible, HETERODYNE_RATE // divisor, rate // divisor)
    peak = float(np.max(np.abs(resampled))) or 1.0
    pcm = np.clip(resampled / peak * 0.9 * 32767, -32768, 32767).astype("<i2")
    with wave.open(str(output), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(HETERODYNE_RATE)
        target.writeframes(pcm.tobytes())
    return {"sample_rate": HETERODYNE_RATE, "band_hz": HETERODYNE_BAND_HZ, "tune_hz": tune_hz, "normalised_peak": peak}


def render(payload: dict) -> dict:
    path = Path(payload["source_path"])
    if payload["operation"] == "inspect":
        return inspect(path)
    rate, count = int(payload["sample_rate"]), int(payload["count"])
    if count < 1 or count > rate * MAX_CLIP_SECONDS:
        raise ValueError("audio_limit")
    values = samples(path, payload["sha256"], int(payload["channel"]), int(payload["start"]), count)
    output = Path(payload["output_path"])
    result = spectrogram(values, rate, output) if payload["operation"] == "spectrogram" else heterodyne(values, rate, float(payload["tune_hz"]), output)
    if output.stat().st_size > MAX_OUTPUT_BYTES:
        raise ValueError("audio_limit")
    return result


def main() -> None:
    result: dict = {"error": None, "value": None}
    try:
        raw = workers.read_request(MAX_REQUEST_BYTES)
        if len(raw) > MAX_REQUEST_BYTES:
            raise ValueError("audio_limit")
        payload = json.loads(raw)
        limits(payload["parent_pid"])
        result["value"] = render(payload)
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and str(error) in ERRORS else None
        if isinstance(error, FileNotFoundError):
            code = "missing_source"
        elif isinstance(error, PermissionError):
            code = "unreadable_source"
        elif isinstance(error, MemoryError):
            code = "audio_limit"
        elif code is None and type(error).__module__.startswith("av"):
            code = "decode_failed"
        result = {"error": code or "audio_failed", "value": None}
    workers.write_response(json.dumps(result))


if __name__ == "__main__":
    main()
