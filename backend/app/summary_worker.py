"""Disposable Linux-limited source decoder and durable summary-image writer."""

from __future__ import annotations

from fractions import Fraction
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
from uuid import UUID

MAX_REQUEST_BYTES = 64 * 1024
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_RUN_BYTES = 128 * 1024 * 1024
MAX_GLOBAL_BYTES = 512 * 1024 * 1024
MAX_FRAMES = 1_000_000
MAX_SEGMENTS = 64

# Native numerical libraries must not create an unbounded thread pool in the worker.
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"


class WorkerError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def limits(parent_pid: int) -> None:
    """Install limits before importing native codecs, numerical or image libraries."""
    if sys.platform != "linux":
        raise WorkerError("summary_limits_unavailable")
    import ctypes
    import resource
    if ctypes.CDLL(None, use_errno=True).prctl(1, 9, 0, 0, 0) != 0 or os.getppid() != parent_pid:
        raise WorkerError("summary_limits_unavailable")
    for kind, amount in ((resource.RLIMIT_AS, 1024 ** 3), (resource.RLIMIT_CPU, 300),
                         (resource.RLIMIT_FSIZE, MAX_RUN_BYTES), (resource.RLIMIT_CORE, 0)):
        _, hard = resource.getrlimit(kind)
        bound = amount if hard == resource.RLIM_INFINITY else min(amount, hard)
        resource.setrlimit(kind, (bound, bound))


def _disk_bytes(root: Path) -> int:
    amount = 0
    if root.is_symlink():
        raise WorkerError("summary_failed")
    if root.exists():
        for candidate in root.rglob("*"):
            if candidate.is_symlink():
                raise WorkerError("summary_failed")
            if candidate == root / ".manifest-reserve":
                continue  # Separate fixed emergency metadata reserve, not image bytes.
            if candidate.is_file():
                amount += candidate.stat().st_size
                if amount > MAX_GLOBAL_BYTES:
                    raise WorkerError("summary_limit")
    return amount


def render(payload: dict) -> None:
    """Persist per-window results; the supervisor finalises the run after reaping."""
    import av
    from . import media, motion, summary_store, windows

    db = Path(payload["db_path"])
    data_dir = Path(payload["data_dir"])
    run_id = str(UUID(payload["run_id"]))
    if not db.is_absolute() or not data_dir.is_absolute():
        raise WorkerError("summary_failed")
    private = summary_store.private_run(db, run_id)
    if private is None or private["run"]["state"] not in {"queued", "running"}:
        raise WorkerError("summary_failed")
    if not 0 < len(private["sources"]) <= MAX_SEGMENTS or len(private["windows"]) > windows.MAX_WINDOWS:
        raise WorkerError("summary_limit")
    params = private["run"]["parameters"]
    if windows.parameter_hash(params) != private["run"]["parameter_hash"]:
        raise WorkerError("summary_failed")
    root = data_dir / "summaries"
    root.mkdir(exist_ok=True)
    initial_bytes = _disk_bytes(root)
    output = root / run_id
    if output.is_symlink():
        raise WorkerError("summary_failed")
    output.mkdir(exist_ok=True)
    run_bytes = 0
    decoded_total = 0
    summary_store.set_running(db, run_id)

    def publish(row: dict, evidence: motion.Evidence) -> None:
        nonlocal run_bytes
        if row["interval"]["end_time"] is None:
            summary_store.record_window(db, row["id"], evidence.stats(), "incomplete",
                                        error_code="unknown_end", flags=sorted(evidence.flags))
            return
        if not evidence.frame_count:
            summary_store.record_window(db, row["id"], evidence.stats(), "incomplete",
                                        error_code="no_decoded_frames", flags=sorted(evidence.flags))
            return
        image = evidence.png(row["segment_id"], private["run"]["parameter_hash"])
        if not 0 < len(image) <= MAX_IMAGE_BYTES or run_bytes + len(image) > MAX_RUN_BYTES or initial_bytes + run_bytes + len(image) > MAX_GLOBAL_BYTES:
            raise WorkerError("summary_limit")
        target = output / f"{UUID(row['id'])}.png"
        part = output / f"{UUID(row['id'])}.png.part"
        if target.exists():
            raise WorkerError("summary_failed")
        try:
            with part.open("xb") as destination:
                destination.write(image)
                destination.flush()
                os.fsync(destination.fileno())
            os.replace(part, target)
            directory = os.open(output, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
            summary_store.record_window(db, row["id"], evidence.stats(), "complete", target,
                                        sha256(image).hexdigest(), len(image), flags=sorted(evidence.flags))
            run_bytes += len(image)
        except BaseException:
            part.unlink(missing_ok=True)
            # A failed DB commit must not leave an apparently published orphan.
            referenced = summary_store.private_window(db, row["id"])
            if referenced is None or referenced.get("image_path") != str(target):
                target.unlink(missing_ok=True)
            raise

    current_rows: list[dict] = []
    current_evidence: motion.Evidence | None = None
    current_row: dict | None = None
    try:
        for source in private["sources"]:
            metadata = json.loads(source["metadata_json"])
            identity = json.loads(source["identity_json"])
            path = Path(source["source_path"])
            if path.suffix.lower() not in {".mp4", ".mts"}:
                raise WorkerError("unsupported_codec")
            time_base = windows.fraction(metadata["time_base"])
            first_pts, last_pts = int(metadata["first_pts"]), int(metadata["last_pts"])
            current_rows = [row for row in private["windows"] if row["segment_id"] == source["id"]]
            if not current_rows or [row["index"] for row in current_rows] != list(range(len(current_rows))):
                raise WorkerError("coverage_mismatch")
            current_evidence = None
            current_row = None
            if media.identity_info(path) != identity:
                raise WorkerError("changed_source")
            with path.open("rb") as original:
                if media._identity(os.fstat(original.fileno())) != identity:
                    raise WorkerError("changed_source")
                if media._hash_file(original, media._no_progress, media._not_cancelled) != source["sha256"]:
                    raise WorkerError("changed_source")
                original.seek(0)
                with av.open(original, format="mp4" if path.suffix.lower() == ".mp4" else "mpegts", options={
                    "protocol_whitelist": "file,pipe", "format_whitelist": "mov,mpegts", "err_detect": "explode",
                    "enable_drefs": "0", "use_absolute_path": "0",
                }) as container:
                    if len(container.streams.video) != 1:
                        raise WorkerError("unsupported_codec")
                    stream = container.streams.video[0]
                    if stream.time_base != time_base:
                        raise WorkerError("unknown_timing")
                    stream.codec_context.thread_count = 1
                    previous = None
                    previous_time = previous_duration = None
                    actual_first = actual_last = None
                    source_count = 0
                    row_index = 0
                    last_duration = None
                    for frame in media.decoded_frames(container, stream):
                        decoded_total += 1
                        source_count += 1
                        if decoded_total > MAX_FRAMES:
                            raise WorkerError("summary_limit")
                        if frame.time_base != time_base:
                            raise WorkerError("unknown_timing")
                        if (frame.width, frame.height) != (metadata["width"], metadata["height"]):
                            raise WorkerError("unsupported_codec")
                        pts = frame.pts
                        if actual_first is None:
                            actual_first = pts
                        actual_last = pts
                        index = windows.window_index(pts, first_pts, time_base, params["window_seconds"])
                        if index >= len(current_rows):
                            raise WorkerError("coverage_mismatch")
                        timestamp = pts * time_base
                        while row_index < index:
                            row = current_rows[row_index]
                            evidence = current_evidence or motion.Evidence(row["interval"], time_base, params, metadata)
                            if previous_time is not None:
                                evidence.spacing(previous_time, previous_duration, timestamp)
                            publish(row, evidence)
                            row_index += 1
                            current_evidence = None
                        current_row = current_rows[row_index]
                        if current_evidence is None:
                            summary_store.start_window(db, current_row["id"])
                            current_evidence = motion.Evidence(current_row["interval"], time_base, params, metadata)
                        gray = frame.to_ndarray(format="gray")
                        if previous_time is not None:
                            current_evidence.spacing(previous_time, previous_duration, timestamp)
                        current_evidence.add(gray, pts, previous)
                        previous, previous_time = gray, timestamp
                        last_duration = frame.duration
                        previous_duration = last_duration * time_base if last_duration is not None and last_duration > 0 else None
                    if actual_first != first_pts or actual_last != last_pts or source_count != metadata["frame_count"]:
                        raise WorkerError("coverage_mismatch")
                    if metadata["end_time"] is not None:
                        if last_duration is None or last_duration <= 0 or (actual_last + last_duration) * time_base != windows.fraction(metadata["end_time"]):
                            raise WorkerError("coverage_mismatch")
                    if media._identity(os.fstat(original.fileno())) != identity or media.identity_info(path) != identity:
                        raise WorkerError("changed_source")
                    while row_index < len(current_rows):
                        row = current_rows[row_index]
                        evidence = current_evidence or motion.Evidence(row["interval"], time_base, params, metadata)
                        publish(row, evidence)
                        row_index += 1
                        current_evidence = None
        if _disk_bytes(root) > MAX_GLOBAL_BYTES:
            raise WorkerError("summary_limit")
    except Exception as error:
        code = getattr(error, "code", None)
        if isinstance(error, (av.error.DecoderNotFoundError, av.error.EncoderNotFoundError)):
            code = "unsupported_codec"
        elif isinstance(error, av.error.FFmpegError):
            code = "decode_failed"
        elif isinstance(error, FileNotFoundError):
            code = "missing_source"
        elif isinstance(error, PermissionError):
            code = "unreadable_source"
        elif isinstance(error, MemoryError):
            code = "summary_limit"
        elif isinstance(error, OSError) and error.errno in {27, 28, 122}:
            code = "summary_limit"
        elif isinstance(error, ValueError) and str(error) in {"summary_limit", "unknown_end", "unsupported_codec", "coverage_mismatch"}:
            code = str(error)
        if code not in {"missing_source", "unreadable_source", "changed_source", "unreadable_metadata",
                        "unsupported_codec", "decode_failed", "unknown_timing", "coverage_mismatch",
                        "summary_limit", "summary_failed", "unknown_end"}:
            code = "summary_failed"
        if current_row is not None and current_evidence is not None:
            row = summary_store.private_window(db, current_row["id"])
            if row and row["status"] != "complete":
                summary_store.record_window(db, current_row["id"], current_evidence.stats(), "failed",
                                            error_code=code, flags=sorted(current_evidence.flags))
        # Earlier images from a source that changed or failed EOF provenance are
        # retained for audit but cannot remain labelled complete.
        if code in {"changed_source", "coverage_mismatch", "unknown_timing", "decode_failed"}:
            for row in current_rows:
                # Revoke only outputs previously marked complete. A failed
                # window's original terminal cause remains immutable history.
                if summary_store.private_window(db, row["id"])["status"] == "complete":
                    summary_store.invalidate_window(db, row["id"], code)
        raise WorkerError(code) from None


def main() -> None:
    allowed = {"missing_source", "unreadable_source", "changed_source", "unreadable_metadata",
               "unsupported_codec", "decode_failed", "unknown_timing", "coverage_mismatch",
               "summary_limit", "summary_limits_unavailable", "summary_failed", "unknown_end"}
    result: dict[str, str | None] = {"error": None}
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise WorkerError("summary_limit")
        payload = json.loads(raw)
        limits(payload["parent_pid"])
        render(payload)
    except Exception as error:
        code = getattr(error, "code", None)
        if isinstance(error, FileNotFoundError):
            code = "missing_source"
        elif isinstance(error, PermissionError):
            code = "unreadable_source"
        elif isinstance(error, MemoryError):
            code = "summary_limit"
        elif isinstance(error, OSError) and error.errno in {27, 28, 122}:
            code = "summary_limit"
        elif isinstance(error, ValueError) and str(error) in allowed:
            code = str(error)
        result["error"] = code if code in allowed else "summary_failed"
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
