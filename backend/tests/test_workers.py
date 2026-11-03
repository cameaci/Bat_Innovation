"""Worker launch, transport and platform helpers. The Windows branch runs here against a fake supervisor;
the real Job Object path is covered by the Windows-only tests at the end and by native acceptance."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
import types
import urllib.request
import uuid
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


def test_frozen_entry_point_reenters_a_worker_module(tmp_path):
    if sys.platform == "win32":
        # A Windows worker exchanges request.json/response.json through the scratch directory given as argv[1].
        (tmp_path / "request.json").write_text("{}")
        result = subprocess.run([sys.executable, "-m", "backend.run_backend", "--worker", "preview_worker", str(tmp_path)],
                                cwd=ROOT, capture_output=True, timeout=30)
        assert result.returncode == 0 and result.stdout == b""
        assert json.loads((tmp_path / "response.json").read_text()) == {"manifest": None, "error": "preview_failed"}
        return
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


def test_closing_the_stop_pipe_shuts_the_api_down_gracefully(tmp_path):
    """Windows has no termination signal a process can handle, so the shell closes stdin; only the flag enables this."""
    token = "t" * 32
    servers = []
    for name, flag, stdin in (("piped", "1", subprocess.PIPE), ("unflagged", "0", subprocess.DEVNULL)):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        (tmp_path / name).mkdir()
        env = {**os.environ, "BAT_APP_DATA_DIR": str(tmp_path / name), "BAT_API_TOKEN": token, "BAT_API_PORT": str(port),
               "BAT_STOP_ON_STDIN_EOF": flag}
        servers.append((port, subprocess.Popen([sys.executable, "-m", "backend.app"], cwd=ROOT, env=env, stdin=stdin,
                                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)))

    def healthy(port: int) -> bool:
        request = urllib.request.Request(f"http://127.0.0.1:{port}/api/health", headers={"X-Bat-Token": token})
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                return response.status == 200
        except OSError:
            return False
    try:
        for port, process in servers:
            deadline = time.monotonic() + 30
            while not healthy(port):
                assert process.poll() is None and time.monotonic() < deadline
                time.sleep(0.1)
        leftover = tmp_path / "piped" / "exports" / str(uuid.uuid4())
        leftover.mkdir()
        (leftover / "provisional-tracks.csv").write_bytes(b"synthetic")
        servers[0][1].stdin.close()
        assert servers[0][1].wait(timeout=15) == 0
        assert not leftover.exists()  # the lifespan shutdown ran
        assert healthy(servers[1][0])  # an empty stdin stops nothing without the flag
    finally:
        for _, process in servers:
            if process.poll() is None:
                process.kill()
            process.wait()


def test_remove_tree_removes_a_read_only_file(tmp_path):
    """A failed export leaves its 0o400 database snapshot behind; Windows refuses to unlink a read-only file."""
    folder = tmp_path / "stage" / "nested"
    folder.mkdir(parents=True)
    snapshot = folder.parent / "snapshot.sqlite3"
    snapshot.write_bytes(b"x")
    (folder / "rows.csv").write_bytes(b"y")
    os.chmod(snapshot, 0o400)
    workers.remove_tree(tmp_path / "stage")
    assert not (tmp_path / "stage").exists()
    with pytest.raises(FileNotFoundError):
        workers.remove_tree(tmp_path / "stage")


def test_rename_directory_retries_only_a_windows_denial(tmp_path, monkeypatch):
    (tmp_path / "stage").mkdir()
    calls = []
    real = os.rename

    def denied_twice(source, target):
        calls.append(source)
        if len(calls) < 3:
            raise PermissionError(13, "synthetic file held open in the directory")
        real(source, target)
    monkeypatch.setattr(workers.os, "rename", denied_twice)
    if sys.platform == "win32":
        workers.rename_directory(tmp_path / "stage", tmp_path / "final")
        assert len(calls) == 3 and (tmp_path / "final").is_dir()
    else:
        with pytest.raises(PermissionError):
            workers.rename_directory(tmp_path / "stage", tmp_path / "final")
        assert len(calls) == 1


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


@windows
def test_windows_directory_rename_waits_for_a_file_held_open_then_fails_explicitly(tmp_path):
    """A virus scanner reading a just-written CSV intermittently made native export publication fail."""
    stage = tmp_path / ".stage.part"
    stage.mkdir()
    (stage / "rows.csv").write_bytes(b"x")
    (tmp_path / "taken").mkdir()
    handle = open(stage / "rows.csv", "rb")
    try:
        with pytest.raises(PermissionError):
            workers.rename_directory(stage, tmp_path / "held", seconds=0.2)
        threading.Timer(0.3, handle.close).start()
        workers.rename_directory(stage, tmp_path / "final")
    finally:
        handle.close()
    assert (tmp_path / "final" / "rows.csv").read_bytes() == b"x" and not stage.exists()
    began = time.monotonic()
    with pytest.raises(FileExistsError):
        workers.rename_directory(tmp_path / "final", tmp_path / "taken")
    assert time.monotonic() - began < 1
