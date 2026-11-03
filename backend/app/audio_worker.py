"""Disposable, OS-limited worker for full-spectrum WAV evidence (feature expansion E7, Phase 3 X9).

Operations: inspect an original WAV (with the start time its file claims: a GUANO `Timestamp` or a timestamp in the
file name), render a bounded spectrogram PNG, derive a heterodyne listening clip, or mark call activity: frames
whose ultrasonic band energy rises a set margin above a rolling noise floor, for a minimum duration.
The original is opened read-only, re-identified by SHA-256 and never written. Outputs are derived files.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import struct
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
ACTIVITY = {"version": "call-activity-v1", "nperseg": 512, "hop": 256, "floor_seconds": 10, "floor_percentile": 20,
            "min_frames": 2, "envelope_seconds": 0.25, "max_marks": 20_000}
FILENAME_CLOCK = re.compile(r"(?<!\d)(20\d{2})(\d{2})(\d{2})[_T-]?(\d{2})(\d{2})(\d{2})(?!\d)")

os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"


def limits(parent_pid: int, cpu: int = CPU_SECONDS) -> None:
    if sys.platform == "win32":
        workers.require_limits(ValueError("audio_limits_unavailable"))
    elif sys.platform != "linux" or not workers.linux_limits(parent_pid, MEMORY_BYTES, cpu, MAX_OUTPUT_BYTES):
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


def guano(path: Path) -> dict[str, str]:
    """GUANO metadata fields of a WAV file (the "guan" RIFF chunk), or an empty dict."""
    with path.open("rb") as handle:
        if handle.read(12)[8:12] != b"WAVE":
            return {}
        while header := handle.read(8):
            if len(header) < 8:
                break
            name, size = header[:4], struct.unpack("<I", header[4:])[0]
            if name == b"guan" and size <= 64 * 1024:
                text = handle.read(size).decode("utf-8", errors="replace")
                return {key.strip(): value.strip() for key, _, value in (line.partition(":") for line in text.splitlines()) if value}
            handle.seek(size + (size & 1), 1)
    return {}


def file_clock(path: Path) -> dict | None:
    """The recording start the file claims, as written (unverified): GUANO first, then a timestamp in the name."""
    stamp = guano(path).get("Timestamp")
    if stamp:
        return {"timestamp": stamp[:40], "source": "guano"}
    match = FILENAME_CLOCK.search(path.name)
    if match:
        y, mo, d, h, mi, se = match.groups()
        return {"timestamp": f"{y}-{mo}-{d}T{h}:{mi}:{se}", "source": "filename"}
    return None


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
            "filename": path.name, "file_clock": file_clock(path)}


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


def blocks(path: Path, expected_sha: str, channel: int, size: int):
    """The whole channel in blocks of `size` samples (float64, -1..1), after re-identifying the original."""
    import numpy as np

    from . import media

    with path.open("rb") as original:
        if media._hash_file(original, media._no_progress, media._not_cancelled) != expected_sha:
            raise ValueError("changed_source")
    pending = np.zeros(0)
    with _open(path) as container:
        stream = _stream(container)
        name, channels = stream.codec_context.name, stream.codec_context.channels
        scale = {"pcm_s16le": 2 ** 15, "pcm_s24le": 2 ** 31, "pcm_s32le": 2 ** 31, "pcm_u8": 128}.get(name, 1)
        for frame in container.decode(stream):
            data = frame.to_ndarray()
            planar = data.shape[0] == channels and frame.format.is_planar
            values = (data[channel] if planar else data.reshape(-1, channels)[:, channel]).astype(np.float64)
            pending = np.concatenate([pending, (values - (128 if name == "pcm_u8" else 0)) / scale])
            while len(pending) >= size:
                yield pending[:size]
                pending = pending[size:]
    if len(pending):
        yield pending


def activity(path: Path, expected_sha: str, channel: int, rate: int, low_hz: float, high_hz: float, margin_db: float, output: Path) -> dict:
    """Call marks (start and end sample, peak dB above the floor) and an envelope of band level above the floor."""
    import numpy as np
    from scipy import signal

    high_hz = min(high_hz, 0.98 * rate / 2)
    if low_hz >= high_hz:
        raise ValueError("not_retunable")
    hop, nperseg = ACTIVITY["hop"], ACTIVITY["nperseg"]
    frequencies = np.fft.rfftfreq(nperseg, 1 / rate)
    band = (frequencies >= low_hz) & (frequencies <= high_hz)
    window = signal.get_window("hann", nperseg)
    levels: list[np.ndarray] = []
    carry = np.zeros(0)
    # Band level in dB per hop, block by block with the overlap carried over.
    for block in blocks(path, expected_sha, channel, rate):
        values = np.concatenate([carry, block])
        count = (len(values) - nperseg) // hop + 1
        if count <= 0:
            carry = values
            continue
        frames = np.lib.stride_tricks.sliding_window_view(values, nperseg)[::hop][:count] * window
        power = (np.abs(np.fft.rfft(frames, axis=1)) ** 2)[:, band].sum(axis=1)
        levels.append(10 * np.log10(power + 1e-20))
        carry = values[count * hop:]
    if not levels:
        raise ValueError("outside_audio")
    level = np.concatenate(levels)
    per_second = max(1, rate // hop)
    # Noise floor: a low percentile of each second, then a running median over the floor window.
    seconds = [np.percentile(level[start:start + per_second], ACTIVITY["floor_percentile"]) for start in range(0, len(level), per_second)]
    span = max(1, ACTIVITY["floor_seconds"])
    smoothed = np.array([np.median(seconds[max(0, index - span // 2):index + span // 2 + 1]) for index in range(len(seconds))])
    floor = np.repeat(smoothed, per_second)[:len(level)]
    above = level - floor
    active = above >= margin_db
    marks = []
    edges = np.flatnonzero(np.diff(np.concatenate([[0], active.astype(np.int8), [0]])))
    for start, end in zip(edges[::2], edges[1::2]):
        if end - start >= ACTIVITY["min_frames"]:
            marks.append([int(start * hop), int((end - 1) * hop + nperseg), round(float(above[start:end].max()), 1)])
            if len(marks) > ACTIVITY["max_marks"]:
                raise ValueError("audio_limit")
    step = max(1, round(ACTIVITY["envelope_seconds"] * rate / hop))
    envelope = [round(float(above[index:index + step].max()), 1) for index in range(0, len(above), step)]
    output.write_text(json.dumps({"marks": marks, "envelope": envelope, "envelope_samples": step * hop}))
    return {"marks": len(marks), "parameters": {**ACTIVITY, "low_hz": low_hz, "high_hz": high_hz, "margin_db": margin_db}}


def render(payload: dict) -> dict:
    path = Path(payload["source_path"])
    if payload["operation"] == "inspect":
        return inspect(path)
    if payload["operation"] == "activity":
        output = Path(payload["output_path"])
        result = activity(path, payload["sha256"], int(payload["channel"]), int(payload["sample_rate"]), float(payload["low_hz"]),
                          float(payload["high_hz"]), float(payload["margin_db"]), output)
        if output.stat().st_size > MAX_OUTPUT_BYTES:
            raise ValueError("audio_limit")
        return result
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
        limits(payload["parent_pid"], int(payload.get("cpu_seconds", CPU_SECONDS)))
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
