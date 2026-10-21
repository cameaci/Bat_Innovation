"""Portable protocol tests, not Windows containment or successful media-operation substitutes."""

from copy import deepcopy
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

import backend.app
from backend.app import contained_import as subject, media
from backend.tests.test_winjob import good_result


@pytest.mark.parametrize('changes', [
    {'first_time': None}, {'first_time': {'num': '30', 'den': '1'}},
    {'last_time': {'num': '30', 'den': '1'}}, {'elapsed_last_time': {'num': '30', 'den': '1'}},
    {'elapsed_end': None}, {'end_time': None}, {'end_time': {'num': '0', 'den': '1'}},
    {'time_base': {'num': '-1', 'den': '90000'}}, {'time_base': {'num': '0', 'den': '1'}},
    {'last_pts': '-1'}, {'first_pts': str(2 ** 63)}, {'first_pts': 'not-pts'},
    {'frame_count': 1}, {'size_bytes': 0}, {'size_bytes': True},
    {'codec': {'wrong': 'type'}}, {'video_stream_index': True}, {'rotation': 'unknown'},
    {'field_order': ['wrong']}, {'streams': []}, {'streams': [{'index': 0}]},
    {'warnings': [None]}, {'interlaced': 1}, {'extra': 'unexpected'},
])
def test_contradictory_or_malformed_source_metadata_is_rejected(changes):
    result = good_result(Path('synthetic.MTS'))
    result.update(deepcopy(changes))
    with pytest.raises(subject.Rejected):
        subject.validate_inspection(Path('synthetic.MTS'), result)


def test_exact_unknown_final_duration_and_negative_origin_are_preserved():
    path = Path('synthetic.MTS')
    result = good_result(path)
    result.update(first_pts='-90', first_time={'num': '-1', 'den': '1000'},
                  elapsed_last_time={'num': '1', 'den': '500'}, end_time=None, elapsed_end=None)
    assert subject.validate_inspection(path, result) is result


@pytest.mark.parametrize('key,value', [('codec', 'wrong'), ('index', 1), ('time_base', None)])
def test_selected_video_stream_must_match_source_pts_binding(key, value):
    path = Path('synthetic.MTS')
    result = good_result(path)
    result['streams'][0][key] = value
    with pytest.raises(subject.Rejected):
        subject.validate_inspection(path, result)


@pytest.fixture
def supervisor(monkeypatch):
    # Protocol boundary only. No Windows API, process or media decoding is simulated as successful.
    state = SimpleNamespace(calls=0, scratch=None, body=b'', outcome='exited', code=0, error=False)
    class Failure(Exception):
        pass
    def run(argv, *_args):
        state.calls += 1
        state.scratch = Path(argv[-1])
        if state.error:
            raise Failure('private-native-detail')
        (state.scratch / 'response.json').write_bytes(state.body)
        return SimpleNamespace(state=state.outcome, exit_code=state.code)
    monkeypatch.setattr(backend.app, 'winjob', SimpleNamespace(
        Limits=lambda *_: None, run=run, ContainmentError=Failure), raising=False)
    return state


def inspect(progress=lambda *_: None, cancelled=lambda: False, path=Path('nonexistent-synthetic.MTS')):
    return subject.inspect_source(path, progress, cancelled)


@pytest.mark.parametrize('code', [*subject.ERROR_MESSAGES, 'unexpected_worker_error'])
def test_worker_error_text_is_replaced_with_fixed_messages(supervisor, code):
    supervisor.code = 2
    supervisor.body = json.dumps({'error': {'code': code, 'message': r'Failure at C:\private-site\synthetic.MTS'}}).encode()
    with pytest.raises(media.MediaError) as caught:
        inspect()
    assert caught.value.code == (code if code in subject.ERROR_MESSAGES else 'import_failed')
    assert 'private' not in caught.value.message and '.MTS' not in caught.value.message
    assert not supervisor.scratch.exists()


@pytest.mark.parametrize('body', [
    b'{not json', b'{"ok": NaN}', b'{"ok":{},"ok":{}}', b'{"ok":{}}',
    b'[' * 2000 + b']' * 2000, b'x' * (subject.MAX_RESPONSE_BYTES + 1),
])
def test_bad_response_is_sanitized_and_scratch_is_removed(supervisor, body):
    supervisor.body = body
    progress = []
    with pytest.raises(media.MediaError) as caught:
        inspect(lambda *update: progress.append(update))
    assert caught.value.code == 'import_failed'
    assert ('inspecting', 100) not in progress
    assert not supervisor.scratch.exists()


@pytest.mark.parametrize('outcome,expected', [('cancelled', 'cancelled'), ('deadline', 'import_timeout'),
                                            ('failure', 'import_failed'), ('unexpected', 'import_failed')])
def test_supervisor_failure_cancel_and_deadline_do_not_consume_response(supervisor, outcome, expected):
    supervisor.outcome, supervisor.error = outcome, outcome == 'failure'
    with pytest.raises(media.MediaError) as caught:
        inspect()
    assert caught.value.code == expected and 'private' not in caught.value.message
    assert not supervisor.scratch.exists()


def test_cancellation_before_start_and_after_exit_never_returns_metadata(supervisor):
    with pytest.raises(media.MediaError) as caught:
        inspect(cancelled=lambda: True)
    assert caught.value.code == 'cancelled' and supervisor.calls == 0
    with pytest.raises(media.MediaError) as caught:
        inspect(cancelled=lambda: supervisor.calls > 0)
    assert caught.value.code == 'cancelled' and not supervisor.scratch.exists()


def test_request_size_is_checked_before_start(supervisor, monkeypatch):
    monkeypatch.setattr(subject, 'MAX_REQUEST_BYTES', 8)
    with pytest.raises(media.MediaError) as caught:
        inspect()
    assert caught.value.code == 'import_failed' and supervisor.calls == 0


def test_response_size_is_checked_before_file_publication(tmp_path, monkeypatch):
    (tmp_path / 'request.json').write_text(json.dumps({'source_path': 'nonexistent-synthetic.MTS'}))
    monkeypatch.setattr(media, 'inspect_source', lambda *_: {'oversize': 'x' * 1024})
    monkeypatch.setattr(subject, 'MAX_RESPONSE_BYTES', 32)
    with pytest.raises(subject.Rejected):
        subject._worker(tmp_path)
    assert not (tmp_path / 'response.tmp').exists() and not (tmp_path / 'response.json').exists()


@pytest.mark.skipif(sys.platform != 'linux', reason='POSIX special-file fixture, not Windows reparse acceptance')
@pytest.mark.parametrize('kind', ['symlink', 'fifo'])
def test_response_must_be_a_regular_file_before_open(tmp_path, kind):
    import os
    path = tmp_path / 'response.json'
    if kind == 'symlink':
        target = tmp_path / 'synthetic.txt'
        target.write_text('{}')
        path.symlink_to(target)
    else:
        os.mkfifo(path)
    with pytest.raises(subject.Rejected):
        subject._read_bounded(path, subject.MAX_RESPONSE_BYTES)


@pytest.mark.skipif(sys.platform != 'linux', reason='Real decoding is verified on Linux only')
def test_real_linux_inspector_metadata_and_immutable_sources(tmp_path):
    import hashlib
    from backend.tests.media_fixtures import generate_media
    fixtures = generate_media(tmp_path)
    for key in ('cfr_mp4', 'nonzero_mts', 'irregular_mp4', 'short_mp4'):
        path = Path(fixtures[key])
        before = hashlib.sha256(path.read_bytes()).hexdigest()
        result = media.inspect_source(path)
        assert subject.validate_inspection(path, result) is result
        assert result['sha256'] == before == hashlib.sha256(path.read_bytes()).hexdigest()
