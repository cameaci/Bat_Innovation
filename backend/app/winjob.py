"""Windows Job Object supervisor for one disposable worker process tree (standard-library ctypes only).

The worker starts suspended, joins a fresh job whose limits are read back and verified, and only then
resumes. Any setup failure terminates and reaps the suspended child before its payload can run.
There is no breakaway fallback. The job also kills the whole tree when its last handle closes, including
when the owning process dies. Jobs limit committed memory, cumulative user CPU and active processes only:
they do not bound disk use, and the CPU and memory limits are enforced with measurable overshoot, so the
wall-clock deadline here is independent and mandatory. conhost.exe helpers join the job but are not
counted against the active-process limit.

Abrupt owner death before assignment can leave a suspended, unassigned child. This helper alone is
not an atomic process-ownership boundary; Windows media must remain disabled pending native acceptance.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes as W
from dataclasses import dataclass
import os
import math
import subprocess
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

if sys.platform != "win32":
    raise ImportError("winjob requires Windows")

_K = ctypes.WinDLL("kernel32", use_last_error=True)
_H, _SIZE_T, _LL = ctypes.c_void_p, ctypes.c_size_t, ctypes.c_longlong

# Explicit 64-bit-safe handle types; ctypes would otherwise truncate handles to int.
_K.CreateJobObjectW.restype = _H
_K.SetInformationJobObject.argtypes = [_H, ctypes.c_int, ctypes.c_void_p, W.DWORD]
_K.QueryInformationJobObject.argtypes = [_H, ctypes.c_int, ctypes.c_void_p, W.DWORD, ctypes.c_void_p]
_K.AssignProcessToJobObject.argtypes = [_H, _H]
_K.IsProcessInJob.argtypes = [_H, _H, ctypes.c_void_p]
_K.TerminateJobObject.argtypes = [_H, W.UINT]
_K.TerminateProcess.argtypes = [_H, W.UINT]
_K.WaitForSingleObject.argtypes = [_H, W.DWORD]
_K.GetExitCodeProcess.argtypes = [_H, ctypes.c_void_p]
_K.ResumeThread.argtypes = [_H]
_K.ResumeThread.restype = W.DWORD
_K.CloseHandle.argtypes = [_H]

CREATE_SUSPENDED, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT = 0x4, 0x08000000, 0x400
LIMIT_JOB_TIME, LIMIT_ACTIVE_PROCESS, LIMIT_JOB_MEMORY, LIMIT_KILL_ON_JOB_CLOSE = 0x4, 0x8, 0x200, 0x2000
JOB_CPU_QUOTA_EXIT = 0xC0000044
REAP_SECONDS = 5.0


class _Basic(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", _LL), ("PerJobUserTimeLimit", _LL), ("LimitFlags", W.DWORD),
                ("MinimumWorkingSetSize", _SIZE_T), ("MaximumWorkingSetSize", _SIZE_T),
                ("ActiveProcessLimit", W.DWORD), ("Affinity", _SIZE_T), ("PriorityClass", W.DWORD),
                ("SchedulingClass", W.DWORD)]


class _Extended(ctypes.Structure):
    _fields_ = [("Basic", _Basic), ("Io", ctypes.c_ulonglong * 6), ("ProcessMemoryLimit", _SIZE_T),
                ("JobMemoryLimit", _SIZE_T), ("PeakProcessMemoryUsed", _SIZE_T), ("PeakJobMemoryUsed", _SIZE_T)]


class _Accounting(ctypes.Structure):
    _fields_ = [("TotalUserTime", _LL), ("TotalKernelTime", _LL), ("ThisPeriodUser", _LL),
                ("ThisPeriodKernel", _LL), ("TotalPageFaultCount", W.DWORD), ("TotalProcesses", W.DWORD),
                ("ActiveProcesses", W.DWORD), ("TotalTerminatedProcesses", W.DWORD)]


class _StartupInfo(ctypes.Structure):
    _fields_ = [("cb", W.DWORD), ("lpReserved", W.LPWSTR), ("lpDesktop", W.LPWSTR), ("lpTitle", W.LPWSTR)] + \
               [(name, W.DWORD) for name in ("x", "y", "xSize", "ySize", "xChars", "yChars", "fill", "flags")] + \
               [("show", W.WORD), ("reserved2", W.WORD), ("reserved2p", ctypes.c_void_p),
                ("hStdInput", _H), ("hStdOutput", _H), ("hStdError", _H)]


class _ProcessInfo(ctypes.Structure):
    _fields_ = [("hProcess", _H), ("hThread", _H), ("dwProcessId", W.DWORD), ("dwThreadId", W.DWORD)]


_K.CreateJobObjectW.restype, _K.CreateJobObjectW.argtypes = _H, [ctypes.c_void_p, W.LPCWSTR]
_K.SetInformationJobObject.argtypes = [_H, ctypes.c_int, ctypes.c_void_p, W.DWORD]
_K.QueryInformationJobObject.argtypes = [_H, ctypes.c_int, ctypes.c_void_p, W.DWORD, ctypes.c_void_p]
_K.AssignProcessToJobObject.argtypes = [_H, _H]
_K.IsProcessInJob.argtypes = [_H, _H, ctypes.POINTER(W.BOOL)]
_K.CreateProcessW.argtypes = [W.LPCWSTR, W.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, W.BOOL, W.DWORD,
                              ctypes.c_void_p, W.LPCWSTR, ctypes.POINTER(_StartupInfo), ctypes.POINTER(_ProcessInfo)]
_K.ResumeThread.restype, _K.ResumeThread.argtypes = W.DWORD, [_H]
_K.TerminateProcess.argtypes = [_H, W.UINT]
_K.TerminateJobObject.argtypes = [_H, W.UINT]
_K.WaitForSingleObject.restype, _K.WaitForSingleObject.argtypes = W.DWORD, [_H, W.DWORD]
_K.GetExitCodeProcess.argtypes = [_H, ctypes.POINTER(W.DWORD)]
_K.CloseHandle.argtypes = [_H]


class ContainmentError(Exception):
    """A fixed, path-free failure code. Native error numbers and paths are never exposed."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Limits:
    memory_bytes: int
    cpu_seconds: int
    active_processes: int
    wall_seconds: float

    def __post_init__(self) -> None:
        maxima = ((1 << (8 * ctypes.sizeof(_SIZE_T))) - 1, (2 ** 63 - 1) // 10_000_000, 2 ** 32 - 1)
        if (any(type(value) is not int or not 1 <= value <= maximum for value, maximum in
                zip((self.memory_bytes, self.cpu_seconds, self.active_processes), maxima))
                or type(self.wall_seconds) not in (int, float)
                or not 0 < self.wall_seconds <= sys.float_info.max):
            raise ValueError("Containment limits must be finite, positive and fit native fields")


@dataclass(frozen=True)
class Outcome:
    state: str  # "exited", "cancelled" or "deadline"
    exit_code: int
    peak_memory_bytes: int
    cpu_seconds: float
    wall_seconds: float


def worker_environment() -> dict[str, str]:
    """Only what Python needs to start; no launch token or other application secret."""
    keep = ("SystemRoot", "PATH", "TEMP", "TMP")
    return {**{name: os.environ[name] for name in keep if name in os.environ}, "PYTHONUTF8": "1"}


def _create_suspended(argv: Sequence[str], cwd: Path, environment: Mapping[str, str]) -> tuple[int, int]:
    command = ctypes.create_unicode_buffer(subprocess.list2cmdline(list(argv)))
    block = ctypes.create_unicode_buffer("".join(f"{k}={environment[k]}\0" for k in sorted(environment, key=str.upper)) + "\0")
    startup, info = _StartupInfo(), _ProcessInfo()
    startup.cb = ctypes.sizeof(_StartupInfo)
    # No handle inheritance and no CREATE_BREAKAWAY_FROM_JOB.
    if not _K.CreateProcessW(argv[0], command, None, None, False,
                             CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                             block, str(cwd), ctypes.byref(startup), ctypes.byref(info)):
        raise ContainmentError("start_failed")
    return info.hProcess, info.hThread


def _expected(limits: Limits) -> _Extended:
    expected = _Extended()
    expected.Basic.LimitFlags = LIMIT_KILL_ON_JOB_CLOSE | LIMIT_JOB_MEMORY | LIMIT_JOB_TIME | LIMIT_ACTIVE_PROCESS
    expected.Basic.PerJobUserTimeLimit = limits.cpu_seconds * 10_000_000
    expected.Basic.ActiveProcessLimit = limits.active_processes
    expected.JobMemoryLimit = limits.memory_bytes
    return expected


def _configure(job: int, limits: Limits) -> None:
    expected = _expected(limits)
    if not _K.SetInformationJobObject(job, 9, ctypes.byref(expected), ctypes.sizeof(expected)):
        raise ContainmentError("limits_failed")
    actual = _Extended()
    if not _K.QueryInformationJobObject(job, 9, ctypes.byref(actual), ctypes.sizeof(actual), None) or (
        (actual.Basic.LimitFlags, actual.Basic.PerJobUserTimeLimit, actual.Basic.ActiveProcessLimit,
         actual.JobMemoryLimit) != (expected.Basic.LimitFlags, expected.Basic.PerJobUserTimeLimit,
                                    expected.Basic.ActiveProcessLimit, expected.JobMemoryLimit)):
        raise ContainmentError("limits_unverified")


def _assign(job: int, process: int) -> None:
    member = W.BOOL()
    if not _K.AssignProcessToJobObject(job, process):
        raise ContainmentError("assignment_failed")
    if not _K.IsProcessInJob(process, job, ctypes.byref(member)) or not member.value:
        raise ContainmentError("assignment_unverified")


def _accounting(job: int) -> _Accounting:
    result = _Accounting()
    if not _K.QueryInformationJobObject(job, 1, ctypes.byref(result), ctypes.sizeof(result), None):
        raise ContainmentError("accounting_failed")
    return result


def _peak_memory(job: int) -> int:
    result = _Extended()
    if not _K.QueryInformationJobObject(job, 9, ctypes.byref(result), ctypes.sizeof(result), None):
        raise ContainmentError("accounting_failed")
    return result.PeakJobMemoryUsed


def _reap(job: int, process: int) -> None:
    """Terminate everything in the job, then require the worker and all members to be gone."""
    terminated = _K.TerminateJobObject(job, 1)
    if _K.WaitForSingleObject(process, int(REAP_SECONDS * 1000)) != 0:
        raise ContainmentError("reap_failed")
    end = time.monotonic() + REAP_SECONDS
    while _accounting(job).ActiveProcesses:
        if time.monotonic() >= end:
            raise ContainmentError("reap_failed")
        time.sleep(0.01)
    if not terminated:
        raise ContainmentError("termination_failed")


def run(argv: Sequence[str], cwd: Path, limits: Limits, cancelled: Callable[[], bool] = lambda: False,
        environment: Mapping[str, str] | None = None, poll_seconds: float = 0.05) -> Outcome:
    """Run one worker tree to completion, cancellation or the wall-clock deadline, then reap all of it."""
    if not math.isfinite(poll_seconds) or poll_seconds <= 0:
        raise ValueError("Polling interval must be finite and positive")
    started = time.monotonic()
    process = thread = job = None
    try:
        process, thread = _create_suspended(argv, cwd, worker_environment() if environment is None else environment)
        job = _K.CreateJobObjectW(None, None)
        if not job:
            raise ContainmentError("job_failed")
        _configure(job, limits)
        _assign(job, process)
        if _K.ResumeThread(thread) == 0xFFFFFFFF:
            raise ContainmentError("resume_failed")
    except BaseException:
        # Still suspended, so the payload has not run. Terminate and reap before reporting.
        try:
            if process is not None:
                _K.TerminateProcess(process, 0xDEAD)
                if _K.WaitForSingleObject(process, int(REAP_SECONDS * 1000)) != 0:
                    raise ContainmentError("reap_failed")
        finally:
            _close(thread, process, job)
        raise
    try:
        state, deadline = "exited", started + limits.wall_seconds
        while True:
            waited = _K.WaitForSingleObject(process, int(min(poll_seconds, 1, max(0, deadline - time.monotonic())) * 1000))
            if waited == 0:
                break
            if waited != 258:  # WAIT_TIMEOUT; WAIT_FAILED must never become an exit or timeout success.
                raise ContainmentError("wait_failed")
            if cancelled():
                state = "cancelled"
                break
            if time.monotonic() >= deadline:
                state = "deadline"
                break
        code = W.DWORD()
        if state == "exited":
            if not _K.GetExitCodeProcess(process, ctypes.byref(code)):
                raise ContainmentError("exit_code_failed")
        accounting, peak = _accounting(job), _peak_memory(job)
        return Outcome(state, code.value if state == "exited" else 1, peak,
                       accounting.TotalUserTime / 1e7, time.monotonic() - started)
    finally:
        try:
            _reap(job, process)
        finally:
            _close(thread, process, job)


def _close(*handles: int | None) -> None:
    for handle in handles:
        if handle:
            _K.CloseHandle(handle)
