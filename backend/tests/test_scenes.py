"""The synthetic benchmark scenes (Phase 3 X2): deterministic, with ground truth that follows the gate rule."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np

from backend.tests import scenes


def test_scenes_are_deterministic_and_their_truth_matches_the_paths() -> None:
    first, second = scenes.scenarios(), scenes.scenarios()
    assert list(first) == list(second)
    for name, scene in first.items():
        assert all(np.array_equal(a, b) for a, b in zip(scene.frames, second[name].frames)), name
        assert len(scene.frames) == len(scene.times_ms)
    # Ten trickle bats: eight cross once, two go out and come back.
    truth = first["sky_trickle"].truth()
    assert len(truth) == 12 and sum(direction == "B_to_A" for _, direction in truth) == 10
    assert first["empty_stone"].truth() == [] and len(first["dense_stream"].truth()) > 100


def test_repeated_frames_and_gain_steps_are_present() -> None:
    repeated = scenes.scenarios()["repeated_frames"].frames
    assert np.array_equal(repeated[1], repeated[0]) and np.array_equal(repeated[3], repeated[2])
    stepped = scenes.scenarios()["gain_steps"].frames
    assert stepped[55].mean() > stepped[45].mean() + 3


def test_benchmark_matches_crossings_by_direction_and_time() -> None:
    spec = importlib.util.spec_from_file_location("benchmark", Path(__file__).resolve().parents[2] / "scripts" / "benchmark_tracking.py")
    benchmark = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(benchmark)
    truth = [(1000, "B_to_A"), (2000, "A_to_B")]
    assert benchmark.match([(1100, "B_to_A"), (2000, "B_to_A")], truth, 200) == 1
    row = benchmark.evaluate(scenes.scenarios()["resting_bat"], "tracks-v2", raw=True)
    assert row["true_crossings"] == 1 and row["matched"] == 1 and row["precision"] == 1.0
