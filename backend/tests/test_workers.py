"""Worker launch, transport and platform helpers. The Windows branch runs here against a fake supervisor;
the real Job Object path is covered by the Windows-only tests at the end and by native acceptance."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.app import __main__ as launcher, preview, workers

ROOT = Path(__file__).resolve().parents[2]


def test_command_runs_modules_from_source_or_frozen_executable(monkeypatch):
    assert workers.command("summary_worker") == [sys.executable, "-m", "backend.app.summary_worker"]
    monkeypatch.setattr(workers, "FROZEN", True)
    assert workers.command("summary_worker") == [sys.executable, "--worker", "summary_worker"]
    assert workers.working_directory() == Path(sys.executable).resolve().parent


@pytest.mark.parametrize("name", ["os", "backend.app.main", "../x", "", "preview_worker --x"])
def test_command_rejects_modules_outside_the_whitelist(name):
    with pytest.raises(ValueError):
        workers.command(name)


@pytest.mark.parametrize("arguments", [["--worker", "os"], ["--worker"], ["--worker", "main"]])
def test_frozen_entry_point_rejects_unknown_workers(arguments):
    result = subprocess.run([sys.executable, "-m", "backend.run_backend", *arguments], cwd=ROOT,
                            capture_output=True, timeout=30)
    assert result.returncode == 2 and result.stdout == b""


def test_frozen_entry_point_reenters_a_worker_module():
    result = subprocess.run([sys.executable, "-m", "backend.run_backend", "--worker", "preview_worker"], cwd=ROOT,
                            input=b"{}", capture_output=True, timeout=30)
    assert result.returncode == 0 and json.loads(result.stdout) == {"manifest": None, "error": "preview_failed"}


def test_bounded_json_transport_rejects_oversize_and_non_regular(tmp_path):
    path = tmp_path / "request.json"
    workers.write_bounded(path, {"a": 1}, 16)
    assert json.loads(workers.read_bounded(path, 16)) == {"a": 1}
    with pytest.raises(workers.Rejected):
        workers.write_bounded(path, {"a": "x" * 64}, 16)
    with pytest.raises(workers.Rejected):
        workers.read_bounded(path, 2)
    with pytest.raises(ValueError):
        workers.write_bounded(path, {"a": float("nan")}, 64)
    with pytest.raises(workers.Rejected):
        workers.read_bounded(tmp_path, 16)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX symbolic link fixture")
def test_open_no_follow_refuses_a_symbolic_link_and_reserve_allocates(tmp_path):
    target = tmp_path / "target"
    target.write_bytes(b"x")
    (tmp_path / "link").symlink_to(target)
    with pytest.raises(OSError):
        workers.open_no_follow(tmp_path / "link", os.O_RDONLY)
    assert workers.is_link(tmp_path / "link") and not workers.is_link(target)
    descriptor = workers.open_no_follow(tmp_path / "reserve", os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    try:
        workers.reserve_bytes(descriptor, 3 * 1024 * 1024 + 5)
    finally:
        os.close(descriptor)
    assert (tmp_path / "reserve").stat().st_size == 3 * 1024 * 1024 + 5
    workers.sync_directory(tmp_path)
    with pytest.raises(OSError):
        workers.sync_directory(tmp_path / "link")


def test_wait_for_exit_returns_when_the_process_is_gone():
    process = subprocess.Popen([sys.executable, "-c", "pass"])
    process.wait()
    done = threading.Event()
    threading.Thread(target=lambda: (launcher.wait_for_exit(process.pid), done.set()), daemon=True).start()
    assert done.wait(5)


# --- Windows branch against a fake supervisor -------------------------------------------------

def fake_worker_environment():
    return {"SystemRoot": "C:\\Windows"}


class FakeWinjob(types.ModuleType):
    class ContainmentError(Exception):
        pass

    class Limits:
        def __init__(self, *values):
            self.values = values

    def __init__(self, behaviour):
        super().__init__("backend.app.winjob")
        self.behaviour, self.calls = behaviour, []
        self.worker_environment = fake_worker_environment

    def run(self, argv, cwd, limits, cancelled, environment=None):
        self.calls.append((argv, cwd, limits, environment))
        scratch = Path(argv[-1])
        assert json.loads((scratch / "request.json").read_text()) == {"ask": 1}
        return self.behaviour(scratch, cancelled)


def install(monkeypatch, behaviour):
    """Make `from . import winjob` inside backend.app resolve to the fake on any platform."""
    import backend.app

    fake = FakeWinjob(behaviour)
    monkeypatch.setitem(sys.modules, "backend.app.winjob", fake)
    monkeypatch.setattr(backend.app, "winjob", fake, raising=False)
    return fake


def contained(monkeypatch, behaviour):
    fake = install(monkeypatch, behaviour)
    return fake, lambda: workers.run_contained("preview_worker", {"ask": 1}, "limits", lambda: False, 1024, 1024)


def outcome(state="exited", code=0):
    return SimpleNamespace(state=state, exit_code=code, peak_memory_bytes=0, cpu_seconds=0.0, wall_seconds=0.0)


def test_contained_run_returns_the_validated_response(monkeypatch):
    def behaviour(scratch, _):
        (scratch / "response.json").write_text('{"manifest": null, "error": null}')
        return outcome()
    fake, run = contained(monkeypatch, behaviour)
    assert run() == ("ok", {"manifest": None, "error": None})
    argv, cwd, limits, environment = fake.calls[0]
    assert argv[:3] == [sys.executable, "-m", "backend.app.preview_worker"] and cwd == workers.working_directory()
    assert limits == "limits" and environment["OPENBLAS_NUM_THREADS"] == "1" and "BAT_API_TOKEN" not in environment


@pytest.mark.parametrize("state,code,expected", [
    ("cancelled", 1, "cancelled"), ("deadline", 1, "limit"),
    ("exited", workers.JOB_CPU_QUOTA_EXIT, "limit"), ("exited", workers.NO_MEMORY_EXIT, "limit"),
])
def test_contained_run_maps_supervisor_outcomes(monkeypatch, state, code, expected):
    _, run = contained(monkeypatch, lambda *_: outcome(state, code))
    assert run() == (expected, None)


@pytest.mark.parametrize("response", [
    None, "", "not json", '{"a": 1, "a": 2}', '{"a": NaN}', "[" * 5000, '{"x": "' + "y" * 2000 + '"}',
])
def test_contained_run_rejects_missing_or_malformed_responses(monkeypatch, response):
    def behaviour(scratch, _):
        if response is not None:
            (scratch / "response.json").write_text(response)
        return outcome()
    _, run = contained(monkeypatch, behaviour)
    with pytest.raises(workers.WorkerFailed):
        run()


def test_contained_run_fails_on_other_exit_codes_and_supervisor_errors(monkeypatch):
    _, run = contained(monkeypatch, lambda *_: outcome(code=1))
    with pytest.raises(workers.WorkerFailed):
        run()

    def broken(*_):
        raise FakeWinjob.ContainmentError("start_failed")
    _, run = contained(monkeypatch, broken)
    with pytest.raises(workers.WorkerFailed):
        run()


def test_contained_run_removes_its_scratch_directory(monkeypatch):
    seen = []

    def behaviour(scratch, _):
        seen.append(scratch)
        (scratch / "response.json").write_text("{}")
        return outcome()
    _, run = contained(monkeypatch, behaviour)
    run()
    assert seen and not seen[0].exists()


@pytest.mark.parametrize("state,code,expected", [
    ("cancelled", 1, "cancelled"), ("deadline", 1, "preview_limit"),
    ("exited", workers.JOB_CPU_QUOTA_EXIT, "preview_limit"), ("exited", 1, "preview_failed"),
])
def test_preview_maps_contained_outcomes_to_user_visible_errors(monkeypatch, state, code, expected):
    install(monkeypatch, lambda *_: outcome(state, code))
    # Only the outcome mapping is under test: the fake supervisor never reads the request file.
    monkeypatch.setattr(workers, "write_bounded", lambda *_: None)
    monkeypatch.setattr(FakeWinjob, "run", lambda self, argv, cwd, limits, cancelled, environment=None: self.behaviour(None, cancelled))
    with pytest.raises(preview.ImportErrorResponse) as error:
        preview.PreviewJobs._contained({"ask": 1}, threading.Event())
    assert error.value.code == expected


# --- Windows only: real Job Object -----------------------------------------------------------

windows = pytest.mark.skipif(sys.platform != "win32", reason="Windows Job Objects")


@windows
def test_windows_worker_refuses_to_run_outside_a_job(tmp_path):
    (tmp_path / "request.json").write_text(json.dumps({"parent_pid": os.getpid()}))
    subprocess.run([*workers.command("preview_worker"), str(tmp_path)], cwd=ROOT, check=True, timeout=60)
    assert json.loads((tmp_path / "response.json").read_text()) == {"manifest": None, "error": "preview_limits_unavailable"}


@windows
def test_windows_worker_runs_inside_a_job_with_limits_in_force():
    from backend.app import winjob

    limits = winjob.Limits(1024 ** 3, 20, 1, 60)
    status, body = workers.run_contained("preview_worker", {"parent_pid": os.getpid()}, limits, lambda: False, 4096, 4096)
    # The worker started, saw its Job Object limits and failed only because the request has no source.
    assert (status, body) == ("ok", {"manifest": None, "error": "preview_failed"})
