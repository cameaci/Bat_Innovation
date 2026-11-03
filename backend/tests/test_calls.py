"""Audio for Phase 3 X9: file clocks (GUANO or file name), a proposed sync anchor, call activity and labels."""

from __future__ import annotations

import sqlite3
import struct
import wave
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient
import pytest

from backend.app import audio_store, store
from backend.app.main import Settings, create_app
from backend.tests.summary_fixtures import encode_frames
from backend.tests.test_import import HEADERS, TOKEN, import_files, order_payload, session
from backend.tests.test_tracking import scenario

RATE = 384_000


def wav(path: Path, seconds: float = 2.0, calls: tuple[float, ...] = (), guano: str | None = None, seed: int = 1) -> Path:
    """Quiet noise with 5 ms calls (a 60 to 40 kHz sweep) at the given times, optionally with a GUANO chunk."""
    rng = np.random.default_rng(seed)
    values = rng.normal(0, 0.002, int(RATE * seconds))
    times = np.arange(int(RATE * 0.005)) / RATE
    sweep = 0.3 * np.sin(2 * np.pi * (60_000 * times - 2_000_000 * times ** 2)) * np.hanning(len(times))
    for at in calls:
        start = int(at * RATE)
        values[start:start + len(sweep)] += sweep
    with wave.open(str(path), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(RATE)
        target.writeframes((np.clip(values, -1, 1) * 32767).astype("<i2").tobytes())
    if guano is not None:
        chunk = guano.encode()
        chunk += b"\x00" * (len(chunk) & 1)
        with path.open("r+b") as handle:
            handle.seek(0, 2)
            handle.write(b"guan" + struct.pack("<I", len(guano.encode())) + chunk)
            size = handle.tell() - 8
            handle.seek(4)
            handle.write(struct.pack("<I", size))
    return path


def survey(client: TestClient, tmp_path: Path) -> tuple[str, dict]:
    video = tmp_path / "video.mp4"
    encode_frames(video, scenario("two_dots"), [index * 40 for index in range(20)])
    session_id = session(client)
    assert import_files(client, session_id, [video])["state"] == "complete"
    return session_id, client.get(f"/api/sessions/{session_id}/media", headers=HEADERS).json()["segments"][0]


def add(client: TestClient, session_id: str, path: Path, mode: str = "full_spectrum") -> dict:
    added = client.post(f"/api/sessions/{session_id}/audio", headers=HEADERS, json={"paths": [str(path)], "source_mode": mode, "channel": 0})
    assert added.status_code == 200, added.text
    return added.json()[0]


def test_file_clocks_come_from_guano_or_the_file_name(tmp_path: Path) -> None:
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id, _segment = survey(client, tmp_path)
        tagged = add(client, session_id, wav(tmp_path / "a.wav", guano="GUANO|Version: 1.0\nMake: Synthetic\nTimestamp: 2026-08-10T21:08:13.5+01:00\n"))
        named = add(client, session_id, wav(tmp_path / "SM4_20260810_210813.wav", seed=2))
        plain = add(client, session_id, wav(tmp_path / "plain.wav", seed=3))
        assert tagged["metadata"]["file_clock"] == {"timestamp": "2026-08-10T21:08:13.5+01:00", "source": "guano"}
        assert named["metadata"]["file_clock"] == {"timestamp": "2026-08-10T21:08:13", "source": "filename"}
        assert plain["metadata"]["file_clock"] is None
        labelled = client.post(f"/api/audio/{named['id']}/label", headers=HEADERS, json={"label": "  detector at   the roost "}).json()
        assert labelled["label"] == "detector at the roost"


def test_a_proposed_anchor_from_file_clocks_waits_for_confirmation(tmp_path: Path) -> None:
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id, segment = survey(client, tmp_path)
        tagged = add(client, session_id, wav(tmp_path / "a.wav", guano="Timestamp: 2026-08-10T21:00:00.4+01:00\n"))
        named = add(client, session_id, wav(tmp_path / "SM4_20260810_200000.wav", seed=2))
        url = lambda audio: f"/api/audio/{audio['id']}/proposed-anchor"
        assert "Declare the recording clock" in client.get(url(tagged), headers=HEADERS).json()["reason"]
        clock = {"segment_id": segment["id"], "utc": "2026-08-10T21:00:00+01:00", "provenance": "Synthetic clock card"}
        assert client.put(f"/api/sessions/{session_id}/media", headers=HEADERS, json=order_payload([segment["id"]], clock)).status_code == 200
        proposal = client.get(url(tagged), headers=HEADERS).json()["proposal"]
        base = int(segment["metadata"]["time_base"]["den"]) / int(segment["metadata"]["time_base"]["num"])
        # The audio started 0.4 s after the first video frame.
        assert proposal["audio_sample"] == 0 and int(proposal["video_pts"]) == int(segment["metadata"]["first_pts"]) + round(0.4 * base)
        assert proposal["basis"] == "guano" and proposal["stated_offset"] is None
        assert client.get(f"/api/sessions/{session_id}/audio", headers=HEADERS).json()[0]["anchor"] is None, "a proposal is not an anchor"
        # A file-name time has no zone: it needs the offset stated by the reviewer.
        unzoned = client.get(url(named), headers=HEADERS).json()
        assert unzoned["proposal"] is None and unzoned["needs_offset"]
        stated = client.get(url(named), headers=HEADERS, params={"utc_offset": "-01:00"}).json()
        assert stated["proposal"] is None and "do not overlap" in stated["reason"], "20:00-01:00 is two hours after the video"
        stated = client.get(url(named), headers=HEADERS, params={"utc_offset": "+00:00"}).json()["proposal"]
        assert stated["audio_sample"] == 0 and stated["stated_offset"] == "+00:00"
        assert client.get(url(named), headers=HEADERS, params={"utc_offset": "1:00"}).status_code == 422
        confirmed = client.post(f"/api/audio/{tagged['id']}/anchor", headers=HEADERS, json={"actor": "Reviewer One", "expected_revision": 0,
                                "segment_id": proposal["segment_id"], "video_pts": proposal["video_pts"], "audio_sample": proposal["audio_sample"],
                                "note": "Confirmed proposal from file clocks (guano)"}).json()
        assert confirmed["anchor"]["video_pts"] == proposal["video_pts"]


def test_call_activity_marks_a_synthetic_call_train(tmp_path: Path) -> None:
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id, _segment = survey(client, tmp_path)
        calls = (0.3, 0.8, 1.45)
        audio = add(client, session_id, wav(tmp_path / "train.wav", seconds=2.0, calls=calls))
        result = client.post(f"/api/audio/{audio['id']}/activity", headers=HEADERS, json={})
        assert result.status_code == 200, result.text
        marks = result.json()["marks"]
        assert len(marks) == len(calls)
        for (start, end, peak), at in zip(marks, calls):
            assert abs(start / RATE - at) < 0.002 and 0.003 < (end - start) / RATE < 0.010 and peak >= 12
        assert result.json()["parameters"]["version"] == "call-activity-v1" and len(result.json()["envelope"]) == 8
        heterodyne = add(client, session_id, wav(tmp_path / "het.wav", seed=5), mode="heterodyne")
        refused = client.post(f"/api/audio/{heterodyne['id']}/activity", headers=HEADERS, json={})
        assert refused.status_code == 409 and refused.json()["detail"]["code"] == "not_retunable"


def test_audio_label_upgrade_from_v19(tmp_path: Path) -> None:
    from backend.app import candidate_store, count_store, flow, label_store, proxy_store, renders, sample_store, template_store, tracking_store
    from backend.tests.test_thermal import legacy_v5

    db_path = legacy_v5(tmp_path)
    for step in (store.upgrade_modality, tracking_store.upgrade, count_store.upgrade, candidate_store.upgrade, audio_store.upgrade,
                 proxy_store.upgrade, tracking_store.upgrade_v2, count_store.upgrade_spans, sample_store.upgrade,
                 template_store.upgrade, proxy_store.upgrade_kind, label_store.upgrade, flow.upgrade, renders.upgrade):
        step(db_path)
    with sqlite3.connect(db_path) as connection:
        connection.execute("ALTER TABLE audio_source ADD COLUMN label TEXT")
    with pytest.raises(sqlite3.OperationalError):
        audio_store.upgrade_label(db_path)
    assert store.schema_version(db_path) == store.RENDER_SCHEMA_VERSION
