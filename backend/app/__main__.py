"""Launch the local API with a token and data directory provided by the desktop shell."""

from __future__ import annotations

import os
import sqlite3
import sys
import threading
import time

import uvicorn

from .main import Settings, create_app
from .store import DatabaseSchemaError


def wait_for_exit(pid: int) -> None:
    """Block until the desktop shell process is gone, so a crashed shell never leaves an orphaned API."""
    if sys.platform == "win32":
        import ctypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if handle:  # No handle means the process is already gone.
            kernel.WaitForSingleObject(handle, 0xFFFFFFFF)
            kernel.CloseHandle(ctypes.c_void_p(handle))
        return
    while True:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(1)


def main() -> None:
    settings = Settings.from_environment()
    port = int(os.environ.get("BAT_API_PORT", "8765"))
    if not 1 <= port <= 65535:
        raise ValueError("BAT_API_PORT must be a valid TCP port")
    try:
        application = create_app(settings)
    except DatabaseSchemaError:
        print("BAT_STARTUP_ERROR:database_schema", file=sys.stderr)
        raise SystemExit(1) from None
    except sqlite3.DatabaseError:
        print("BAT_STARTUP_ERROR:database_unreadable", file=sys.stderr)
        raise SystemExit(1) from None
    server = uvicorn.Server(uvicorn.Config(application, host="127.0.0.1", port=port, access_log=False))
    parent = os.environ.get("BAT_PARENT_PID")
    if parent is not None:
        def stop_with_parent() -> None:
            wait_for_exit(int(parent))
            server.should_exit = True
        threading.Thread(target=stop_with_parent, daemon=True).start()
    server.run()


if __name__ == "__main__":
    main()
