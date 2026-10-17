"""Real source-native weak-motion, colour-time, deterministic image and worker proofs."""

from __future__ import annotations

from fractions import Fraction
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path

import av
import numpy as np
from PIL import Image
import pytest

from backend.app import media, motion, store, summary_store, summary_worker, windows
from backend.tests.summary_fixtures import encode_frames, generate_summary_media

TIMES = [0, 100, 200, 1100, 1200, 1300, 9000, 9900, 10000, 10100,
         11100, 11200, 11300, 19900, 20000, 20100, 21100, 21200, 21300, 29900]
TARGETS = {1100: (12, 12), 11100: (40, 28), 21100: (70, 44)}


def synthetic_arrays(kind: str) -> list[np.ndarray]:
    random = np.random.default_rng(1149)
    base = random.integers(48, 57, size=(64, 96), dtype=np.uint8)
    frames = []
    for index, timestamp in enumerate(TIMES):
        frame = base.copy()
        if kind in {"noise", "weak_noise"}:
            frame = np.clip(frame.astype(np.int16) + random.integers(-1, 2, size=frame.shape), 0, 255).astype(np.uint8)
        if kind in {"weak", "weak_noise"} and timestamp in TARGETS:
            x, y = TARGETS[timestamp]
            frame[y:y + 2, x:x + 2] += 6
        if kind == "insect" and timestamp in TARGETS:
            frame[20:25, 10 + index * 2:15 + index * 2] += 60
        if kind == "brightness" and timestamp >= 10000:
            frame += 35
        if kind == "shake" and timestamp >= 10000:
            frame = np.roll(frame, 2, axis=1)
        frames.append(frame)
    return frames


def candidates(path: Path) -> tuple[dict, dict[str, motion.Evidence], dict[str, list[int]], dict]:
    metadata = media.inspect_source(path)
    interval = windows.plan_source(metadata)[0]
    params = windows.parameters()
    results = {name: motion.Evidence(interval, windows.fraction(metadata["time_base"]), params, metadata)
               for name in ("consecutive", "fixed")}
    preserved = {name: [] for name in results}
    measurements = {name: {"active_frame_pixels": 0, "peak_changed_fraction": 0.0,
                           "targets": []} for name in results}
    first = previous = None
    with av.open(str(path)) as container:
        for frame in media.decoded_frames(container, container.streams.video[0]):
            gray = frame.to_ndarray(format="gray")
            elapsed = frame.pts * frame.time_base - windows.fraction(metadata["first_time"])
            assert elapsed * 1000 in TIMES
            for name, reference in (("consecutive", previous), ("fixed", first)):
                results[name].add(gray, frame.pts, reference)
                if reference is not None:
                    difference = np.abs(gray.astype(np.int16) - reference.astype(np.int16))
                    mask = difference >= params["threshold"]
                    measurements[name]["active_frame_pixels"] += int(np.count_nonzero(mask))
                    measurements[name]["peak_changed_fraction"] = max(
                        measurements[name]["peak_changed_fraction"], float(np.count_nonzero(mask) / mask.size))
                    if int(elapsed * 1000) in TARGETS and path.stem in {"weak", "weak_noise", "insect"}:
                        if path.stem == "insect":
                            x, y, size = 10 + TIMES.index(int(elapsed * 1000)) * 2, 20, 5
                        else:
                            x, y = TARGETS[int(elapsed * 1000)]
                            size = 2
                        target_pixels = int(np.count_nonzero(mask[y:y + size, x:x + size]))
                        preserved[name].append(target_pixels)
                        phase = min(2, int(3 * elapsed / windows.fraction(metadata["elapsed_end"])))
                        measurements[name]["targets"].append({"elapsed": str(elapsed), "phase": phase,
                            "preserved": target_pixels, "expected": size * size,
                            "minimum_difference": int(difference[y:y + size, x:x + size].min()),
                            "panel_peak": int(results[name].planes[phase, y:y + size, x:x + size].max())})
            if first is None:
                first = gray
            previous = gray
    print(json.dumps({"fixture": path.stem, "interval_seconds": str(windows.fraction(metadata["elapsed_end"])),
                      "candidates": measurements}, sort_keys=True))
    return metadata, results, preserved, measurements


@pytest.mark.parametrize("kind", ["weak", "weak_noise"])
def test_real_mp4_weak_fast_target_survives_both_candidates_and_exact_source_colours(tmp_path: Path, kind: str) -> None:
    source = tmp_path / f"{kind}.mp4"
    encode_frames(source, synthetic_arrays(kind), TIMES)
    before = sha256(source.read_bytes()).hexdigest()
    metadata, results, preserved, _ = candidates(source)
    assert preserved == {"consecutive": [4, 4, 4], "fixed": [4, 4, 4]}, "STOP: weak target pixels were lost"
    evidence = results["consecutive"]
    # Frame index thirds differ from these irregular original source-time thirds.
    assert TIMES.index(1100) < len(TIMES) // 3 and TIMES.index(11100) < 2 * len(TIMES) // 3
    for phase, (x, y) in enumerate(TARGETS.values()):
        assert np.all(evidence.planes[phase, y:y + 2, x:x + 2] >= 3 * 16)
        if kind == "weak":
            rgb = evidence.motion_rgb()[y:y + 2, x:x + 2]
            assert all(np.all(rgb[:, :, channel] > 0) == bool(value) for channel, value in enumerate(motion.COLOURS[phase]))
    parameters_hash = windows.parameter_hash(windows.parameters())
    image = evidence.png("11111111-1111-4111-8111-111111111111", parameters_hash)
    assert image == evidence.png("11111111-1111-4111-8111-111111111111", parameters_hash)
    with Image.open(BytesIO(image)) as decoded:
        assert decoded.format == "PNG" and decoded.width == 640 and decoded.height <= 1024
        x_origin, y_origin = map(int, decoded.info["motion_origin"].split(","))
        pixels = np.asarray(decoded)
        for phase, (x, y) in enumerate(TARGETS.values()):
            target = pixels[y_origin+y:y_origin+y+2, x_origin+x:x_origin+x+2]
            assert target.max() >= 48, "STOP: weak target vanished from encoded PNG"
            if kind == "weak":
                assert all(np.all(target[:, :, channel] > 0) == bool(value)
                           for channel, value in enumerate(motion.COLOURS[phase]))
        assert decoded.info["parameters_sha256"] == parameters_hash
    assert evidence.stats()["frame_count"] == metadata["frame_count"] == len(TIMES)
    assert metadata["first_time"] == {"num": "9", "den": "2"}
    assert sha256(source.read_bytes()).hexdigest() == before


@pytest.mark.parametrize("kind", ["stationary", "noise", "insect", "brightness", "shake"])
def test_real_mp4_negative_noise_insect_and_scene_changes_are_retained_and_flagged(tmp_path: Path, kind: str) -> None:
    source = tmp_path / f"{kind}.mp4"
    encode_frames(source, synthetic_arrays(kind), TIMES)
    _, results, _, measurements = candidates(source)
    consecutive, fixed = results["consecutive"], results["fixed"]
    if kind == "stationary":
        assert consecutive.stats()["motion_pixels"] == 0
    elif kind == "noise":
        # RGB/gray to limited-range codec conversion can turn +/-1 source noise
        # into differences >=3. Retain it; do not tune away the weak positive.
        assert consecutive.stats()["motion_pixels"] > 0
        assert "framewide_change" not in consecutive.flags
    elif kind == "insect":
        for phase, index in enumerate(TIMES.index(value) for value in TARGETS):
            assert np.all(consecutive.planes[phase, 20:25, 10 + index * 2:15 + index * 2] > 0)
    else:
        assert "framewide_change" in consecutive.flags
        assert ("brightness_transition" in consecutive.flags) == (kind == "brightness")
        assert np.count_nonzero(consecutive.planes[2]) == 0
        assert np.count_nonzero(fixed.planes[2]) > 0
        assert measurements["consecutive"]["active_frame_pixels"] < measurements["fixed"]["active_frame_pixels"]
    assert consecutive.png("22222222-2222-4222-8222-222222222222", windows.parameter_hash(windows.parameters())).startswith(b"\x89PNG")


def test_native_full_hd_weak_motion_is_preserved_before_max_pooling(tmp_path: Path) -> None:
    base = np.full((1080, 1920), 52, dtype=np.uint8)
    target = base.copy()
    target[1077:1079, 1916:1918] += 6
    source = tmp_path / "weak-full-hd.mp4"
    encode_frames(source, [base, target], [0, 1000])
    metadata = media.inspect_source(source)
    evidence = motion.Evidence(windows.plan_source(metadata)[0], windows.fraction(metadata["time_base"]), windows.parameters(), metadata)
    previous = None
    with av.open(str(source)) as container:
        for frame in media.decoded_frames(container, container.streams.video[0]):
            gray = frame.to_ndarray(format="gray")
            evidence.add(gray, frame.pts, previous)
            previous = gray
    assert evidence.motion_rgb().shape == (360, 640, 3)
    assert evidence.stats()["motion_pixels"] > 0, "STOP: full-HD weak target vanished during reduction"
    assert evidence.motion_rgb().max() >= 80
    with Image.open(BytesIO(evidence.png("33333333-3333-4333-8333-333333333333", "0" * 64))) as decoded:
        assert decoded.width == 1280 and decoded.height <= 1024
        x_origin, y_origin = map(int, decoded.info["motion_origin"].split(","))
        pixels = np.asarray(decoded)
        assert pixels[y_origin + 1077//3:y_origin + 1079//3+1,
                      x_origin + 1916//3:x_origin + 1918//3+1].max() >= 80


def prepared(directory: Path, source: Path, unknown_end: bool = False) -> tuple[Path, str]:
    database = directory / "bat.sqlite3"
    store.initialise(database)
    store.upgrade_media(database)
    session_id = store.create_session(database, "Synthetic motion", "Synthetic IR camera")["id"]
    metadata = media.inspect_source(source)
    if unknown_end:
        metadata["end_time"] = metadata["elapsed_end"] = None
    store.commit_segments(database, session_id, [(source, metadata)])
    summary_store.upgrade(database)
    return database, summary_store.create_run(database, session_id)


@pytest.mark.parametrize("case,counts", [("quiet_65", [2, 2, 2]), ("quiet_9", [2]), ("empty_middle", [1, 0, 1]), ("single", [1])])
def test_worker_publishes_every_window_or_explicit_incomplete_record(tmp_path: Path, case: str, counts: list[int]) -> None:
    source = generate_summary_media(tmp_path / "originals")[case]
    database, run_id = prepared(tmp_path / "data", source)
    before = sha256(source.read_bytes()).hexdigest()
    summary_worker.render({"db_path": str(database), "data_dir": str(database.parent), "run_id": run_id})
    summary_store.finish_run(database, run_id, "complete")
    run = summary_store.get_run(database, run_id)
    assert [row["stats"]["frame_count"] for row in run["windows"]] == counts
    assert run["counts"]["planned"] == len(counts)
    assert run["state"] == ("incomplete" if 0 in counts else "complete")
    for row, count in zip(run["windows"], counts, strict=True):
        assert row["image"] is not None if count else row["image"] is None
        if not count:
            assert row["error"]["code"] == "no_decoded_frames"
        if count == 1:
            assert "insufficient_comparison_frames" in row["flags"] or row["stats"]["comparison_count"] > 0
    assert not list((database.parent / "summaries").rglob("*.part"))
    assert sha256(source.read_bytes()).hexdigest() == before


def test_worker_unknown_final_end_has_stats_and_no_invented_image(tmp_path: Path) -> None:
    source = generate_summary_media(tmp_path / "originals")["quiet_65"]
    database, run_id = prepared(tmp_path / "data", source, unknown_end=True)
    summary_worker.render({"db_path": str(database), "data_dir": str(database.parent), "run_id": run_id})
    summary_store.finish_run(database, run_id, "complete")
    run = summary_store.get_run(database, run_id)
    assert run["state"] == "incomplete"
    assert len(run["windows"]) == 3
    tail = run["windows"][-1]
    assert tail["interval"]["end_time"] is None and tail["interval"]["end_pts"] is None
    assert tail["stats"]["frame_count"] == 2 and tail["preview_pts"] is not None
    assert tail["status"] == "incomplete" and tail["error"]["code"] == "unknown_end" and tail["image"] is None
    assert tail["stats"]["phase_pixels"] is None and tail["stats"]["motion_pixels"] is None
    assert "unknown_end_unassessable" in tail["flags"]


def test_actual_partial_nine_second_worker_png_has_all_three_source_time_colours(tmp_path: Path) -> None:
    times = [0, 1100, 1200, 4100, 4200, 7100, 7200, 8960]
    targets = {1100: (12, 12), 4100: (40, 28), 7100: (70, 44)}
    base = np.full((64, 96), 52, dtype=np.uint8)
    frames = []
    for timestamp in times:
        frame = base.copy()
        if timestamp in targets:
            x, y = targets[timestamp]
            frame[y:y+2, x:x+2] += 6
        frames.append(frame)
    source = tmp_path / "weak-nine-second-original.mp4"
    encode_frames(source, frames, times)
    database, run_id = prepared(tmp_path / "data", source)
    before = sha256(source.read_bytes()).hexdigest()
    summary_worker.render({"db_path": str(database), "data_dir": str(database.parent), "run_id": run_id})
    summary_store.finish_run(database, run_id, "complete")
    run = summary_store.get_run(database, run_id)
    assert run["state"] == "complete" and run["counts"]["planned"] == 1
    row = summary_store.private_window(database, run["windows"][0]["id"])
    assert windows.fraction(row["interval"]["elapsed_end"]) == 9
    assert row["stats"]["phase_pixels"] == [4, 4, 4]
    with Image.open(row["image_path"]) as image:
        x_origin, y_origin = map(int, image.info["motion_origin"].split(","))
        pixels = np.asarray(image)
        for phase, (x, y) in enumerate(targets.values()):
            target = pixels[y_origin+y:y_origin+y+2, x_origin+x:x_origin+x+2]
            assert all(np.all(target[:, :, channel] > 0) == bool(value)
                       for channel, value in enumerate(motion.COLOURS[phase])), "STOP: weak partial-window time colour lost"
            assert target.max() >= 80
    assert sha256(source.read_bytes()).hexdigest() == before


def test_declared_gap_is_clipped_into_every_window_before_publication(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = generate_summary_media(tmp_path / "originals")["empty_middle"]
    database, run_id = prepared(tmp_path / "data", source)
    decode = media.decoded_frames

    def declared_short_frame(container, stream, cancelled=media._not_cancelled):
        for frame in decode(container, stream, cancelled):
            # A controlled declared 40ms first-frame duration proves a real gap.
            # Unmodified MP4 duration spans the next PTS; spacing alone is not gap evidence.
            frame.duration = int(Fraction(1, 25) / frame.time_base)
            yield frame

    monkeypatch.setattr(media, "decoded_frames", declared_short_frame)
    summary_worker.render({"db_path": str(database), "data_dir": str(database.parent), "run_id": run_id})
    summary_store.finish_run(database, run_id, "complete")
    rows = summary_store.get_run(database, run_id)["windows"]
    assert [row["stats"]["frame_count"] for row in rows] == [1, 0, 1]
    first = windows.fraction(rows[0]["interval"]["start_time"])
    expected = [(first + Fraction(1, 25), first + 30),
                (first + 30, first + 60), (first + 60, first + Fraction(1624, 25))]
    for row, (start, end) in zip(rows, expected, strict=True):
        assert row["stats"]["gap_count"] == 1 and "declared_timestamp_gap" in row["flags"]
        assert row["stats"]["gaps"] == [{"start": windows.rational(start), "end": windows.rational(end)}]


def test_unknown_tail_does_not_fabricate_phase_and_gap_examples_are_explicitly_bounded() -> None:
    metadata = {"width": 4, "height": 4, "rotation": 0, "interlaced": False, "field_order": None}
    interval = {"index": 0, "start_time": windows.rational(0), "end_time": None}
    evidence = motion.Evidence(interval, Fraction(1, 1000), windows.parameters(), metadata)
    evidence.add(np.zeros((4, 4), dtype=np.uint8), 0, None)
    evidence.add(np.full((4, 4), 50, dtype=np.uint8), 100, np.zeros((4, 4), dtype=np.uint8))
    for index in range(70):
        evidence.spacing(Fraction(index), Fraction(1, 25), Fraction(index) + Fraction(1, 2))
    assert evidence.stats()["frame_count"] == 2 and evidence.stats()["comparison_count"] == 1
    assert evidence.stats()["motion_pixels"] is None and evidence.stats()["phase_pixels"] is None
    assert np.count_nonzero(evidence.planes) == 0
    assert evidence.stats()["gap_count"] == 70 and len(evidence.stats()["gaps"]) == 64
    assert {"gap_examples_truncated", "unknown_end_unassessable"} <= evidence.flags
