"""Windows stand-in for a stopped real worker: the text-only sleeping worker, started inside the real Job Object.

Linux tests freeze the real worker with SIGSTOP and inspect /proc. The Windows supervisor exposes no process object,
so these helpers substitute the synthetic worker and identify it by pid plus creation time, never by name.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes as W
from pathlib import Path
import sys
import time

import pytest

from backend.app import workers

WORKER = Path(__file__).with_name("winjob_worker.py")


def _kernel32():
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
    kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    kernel.GetProcessTimes.argtypes = [ctypes.c_void_p] + [ctypes.c_void_p] * 4
    kernel.TerminateProcess.argtypes = [ctypes.c_void_p, ctypes.c_uint]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    return kernel


def identity(pid: int) -> int | None:
    """Creation time of a live process, or None when it is gone."""
    kernel = _kernel32()
    handle = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return None
    try:
        code = W.DWORD()
        times = (ctypes.c_ulonglong * 4)()
        kernel.GetProcessTimes(handle, *[ctypes.byref(times, 8 * i) for i in range(4)])
        kernel.GetExitCodeProcess(handle, ctypes.byref(code))
        return times[0] if code.value == 259 else None  # STILL_ACTIVE
    finally:
        kernel.CloseHandle(handle)


def hold(monkeypatch: pytest.MonkeyPatch, directory: Path) -> None:
    """Every contained worker started from now on sleeps for a minute after writing its pid into directory."""
    directory.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(workers, "command", lambda _module: [sys.executable, str(WORKER), "sleep", str(directory)])


def held(directory: Path, seconds: float = 10) -> tuple[int, int]:
    """Wait for the held worker to run; return its pid and creation time."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            pid = int((directory / "started.marker").read_text())
        except (OSError, ValueError):
            pid = 0
        created = identity(pid) if pid else None
        if created is not None:
            return pid, created
        time.sleep(0.005)
    pytest.fail("The held Windows worker did not start")


def ended(pid: int, created: int, seconds: float = 0) -> bool:
    """True once this exact process no longer runs, waiting at most seconds."""
    deadline = time.monotonic() + seconds
    while identity(pid) == created:
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.005)
    return True


def terminate(pid: int, code: int) -> None:
    """End a process with the exit code a Job Object limit reports, as the operating system would."""
    kernel = _kernel32()
    handle = kernel.OpenProcess(0x0001, False, pid)  # PROCESS_TERMINATE
    assert handle, ctypes.get_last_error()
    try:
        assert kernel.TerminateProcess(handle, code), ctypes.get_last_error()
    finally:
        kernel.CloseHandle(handle)
