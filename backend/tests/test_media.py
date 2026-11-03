"""Synthetic-only media truth, immutable-source and explicit-failure tests."""

from fractions import Fraction
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import subprocess
import sys
from threading import Thread
from types import SimpleNamespace
from typing import Any

import av
import pytest

from backend.app import media as media_module
from backend.app.media import MediaError, decoded_frames, file_sha256, inspect_source
from backend.tests.media_fixtures import generate_media


@pytest.fixture(scope="module")
def media(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    return generate_media(tmp_path_factory.mktemp("synthetic-media"))


def rational(value: dict[str, str]) -> Fraction:
    return Fraction(int(value["num"]), int(value["den"]))


@pytest.mark.parametrize(("name", "timestamps", "time_base"), [
    ("cfr_mp4", [Fraction(index, 25) for index in range(8)], Fraction(1, 12800)),
    ("nonzero_mts", [Fraction(36 + index, 25) for index in range(8)], Fraction(1, 90000)),
    ("irregular_mp4", [Fraction(index, 25) for index in (0, 1, 3, 4, 5, 7)], Fraction(1, 12800)),
])
def test_decoded_pixels_and_exact_source_pts_match_one_ffmpeg_path(
    media: dict[str, Path], name: str, timestamps: list[Fraction], time_base: Fraction,
) -> None:
    """One CLI decode gives paired pixels and PTS, never a second ffprobe timeline."""
    path = media[name]
    original_hash = file_sha256(path)
    result = subprocess.run([
        "ffmpeg", "-hide_banner", "-nostdin", "-copyts", "-noautorotate", "-i", str(path),
        "-map", "0:v:0", "-vf", "showinfo", "-fps_mode", "passthrough",
        "-pix_fmt", "yuv420p", "-f", "rawvideo", "pipe:1",
    ], check=True, capture_output=True, timeout=30)
    log = result.stderr.decode()
    cli_time_base = re.search(r"config in time_base: (\d+/\d+)", log)
    assert cli_time_base is not None
    assert Fraction(cli_time_base.group(1)) == time_base
    cli_frames = re.findall(r"\bn:\s*(\d+) pts:\s*(-?\d+) pts_time:\S+.*?fmt:(\S+).*?s:(\d+)x(\d+)", log)
    assert len(cli_frames) == len(timestamps)
    frame_bytes = 96 * 64 * 3 // 2
    assert len(result.stdout) == len(cli_frames) * frame_bytes
    with path.open("rb") as source, av.open(source) as container:
        frames = decoded_frames(container, container.streams.video[0])
        for number, frame in enumerate(frames):
            cli_number, cli_pts, pixel_format, width, height = cli_frames[number]
            assert (int(cli_number), pixel_format, width, height) == (number, "yuv420p", "96", "64")
            assert frame.pts * frame.time_base == int(cli_pts) * time_base == timestamps[number]
            pixels = b"".join(bytes(plane)[row * plane.line_size:row * plane.line_size + plane.width]
                              for plane in frame.planes for row in range(plane.height))
            assert pixels == result.stdout[number * frame_bytes:(number + 1) * frame_bytes]
    metadata = inspect_source(path)
    assert metadata["sha256"] == original_hash == file_sha256(path)
    assert metadata["frame_count"] == len(timestamps)
    assert rational(metadata["time_base"]) == time_base
    assert rational(metadata["first_time"]) == timestamps[0]
    assert rational(metadata["last_time"]) == timestamps[-1]
    assert rational(metadata["elapsed_last_time"]) == Fraction(7, 25)
    assert rational(metadata["end_time"]) == timestamps[-1] + Fraction(1, 25)
    assert rational(metadata["elapsed_end"]) == Fraction(8, 25)
    assert metadata["width"] == 96 and metadata["height"] == 64
    assert metadata["streams"][0]["type"] == "video"
    assert "No original-clock anchor" in " ".join(metadata["warnings"])


def test_short_final_segment_and_irregular_rate_are_not_frame_count_time(media: dict[str, Path]) -> None:
    short = inspect_source(media["short_mp4"])
    assert short["frame_count"] == 3
    assert rational(short["last_time"]) == Fraction(2, 25)
    assert rational(short["elapsed_end"]) == Fraction(3, 25)
    irregular = inspect_source(media["irregular_mp4"])
    assert rational(irregular["average_rate"]) == Fraction(75, 4)
    assert rational(irregular["base_rate"]) == Fraction(25)
    assert rational(irregular["last_time"]) != Fraction(irregular["frame_count"] - 1, 25)


def test_missing_corrupt_and_unsupported_media_are_explicit(tmp_path: Path) -> None:
    with pytest.raises(MediaError) as error:
        inspect_source(tmp_path / "absent.mp4")
    assert error.value.code == "missing_source"
    invalid = tmp_path / "corrupt.mp4"
    invalid.write_bytes(b"not a video")
    with pytest.raises(MediaError) as error:
        inspect_source(invalid)
    assert error.value.code == "unreadable_metadata"
    assert str(tmp_path) not in error.value.message
    with pytest.raises(MediaError) as error:
        inspect_source(tmp_path / "unsupported.avi")
    assert error.value.code == "unsupported_codec"
    directory = tmp_path / "directory.mp4"
    directory.mkdir()
    with pytest.raises(MediaError) as error:
        inspect_source(directory)
    assert error.value.code == "missing_source"


def test_hashing_is_bounded_and_cancelable(tmp_path: Path) -> None:
    path = tmp_path / "hash-only.mp4"
    path.write_bytes(b"test" * (800 * 1024))
    calls: list[tuple[str, int]] = []
    assert file_sha256(path, lambda *args: calls.append(args)) == sha256(path.read_bytes()).hexdigest()
    assert [amount for phase, amount in calls] == [0, 1024 * 1024, 2 * 1024 * 1024,
                                                  3 * 1024 * 1024, path.stat().st_size]
    with pytest.raises(MediaError) as error:
        file_sha256(path, lambda phase, amount: calls.append((phase, amount)), lambda: calls[-1][1] > 0)
    assert error.value.code == "cancelled"


@pytest.mark.skipif(sys.platform != "win32", reason="Windows path and handle stat differ for st_ctime")
def test_windows_path_and_open_file_identity_match(tmp_path: Path) -> None:
    path = tmp_path / "synthetic.mp4"
    path.write_bytes(b"synthetic video")
    expected = media_module.identity_info(path)
    with path.open("rb") as source:
        assert media_module._identity(media_module.os.fstat(source.fileno())) == expected


@pytest.mark.parametrize("phase", ["hashing", "decoding"])
def test_source_change_during_inspection_is_not_success(media: dict[str, Path], tmp_path: Path, phase: str) -> None:
    path = tmp_path / "changing.mp4"
    path.write_bytes(media["cfr_mp4"].read_bytes())
    changed = False

    def change_source(current_phase: str, amount: int) -> None:
        nonlocal changed
        if current_phase == phase and amount > 0 and not changed:
            with path.open("ab") as source:
                source.write(b"changed")
            changed = True

    with pytest.raises(MediaError) as error:
        inspect_source(path, change_source)
    assert changed
    assert error.value.code == "changed_source"


def test_decode_cancellation_is_explicit(media: dict[str, Path]) -> None:
    cancelled = False

    def cancel_decoding(phase: str, amount: int) -> None:
        nonlocal cancelled
        cancelled = phase == "decoding"

    with pytest.raises(MediaError) as error:
        inspect_source(media["cfr_mp4"], cancel_decoding, lambda: cancelled)
    assert error.value.code == "cancelled"


def test_truncated_transport_stream_is_not_a_partially_successful_import(
    media: dict[str, Path], tmp_path: Path,
) -> None:
    original = media["nonzero_mts"].read_bytes()
    damaged = tmp_path / "truncated.mts"
    damaged.write_bytes(original[:len(original) // 2])
    with pytest.raises(MediaError) as error:
        inspect_source(damaged)
    assert error.value.code == "decode_failed"


def test_unknown_video_codec_is_distinct_from_unreadable_metadata(
    media: dict[str, Path], tmp_path: Path,
) -> None:
    source = bytearray(media["cfr_mp4"].read_bytes())
    # The final avc1 is the synthetic MP4 sample-entry codec fourcc, after the
    # compatible-brand occurrence. Keep the valid container with an unknown codec.
    sample_entry = source.rfind(b"avc1")
    assert sample_entry > source.find(b"avc1")
    source[sample_entry:sample_entry + 4] = b"zzzz"
    unsupported = tmp_path / "unknown-codec.mp4"
    unsupported.write_bytes(source)
    with pytest.raises(MediaError) as error:
        inspect_source(unsupported)
    assert error.value.code == "unsupported_codec"


def test_video_and_audio_stream_metadata_are_inspected(tmp_path: Path) -> None:
    source = tmp_path / "with-audio.mp4"
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=25:duration=0.12",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=0.12", "-c:v", "libx264",
        "-c:a", "aac", "-pix_fmt", "yuv420p", str(source),
    ], check=True, capture_output=True, timeout=30)
    metadata = inspect_source(source)
    assert [(stream["type"], stream["codec"]) for stream in metadata["streams"]] == [
        ("video", "h264"), ("audio", "aac"),
    ]
    assert metadata["frame_count"] == 3


@pytest.mark.parametrize("times", [[None], [0, 0], [2, 1]])
def test_missing_or_nonincreasing_decoded_pts_has_no_fps_fallback(times: list[int | None]) -> None:
    # These decoder anomalies cannot be generated reliably by an encoder, which
    # usually repairs timestamps. Exercise the decoder boundary with actual PTS
    # values withheld/reordered, rather than inventing timing in the inspector.
    frames = [SimpleNamespace(pts=pts, time_base=Fraction(1, 25), is_corrupt=False) for pts in times]
    container: Any = SimpleNamespace(decode=lambda stream: iter(frames))
    with pytest.raises(MediaError) as error:
        list(decoded_frames(container, None))
    assert error.value.code == "unknown_timing"


def test_flagged_corrupt_decoded_frame_fails_explicitly() -> None:
    container: Any = SimpleNamespace(decode=lambda stream: iter([
        SimpleNamespace(pts=0, time_base=Fraction(1, 25), is_corrupt=True),
    ]))
    with pytest.raises(MediaError) as error:
        list(decoded_frames(container, None))
    assert error.value.code == "decode_failed"


def test_last_frame_without_duration_keeps_end_unknown(
    media: dict[str, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Do not invent a final frame duration or turn missing metadata into a crash."""
    def frames_with_unknown_last_duration(container, stream, cancelled=lambda: False):
        last = None
        for frame in decoded_frames(container, stream, cancelled):
            if last is not None:
                yield last
            last = frame
        if last is not None:
            yield SimpleNamespace(
                pts=last.pts, time_base=last.time_base,
                width=last.width, height=last.height,
                rotation=last.rotation, interlaced_frame=last.interlaced_frame,
                duration=None,
            )

    monkeypatch.setattr("backend.app.media.decoded_frames", frames_with_unknown_last_duration)
    result = inspect_source(media["short_mp4"])
    assert result["frame_count"] == 3
    assert result["last_pts"] == "1024"
    assert result["end_time"] is None and result["elapsed_end"] is None
    assert "The final decoded frame has no duration; the source end is unknown." in result["warnings"]


def test_disguised_playlist_cannot_fetch_network(tmp_path: Path) -> None:
    requests: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            requests.append(self.path)
            self.send_error(404)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    manifest = tmp_path / "playlist.mp4"
    manifest.write_text("#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n"
                        f"http://127.0.0.1:{server.server_port}/private.ts\n#EXT-X-ENDLIST\n")
    try:
        with pytest.raises(MediaError) as error:
            inspect_source(manifest)
        assert error.value.code == "unreadable_metadata"
        assert requests == []
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
