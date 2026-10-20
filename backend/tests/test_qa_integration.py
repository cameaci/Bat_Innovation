"""Real source/preview/evidence QA decisions and durable independent histories."""

import json
from pathlib import Path
import sqlite3

from fastapi.testclient import TestClient
import pytest

from backend.app import media, review_store, store
from backend.app.main import Settings, create_app
from backend.tests.test_review_integration import (ACTOR, HEADERS, TOKEN, action, current, history,
    observation, originals, prepare, preview_receipt, run_summary, upgrade)


def qa_current(client, window_id):
    response = client.get(f"/api/summary-windows/{window_id}/qa", headers=HEADERS)
    assert response.status_code == 200, response.text
    return response.json()


def qa_history(client, window_id):
    response = client.get(f"/api/summary-windows/{window_id}/qa-history", headers=HEADERS)
    assert response.status_code == 200, response.text
    return response.json()


def qa_change(state, **fields):
    return {"actor": "Synthetic independent reviewer", "expected_revision": state["revision"],
            "expected_first_review_revision": state["first_review"]["revision"],
            "expected_evidence_revision": state["current_evidence_revision"], "action": "set_decision",
            "decision": "agree", "note": "Synthetic explicit independent assessment", "suggestion": None,
            "preview_id": None, "confirmed": True, **fields}


def qa_post(client, window_id, state=None, **fields):
    return client.post(f"/api/summary-windows/{window_id}/qa-actions", headers=HEADERS,
                       json=qa_change(state or qa_current(client, window_id), **fields))


def setup(client, session_id):
    upgrade(client)
    assert client.post('/api/qa/upgrade', headers=HEADERS, json={}).json() == {"schema_version": 5}
    return run_summary(client, session_id)


def finish_first(client, row, with_observation=False):
    state = current(client, row["id"])
    if with_observation:
        state = action(client, row["id"], state["revision"], "add_observation", observation=observation(row))
    receipt = preview_receipt(client, row)
    result = action(client, row["id"], state["revision"], "set_decision",
                    decision="reviewed_with_observations" if with_observation else "reviewed_no_discernible_event",
                    preview_id=receipt["id"])
    return result, receipt


def test_qa_decisions_suggestions_retraction_restart_and_independent_run(tmp_path, originals):
    source = originals["quiet_65"]
    checksum = media.file_sha256(source)
    db, session = prepare(tmp_path / 'data', [source])
    with TestClient(create_app(Settings(db.parent, TOKEN))) as client:
        run = setup(client, session)
        rows = run["windows"]
        for row in rows:
            assert qa_current(client, row["id"])["status"] == "pending"
            assert qa_history(client, row["id"])["events"] == []
            assert qa_post(client, row["id"]).status_code == 409
        first, receipt = finish_first(client, rows[0], True)
        first_events = history(client, rows[0]["id"])
        state = qa_current(client, rows[0]["id"])
        assert qa_post(client, rows[0]["id"], state, actor='  SYNTHETIC  REVIEWER ', preview_id=receipt["id"]).status_code == 422
        assert qa_post(client, rows[0]["id"], state).status_code == 409
        obs = state["first_review"]["observations"][0]
        suggestion = {"observation_id": obs["id"], "observation_revision": obs["revision"],
                      "note": "Synthetic category uncertain", "category": "uncertain", "count": None}
        response = qa_post(client, rows[0]["id"], state, decision="disagree", suggestion=suggestion, preview_id=receipt["id"])
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "disagree"
        assert response.json()["suggestion"]["original_observation"]["start_pts"] == first["observations"][0]["start_pts"]
        stale = qa_post(client, rows[0]["id"], state, preview_id=receipt["id"])
        assert stale.status_code == 409 and stale.json()["detail"]["code"] == 'qa_conflict'
        response = qa_post(client, rows[0]["id"], decision="needs_clarification", note="Clarify synthetic glare")
        assert response.status_code == 200 and response.json()["status"] == 'needs_clarification'
        response = qa_post(client, rows[0]["id"], preview_id=receipt["id"])
        assert response.status_code == 200 and response.json()["status"] == 'agree'
        assert history(client, rows[0]["id"]) == first_events
        assert current(client, rows[0]["id"]) == first
        events = qa_history(client, rows[0]["id"])
        assert [e["after"]["decision"] for e in events["events"]] == ['disagree','needs_clarification','agree']
        assert str(db.parent) not in json.dumps(events)
        response = qa_post(client, rows[1]["id"], decision='unassessable', note='Synthetic missing review context')
        assert response.status_code == 200
        progress = client.get(f'/api/summaries/{run["id"]}', headers=HEADERS).json()
        assert progress["review_progress"]["reviewed"] == 1
        assert progress["qa_progress"] == {"total":3,"agree":1,"disagree":0,"needs_clarification":0,"pending":1,"unassessable":1,"needs_reverification":0}
    with TestClient(create_app(Settings(db.parent, TOKEN))) as client:
        assert qa_current(client, rows[0]["id"])["status"] == 'agree'
        assert qa_history(client, rows[0]["id"]) == events
        assert qa_current(client, rows[1]["id"])["status"] == 'unassessable'
        response = qa_post(client, rows[0]["id"], action='retract', decision=None, note='Retract prior QA')
        assert response.status_code == 200 and response.json()["status"] == 'pending'
        assert len(qa_history(client, rows[0]["id"])["events"]) == 4
        second = run_summary(client, session)
        assert second["id"] != run["id"] and second["qa_progress"]["pending"] == 3
        assert all(qa_current(client, r["id"])["revision"] == 0 for r in second["windows"])
    assert media.file_sha256(source) == checksum


@pytest.mark.parametrize('name', ['nonzero_mts','irregular_mp4'])
def test_qa_exact_source_binding_preview_and_pts_preserved(tmp_path, originals, name):
    db, session = prepare(tmp_path / 'data', [originals[name]])
    with TestClient(create_app(Settings(db.parent, TOKEN))) as client:
        row = setup(client, session)["windows"][0]
        first, receipt = finish_first(client, row, True)
        assert qa_post(client, row['id'], preview_id=receipt['id']).status_code == 200
        event = qa_history(client,row['id'])['events'][0]
        assert event['time_base'] == row['time_base'] and event['source_sha256'] == row['source_sha256']
        assert event['interval'] == row['interval'] and event['segment_id'] == row['segment_id']
        assert event['after']['verification']['preview']['actual_pts'] == receipt['manifest']['actual_pts']
        assert current(client,row['id'])['observations'] == first['observations']


@pytest.mark.parametrize('failure', ['first_review','png','source'])
def test_prior_qa_acceptance_stays_stale_after_change_and_restoration(tmp_path, originals, failure):
    source = tmp_path / 'originals' / 'original.mp4'
    source.parent.mkdir()
    source.write_bytes(originals['quiet_9'].read_bytes())
    db, session = prepare(tmp_path / 'data', [source])
    with TestClient(create_app(Settings(db.parent, TOKEN))) as client:
        run = setup(client, session); row = run['windows'][0]
        first, receipt = finish_first(client,row)
        assert qa_post(client,row['id'],preview_id=receipt['id']).status_code == 200
        events = qa_history(client,row['id'])
        state = qa_current(client,row['id'])
        if failure == 'first_review':
            action(client,row['id'],first['revision'],'unable_to_assess',note='Synthetic recheck')
        elif failure == 'source':
            source.parent.rename(source.parent.with_name('offline-originals'))
        else:
            with sqlite3.connect(db) as c:
                image = db.parent / c.execute('SELECT image_path FROM summary_window WHERE id=?',(row['id'],)).fetchone()[0]
            original_png = image.read_bytes(); image.write_bytes(b'Synthetic corrupt PNG')
        changed = qa_current(client,row['id'])
        assert changed['needs_reverification'] and changed['status'] != 'agree'
        assert qa_post(client,row['id'],state,preview_id=receipt['id']).status_code == 409
        if failure == 'source': source.parent.with_name('offline-originals').rename(source.parent)
        elif failure == 'png': image.write_bytes(original_png)
        restored = qa_current(client,row['id'])
        assert restored['status'] != 'agree' and restored['needs_reverification']
        assert qa_history(client,row['id']) == events
        assert client.get(f'/api/summaries/{run["id"]}',headers=HEADERS).json()['qa_progress']['agree'] == 0
        fresh_first, fresh_receipt = finish_first(client,row)
        assert qa_post(client,row['id'],preview_id=fresh_receipt['id']).status_code == 200
        assert len(qa_history(client,row['id'])['events']) == 2


def test_incomplete_unknown_end_and_missing_sources_remain_in_full_qa_denominator(tmp_path, originals):
    db, session = prepare(tmp_path / 'data', [originals['empty_middle'],originals['single']])
    with TestClient(create_app(Settings(db.parent,TOKEN))) as client:
        run = setup(client,session)
        assert run['qa_progress']['total'] == run['counts']['planned'] == 4
        for row in run['windows']:
            state = qa_current(client,row['id'])
            assert state['status'] in {'pending','unassessable'}
            assert qa_post(client,row['id']).status_code == 409
            assert qa_post(client,row['id'],decision='unassessable',note='Explicit unresolved evidence').status_code == 200
        progress=client.get(f'/api/summaries/{run["id"]}',headers=HEADERS).json()['qa_progress']
        assert progress['unassessable'] == progress['total'] == 4 and progress['agree'] == 0


@pytest.mark.parametrize('fields', [dict(confirmed=False),dict(actor=' '),dict(decision='disagree',note=' '),
    dict(decision='needs_clarification',note=''),dict(expected_revision=True),dict(expected_evidence_revision=-1),
    dict(source_path='/synthetic/forbidden'),dict(note='x'*2001)])
def test_bad_qa_payloads_fail_without_events(tmp_path, originals, fields):
    db, session = prepare(tmp_path / 'data',[originals['quiet_9']])
    with TestClient(create_app(Settings(db.parent,TOKEN))) as client:
        row=setup(client,session)['windows'][0]
        assert qa_post(client,row['id'],**fields).status_code == 422
        assert qa_history(client,row['id'])['events'] == []


def test_qa_auth_ids_history_limits_upgrade_and_oversized_utf8(tmp_path, originals):
    db, session = prepare(tmp_path / 'data',[originals['quiet_9']])
    with TestClient(create_app(Settings(db.parent,TOKEN))) as client:
        upgrade(client); row=run_summary(client,session)['windows'][0]
        assert client.get(f'/api/summary-windows/{row["id"]}/qa',headers=HEADERS).status_code == 409
        assert client.post('/api/qa/upgrade',headers=HEADERS,json={'path':'arbitrary'}).status_code == 422
        assert store.schema_version(db) == 4
        assert client.post('/api/qa/upgrade',headers=HEADERS,json={}).status_code == 200
        for suffix in ('qa','qa-history'):
            assert client.get(f'/api/summary-windows/{row["id"]}/{suffix}').status_code == 401
            assert client.get(f'/api/summary-windows/not-an-id/{suffix}',headers=HEADERS).status_code == 422
        assert client.get(f'/api/summary-windows/{row["id"]}/qa-history?after_revision=-1',headers=HEADERS).status_code == 422
        payload=qa_change(qa_current(client,row['id']),decision='unassessable',note='😀'*2000)
        response=client.post(f'/api/summary-windows/{row["id"]}/qa-actions',headers=HEADERS,content=json.dumps(payload,ensure_ascii=False).encode())
        assert response.status_code == 413
        assert qa_history(client,row['id'])['events'] == []


@pytest.mark.parametrize('reference', ['wrong_id','wrong_revision','other_window'])
def test_qa_observation_reference_rejects_wrong_window_or_revision(tmp_path, originals, reference):
    db, session = prepare(tmp_path / 'data',[originals['quiet_9'],originals['brightness_9']])
    with TestClient(create_app(Settings(db.parent,TOKEN))) as client:
        run=setup(client,session); first,receipt=finish_first(client,run['windows'][0],True)
        other,_=finish_first(client,run['windows'][1],True)
        row=run['windows'][0]; state=qa_current(client,row['id']); obs=state['first_review']['observations'][0]
        from uuid import uuid4
        suggestion={'observation_id':obs['id'],'observation_revision':obs['revision'],'note':'Synthetic disagreement','category':None,'count':None}
        if reference == 'wrong_id': suggestion['observation_id']=str(uuid4())
        elif reference == 'wrong_revision': suggestion['observation_revision']+=1
        else: suggestion['observation_id']=other['observations'][0]['id']
        # Starting the other preview invalidated the first ephemeral receipt.
        receipt=preview_receipt(client,row)
        response=qa_post(client,row['id'],state,decision='disagree',suggestion=suggestion,preview_id=receipt['id'])
        assert response.status_code == 409 and response.json()['detail']['code'] == 'qa_conflict'
        assert qa_history(client,row['id'])['events'] == []
        assert current(client,row['id']) == first


def test_wrong_segment_preview_and_failed_window_never_allow_qa_clearance(tmp_path, originals):
    db, session = prepare(tmp_path / 'data',[originals['quiet_9'],originals['brightness_9']])
    with TestClient(create_app(Settings(db.parent,TOKEN))) as client:
        run=setup(client,session); row,other=run['windows']
        finish_first(client,row)
        wrong=preview_receipt(client,other)
        assert qa_post(client,row['id'],preview_id=wrong['id']).status_code == 409
        with sqlite3.connect(db) as c:
            c.execute("UPDATE summary_window SET status='failed',error_code='decode_failed',image_path=NULL,image_sha256=NULL,image_bytes=0 WHERE id=?",(row['id'],))
        valid=preview_receipt(client,row)
        assert qa_post(client,row['id'],preview_id=valid['id']).status_code == 409
        progress=client.get(f'/api/summaries/{run["id"]}',headers=HEADERS).json()
        assert progress['qa_progress']['total'] == 2 and progress['qa_progress']['unassessable'] == 1
        assert progress['windows'][0]['error']['code'] == 'decode_failed'
        assert qa_history(client,row['id'])['events'] == []


def test_weak_noisy_target_qa_preserves_all_three_phase_evidence_and_provisional_pts(tmp_path):
    from backend.tests.summary_fixtures import encode_frames
    from backend.tests.test_summary_motion import TIMES, synthetic_arrays
    from backend.app import summary_store
    from PIL import Image
    import numpy as np
    source=tmp_path/'synthetic-weak-noise.mp4'
    encode_frames(source,synthetic_arrays('weak_noise'),TIMES)
    db,session=prepare(tmp_path/'data',[source])
    with TestClient(create_app(Settings(db.parent,TOKEN))) as client:
        run=setup(client,session); row=run['windows'][0]
        assert row['stats']['motion_pixels'] > 0 and all(n > 0 for n in row['stats']['phase_pixels'])
        image=db.parent/summary_store.private_window(db,row['id'])['image_path']
        image_before=image.read_bytes()
        with Image.open(image) as png:
            assert np.asarray(png).max() > 0
        first,receipt=finish_first(client,row,True)
        before=history(client,row['id'])
        response=qa_post(client,row['id'],decision='disagree',note='Synthetic weak evidence remains uncertain',preview_id=receipt['id'])
        assert response.status_code == 200
        assert image.read_bytes() == image_before and history(client,row['id']) == before
        assert current(client,row['id'])['observations'] == first['observations']
        assert qa_history(client,row['id'])['events'][0]['interval'] == row['interval']


def test_concurrent_real_api_qa_requests_have_one_commit_and_one_conflict(tmp_path, originals):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    db,session=prepare(tmp_path/'data',[originals['quiet_9']])
    with TestClient(create_app(Settings(db.parent,TOKEN))) as client:
        row=setup(client,session)['windows'][0]
        _,receipt=finish_first(client,row)
        state=qa_current(client,row['id'])
        barrier=Barrier(2)
        def save():
            barrier.wait()
            return qa_post(client,row['id'],state,preview_id=receipt['id'])
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses=list(pool.map(lambda _: save(),range(2)))
        assert sorted(r.status_code for r in responses) == [200,409]
        rejected=next(r for r in responses if r.status_code==409)
        assert rejected.json()['detail']['code'] in {'qa_conflict','qa_busy'}
        assert qa_current(client,row['id'])['revision'] == 1
        assert len(qa_history(client,row['id'])['events']) == 1
