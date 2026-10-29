"""Full-spectrum WAV evidence (feature expansion E7): inspection, sync anchor, spectrogram and heterodyne."""

from __future__ import annotations

import io
import sqlite3
import wave
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image
import pytest

from backend.app.main import Settings, create_app
from backend.tests.summary_fixtures import encode_frames
from backend.tests.test_import import HEADERS, TOKEN, import_files, session
from backend.tests.test_tracking import scenario

RATE = 384_000


def tone(path: Path, seconds: float = 2.0, frequency: float = 45_000, channels: int = 1) -> Path:
    times = np.arange(int(RATE * seconds)) / RATE
    signal = 0.3 * np.sin(2 * np.pi * frequency * times)
    data = np.repeat((signal * 32767).astype("<i2")[:, None], channels, axis=1)
    with wave.open(str(path), "wb") as target:
        target.setnchannels(channels)
        target.setsampwidth(2)
        target.setframerate(RATE)
        target.writeframes(data.tobytes())
    return path


def prepared(client: TestClient, tmp_path: Path, mode: str = "full_spectrum") -> tuple[str, dict, dict]:
    video = tmp_path / "video.mp4"
    encode_frames(video, scenario("two_dots"), [index * 40 for index in range(20)])
    session_id = session(client)
    assert import_files(client, session_id, [video])["state"] == "complete"
    segment = client.get(f"/api/sessions/{session_id}/media", headers=HEADERS).json()["segments"][0]
    added = client.post(f"/api/sessions/{session_id}/audio", headers=HEADERS,
                        json={"paths": [str(tone(tmp_path / "bat.wav"))], "source_mode": mode, "channel": 0})
    assert added.status_code == 200, added.text
    return session_id, segment, added.json()[0]


def anchor(client: TestClient, audio: dict, segment: dict, expected: int = 0) -> dict:
    response = client.post(f"/api/audio/{audio['id']}/anchor", headers=HEADERS, json={
        "actor": "Reviewer One", "expected_revision": expected, "segment_id": segment["id"],
        "video_pts": segment["metadata"]["first_pts"], "audio_sample": 0, "note": "Clap at the start"})
    assert response.status_code == 200, response.text
    return response.json()


def derive(client: TestClient, audio: dict, segment: dict, **body) -> dict:
    response = client.post(f"/api/audio/{audio['id']}/derive", headers=HEADERS,
                           json={"segment_id": segment["id"], "start_pts": segment["metadata"]["first_pts"], "seconds": 1, **body})
    return response


def test_spectrogram_and_heterodyne_follow_the_sync_anchor(tmp_path: Path) -> None:
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        _session_id, segment, audio = prepared(client, tmp_path)
        assert audio["metadata"]["sample_rate"] == RATE and audio["metadata"]["frames"] == 2 * RATE and audio["retunable"]
        early = derive(client, audio, segment, kind="spectrogram")
        assert early.status_code == 409 and early.json()["detail"]["code"] == "audio_not_synchronised"
        anchored = anchor(client, audio, segment)
        assert anchored["anchor"]["revision"] == 1
        spectrogram = derive(client, audio, segment, kind="spectrogram").json()
        assert spectrogram["start_sample"] == 0 and spectrogram["end_sample"] == RATE and spectrogram["drift_corrected"] is False
        png = client.get(f"/api/audio/derived/{spectrogram['id']}/content", headers=HEADERS)
        assert png.headers["content-type"] == "image/png"
        image = np.asarray(Image.open(io.BytesIO(png.content)))
        expected_row = round((1 - 45_000 / (RATE / 2)) * image.shape[0])
        assert abs(int(image.mean(axis=1).argmax()) - expected_row) <= 3
        listened = derive(client, audio, segment, kind="heterodyne", tune_hz=40_000).json()
        content = client.get(f"/api/audio/derived/{listened['id']}/content", headers=HEADERS)
        assert content.headers["content-type"] == "audio/wav"
        with wave.open(io.BytesIO(content.content)) as source:
            assert source.getframerate() == 48_000
            samples = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(float)
        frequencies = np.fft.rfftfreq(len(samples), 1 / 48_000)
        assert abs(frequencies[np.argmax(np.abs(np.fft.rfft(samples)))] - 5_000) < 20
        late = derive(client, audio, segment, kind="spectrogram", start_pts=str(int(segment["metadata"]["first_pts"]) + 10**9))
        assert late.status_code == 409 and late.json()["detail"]["code"] == "outside_audio"
        stale = client.post(f"/api/audio/{audio['id']}/anchor", headers=HEADERS, json={
            "actor": "R", "expected_revision": 0, "segment_id": segment["id"], "video_pts": segment["metadata"]["first_pts"], "audio_sample": 10})
        assert stale.status_code == 409 and stale.json()["detail"]["code"] == "audio_conflict"
        with sqlite3.connect(tmp_path / "app-data" / "bat_innovation.sqlite3") as connection:
            with pytest.raises(sqlite3.IntegrityError):
                connection.execute("DELETE FROM audio_anchor_event")


def test_recorded_heterodyne_audio_cannot_be_retuned(tmp_path: Path) -> None:
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        _session_id, segment, audio = prepared(client, tmp_path, mode="heterodyne")
        anchor(client, audio, segment)
        refused = derive(client, audio, segment, kind="heterodyne", tune_hz=40_000)
        assert refused.status_code == 409 and refused.json()["detail"]["code"] == "not_retunable"
        assert derive(client, audio, segment, kind="spectrogram").status_code == 200


def test_non_wav_and_duplicate_audio_are_refused(tmp_path: Path) -> None:
    fake = tmp_path / "fake.wav"
    fake.write_bytes(b"not a wave file at all" * 100)
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id = session(client)
        refused = client.post(f"/api/sessions/{session_id}/audio", headers=HEADERS, json={"paths": [str(fake)], "source_mode": "full_spectrum"})
        assert refused.status_code == 409 and refused.json()["detail"]["code"] in {"unsupported_audio", "decode_failed", "audio_failed"}
        mp4 = tmp_path / "audio.mp4"
        mp4.write_bytes(b"x")
        wrong = client.post(f"/api/sessions/{session_id}/audio", headers=HEADERS, json={"paths": [str(mp4)], "source_mode": "full_spectrum"})
        assert wrong.status_code == 400 and wrong.json()["detail"]["code"] == "invalid_sources"
        path = str(tone(tmp_path / "once.wav", seconds=0.2))
        assert client.post(f"/api/sessions/{session_id}/audio", headers=HEADERS, json={"paths": [path], "source_mode": "unknown"}).status_code == 200
        again = client.post(f"/api/sessions/{session_id}/audio", headers=HEADERS, json={"paths": [path], "source_mode": "unknown"})
        assert again.status_code == 409 and again.json()["detail"]["code"] == "audio_duplicate"


def test_export_manifest_records_audio_sync_provenance(tmp_path: Path) -> None:
    from backend.tests.test_counts import wait_export
    from backend.tests.test_tracking import wait

    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id, segment, audio = prepared(client, tmp_path)
        anchor(client, audio, segment)
        summary = client.post("/api/summaries", headers=HEADERS, json={"session_id": session_id, "window_seconds": 30}).json()
        summary = wait(client, f"/api/summaries/{summary['id']}", ("queued", "running"))
        job = wait_export(client, summary["id"])
        sync = job["manifest"]["audio_sync"]
        assert len(sync) == 1 and sync[0]["anchor"]["audio_sample"] == 0 and sync[0]["drift_corrected"] is False
