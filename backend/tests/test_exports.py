"""Synthetic real snapshot/CSV exports and negative publication/resource cases."""
from contextlib import closing
import csv
import errno
from fractions import Fraction
from hashlib import sha256
import io
import json
from pathlib import Path
import sqlite3
import time
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from backend.app import csv_export as export, export_worker, qa_store, review_store, store, summary_store
from backend.app.export_jobs import ExportJobs, ExportError
from backend.app.main import Settings, create_app
from backend.tests.test_review_integration import TOKEN, HEADERS, originals, prepare, current, action, history, preview_receipt, observation
from backend.tests.test_qa_integration import setup, finish_first, qa_post, qa_history
from backend.tests.test_summary_store import prepared, metadata


def wait_export(client, run_id):
    response = client.post('/api/exports', headers=HEADERS, json={'run_id': run_id})
    assert response.status_code == 202, response.text
    job = response.json()
    end = time.monotonic() + 35
    while job['state'] == 'working' and time.monotonic() < end:
        time.sleep(.02)
        result = client.get(f"/api/exports/{job['id']}", headers=HEADERS)
        assert result.status_code == 200, result.text
        job = result.json()
    assert job['state'] == 'ready', job
    return job


def parsed(client, job, kind):
    response = client.get(f"/api/exports/{job['id']}/files/{kind}", headers=HEADERS)
    assert response.status_code == 200, response.text
    assert sha256(response.content).hexdigest() == job['manifest']['files'][kind]['sha256']
    reader = csv.DictReader(io.StringIO(response.content.decode('utf-8'), newline=''))
    assert reader.fieldnames == (export.OBS_COLUMNS if kind == 'observations' else export.AUDIT_COLUMNS)
    return [{k: v if k in export.NUMERIC else export.decode_text(v) for k, v in row.items()} for row in reader]


def logical_dump(database):
    with sqlite3.connect(database) as connection:
        return '\n'.join(connection.iterdump())


def test_real_exports_all_65s_windows_observations_qa_history_repeatability_and_no_mutation(tmp_path, originals):
    source = originals['quiet_65']
    checksum = sha256(source.read_bytes()).hexdigest()
    db, session = prepare(tmp_path / 'data', [source])
    with TestClient(create_app(Settings(db.parent, TOKEN))) as client:
        run = setup(client, session); rows = run['windows']
        first, receipt = finish_first(client, rows[0], True)
        # Multiple provisional visual records, including unknown count and hostile text.
        item = observation(rows[0]); item.update(notes='\t=SUM(1,2)\r\n"Synthetic", \\u0000\x00', activity='@activity', count=None, category='bat', uncertain=True)
        state = action(client, rows[0]['id'], first['revision'], 'add_observation', observation=item)
        receipt = preview_receipt(client, rows[0])
        action(client, rows[0]['id'], state['revision'], 'set_decision', decision='reviewed_with_observations', preview_id=receipt['id'])
        assert qa_post(client, rows[0]['id'], decision='disagree', note='=Synthetic disagreement', preview_id=receipt['id']).status_code == 200
        assert qa_post(client, rows[0]['id'], decision='needs_clarification', note='Clarify synthetic record').status_code == 200
        first_events, qa_events = history(client, rows[0]['id']), qa_history(client, rows[0]['id'])
        before = logical_dump(db)
        job = wait_export(client, run['id'])
        audit, obs = parsed(client, job, 'audit'), parsed(client, job, 'observations')
        assert len(audit) == 3 and len(obs) == 2
        assert [Fraction(int(r['elapsed_end_seconds_num']), int(r['elapsed_end_seconds_den'])) - Fraction(int(r['elapsed_start_seconds_num']), int(r['elapsed_start_seconds_den'])) for r in audit] == [30,30,5]
        assert all(r['run_id'] == run['id'] and r['source_sha256'] == checksum for r in audit + obs)
        assert all(not r['start_utc'] and r['provisional_label'] == export.LABEL for r in audit + obs)
        assert all(r['qa_effective_status'] == 'needs_clarification' and r['has_disagreement'] == '1' for r in obs)
        assert any(r['notes'] == item['notes'] and r['count'] == '' and r['uncertain'] == '1' for r in obs)
        assert all(json.loads(r['canonical_json'])['start_pts'] == r['start_pts'] for r in obs)
        assert [r['first_review_effective_decision'] for r in audit][1:] == ['unreviewed', 'unreviewed']
        assert job['manifest']['counts']['qa']['pending'] == 2
        assert job['manifest']['counts']['planned'] == job['manifest']['counts']['actual'] == 3
        assert job['manifest']['files']['observations']['rows'] == 2
        assert str(db.parent) not in json.dumps(audit + obs + [job])
        assert logical_dump(db) == before
        old_rows = audit, obs
        repeat = wait_export(client, run['id'])
        new_rows = parsed(client, repeat, 'audit'), parsed(client, repeat, 'observations')
        for old, new in zip(old_rows, new_rows):
            for left, right in zip(old, new):
                for field in ('as_of_utc', 'canonical_json'): left.pop(field); right.pop(field)
            assert old == new
        assert history(client, rows[0]['id']) == first_events and qa_history(client, rows[0]['id']) == qa_events
        second = client.post('/api/summaries', headers=HEADERS, json={'session_id':session,'window_seconds':30}).json()
        # Finish existing run processing through the real service, then export zero observations.
        while second['state'] in {'queued','running'}:
            time.sleep(.02); second=client.get(f"/api/summaries/{second['id']}",headers=HEADERS).json()
        isolated=wait_export(client,second['id'])
        assert parsed(client,isolated,'observations') == []
        assert len(parsed(client,isolated,'audit')) == 3
    assert sha256(source.read_bytes()).hexdigest() == checksum


@pytest.mark.parametrize('name', ['nonzero_mts','irregular_mp4'])
def test_export_exact_original_pts_and_provenance_clock_anchor(tmp_path, originals, name):
    db, session = prepare(tmp_path/'data',[originals[name]])
    segment=store.private_segments(db,session)[0]
    store.update_media(db,session,[segment['id']],[{'segment_id':segment['id'],'status':'unknown','provenance':None}],
        {'segment_id':segment['id'],'utc':'2020-01-01T00:00:00Z','provenance':'Synthetic exact anchor'})
    with TestClient(create_app(Settings(db.parent,TOKEN))) as client:
        run=setup(client,session); row=run['windows'][0]
        first,_=finish_first(client,row,True)
        job=wait_export(client,run['id']); audit=parsed(client,job,'audit'); obs=parsed(client,job,'observations')
        assert audit[0]['start_utc'] == '2020-01-01T00:00:00+00:00'
        assert audit[0]['clock_provenance'] == 'Synthetic exact anchor'
        assert obs[0]['start_pts'] == first['observations'][0]['start_pts']
        assert obs[0]['end_pts_exclusive'] == first['observations'][0]['end_pts']
        assert obs[0]['time_base_num'] == row['time_base']['num'] and obs[0]['time_base_den'] == row['time_base']['den']


def test_metadata_240_all_windows_missing_failed_unknown_end_without_media_decode(tmp_path):
    db,session=prepared(tmp_path,[metadata(Fraction(7200)),metadata(None)])
    review_store.upgrade(db); qa_store.upgrade(db)
    run=summary_store.create_run(db,session)
    with sqlite3.connect(db) as connection:
        connection.execute("UPDATE processing_run SET state='incomplete' WHERE id=?",(run,))
        connection.execute("UPDATE summary_window SET status='incomplete',error_code='unknown_end' WHERE run_id=?",(run,))
        connection.execute("UPDATE summary_window SET status='failed',error_code='decode_failed' WHERE run_id=? AND window_index=0",(run,))
        connection.execute("DELETE FROM summary_window WHERE run_id=? AND window_index=1",(run,))
    out=tmp_path/'csv';out.mkdir()
    before=logical_dump(db)
    manifest=export.export_rows(db,tmp_path,run,out,'2020-01-01T00:00:00+00:00',lambda:None)
    rows=list(csv.DictReader((out/export.FILES['audit']).open(newline='')))
    assert len(rows) == manifest['counts']['planned'] == 243
    assert manifest['counts']['missing'] == 2 and not manifest['manifest_complete'] and not manifest['processing_complete']
    assert len([r for r in rows if export.decode_text(r['processing_status'])=='failed'])==2
    assert rows[-1]['window_end_pts_num'] == '' and rows[-1]['source_end_seconds_num'] == ''
    assert all(export.decode_text(r['first_review_effective_decision'])=='unreviewed' for r in rows)
    assert logical_dump(db)==before


@pytest.mark.parametrize('failure', ['source','image','first_revision'])
def test_stale_qa_agree_never_exports_current_approval_without_mutating_epochs(tmp_path, originals, failure):
    source=tmp_path/'source.mp4';source.write_bytes(originals['quiet_9'].read_bytes())
    db,session=prepare(tmp_path/'data',[source])
    with TestClient(create_app(Settings(db.parent,TOKEN))) as client:
        row=setup(client,session)['windows'][0]; first,receipt=finish_first(client,row)
        assert qa_post(client,row['id'],preview_id=receipt['id']).status_code==200
        if failure=='source': source.unlink()
        elif failure=='image':
            with sqlite3.connect(db) as c: image=db.parent/c.execute('SELECT image_path FROM summary_window WHERE id=?',(row['id'],)).fetchone()[0]
            image.unlink()
        else: action(client,row['id'],first['revision'],'unable_to_assess',note='Synthetic revised first review')
        before=logical_dump(db)
        job=wait_export(client,row['run_id']); item=parsed(client,job,'audit')[0]
        assert item['qa_decision']=='agree' and item['qa_effective_status']!='agree'
        assert item['qa_needs_reverification']=='1' and item['qa_reason']
        assert logical_dump(db)==before


@pytest.mark.parametrize('text', ['=1+2','+SUM(1,2)','-1+2','@x',' \t=cmd','\r\n=cmd','"=cmd"',"'already",'\\u0000\x00\x7f\t','日本語, "quoted"\r\nline'])
def test_every_text_cell_safe_reversible_and_csv_roundtrips(tmp_path,text):
    file=export.CSVFile(tmp_path/'test.csv',['actor','start_pts','count','canonical_json'],lambda:None)
    file.row({'actor':text,'start_pts':'-9223372036854775808','count':None});file.close()
    row=next(csv.DictReader(io.StringIO((tmp_path/'test.csv').open(newline='').read(),newline='')))
    assert row['actor'].startswith("'") and export.decode_text(row['actor'])==text
    assert row['start_pts']=='-9223372036854775808' and row['count']==''
    assert json.loads(export.decode_text(row['canonical_json']))=={'actor':text,'start_pts':'-9223372036854775808','count':None}


@pytest.mark.parametrize('journal_mode',['delete','wal'])
def test_snapshot_allows_real_first_and_qa_writes_with_one_pinned_revision(tmp_path,originals,journal_mode):
    db,session=prepare(tmp_path/'data',[originals['quiet_9']])
    with TestClient(create_app(Settings(db.parent,TOKEN))) as client:
        row=setup(client,session)['windows'][0]; first,receipt=finish_first(client,row)
        assert qa_post(client,row['id'],preview_id=receipt['id']).status_code==200
        with sqlite3.connect(db) as connection: connection.execute('PRAGMA journal_mode='+journal_mode)
        saved=False
        def concurrent_write():
            nonlocal saved
            if saved:return
            saved=True
            # The existing rollback journal gives the pinned reader precedence.
            # Concurrent saves explicitly conflict; they must succeed after retry.
            response=client.post(f"/api/summary-windows/{row['id']}/review-actions",headers=HEADERS,
                json={'actor':'Synthetic reviewer','expected_revision':first['revision'],'action':'unable_to_assess','note':'Synthetic concurrent first edit'})
            if journal_mode=='delete': assert response.status_code==409 and response.json()['detail']['code']=='review_busy'
            else: assert response.status_code==200,response.text
            response=qa_post(client,row['id'],decision='unassessable',note='Synthetic concurrent QA')
            if journal_mode=='delete': assert response.status_code==409 and response.json()['detail']['code'] in {'qa_busy','review_busy'}
            else: assert response.status_code==200,response.text
        target=tmp_path/'snapshot.sqlite3'
        asof=export.snapshot(db,target,concurrent_write)
        with closing(export.readonly(target)) as copy:
            assert copy.execute('SELECT revision FROM review_window').fetchone()[0]==first['revision']
            assert copy.execute('SELECT revision FROM qa_window').fetchone()[0]==1
            with pytest.raises(sqlite3.OperationalError):copy.execute('DELETE FROM review_event')
        if journal_mode=='delete':
            assert qa_post(client,row['id'],decision='needs_clarification',note='Synthetic QA retry').status_code==200
            action(client,row['id'],first['revision'],'unable_to_assess',note='Synthetic first edit retry')
        out=tmp_path/'csv';out.mkdir();manifest=export.export_rows(target,db.parent,row['run_id'],out,asof,lambda:None)
        audit=next(csv.DictReader((out/export.FILES['audit']).open(newline='')))
        assert audit['first_review_revision']==str(first['revision']) and audit['qa_revision']=='1'
        assert export.decode_text(audit['qa_effective_status'])=='agree'
        assert manifest['counts']['qa']['agree']==1 # explicitly snapshot approval, not live approval


def test_export_api_auth_narrow_paths_and_schema(tmp_path, originals):
    db,session=prepare(tmp_path/'data',[originals['quiet_9']])
    with TestClient(create_app(Settings(db.parent,TOKEN))) as client:
        unknown=str(uuid4())
        assert client.post('/api/exports',json={'run_id':unknown}).status_code==401
        assert client.get(f'/api/exports/{unknown}').status_code==401
        assert client.get(f'/api/exports/{unknown}/files/audit').status_code==401
        assert client.post('/api/exports',headers=HEADERS,json={'run_id':unknown,'path':'/unselected'}).status_code==422
        assert client.post('/api/exports',headers=HEADERS,json={'run_id':'/unselected'}).status_code==422
        response=client.post('/api/exports',headers=HEADERS,json={'run_id':unknown})
        assert response.json()['detail']['code']=='export_schema_required'
        setup(client,session)
        assert client.post('/api/exports',headers=HEADERS,json={'run_id':unknown}).status_code==404


@pytest.mark.parametrize('limit', ['MAX_ROWS','MAX_CSV_BYTES','MAX_ROW_BYTES','MAX_SNAPSHOT_BYTES'])
def test_size_limits_are_explicit_never_truncate(tmp_path,monkeypatch,limit):
    monkeypatch.setattr(export,limit,1)
    with pytest.raises(export.ExportFailure,match='export_too_large'):
        if limit=='MAX_SNAPSHOT_BYTES':
            db,_=prepared(tmp_path);review_store.upgrade(db);qa_store.upgrade(db)
            export.snapshot(db,tmp_path/'snapshot.db',lambda:None)
        else:
            file=export.CSVFile(tmp_path/'too-large.csv',['actor'],lambda:None)
            try:file.row({'actor':'one'});file.row({'actor':'two'})
            finally:file.handle.close()


@pytest.mark.parametrize('failure',['cancel','shutdown','thread_start','rename','enospc'])
def test_manager_cleanup_failures_and_retry(tmp_path,originals,monkeypatch,failure):
    db,session=prepare(tmp_path/'data',[originals['quiet_9']])
    with TestClient(create_app(Settings(db.parent,TOKEN))) as client: run=setup(client,session)
    manager=ExportJobs(db,db.parent)
    try:
        if failure=='thread_start':
            from backend.app import export_jobs
            with monkeypatch.context() as m:
                m.setattr(export_jobs.Thread,'start',lambda _: (_ for _ in ()).throw(RuntimeError('synthetic startup failure')))
                with pytest.raises(ExportError): manager.start(run['id'])
        elif failure in {'rename','enospc'}:
            import errno
            with monkeypatch.context() as m:
                if failure=='rename':m.setattr(export_worker.os,'rename',lambda *_:(_ for _ in ()).throw(OSError(errno.EIO,'synthetic rename failure')))
                else:m.setattr(export.CSVFile,'row',lambda *_:(_ for _ in ()).throw(OSError(errno.ENOSPC,'synthetic full disk')))
                with pytest.raises(OSError):export_worker.render(db.parent,str(uuid4()),run['id'])
            # Supervisor performs cleanup after a worker failure; restart does too.
            manager.close();manager=ExportJobs(db,db.parent)
        else:
            job=manager.start(run['id'])
            if failure=='cancel': manager.cancel(job['id']);manager.thread.join(5)
            else:manager.close();manager=ExportJobs(db,db.parent)
        assert not list(manager.directory.iterdir())
        job=manager.start(run['id']);manager.thread.join(35)
        result=manager.get(job['id']);assert result['state']=='ready',result
        assert manager.process is None and not manager.thread.is_alive()
        chunks,size=manager.content(job['id'],'audit');assert sum(map(len,chunks))==size
    finally:manager.close()
    assert not list((db.parent/'exports').iterdir())


def test_stale_filesystem_and_live_manifest_changes_fail_before_publication(tmp_path, originals, monkeypatch):
    db,session=prepare(tmp_path/'data',[originals['quiet_9']])
    with TestClient(create_app(Settings(db.parent,TOKEN))) as client:run=setup(client,session)
    root=db.parent/'exports';root.mkdir(exist_ok=True)
    original=export.export_rows
    def change_after_rows(*args):
        result=original(*args)
        with sqlite3.connect(db) as c:c.execute('UPDATE summary_window SET evidence_revision=evidence_revision+1 WHERE run_id=?',(run['id'],))
        return result
    monkeypatch.setattr(export,'export_rows',change_after_rows)
    with pytest.raises(export.ExportFailure,match='export_stale'):export_worker.render(db.parent,str(uuid4()),run['id'])
    assert not [p for p in root.iterdir() if not p.name.endswith('.part')]
    manager=ExportJobs(db,db.parent);assert not list(root.iterdir());manager.close()


def test_real_weak_motion_and_unknown_end_are_retained_with_source_boundaries(tmp_path, originals, monkeypatch):
    from backend.tests.summary_fixtures import encode_frames
    from backend.tests.test_summary_motion import TIMES, synthetic_arrays
    source=tmp_path/'synthetic-weak.mp4'
    encode_frames(source,synthetic_arrays('weak_noise'),TIMES)
    from backend.app import media
    from types import SimpleNamespace
    original_decoder=media.decoded_frames
    def absent_final_duration(container,stream,cancelled=lambda:False):
        for frame in original_decoder(container,stream,cancelled):
            if container.name==str(originals['single']):
                yield SimpleNamespace(pts=frame.pts,time_base=frame.time_base,width=frame.width,height=frame.height,
                    rotation=frame.rotation,interlaced_frame=frame.interlaced_frame,duration=None)
            else:yield frame
    # The encoder supplies a duration. Withhold just that input metadata on the
    # one-frame fixture; real decoding, processing, SQLite and CSV remain intact.
    with monkeypatch.context() as patch:
        patch.setattr(media,'decoded_frames',absent_final_duration)
        db,session=prepare(tmp_path/'data',[source,originals['single']])
    with TestClient(create_app(Settings(db.parent,TOKEN))) as client:
        run=setup(client,session)
        weak=run['windows'][0]
        assert weak['stats']['motion_pixels']>0 and all(n>0 for n in weak['stats']['phase_pixels'])
        first,_=finish_first(client,weak,True)
        job=wait_export(client,run['id']);audit=parsed(client,job,'audit');obs=parsed(client,job,'observations')
        assert len(audit)==2 and len(obs)==1
        assert int(audit[0]['motion_pixels'])==weak['stats']['motion_pixels']
        assert audit[-1]['window_end_pts_num']=='' and audit[-1]['window_end_pts_den']==''
        assert audit[-1]['processing_status']=='incomplete' and audit[-1]['qa_effective_status']=='unassessable'
        assert obs[0]['start_pts']==first['observations'][0]['start_pts']
        assert job['manifest']['counts']['planned']==2


def test_source_unreadable_is_not_missing_and_history_survives_export(tmp_path, originals):
    import os
    if os.geteuid()==0:pytest.skip('Permission denial requires a non-root local test user')
    source=tmp_path/'original.mp4';source.write_bytes(originals['quiet_9'].read_bytes())
    db,session=prepare(tmp_path/'data',[source])
    with TestClient(create_app(Settings(db.parent,TOKEN))) as client:
        row=setup(client,session)['windows'][0];finish_first(client,row,True)
        before=logical_dump(db)
        source.chmod(0)
        try:
            job=wait_export(client,row['run_id']);audit=parsed(client,job,'audit')
            assert audit[0]['first_review_reason']=='unreadable_source'
            assert audit[0]['qa_effective_status']=='unassessable'
            assert len(parsed(client,job,'observations'))==1
            assert logical_dump(db)==before
        finally:source.chmod(0o600)


def test_clock_is_segment_bound_exact_and_never_inferred(tmp_path):
    source={'id':str(uuid4()),'metadata_json':json.dumps(metadata(Fraction(65),first_pts=-11,time_base=Fraction(7,300)))}
    base=json.loads(source['metadata_json'])
    anchor={'segment_id':source['id'],'source_pts':base['first_pts'],'time_base':base['time_base'],'utc':'2020-01-01T00:00:00Z','provenance':'Synthetic recorded anchor'}
    start={'num':'-10','den':'1'}
    exact=export.clock(anchor,source,start,None)
    assert exact['start_utc']=='' and exact['clock_reason']=='exact_fractional_offset_only'
    assert exact['clock_offset_seconds'][0]=={'num':'7','den':'300'}
    assert export.clock({**anchor,'segment_id':str(uuid4())},source,start,None)['clock_reason']=='unknown_recording_clock'
    assert export.clock({**anchor,'provenance':''},source,start,None)['start_utc']==''
    assert export.clock(None,source,start,None)['start_utc']==''
    assert export.clock({**anchor,'source_pts':'0'},source,start,None)['clock_reason']=='invalid_clock_provenance'


def test_wal_worker_publication_contains_only_declared_artifacts_and_delivery_is_serial(tmp_path,originals):
    db,session=prepare(tmp_path/'data',[originals['quiet_9']])
    with TestClient(create_app(Settings(db.parent,TOKEN))) as client:run=setup(client,session)
    with sqlite3.connect(db) as connection:connection.execute('PRAGMA journal_mode=WAL')
    job_id=str(uuid4())
    result=export_worker.render(db.parent,job_id,run['id'])
    assert set(p.name for p in (db.parent/'exports'/job_id).iterdir())==set(export.FILES.values())
    manager=ExportJobs(db,db.parent)
    try:
        job=manager.start(run['id']);manager.thread.join(35)
        assert manager.get(job['id'])['state']=='ready'
        chunks,size=manager.content(job['id'],'audit')
        first=next(chunks)
        with pytest.raises(ExportError,match='export_busy'):manager.content(job['id'],'observations')
        assert len(first)+sum(map(len,chunks))==size
        target=manager.directory/job['id']/export.FILES['audit']
        content=target.read_bytes();target.write_bytes(b'X'+content[1:])
        with pytest.raises(ExportError) as error:manager.content(job['id'],'audit')
        assert error.value.code=='export_stale'
    finally:manager.close()


@pytest.mark.parametrize(('error','code'),[(MemoryError(),'export_too_large'),(OSError(errno.EFBIG,'synthetic file limit'),'export_too_large'),(OSError(errno.ENOSPC,'synthetic full disk'),'export_write_failed')])
def test_worker_resource_failures_are_fixed_explicit_codes(tmp_path,monkeypatch,capsys,error,code):
    import os
    monkeypatch.setattr(export_worker.sys,'argv',['export_worker',str(tmp_path),str(uuid4()),str(uuid4()),str(os.getpid())])
    monkeypatch.setattr(export_worker,'limits',lambda _:None) # only failure-code serialization is under test
    def fail(*_):raise error
    monkeypatch.setattr(export_worker,'render',fail)
    export_worker.main()
    assert json.loads(capsys.readouterr().out)=={'ok':False,'code':code}
