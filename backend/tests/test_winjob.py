"""Native Windows tests for the Job Object supervisor, using text-only synthetic Python workers (no media).

Skipped off Windows. Processes are identified by pid plus creation time, never by name or port.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes as W
import json
from pathlib import Path
import subprocess
import sys
import threading
import time

import pytest

from backend.app import contained_import, imports

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows Job Objects")
if sys.platform == "win32":
    from backend.app import winjob

WORKER = Path(__file__).with_name("winjob_worker.py")
ROOT = Path(__file__).resolve().parents[2]
FAST = dict(memory_bytes=512 * 1024 ** 2, cpu_seconds=60, active_processes=4, wall_seconds=30)


def limits(**changes) -> "winjob.Limits":
    return winjob.Limits(**{**FAST, **changes})


def start(mode: str, scratch: Path, *extra: str, **kw):
    return winjob.run([sys.executable, str(WORKER), mode, str(scratch), *extra], ROOT, kw.pop("limits", limits()),
                      **kw)


def identity(pid: int):
    """Creation time of a live process, or None when it is gone."""
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.OpenProcess.restype = ctypes.c_void_p
    k.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
    k.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    k.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = k.OpenProcess(0x1000, False, pid)
    if not handle:
        return None
    try:
        code = W.DWORD()
        times = (ctypes.c_ulonglong * 4)()
        k.GetProcessTimes.argtypes = [ctypes.c_void_p] + [ctypes.c_void_p] * 4
        k.GetProcessTimes(handle, *[ctypes.byref(times, 8 * i) for i in range(4)])
        k.GetExitCodeProcess(handle, ctypes.byref(code))
        return times[0] if code.value == 259 else None
    finally:
        k.CloseHandle(handle)


def read_pids(scratch: Path) -> list[int]:
    return json.loads((scratch / "pids.json").read_text())


def wait_for(path: Path, seconds: float = 10) -> None:
    end = time.monotonic() + seconds
    while not path.exists():
        assert time.monotonic() < end, "worker did not report"
        time.sleep(0.02)


def test_normal_exit_and_nonzero_exit(tmp_path):
    ok = start("exit", tmp_path, "0")
    assert (ok.state, ok.exit_code) == ("exited", 0) and ok.peak_memory_bytes > 0
    bad = start("exit", tmp_path, "7")
    assert (bad.state, bad.exit_code) == ("exited", 7)
    assert identity(int((tmp_path / "started.marker").read_text())) is None


def test_start_failure_is_path_free(tmp_path):
    secret = tmp_path / "private-survey-site" / "missing.exe"
    with pytest.raises(winjob.ContainmentError) as caught:
        winjob.run([str(secret)], ROOT, limits())
    assert caught.value.code == "start_failed" and "private-survey-site" not in str(caught.value)


@pytest.mark.parametrize("stage,code", [("_assign", "assignment_failed"), ("_configure", "limits_failed"),
                                         ("_assign", "assignment_unverified"), ("_configure", "limits_unverified")])
def test_setup_failure_reaps_suspended_child_without_running_payload(tmp_path, monkeypatch, stage, code):
    seen: list[int] = []
    real = winjob._create_suspended

    def spy(*a):
        winjob._K.GetProcessId.argtypes = [ctypes.c_void_p]
        process, thread = real(*a)
        seen.append(winjob._K.GetProcessId(process))
        return process, thread

    def fail(*_):
        raise winjob.ContainmentError(code)

    monkeypatch.setattr(winjob, "_create_suspended", spy)
    monkeypatch.setattr(winjob, stage, fail)
    with pytest.raises(winjob.ContainmentError) as caught:
        start("sleep", tmp_path)
    assert caught.value.code == code
    assert not (tmp_path / "started.marker").exists()  # suspended payload never ran
    assert seen and identity(seen[0]) is None  # terminated and reaped
    assert not any(identity(p) for p in seen)


def test_resume_failure_never_runs_payload(tmp_path, monkeypatch):
    monkeypatch.setattr(winjob._K, "ResumeThread", lambda _h: 0xFFFFFFFF)
    with pytest.raises(winjob.ContainmentError) as caught:
        start("sleep", tmp_path)
    assert caught.value.code == "resume_failed" and not (tmp_path / "started.marker").exists()


def test_job_limit_readback_mismatch_is_detected(tmp_path, monkeypatch):
    monkeypatch.setattr(winjob._K, "SetInformationJobObject", lambda *_: 1)  # limits silently not applied
    with pytest.raises(winjob.ContainmentError) as caught:
        start("sleep", tmp_path)
    assert caught.value.code == "limits_unverified" and not (tmp_path / "started.marker").exists()


def test_memory_limit_overshoot_recorded(tmp_path):
    limit = 128 * 1024 ** 2
    outcome = start("mem", tmp_path, limits=limits(memory_bytes=limit))
    result = json.loads((tmp_path / "result.json").read_text())
    assert result["outcome"] == "MemoryError" and result["allocated_mb"] < 1024
    assert outcome.peak_memory_bytes < 2 * limit  # observed overshoot is bounded but not exact
    print(f"memory limit {limit >> 20} MiB, job peak {outcome.peak_memory_bytes >> 20} MiB")


def test_cpu_limit_with_wall_deadline_backstop(tmp_path):
    outcome = start("cpu", tmp_path, limits=limits(cpu_seconds=1, wall_seconds=15))
    assert outcome.state in {"exited", "deadline"} and outcome.wall_seconds < 20
    print(f"cpu limit 1 s, state {outcome.state}, cpu {outcome.cpu_seconds:.1f} s, wall {outcome.wall_seconds:.1f} s")
    if outcome.state == "exited":
        assert outcome.exit_code == winjob.JOB_CPU_QUOTA_EXIT


def test_active_process_limit_and_breakaway_refused(tmp_path):
    outcome = start("spawn", tmp_path, limits=limits(active_processes=3, wall_seconds=3))
    assert outcome.state == "deadline"
    report = json.loads((tmp_path / "result.json").read_text())
    assert report["breakaway"].startswith("refused")
    started = [v for k, v in report.items() if k.startswith("child") and v.startswith("started")]
    assert len(started) <= 2 and any(v.startswith("refused") for k, v in report.items() if k.startswith("child"))
    for value in started:
        assert identity(int(value.split(":")[1])) is None


def test_wall_deadline_kills_worker(tmp_path):
    outcome = start("sleep", tmp_path, limits=limits(wall_seconds=1))
    assert outcome.state == "deadline" and 1 <= outcome.wall_seconds < 10
    assert identity(int((tmp_path / "started.marker").read_text())) is None


def test_cancellation_kills_descendants(tmp_path):
    flag = threading.Event()
    threading.Thread(target=lambda: (wait_for(tmp_path / "pids.json"), flag.set()), daemon=True).start()
    outcome = start("tree", tmp_path, cancelled=flag.is_set)
    assert outcome.state == "cancelled"
    for pid in [int((tmp_path / "started.marker").read_text()), *read_pids(tmp_path)]:
        assert identity(pid) is None


def test_job_reaps_children_left_by_exited_worker(tmp_path):
    outcome = start("orphan", tmp_path)
    assert outcome.state == "exited"
    assert all(identity(pid) is None for pid in read_pids(tmp_path))


def test_owner_death_kills_tree_via_kill_on_job_close(tmp_path):
    owner = subprocess.Popen([sys.executable, "-c", (
        "import sys; from pathlib import Path; from backend.app import winjob\n"
        f"winjob.run([sys.executable, r'{WORKER}', 'tree', r'{tmp_path}'], Path(r'{ROOT}'), "
        "winjob.Limits(512*1024**2, 60, 4, 30))")], cwd=ROOT)
    try:
        wait_for(tmp_path / "pids.json")
        pids = [int((tmp_path / "started.marker").read_text()), *read_pids(tmp_path)]
        assert all(identity(pid) for pid in pids)
        owner.kill()
        owner.wait(10)
        end = time.monotonic() + 10
        while any(identity(pid) for pid in pids) and time.monotonic() < end:
            time.sleep(0.05)
        assert not any(identity(pid) for pid in pids)
    finally:
        owner.kill()


def test_worker_environment_has_no_application_secrets(monkeypatch):
    monkeypatch.setenv("BAT_API_TOKEN", "secret-token")
    assert "BAT_API_TOKEN" not in winjob.worker_environment()


def good_result(path: Path) -> dict:
    first, last = {"num": "0", "den": "1"}, {"num": "1", "den": "1000"}
    end, rate = {"num": "1", "den": "500"}, {"num": "30", "den": "1"}
    return {
        "filename": path.name, "size_bytes": 5, "sha256": "a" * 64, "container": "mpegts",
        "streams": [{"index": 0, "type": "video", "codec": "h264", "time_base": {"num": "1", "den": "90000"}}],
        "video_stream_index": 0, "codec": "h264", "width": 4, "height": 4, "time_base": {"num": "1", "den": "90000"},
        "first_pts": "0", "last_pts": "90", "first_time": first, "last_time": last, "elapsed_last_time": last,
        "end_time": end, "elapsed_end": end, "frame_count": 3, "reported_duration": None, "average_rate": rate,
        "base_rate": rate, "rotation": 0, "field_order": None, "interlaced": False, "warnings": [],
        "_identity": {"device": 1, "inode": 2, "size_bytes": 5, "mtime_ns": 3, "ctime_ns": 4},
    }


def test_validation_accepts_good_and_rejects_malformed():
    path = Path("a.MTS")
    assert contained_import.validate_inspection(path, good_result(path))["frame_count"] == 3
    for mutate in (lambda r: r.pop("sha256"), lambda r: r.update(extra=1), lambda r: r.update(filename="b.MTS"),
                   lambda r: r.update(size_bytes=6), lambda r: r.update(first_pts="x"),
                   lambda r: r.update(time_base={"num": "1", "den": "0"}), lambda r: r.update(frame_count=0)):
        bad = good_result(path)
        mutate(bad)
        with pytest.raises(contained_import.Rejected):
            contained_import.validate_inspection(path, bad)


def contained(tmp_path, body: str, source: Path = Path("a.MTS")):
    """Run the host against a synthetic worker script; the source path never exists."""
    script = tmp_path / "fake.py"
    script.write_text(body, encoding="utf-8")
    return contained_import.inspect_source(source, lambda *_: None, lambda: False,
                                           lambda scratch: [sys.executable, str(script), str(scratch)])


def test_host_accepts_valid_worker_response(tmp_path):
    path = tmp_path / "a.MTS"
    payload = json.dumps({"ok": good_result(path)})
    out = contained(tmp_path, "import sys,os\nopen(os.path.join(sys.argv[1],'response.json'),'w').write(%r)" % payload,
                    path)
    assert out["filename"] == "a.MTS"


@pytest.mark.parametrize("body", [
    "pass",  # no response
    "import sys,os\nopen(os.path.join(sys.argv[1],'response.json'),'w').write('{not json')",
    "import sys,os\nopen(os.path.join(sys.argv[1],'response.json'),'w').write('x'*(2*1024*1024))",
    "import sys,os\nopen(os.path.join(sys.argv[1],'response.json'),'w').write('{\"ok\": NaN}')",
    "import sys,os\nopen(os.path.join(sys.argv[1],'response.json'),'w').write('{\"ok\": {}}')",
    "import sys,os\nopen(os.path.join(sys.argv[1],'response.json'),'w').write('{\"ok\": {}}')\nsys.exit(5)",
])
def test_host_rejects_bad_responses_without_leaking_paths(tmp_path, body):
    from backend.app import media
    secret = tmp_path / "private-site" / "a.MTS"
    with pytest.raises(media.MediaError) as caught:
        contained(tmp_path, body, secret)
    assert caught.value.code == "import_failed" and "private-site" not in caught.value.message


def test_host_reports_worker_media_error_and_cancellation(tmp_path):
    from backend.app import media
    err = "import sys,os,json\nopen(os.path.join(sys.argv[1],'response.json'),'w').write(json.dumps({'error':{'code':'unsupported_codec','message':'No.'}}))\nsys.exit(2)"
    with pytest.raises(media.MediaError) as caught:
        contained(tmp_path, err)
    assert caught.value.code == "unsupported_codec"
    with pytest.raises(media.MediaError) as cancelled:
        contained_import.inspect_source(Path("a.MTS"), lambda *_: None, lambda: True)
    assert cancelled.value.code == "cancelled"


def test_windows_import_ipc_cannot_reach_supervisor(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from backend.app.main import Settings, create_app

    def forbidden(*_a, **_k):
        raise AssertionError("contained import reached")

    token = "synthetic-private-per-launch-token-long-enough"
    headers = {"X-Bat-Token": token}
    monkeypatch.setattr(contained_import, "inspect_source", forbidden)
    monkeypatch.setattr(winjob, "run", forbidden)
    monkeypatch.setattr(imports, "inspect", forbidden)
    with TestClient(create_app(Settings(tmp_path / "data", token))) as client:
        sid = client.post("/api/sessions", headers=headers,
                          json={"display_name": "Synthetic", "camera_ref": "Test"}).json()["id"]
        assert client.post("/api/media/upgrade", headers=headers).status_code == 200
        for name in ("x.mp4", "y.MTS"):
            response = client.post("/api/media/import", headers=headers, json={
                "session_id": sid, "paths": [str(tmp_path / "private-site" / name)]})
            assert response.status_code == 409 and response.json()["detail"]["code"] == "import_limits_unavailable"
            assert "private-site" not in response.text


@pytest.mark.parametrize('changes', [
    {'wall_seconds': float('nan')}, {'wall_seconds': float('inf')}, {'wall_seconds': 0},
    {'memory_bytes': 2 ** 64}, {'cpu_seconds': 2 ** 63}, {'active_processes': 2 ** 32},
    {'active_processes': True}, {'memory_bytes': 1.5},
])
def test_invalid_limits_rejected_before_native_field_conversion(changes):
    with pytest.raises(ValueError):
        limits(**changes)


@pytest.mark.parametrize('poll', [float('nan'), float('inf'), 0, -1])
def test_invalid_poll_interval_does_not_start_child(tmp_path, poll):
    with pytest.raises(ValueError):
        start('sleep', tmp_path, poll_seconds=poll)
    assert not (tmp_path / 'started.marker').exists()


@pytest.mark.parametrize('api,code', [('WaitForSingleObject', 'wait_failed'), ('GetExitCodeProcess', 'exit_code_failed')])
def test_native_status_failure_is_not_success_and_still_reaps(tmp_path, monkeypatch, api, code):
    real_wait = winjob._K.WaitForSingleObject
    if api == 'WaitForSingleObject':
        # Fail only the first running wait; retain the real wait during cleanup.
        calls = []
        def wait(handle, milliseconds):
            calls.append(1)
            return 0xFFFFFFFF if len(calls) == 1 else real_wait(handle, milliseconds)
        monkeypatch.setattr(winjob._K, api, wait)
    else:
        monkeypatch.setattr(winjob._K, api, lambda *_: 0)
    with pytest.raises(winjob.ContainmentError) as caught:
        start('exit', tmp_path, '0')
    assert caught.value.code == code
    marker = tmp_path / 'started.marker'
    if marker.exists():
        assert identity(int(marker.read_text())) is None


def test_poll_interval_cannot_overrun_wall_deadline(tmp_path):
    outcome = start('sleep', tmp_path, limits=limits(wall_seconds=1), poll_seconds=60)
    assert outcome.state == 'deadline' and outcome.wall_seconds < 10
    assert identity(int((tmp_path / 'started.marker').read_text())) is None


def test_failed_job_termination_is_reported_even_when_worker_has_exited(tmp_path, monkeypatch):
    real = winjob._K.TerminateJobObject
    def terminate(job, code):
        assert real(job, code)  # actually clean up; inject only the reported API failure
        return 0
    monkeypatch.setattr(winjob._K, 'TerminateJobObject', terminate)
    with pytest.raises(winjob.ContainmentError) as caught:
        start('exit', tmp_path, '0')
    assert caught.value.code == 'termination_failed'
    assert identity(int((tmp_path / 'started.marker').read_text())) is None
