"""End-to-end smoke test of a backend executable with synthetic media: import, preview, summaries, QA upgrade, export.

Usage: python scripts/smoke_backend.py <backend command> [args...]
For a frozen build pass the executable (for example backend/dist/bat-backend/bat-backend.exe). Everything is generated
under a temporary directory and removed afterwards; no real media is read. Exit code 0 only if every step passed.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


def make_video(path: Path) -> None:
    """Two seconds of 25 fps MPEG-4 with a small moving square, encoded by the PyAV that the backend itself uses."""
    import av
    import numpy

    with av.open(str(path), "w") as container:
        stream = container.add_stream("mpeg4", rate=25)
        stream.width, stream.height, stream.pix_fmt = 96, 64, "yuv420p"
        for index in range(50):
            image = numpy.zeros((64, 96, 3), dtype=numpy.uint8)
            x = 4 + index
            image[28:36, x:x + 8] = 255
            for packet in stream.encode(av.VideoFrame.from_ndarray(image, format="rgb24")):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


class Api:
    def __init__(self, port: int, token: str) -> None:
        self.base, self.token = f"http://127.0.0.1:{port}", token

    def call(self, method: str, route: str, body: dict | None = None, raw: bool = False):
        request = urllib.request.Request(self.base + route, method=method, headers={"X-Bat-Token": self.token, "Content-Type": "application/json"},
                                         data=None if body is None else json.dumps(body).encode())
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read()
        except urllib.error.HTTPError as error:
            raise SystemExit(f"FAIL {method} {route}: HTTP {error.code} {error.read()[:300]!r}") from None
        return data if raw else json.loads(data)

    def wait(self, route: str, done: set[str], seconds: float = 120) -> dict:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            state = self.call("GET", route)
            if state["state"] in done:
                return state
            time.sleep(0.25)
        raise SystemExit(f"FAIL {route}: still {state['state']} after {seconds}s")


def step(message: str) -> None:
    print(f"ok  {message}", flush=True)


def main(command: list[str]) -> None:
    work = Path(tempfile.mkdtemp(prefix="bat-smoke-")).resolve()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    token = secrets.token_hex(32)
    log = (work / "backend.log").open("wb")
    process = subprocess.Popen(command, env={**os.environ, "BAT_APP_DATA_DIR": str(work / "data"), "BAT_API_TOKEN": token,
                                               "BAT_API_PORT": str(port)}, stderr=log, stdout=subprocess.DEVNULL)
    try:
        api = Api(port, token)
        for _ in range(240):
            try:
                api.call("GET", "/api/health")
                break
            except (SystemExit, urllib.error.URLError, ConnectionError, OSError):
                if process.poll() is not None:
                    raise SystemExit(f"FAIL backend exited early with {process.returncode}: {(work / 'backend.log').read_bytes()[-500:]!r}")
                time.sleep(0.25)
        else:
            raise SystemExit("FAIL backend did not become healthy")
        step("authenticated health")

        video = work / "originals" / "synthetic.mp4"
        video.parent.mkdir()
        make_video(video)
        before = video.read_bytes()
        session = api.call("POST", "/api/sessions", {"display_name": "Smoke", "camera_ref": "Synthetic"})["id"]
        for route in ("/api/media/upgrade", "/api/summaries/upgrade", "/api/reviews/upgrade", "/api/qa/upgrade"):
            api.call("POST", route, {})
        step("schema upgrades")

        job = api.call("POST", "/api/media/import", {"session_id": session, "paths": [str(video)]})
        done = api.wait(f"/api/media/import/{job['id']}", {"complete", "failed", "cancelled"})
        if done["state"] != "complete":
            raise SystemExit(f"FAIL import: {done}")
        segment = api.call("GET", f"/api/sessions/{session}/media")["segments"][0]
        first_pts = segment["metadata"]["first_pts"]
        step("import")

        preview = api.call("POST", "/api/media/preview", {"segment_id": segment["id"], "source_pts": str(first_pts)})
        ready = api.wait(f"/api/media/preview/{preview['id']}", {"ready", "failed", "cancelled"})
        if ready["state"] != "ready":
            raise SystemExit(f"FAIL preview: {ready}")
        clip = api.call("GET", f"/api/media/preview/{preview['id']}/content", raw=True)
        if not clip.startswith(b"\x1a\x45\xdf\xa3"):
            raise SystemExit("FAIL preview is not WebM")
        step(f"preview ({len(clip)} bytes WebM)")

        run = api.call("POST", "/api/summaries", {"session_id": session, "window_seconds": 1})
        finished = api.wait(f"/api/summaries/{run['id']}", {"complete", "failed", "cancelled", "interrupted"}, 300)
        windows = finished.get("windows") or []
        if finished["state"] != "complete" or len(windows) != 2 or any(w["status"] != "complete" for w in windows):
            raise SystemExit(f"FAIL summaries: {json.dumps(finished)[:600]}")
        image = api.call("GET", f"/api/summary-windows/{windows[0]['id']}/image", raw=True)
        if not image.startswith(b"\x89PNG"):
            raise SystemExit("FAIL summary image is not PNG")
        step(f"summaries ({len(windows)} of {len(windows)} windows complete)")

        export = api.call("POST", "/api/exports", {"run_id": run["id"]})
        ready = api.wait(f"/api/exports/{export['id']}", {"ready", "failed", "cancelled"})
        if ready["state"] != "ready":
            raise SystemExit(f"FAIL export: {ready}")
        manifest = json.loads(api.call("GET", f"/api/exports/{export['id']}/files/manifest", raw=True))
        audit = api.call("GET", f"/api/exports/{export['id']}/files/audit", raw=True).decode("utf-8")
        if manifest["run_id"] != run["id"] or len(audit.strip().splitlines()) != 3:  # header + one row per planned window
            raise SystemExit("FAIL export content does not cover every planned window")
        step("provisional export (audit has every planned window)")

        if video.read_bytes() != before:
            raise SystemExit("FAIL original video changed")
        step("original video unchanged")
    finally:
        process.terminate()
        try:
            process.wait(10)
        except subprocess.TimeoutExpired:
            process.kill()
        log.close()
        shutil.rmtree(work, ignore_errors=True)
    print("SMOKE PASSED")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    main(sys.argv[1:])
