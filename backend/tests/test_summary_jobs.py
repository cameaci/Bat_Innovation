"""Real isolated summary workers, bounded resources and durable cleanup failures."""

from __future__ import annotations

import ctypes
import json
import os
from pathlib import Path
import signal
import select
import subprocess
import sys
from threading import Lock
import time
from types import SimpleNamespace
from uuid import uuid4

import numpy as np
import pytest

from backend.app import media, store, summary_jobs, summary_store
from backend.tests.summary_fixtures import encode_frames, generate_summary_media


@pytest.fixture(scope="module")
def originals(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    return generate_summary_media(tmp_path_factory.mktemp("summary-job-originals"))


def prepare(directory: Path, source: Path) -> tuple[Path, str]:
    database = directory / "bat_innovation.sqlite3"
    store.initialise(database)
    store.upgrade_media(database)
    session = store.create_session(database, "Synthetic cleanup session", "Synthetic camera")["id"]
    store.commit_segments(database, session, [(source, media.inspect_source(source))])
    summary_store.upgrade(database)
    return database, session


def wait(jobs: summary_jobs.SummaryJobs, run_id: str) -> dict:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        run = jobs.get(run_id)
        if run["state"] not in {"queued", "running"}:
            return run
        time.sleep(0.005)
    pytest.fail("The small real summary worker exceeded its test deadline")


def stop_worker(jobs: summary_jobs.SummaryJobs) -> int:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        child = jobs._process
        if child is not None and child.poll() is None:
            os.kill(child.pid, signal.SIGSTOP)
            return child.pid
        time.sleep(0.001)
    pytest.fail("The real summary child did not start")


@pytest.mark.parametrize("end", ["cancel", "kill", "timeout", "close"])
def test_real_worker_terminal_status_follows_reap_cleanup_and_reservation_release(
    tmp_path: Path, originals: dict[str, Path], monkeypatch: pytest.MonkeyPatch, end: str,
) -> None:
    database, session = prepare(tmp_path / "data", originals["quiet_65"])
    if end == "timeout":
        monkeypatch.setattr(summary_jobs, "WALL_SECONDS", 0.2)
    activity = Lock()
    jobs = summary_jobs.SummaryJobs(database, database.parent, activity)
    run = jobs.start(session)
    pid = stop_worker(jobs)
    assert not activity.acquire(blocking=False)
    if end == "cancel":
        jobs.cancel(run["id"])
    elif end == "kill":
        os.kill(pid, signal.SIGKILL)
    elif end == "close":
        jobs.close()
    terminal = wait(jobs, run["id"])
    assert terminal["state"] == ("cancelled" if end in {"cancel", "close"} else "failed")
    assert terminal["error"]["code"] == ("cancelled" if end in {"cancel", "close"} else "summary_limit")
    assert terminal["counts"]["incomplete"] == terminal["counts"]["planned"] == 3
    assert not Path(f"/proc/{pid}").exists()
    assert not list(jobs.directory.rglob("*.part"))
    assert not (jobs.directory / ".manifest-reserve").exists()
    assert activity.acquire(blocking=False)
    activity.release()
    jobs.close()


def test_linux_worker_limits_token_removal_and_native_thread_bounds(
    tmp_path: Path, originals: dict[str, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    database, session = prepare(tmp_path / "data", originals["quiet_65"])
    monkeypatch.setenv("BAT_API_TOKEN", "synthetic-secret-must-not-reach-native-worker")
    jobs = summary_jobs.SummaryJobs(database, database.parent, Lock())
    jobs.start(session)
    deadline = time.monotonic() + 3
    pid = None
    while time.monotonic() < deadline:
        child = jobs._process
        if child is not None and child.poll() is None:
            limits = Path(f"/proc/{child.pid}/limits").read_text()
            if "Max address space         1073741824" in limits:
                pid = child.pid
                os.kill(pid, signal.SIGSTOP)
                break
        time.sleep(0.001)
    try:
        assert pid is not None
        assert "Max cpu time              300" in limits
        assert "Max file size             134217728" in limits
        assert "Max core file size        0" in limits
        environment = Path(f"/proc/{pid}/environ").read_bytes()
        assert b"BAT_API_TOKEN=" not in environment
        assert b"OPENBLAS_NUM_THREADS=1\x00" in environment
        assert b"OMP_NUM_THREADS=1\x00" in environment
    finally:
        jobs.close()
    assert not Path(f"/proc/{pid}").exists()


def test_thread_start_failure_keeps_manifest_cleanup_shutdown_and_retry_safe(
    tmp_path: Path, originals: dict[str, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    database, session = prepare(tmp_path / "data", originals["quiet_9"])
    activity = Lock()
    jobs = summary_jobs.SummaryJobs(database, database.parent, activity)

    def unavailable(_thread) -> None:
        raise RuntimeError("Synthetic native thread startup failure")

    with monkeypatch.context() as patch:
        patch.setattr(summary_jobs.Thread, "start", unavailable)
        with pytest.raises(summary_jobs.SummaryError) as failure:
            jobs.start(session)
        assert failure.value.code == "summary_failed"
        assert jobs._thread is None
        failed = jobs.list(session)[0]
        assert failed["state"] == "failed" and failed["counts"]["incomplete"] == 1
        assert activity.acquire(blocking=False)
        activity.release()
        assert not (jobs.directory / ".manifest-reserve").exists()
        jobs.close()
    retried = summary_jobs.SummaryJobs(database, database.parent, activity)
    try:
        complete = wait(retried, retried.start(session)["id"])
        assert complete["state"] == "complete"
        first_id = complete["windows"][0]["id"]
        first_image = retried.image(first_id)
        repeated = wait(retried, retried.start(session)["id"])
        assert repeated["state"] == "complete" and repeated["id"] != complete["id"]
        assert retried.image(first_id) == first_image
    finally:
        retried.close()


@pytest.mark.parametrize("rollback_failure", ["cleanup", "finish"])
def test_thread_start_rollback_failure_still_releases_reservation_and_allows_restart(
    tmp_path: Path, originals: dict[str, Path], monkeypatch: pytest.MonkeyPatch, rollback_failure: str,
) -> None:
    database, session = prepare(tmp_path / "data", originals["quiet_9"])
    activity = Lock()
    jobs = summary_jobs.SummaryJobs(database, database.parent, activity)

    def unavailable(*_args, **_kwargs):
        raise OSError("Synthetic local storage or native thread failure")

    with monkeypatch.context() as patch:
        patch.setattr(summary_jobs.Thread, "start", unavailable)
        if rollback_failure == "cleanup":
            real_cleanup = jobs._cleanup

            def fail_rollback(run_id=None):
                if run_id is not None:
                    unavailable()
                real_cleanup(run_id)

            patch.setattr(jobs, "_cleanup", fail_rollback)
        else:
            patch.setattr(summary_store, "finish_run", unavailable)
        with pytest.raises(summary_jobs.SummaryError) as failure:
            jobs.start(session)
        assert failure.value.code == "summary_failed"
        assert jobs._thread is None and jobs._run_id is None
        assert activity.acquire(blocking=False)
        activity.release()
        jobs.close()
    recovered = summary_jobs.SummaryJobs(database, database.parent, activity)
    try:
        assert recovered.list(session)[0]["state"] == "interrupted"
        assert wait(recovered, recovered.start(session)["id"])["state"] == "complete"
    finally:
        recovered.close()


def test_parent_death_kills_native_worker_and_restart_records_interruption(
    tmp_path: Path, originals: dict[str, Path],
) -> None:
    database, session = prepare(tmp_path / "data", originals["quiet_65"])
    # Adopt this test's orphan so it can be reaped even when container PID 1
    # does not reap grandchildren. Restore the previous Linux process setting.
    libc, previous = ctypes.CDLL(None), ctypes.c_int()
    assert libc.prctl(37, ctypes.byref(previous), 0, 0, 0) == 0
    assert libc.prctl(36, 1, 0, 0, 0) == 0
    controller_code = """
import json, os, signal, sys, time
from pathlib import Path
from threading import Lock
from backend.app.summary_jobs import SummaryJobs
payload = json.loads(sys.stdin.read())
database = Path(payload['database'])
jobs = SummaryJobs(database, database.parent, Lock())
jobs.start(payload['session'])
deadline = time.monotonic() + 4
while time.monotonic() < deadline:
    child = jobs._process
    if child is not None and child.poll() is None:
        limits = Path(f'/proc/{child.pid}/limits').read_text()
        if 'Max address space         1073741824' in limits:
            os.kill(child.pid, signal.SIGSTOP)
            print(child.pid, flush=True)
            while True: time.sleep(1)
    time.sleep(.001)
raise RuntimeError('Worker never installed its limits')
"""
    controller = subprocess.Popen([sys.executable, "-c", controller_code], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    worker_pid = None
    try:
        controller.stdin.write(json.dumps({"database": str(database), "session": session}).encode())
        controller.stdin.close()
        assert select.select([controller.stdout], [], [], 6)[0]
        worker_pid = int(controller.stdout.readline())
        controller.kill()
        controller.wait(timeout=3)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                state = Path(f"/proc/{worker_pid}/status").read_text()
            except FileNotFoundError:
                break
            if "State:\tZ" in state:
                break
            time.sleep(0.005)
        else:
            pytest.fail("The Linux parent-death guard did not kill the stopped native worker")
    finally:
        if controller.poll() is None:
            controller.kill()
            controller.wait(timeout=3)
        if worker_pid is not None:
            try:
                os.kill(worker_pid, signal.SIGKILL)
                os.waitpid(worker_pid, 0)
            except (ProcessLookupError, ChildProcessError):
                pass
        assert libc.prctl(36, previous.value, 0, 0, 0) == 0
    assert not Path(f"/proc/{worker_pid}").exists()
    recovered = summary_jobs.SummaryJobs(database, database.parent, Lock())
    try:
        run = recovered.list(session)[0]
        assert run["state"] == "interrupted" and run["counts"]["incomplete"] == 3
        assert not (recovered.directory / ".manifest-reserve").exists()
    finally:
        recovered.close()


def test_restart_records_interrupted_plan_and_cleans_only_owned_orphans(
    tmp_path: Path, originals: dict[str, Path],
) -> None:
    database, session = prepare(tmp_path / "data", originals["quiet_65"])
    run_id = summary_store.create_run(database, session)
    folder = database.parent / "summaries" / run_id
    folder.mkdir(parents=True)
    orphan = folder / f"{uuid4()}.png"
    partial = folder / f"{uuid4()}.png.part"
    orphan.write_bytes(b"unfinished derived output")
    partial.write_bytes(b"interrupted atomic write")
    unrelated = folder / "keep-unrelated.txt"
    unrelated.write_text("not a managed artifact")
    jobs = summary_jobs.SummaryJobs(database, database.parent, Lock())
    try:
        run = jobs.get(run_id)
        assert run["state"] == "interrupted" and run["counts"]["incomplete"] == 3
        assert all(row["error"]["code"] == "interrupted" for row in run["windows"])
        assert not orphan.exists() and not partial.exists() and unrelated.is_file()
    finally:
        jobs.close()


def test_disk_quota_platform_and_shared_activity_rejections_do_not_mutate_history(
    tmp_path: Path, originals: dict[str, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    database, session = prepare(tmp_path / "data", originals["quiet_9"])
    activity = Lock()
    jobs = summary_jobs.SummaryJobs(database, database.parent, activity)
    complete = wait(jobs, jobs.start(session)["id"])
    assert complete["state"] == "complete"
    with monkeypatch.context() as patch:
        patch.setattr(summary_jobs, "MAX_TOTAL_BYTES", 1)
        with pytest.raises(summary_jobs.SummaryError) as failure:
            jobs.start(session)
        assert failure.value.code == "summary_limit"
    with monkeypatch.context() as patch:
        patch.setattr(summary_jobs, "MAX_RUNS_PER_SESSION", 1)
        with pytest.raises(summary_jobs.SummaryError) as failure:
            jobs.start(session)
        assert failure.value.code == "summary_limit"
    with monkeypatch.context() as patch:
        patch.setattr(summary_jobs.shutil, "disk_usage", lambda _: SimpleNamespace(free=0))
        with pytest.raises(summary_jobs.SummaryError) as failure:
            jobs.start(session)
        assert failure.value.code == "summary_limit"
    with monkeypatch.context() as patch:
        patch.setattr(summary_jobs.sys, "platform", "win32")
        with pytest.raises(summary_jobs.SummaryError) as failure:
            jobs.start(session)
        assert failure.value.code == "summary_limits_unavailable"
    activity.acquire()
    try:
        with pytest.raises(summary_jobs.SummaryError) as failure:
            jobs.start(session)
        assert failure.value.code == "summary_busy"
    finally:
        activity.release()
    assert len(jobs.list(session)) == 1
    assert jobs.image(complete["windows"][0]["id"]).startswith(b"\x89PNG")
    jobs.close()


@pytest.mark.parametrize("change", ["missing", "changed", "unreadable"])
def test_unavailable_original_at_start_has_a_durable_failed_coverage_plan(
    tmp_path: Path, originals: dict[str, Path], monkeypatch: pytest.MonkeyPatch, change: str,
) -> None:
    original = tmp_path / "source.mp4"
    original.write_bytes(originals["quiet_65"].read_bytes())
    database, session = prepare(tmp_path / "data", original)
    jobs = summary_jobs.SummaryJobs(database, database.parent, Lock())
    if change == "missing":
        original.unlink()
    elif change == "changed":
        with original.open("ab") as source:
            source.write(b"synthetic source change")
    else:
        original_open = Path.open

        def unreadable(path, *args, **kwargs):
            if path == original:
                raise PermissionError("Synthetic denied source access")
            return original_open(path, *args, **kwargs)

        monkeypatch.setattr(Path, "open", unreadable)
    run = jobs.start(session)
    assert run["state"] == "failed" and run["error"]["code"] == f"{change}_source"
    assert run["counts"]["planned"] == run["counts"]["incomplete"] == 3
    assert all(row["image"] is None for row in run["windows"])
    assert all(row["source_state"] == f"{change}_source" for row in run["windows"])
    assert summary_store.get_run(database, run["id"])["state"] == "failed"
    assert not (jobs.directory / ".manifest-reserve").exists()
    jobs.close()


def test_unavailable_segment_does_not_mislabel_an_independent_ready_segment(
    tmp_path: Path, originals: dict[str, Path],
) -> None:
    missing = tmp_path / "missing.mp4"
    missing.write_bytes(originals["quiet_65"].read_bytes())
    database, session = prepare(tmp_path / "data", missing)
    store.commit_segments(database, session, [(originals["quiet_9"], media.inspect_source(originals["quiet_9"]))])
    segments = store.private_segments(database, session)
    missing.unlink()
    jobs = summary_jobs.SummaryJobs(database, database.parent, Lock())
    try:
        run = jobs.start(session)
        assert run["state"] == "failed" and run["error"]["code"] == "missing_source"
        for window in run["windows"]:
            if window["segment_id"] == segments[0]["id"]:
                assert window["error"]["code"] == window["source_state"] == "missing_source"
            else:
                assert window["source_state"] == "ready"
                assert window["error"]["code"] == "incomplete_run"
                assert window["status"] == "incomplete"
    finally:
        jobs.close()


def test_real_decoding_then_enospc_image_failure_leaves_durable_manifest_and_retry(
    tmp_path: Path, originals: dict[str, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    database, session = prepare(tmp_path / "data", originals["quiet_65"])
    jobs = summary_jobs.SummaryJobs(database, database.parent, Lock())
    real_popen = subprocess.Popen
    # Inject only the OS image-write error inside a real resource-limited worker.
    # PyAV decoding, motion evidence, PNG creation and SQLite writes still execute.
    fault = """
import errno, os
from pathlib import Path
from backend.app import summary_worker
original_open = Path.open
def fail_image(self, *args, **kwargs):
    if self.name.endswith('.png.part'):
        reserve = self.parent.parent / '.manifest-reserve'
        assert reserve.stat().st_blocks * 512 >= 8 * 1024 * 1024
        raise OSError(errno.ENOSPC, 'Synthetic full output volume')
    return original_open(self, *args, **kwargs)
Path.open = fail_image
summary_worker.main()
"""

    def faulty_worker(command, **kwargs):
        return real_popen([sys.executable, "-c", fault], **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(summary_jobs.subprocess, "Popen", faulty_worker)
        failed = wait(jobs, jobs.start(session)["id"])
    assert failed["state"] == "failed" and failed["error"]["code"] == "summary_limit"
    assert failed["counts"]["failed"] + failed["counts"]["incomplete"] == 3
    assert failed["windows"][0]["stats"]["frame_count"] > 0
    assert not list(jobs.directory.rglob("*.png")) and not list(jobs.directory.rglob("*.part"))
    assert not (jobs.directory / ".manifest-reserve").exists()
    assert wait(jobs, jobs.start(session)["id"])["state"] == "complete"
    jobs.close()
    reopened = summary_jobs.SummaryJobs(database, database.parent, Lock())
    try:
        assert reopened.get(failed["id"])["state"] == "failed"
    finally:
        reopened.close()


def test_full_hd_weak_targets_survive_the_actual_limited_worker(tmp_path: Path) -> None:
    source = tmp_path / "original-full-hd.mp4"
    arrays = [np.full((1080, 1920), 32, np.uint8) for _ in range(5)]
    for index, (x, y) in enumerate(((100, 100), (300, 200), (500, 300)), start=1):
        arrays[index][y:y+2, x:x+2] += 6
    encode_frames(source, arrays, [0, 1100, 11100, 21100, 29960])
    database, session = prepare(tmp_path / "data", source)
    jobs = summary_jobs.SummaryJobs(database, database.parent, Lock())
    started = time.monotonic()
    run_id = jobs.start(session)["id"]
    peak_kib = 0
    while time.monotonic() - started < 15:
        child = jobs._process
        if child is not None:
            try:
                for line in Path(f"/proc/{child.pid}/status").read_text().splitlines():
                    if line.startswith("VmHWM:"):
                        peak_kib = max(peak_kib, int(line.split()[1]))
            except FileNotFoundError:
                pass
        run = jobs.get(run_id)
        if run["state"] not in {"queued", "running"}:
            break
        time.sleep(0.002)
    try:
        assert run["state"] == "complete", run
        window = run["windows"][0]
        assert window["stats"]["frame_count"] == 5
        assert all(count > 0 for count in window["stats"]["phase_pixels"])
        assert 0 < peak_kib < 1024 * 1024
        image = jobs.image(window["id"])
        print(f"Full-HD limited worker: {time.monotonic()-started:.3f}s, peak RSS {peak_kib} KiB, PNG {len(image)} bytes, phase pixels {window['stats']['phase_pixels']}")
    finally:
        jobs.close()


@pytest.mark.parametrize("window_status, terminal_error", [
    ("failed", "decode_failed"),
    ("incomplete", "cancelled"),
    ("incomplete", "no_decoded_frames"),
])
def test_missing_original_does_not_erase_terminal_summary_errors(
    tmp_path: Path, originals: dict[str, Path],
    monkeypatch: pytest.MonkeyPatch, window_status: str, terminal_error: str,
) -> None:
    source = tmp_path / "original.mp4"
    source.write_bytes(originals["quiet_9"].read_bytes())
    database, session = prepare(tmp_path / "data", source)
    run_id = summary_store.create_run(database, session)
    window = summary_store.private_run(database, run_id)["windows"][0]
    summary_store.record_window(database, window["id"], {"frame_count": 0},
                                window_status, error_code=terminal_error)
    summary_store.finish_run(database, run_id, "cancelled" if terminal_error == "cancelled" else "failed",
                             terminal_error)
    source.unlink()
    jobs = summary_jobs.SummaryJobs(database, database.parent, Lock())
    try:
        for _ in range(2):
            result = jobs.get(run_id)
            assert result["windows"][0]["status"] == window_status
            assert result["windows"][0]["error"]["code"] == terminal_error
            assert result["windows"][0]["source_state"] == "missing_source"
            saved = summary_store.private_window(database, window["id"])
            assert saved["status"] == window_status
            assert saved["error_code"] == terminal_error

        def forbidden_detail(*_args, **_kwargs):
            raise AssertionError("Run listing must not load or revalidate every window")

        monkeypatch.setattr(jobs, "_get", forbidden_detail)
        listing = jobs.list(session)
        assert len(listing) == 1
        assert listing[0]["id"] == run_id
        assert listing[0]["counts"]["planned"] == 1
        assert listing[0]["counts"][window_status] == 1
    finally:
        jobs.close()



def test_worker_source_failure_retains_preexisting_terminal_errors(
    tmp_path: Path, originals: dict[str, Path],
) -> None:
    from hashlib import sha256
    from backend.app import summary_worker

    source = tmp_path / "original.mp4"
    source.write_bytes(originals["quiet_65"].read_bytes())
    database, session = prepare(tmp_path / "data", source)
    run_id = summary_store.create_run(database, session)
    first, second, third = summary_store.private_run(database, run_id)["windows"]
    saved_image = tmp_path / "previous-complete.png"
    saved_image.write_bytes(b"synthetic image data for storage transaction only")
    data = saved_image.read_bytes()
    summary_store.record_window(
        database, first["id"], {"frame_count": 1}, "complete",
        saved_image, sha256(data).hexdigest(), len(data),
    )
    summary_store.record_window(
        database, second["id"], {"frame_count": 0}, "failed", error_code="decode_failed",
    )
    source.write_bytes(source.read_bytes() + b"changed after import")
    with pytest.raises(summary_worker.WorkerError) as error:
        summary_worker.render({
            "db_path": str(database), "data_dir": str(database.parent), "run_id": run_id,
        })
    assert error.value.code == "changed_source"
    completed = summary_store.private_window(database, first["id"])
    prior_failure = summary_store.private_window(database, second["id"])
    untouched = summary_store.private_window(database, third["id"])
    assert completed["status"] == "incomplete"
    assert completed["error_code"] == "changed_source"
    assert prior_failure["status"] == "failed"
    assert prior_failure["error_code"] == "decode_failed"
    assert untouched["status"] == "planned"
    summary_store.finish_run(database, run_id, "failed", "changed_source")
    assert summary_store.private_window(database, third["id"])["error_code"] == "incomplete_run"
