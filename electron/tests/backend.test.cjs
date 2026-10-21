const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { access, mkdtemp, readFile, readdir, rm, symlink } = require('node:fs/promises');
const { createServer } = require('node:net');
const { createServer: httpServer } = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { BackendClient, BackendRuntime, isReviewChange, isQAChange, isReviewCursor, MAX_PREVIEW_BYTES, MAX_SUMMARY_BYTES } = require('../dist/backend.js');

const repoRoot = path.resolve(__dirname, '../..');
const python = process.env.BAT_PYTHON || 'python';

test('QA bridge permits only confirmed bounded ID-based actions and exact revisions', async () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const input = { actor: 'Synthetic QA', expected_revision: 0, expected_first_review_revision: 1,
    expected_evidence_revision: 0, action: 'set_decision', decision: 'agree', note: '', suggestion: null,
    preview_id: id, confirmed: true };
  assert.equal(isQAChange(input), true);
  for (const extra of [{ confirmed: false }, { actor: ' ' }, { expected_revision: true },
    { expected_first_review_revision: 2 ** 31 }, { expected_evidence_revision: -1 }, { path: '/unselected' },
    { decision: 'finalised' }, { note: 'x'.repeat(2001) }, { preview_id: '/private/file.mp4' },
    { decision: 'disagree', note: '' }, { action: 'retract', decision: null, note: 'Retract', preview_id: id }]) {
    assert.equal(isQAChange({ ...input, ...extra }), false);
  }
  const suggestion = { observation_id: id, observation_revision: 1, note: 'Synthetic uncertainty', category: 'uncertain', count: null };
  const disagreement = { ...input, decision: 'disagree', note: 'Synthetic reason', suggestion };
  assert.equal(isQAChange(disagreement), true);
  for (const extra of [{ observation_id: '/private' }, { observation_revision: 0 }, { count: true },
    { count: -1 }, { category: 'species' }, { category: { toString: 'uncertain' } }, { note: ' ' }, { path: '/not-allowed' }]) {
    assert.equal(isQAChange({ ...disagreement, suggestion: { ...suggestion, ...extra } }), false);
  }
  assert.equal(isQAChange({ ...disagreement, actor: '😀'.repeat(60), note: '😀'.repeat(1000), suggestion: { ...suggestion, note: '😀'.repeat(1000) } }), false);
  const client = new BackendClient(1, 'synthetic-not-launched-token');
  expectFailure(await client.getWindowQA('/private'), 'invalid');
  expectFailure(await client.saveQA(id, { ...input, path: '/private' }), 'invalid');
  expectFailure(await client.qaHistory(id, -1), 'invalid');
});

test('real QA bridge preserves separate audit and source binding across backend restart', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bat-qa-runtime-'));
  const dataDir = path.join(directory, 'data');
  const runtime = new BackendRuntime(), reopened = new BackendRuntime();
  t.after(async () => { await Promise.all([runtime.stop(), reopened.stop()]); await rm(directory, { recursive: true, force: true }); });
  const generated = spawnSync(python, ['-m', 'backend.tests.summary_fixtures', path.join(directory, 'originals')], { cwd: repoRoot, encoding: 'utf8', timeout: 15000 });
  assert.equal(generated.status, 0, generated.stderr);
  const source = JSON.parse(generated.stdout).quiet_9;
  const bytes = await readFile(source);
  const port = await availablePort();
  assert.equal((await runtime.start({ python, repoRoot, dataDir, port })).ok, true);
  const unauthorized = new BackendClient(port, 'incorrect-synthetic-token');
  const id = '12345678-1234-1234-1234-123456789abc';
  expectFailure(await unauthorized.upgradeQA(), 'unauthorized');
  expectFailure(await unauthorized.getWindowQA(id), 'unauthorized');
  expectFailure(await unauthorized.qaHistory(id, 0), 'unauthorized');
  assert.equal((await runtime.upgradeMedia()).ok, true);
  const session = await runtime.createSession({ display_name: 'Synthetic QA', camera_ref: 'Synthetic camera' });
  const imported = await runtime.importSelectedMedia(session.value.id, [source]);
  assert.equal((await waitUntilTerminal(() => runtime.importStatus(imported.value.id), ['running'])).state, 'complete');
  assert.equal((await runtime.upgradeSummaries()).ok, true);
  assert.equal((await runtime.upgradeReviews()).ok, true);
  assert.deepEqual(await runtime.upgradeQA(), { ok: true, value: { schema_version: 5 } });
  const started = await runtime.startSummaries({ session_id: session.value.id, window_seconds: 30 });
  const run = await waitUntilTerminal(() => runtime.summaryRun(started.value.id), ['queued','running']);
  const row = run.windows[0];
  assert.equal(run.qa_progress.pending, 1);
  const preview = await runtime.startPreview({ segment_id: row.segment_id, source_pts: row.preview_pts });
  assert.equal((await waitUntilTerminal(() => runtime.previewStatus(preview.value.id), ['running'])).state, 'ready');
  const first = await runtime.saveReview(row.id, { actor: 'Synthetic first reviewer', expected_revision: 0, action: 'set_decision', decision: 'reviewed_no_discernible_event', preview_id: preview.value.id });
  assert.equal(first.ok, true, JSON.stringify(first));
  const before = await runtime.reviewHistory(row.id, 0);
  const state = await runtime.getWindowQA(row.id);
  const change = { actor: 'Synthetic second reviewer', expected_revision: 0, expected_first_review_revision: 1,
    expected_evidence_revision: state.value.current_evidence_revision, action: 'set_decision', decision: 'agree', note: '', suggestion: null, preview_id: preview.value.id, confirmed: true };
  expectFailure(await unauthorized.saveQA(row.id, change), 'unauthorized');
  expectFailure(await runtime.saveQA(row.id, { ...change, actor: ' SYNTHETIC FIRST REVIEWER ' }), 'qa_same_actor');
  const saved = await runtime.saveQA(row.id, change);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.value.status, 'agree');
  expectFailure(await runtime.saveQA(row.id, change), 'qa_conflict');
  assert.deepEqual(await runtime.reviewHistory(row.id, 0), before);
  const events = await runtime.qaHistory(row.id, 0);
  assert.equal(events.value.events[0].source_sha256, row.source_sha256);
  assert.deepEqual(events.value.events[0].interval, row.interval);
  assert.doesNotMatch(JSON.stringify(events), /source_path|image_path|bat-qa-runtime-/);
  await runtime.stop();
  assert.equal((await reopened.start({ python, repoRoot, dataDir })).ok, true);
  assert.deepEqual(await reopened.getWindowQA(row.id), saved);
  assert.deepEqual(await reopened.qaHistory(row.id, 0), events);
  assert.deepEqual(await readFile(source), bytes);
  const edited = await reopened.saveReview(row.id, { actor: 'Synthetic first reviewer', expected_revision: 1, action: 'unable_to_assess', note: 'Synthetic new uncertainty' });
  assert.equal(edited.ok, true);
  assert.equal((await reopened.getWindowQA(row.id)).value.needs_reverification, true);
  assert.equal((await reopened.summaryRun(run.id)).value.qa_progress.agree, 0);
  assert.deepEqual(await reopened.qaHistory(row.id, 0), events);
});

async function availablePort() {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('No loopback port available for integration test'));
        return;
      }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function expectFailure(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
}

function expectExited(pid) {
  assert.equal(typeof pid, 'number');
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
}

async function waitUntilTerminal(read, activeStates) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await read();
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!activeStates.includes(result.value.state)) return result.value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Synthetic media operation did not reach a terminal state');
}

test('real backend without media CLI persists sessions across runtime restart and rejects unauthorized access', { timeout: 45000 }, async t => {
  const resolved = spawnSync(python, ['-c', 'import sys; print(sys.executable)'], {
    cwd: repoRoot, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(resolved.status, 0);
  const runtimePython = resolved.stdout.trim();
  assert.ok(path.isAbsolute(runtimePython));
  const previousPath = process.env.PATH;
  process.env.PATH = '';
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bat-runtime-'));
  const first = new BackendRuntime();
  const reopened = new BackendRuntime();
  t.after(async () => {
    await Promise.all([first.stop(), reopened.stop()]);
    await rm(dataDir, { recursive: true, force: true });
  });

  const port = await availablePort();
  const options = { python: runtimePython, repoRoot, dataDir, port };
  const [ready, sameLaunch] = await Promise.all([first.start(options), first.start(options)]);
  assert.deepEqual(ready, { ok: true, value: { status: 'ok', storage: 'ready' } });
  assert.deepEqual(sameLaunch, ready);
  const firstPid = first.pid;
  assert.equal(typeof firstPid, 'number');
  assert.deepEqual(await first.health(), ready);
  assert.deepEqual(await first.listSessions(), { ok: true, value: [] });

  const unauthorized = new BackendClient(port, 'deliberately-incorrect-synthetic-token');
  expectFailure(await unauthorized.health(), 'unauthorized');
  expectFailure(await unauthorized.listSessions(), 'unauthorized');
  expectFailure(await unauthorized.createSession({ display_name: 'Not saved', camera_ref: 'Synthetic camera' }), 'unauthorized');

  expectFailure(await first.createSession({ display_name: '   ', camera_ref: 'Synthetic camera' }), 'invalid');
  expectFailure(await first.createSession({ display_name: 'x'.repeat(121), camera_ref: 'Synthetic camera' }), 'invalid');
  expectFailure(await first.createSession({
    display_name: 'Synthetic path injection', camera_ref: 'Synthetic camera', source_path: '/not-selected/synthetic.mp4',
  }), 'invalid');
  const created = await first.createSession({ display_name: '  Synthetic persistence survey  ', camera_ref: '  Synthetic camera A  ' });
  assert.equal(created.ok, true);
  assert.equal(created.value.display_name, 'Synthetic persistence survey');
  assert.equal(created.value.camera_ref, 'Synthetic camera A');
  assert.equal(typeof created.value.id, 'string');
  assert.ok(created.value.id.length > 0);
  assert.ok(Number.isFinite(Date.parse(created.value.created_at_utc)));
  assert.deepEqual(await first.listSessions(), { ok: true, value: [created.value] });

  await first.stop();
  expectExited(firstPid);
  assert.equal(first.pid, undefined);
  const unavailable = await first.health();
  expectFailure(unavailable, 'unavailable');
  assert.match(unavailable.error.message, /installed backend dependencies/);
  assert.doesNotMatch(unavailable.error.message, /ffmpeg|ffprobe/i);
  expectFailure(await unauthorized.health(), 'unavailable');

  const restarted = await reopened.start({ python: runtimePython, repoRoot, dataDir });
  assert.deepEqual(restarted, ready);
  assert.deepEqual(await reopened.listSessions(), { ok: true, value: [created.value] });
  const reopenedPid = reopened.pid;
  await reopened.stop();
  expectExited(reopenedPid);
  assert.equal(reopened.pid, undefined);
});

test('preview bridge rejects paths, invalid timestamps and unauthenticated requests against the real backend', { timeout: 20000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bat-preview-contract-'));
  const runtime = new BackendRuntime();
  t.after(async () => { await runtime.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const port = await availablePort();
  assert.equal((await runtime.start({ python, repoRoot, dataDir, port })).ok, true);
  assert.equal((await runtime.upgradeMedia()).ok, true);
  const id = '00000000-0000-4000-8000-000000000000';
  for (const input of [
    { segment_id: id, source_pts: '0', path: '/not-selected/synthetic.mp4' },
    { segment_id: id, source_pts: 0 },
    { segment_id: id, source_pts: '1.5' },
    { segment_id: id, source_pts: '1e3' },
    { segment_id: id, source_pts: '9223372036854775808' },
    { segment_id: id, source_pts: '-9223372036854775809' },
    { segment_id: 'file:///not-selected/synthetic.mp4', source_pts: '0' },
  ]) expectFailure(await runtime.startPreview(input), 'invalid');
  expectFailure(await runtime.previewContent('../not-selected'), 'invalid');
  expectFailure(await runtime.previewStatus('http://example.invalid'), 'invalid');
  expectFailure(await runtime.startPreview({ segment_id: id, source_pts: '0' }), 'segment_missing');
  const unauthorized = new BackendClient(port, 'deliberately-incorrect-synthetic-token');
  expectFailure(await unauthorized.startPreview({ segment_id: id, source_pts: '0' }), 'unauthorized');
  expectFailure(await unauthorized.previewStatus(id), 'unauthorized');
  expectFailure(await unauthorized.cancelPreview(id), 'unauthorized');
  expectFailure(await unauthorized.previewContent(id), 'unauthorized');
});

test('binary preview transport refuses oversized responses before accepting media bytes', { timeout: 10000 }, async t => {
  // Deliberately invalid upstream responses test the byte boundary, never successful decoding.
  for (const declaredLength of [true, false]) {
    await t.test(declaredLength ? 'oversized Content-Length' : 'oversized chunked body', async () => {
      const server = httpServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'video/webm', ...(declaredLength ? { 'Content-Length': MAX_PREVIEW_BYTES + 1 } : {}) });
        response.end(Buffer.alloc(MAX_PREVIEW_BYTES + 1));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const client = new BackendClient(server.address().port, 'synthetic-transport-test-token-only');
        expectFailure(await client.previewContent('00000000-0000-4000-8000-000000000000'), 'unavailable');
      } finally { await new Promise(resolve => server.close(resolve)); }
    });
  }
});

test('binary preview transport admits only one in-flight content response', { timeout: 10000 }, async () => {
  let received;
  const arrived = new Promise(resolve => { received = resolve; });
  let requests = 0;
  const server = httpServer((_request, response) => { requests += 1; received(response); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new BackendClient(server.address().port, 'synthetic-transport-test-token-only');
    const first = client.previewContent('00000000-0000-4000-8000-000000000000');
    const response = await arrived;
    expectFailure(await client.previewContent('00000000-0000-4000-8000-000000000001'), 'preview_busy');
    assert.equal(requests, 1);
    response.writeHead(409, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ detail: { code: 'preview_not_ready' } }));
    expectFailure(await first, 'preview_not_ready');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('summary bridge requires explicit storage upgrade and rejects paths, invalid durations and unauthorized routes', { timeout: 30000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bat-summary-contract-'));
  const runtime = new BackendRuntime();
  t.after(async () => { await runtime.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const port = await availablePort();
  assert.equal((await runtime.start({ python, repoRoot, dataDir, port })).ok, true);
  expectFailure(await runtime.upgradeSummaries(), 'summary_upgrade_failed');
  assert.deepEqual(await runtime.upgradeMedia(), { ok: true, value: { schema_version: 2 } });
  const created = await runtime.createSession({ display_name: 'Synthetic summary contract', camera_ref: 'Synthetic camera' });
  assert.equal(created.ok, true);
  const id = created.value.id;
  expectFailure(await runtime.startSummaries({ session_id: id, window_seconds: 30 }), 'summary_upgrade_required');
  for (const input of [
    { session_id: '../not-selected', window_seconds: 30 },
    { session_id: id, window_seconds: 0 },
    { session_id: id, window_seconds: 121 },
    { session_id: id, window_seconds: 1.5 },
    { session_id: id, window_seconds: '30' },
    { session_id: id, window_seconds: NaN },
    { session_id: id, window_seconds: 30, path: '/not-selected/synthetic.mp4' },
    { session_id: id, window_seconds: 30, algorithm_version: 'unrecorded' },
    { session_id: id },
  ]) expectFailure(await runtime.startSummaries(input), 'invalid');
  for (const invalidID of ['../not-selected', 'file:///not-selected/synthetic.png', 'https://example.invalid', 1]) {
    for (const method of ['listSummaryRuns', 'summaryRun', 'cancelSummaries', 'summaryImage']) {
      expectFailure(await runtime[method](invalidID), 'invalid');
    }
  }
  const unauthorized = new BackendClient(port, 'deliberately-incorrect-synthetic-token');
  expectFailure(await unauthorized.upgradeSummaries(), 'unauthorized');
  expectFailure(await unauthorized.listSummaryRuns(id), 'unauthorized');
  expectFailure(await unauthorized.startSummaries({ session_id: id, window_seconds: 30 }), 'unauthorized');
  expectFailure(await unauthorized.summaryRun(id), 'unauthorized');
  expectFailure(await unauthorized.cancelSummaries(id), 'unauthorized');
  expectFailure(await unauthorized.summaryImage(id), 'unauthorized');
  assert.equal((await runtime.getMedia(id)).value.schema_version, 2, 'Rejected requests must not upgrade storage');
});

test('summary PNG transport refuses oversized bodies, incorrect MIME and private error text', { timeout: 15000 }, async t => {
  assert.equal(MAX_SUMMARY_BYTES, 4 * 1024 * 1024);
  for (const scenario of ['declared-length', 'chunked', 'wrong-mime', 'missing-image']) {
    await t.test(scenario, async () => {
      const server = httpServer((_request, response) => {
        if (scenario === 'missing-image') {
          response.writeHead(409, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ detail: { code: 'summary_image_missing', message: '/private/synthetic/image.png' } }));
        } else if (scenario === 'wrong-mime') {
          response.writeHead(200, { 'Content-Type': 'text/plain' });
          response.end('This is not a summary PNG');
        } else {
          response.writeHead(200, { 'Content-Type': 'image/png',
            ...(scenario === 'declared-length' ? { 'Content-Length': MAX_SUMMARY_BYTES + 1 } : {}) });
          response.end(Buffer.alloc(MAX_SUMMARY_BYTES + 1));
        }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const client = new BackendClient(server.address().port, 'synthetic-transport-test-token-only');
        const result = await client.summaryImage('00000000-0000-4000-8000-000000000000');
        expectFailure(result, scenario === 'missing-image' ? 'summary_image_missing' : scenario === 'wrong-mime' ? 'backend' : 'unavailable');
        assert.doesNotMatch(result.error.message, /private|synthetic\/image|not a summary PNG/);
      } finally { await new Promise(resolve => server.close(resolve)); }
    });
  }
});

test('preview and summary binary transport share one in-flight response reservation', { timeout: 10000 }, async () => {
  for (const [firstMethod, blockedMethod] of [['summaryImage', 'previewContent'], ['previewContent', 'summaryImage']]) {
    let received;
    const arrived = new Promise(resolve => { received = resolve; });
    let requests = 0;
    const server = httpServer((_request, response) => { requests += 1; received(response); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = new BackendClient(server.address().port, 'synthetic-transport-test-token-only');
      const first = client[firstMethod]('00000000-0000-4000-8000-000000000000');
      const response = await arrived;
      expectFailure(await client[blockedMethod]('00000000-0000-4000-8000-000000000001'), 'preview_busy');
      assert.equal(requests, 1);
      response.writeHead(409, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ detail: { code: 'summary_not_ready' } }));
      expectFailure(await first, 'summary_not_ready');
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
});

test('real PyAV summaries and PNG evidence survive runtime restart after a media-to-summary upgrade', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bat-summary-persistence-'));
  const dataDir = path.join(directory, 'app-data');
  const first = new BackendRuntime();
  const reopened = new BackendRuntime();
  t.after(async () => {
    await Promise.all([first.stop(), reopened.stop()]);
    await rm(directory, { recursive: true, force: true });
  });
  const generated = spawnSync(python, ['-m', 'backend.tests.summary_fixtures', path.join(directory, 'originals')],
    { cwd: repoRoot, encoding: 'utf8', timeout: 15000 });
  assert.equal(generated.status, 0, generated.stderr);
  const source = JSON.parse(generated.stdout).quiet_9;
  const original = await readFile(source);
  assert.equal((await first.start({ python, repoRoot, dataDir })).ok, true);
  assert.deepEqual(await first.upgradeMedia(), { ok: true, value: { schema_version: 2 } });
  const created = await first.createSession({ display_name: 'Synthetic summary persistence', camera_ref: 'Synthetic camera' });
  assert.equal(created.ok, true);
  const sessionID = created.value.id;
  const imported = await first.importSelectedMedia(sessionID, [source]);
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal((await waitUntilTerminal(() => first.importStatus(imported.value.id), ['running'])).state, 'complete');
  const before = await first.getMedia(sessionID);
  assert.equal(before.ok, true);
  assert.equal(before.value.schema_version, 2);
  assert.equal(before.value.segments.length, 1);
  assert.deepEqual(await first.upgradeSummaries(), { ok: true, value: { schema_version: 3 } });
  assert.deepEqual(await first.upgradeSummaries(), { ok: true, value: { schema_version: 3 } });
  const after = await first.getMedia(sessionID);
  assert.deepEqual(after.value.segments, before.value.segments);
  assert.equal(after.value.schema_version, 3);
  const started = await first.startSummaries({ session_id: sessionID, window_seconds: 30 });
  assert.equal(started.ok, true, JSON.stringify(started));
  const run = await waitUntilTerminal(() => first.summaryRun(started.value.id), ['queued', 'running']);
  assert.equal(run.state, 'complete', JSON.stringify(run));
  assert.equal(run.counts.planned, 1);
  assert.equal(run.counts.complete, 1);
  assert.equal(run.windows.length, 1);
  const window = run.windows[0];
  assert.equal(window.status, 'complete');
  assert.equal(window.stats.motion_pixels, 0, 'Quiet evidence remains an accessible complete window');
  const content = await first.summaryImage(window.id);
  assert.equal(content.ok, true, JSON.stringify(content));
  const png = Buffer.from(content.value.bytes);
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.length, window.image.bytes);
  assert.equal(createHash('sha256').update(png).digest('hex'), window.image.sha256);
  assert.doesNotMatch(JSON.stringify(run), /source_path|image_path|bat-summary-persistence-/);

  // The existing source-preview route must still work after schema 3 is selected.
  const segment = after.value.segments[0];
  const preview = await first.startPreview({ segment_id: segment.id, source_pts: segment.metadata.last_pts });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal((await waitUntilTerminal(() => first.previewStatus(preview.value.id), ['running'])).state, 'ready');
  assert.equal((await first.previewContent(preview.value.id)).ok, true);
  const firstPid = first.pid;
  await first.stop();
  expectExited(firstPid);
  assert.equal((await reopened.start({ python, repoRoot, dataDir })).ok, true);
  assert.deepEqual(await reopened.summaryRun(run.id), { ok: true, value: run });
  const listed = await reopened.listSummaryRuns(sessionID);
  assert.equal(listed.ok, true);
  assert.equal(listed.value.length, 1);
  assert.equal(listed.value[0].id, run.id);
  assert.deepEqual(Buffer.from((await reopened.summaryImage(window.id)).value.bytes), png);
  assert.deepEqual(await readFile(source), original, 'Import, processing and preview leave original bytes untouched');

  await rm(path.join(dataDir, 'summaries', run.id, `${window.id}.png`));
  const missing = await reopened.summaryImage(window.id);
  expectFailure(missing, 'summary_image_missing');
  assert.doesNotMatch(missing.error.message, /bat-summary-persistence-|\.png|source_path|image_path/);
  const invalidated = await reopened.summaryRun(run.id);
  assert.equal(invalidated.ok, true);
  assert.equal(invalidated.value.windows[0].status, 'incomplete');
  assert.equal(invalidated.value.windows[0].image, null);
  assert.equal(invalidated.value.windows[0].error.code, 'summary_image_missing');
  const reopenedPid = reopened.pid;
  await reopened.stop();
  expectExited(reopenedPid);
});

test('review bridge bounds IDs, fields, source PTS and history cursors and authenticates every route', { timeout: 30000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bat-review-contract-'));
  const runtime = new BackendRuntime();
  t.after(async () => { await runtime.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const port = await availablePort();
  assert.equal((await runtime.start({ python, repoRoot, dataDir, port })).ok, true);
  const id = '00000000-0000-4000-8000-000000000000';
  const observation = { segment_id: id, start_pts: '0', end_pts: '1', category: 'uncertain',
    activity: null, count: null, uncertain: true, notes: 'Synthetic provisional note' };
  const change = { expected_revision: 0, actor: 'Synthetic reviewer', action: 'add_observation', observation };
  assert.equal(isReviewChange(change), true, 'Unknown count is a supported provisional value');
  assert.equal(isReviewChange({ ...change, observation: { ...observation, count: 0 } }), true);
  const oversized = { ...change, observation: { ...observation, notes: '\u0000'.repeat(2000) } };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > 8 * 1024, 'Escaped text tests the serialized request byte cap');
  for (const invalidID of ['../private', 'file:///private/source.mp4', 'https://example.invalid', 1, null]) {
    expectFailure(await runtime.getWindowReview(invalidID), 'invalid');
    expectFailure(await runtime.saveReview(invalidID, change), 'invalid');
    expectFailure(await runtime.reviewHistory(invalidID, 0), 'invalid');
  }
  for (const invalidChange of [
    { ...change, actor: '' }, { ...change, actor: '   ' }, { ...change, actor: 'x'.repeat(121) },
    { ...change, expected_revision: -1 }, { ...change, expected_revision: 1.5 },
    { ...change, expected_revision: true }, { ...change, expected_revision: 2 ** 31 },
    { ...change, expected_revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...change, path: '/private/source.mp4' }, { ...change, action: 'finalise' },
    { ...change, observation: { ...observation, source_path: '/private/source.mp4' } },
    { ...change, observation: { ...observation, segment_id: '../source' } },
    { ...change, observation: { ...observation, start_pts: 0 } },
    { ...change, observation: { ...observation, start_pts: '1.5' } },
    { ...change, observation: { ...observation, start_pts: '1e3' } },
    { ...change, observation: { ...observation, start_pts: '1', end_pts: '0' } },
    { ...change, observation: { ...observation, start_pts: '-9223372036854775809' } },
    { ...change, observation: { ...observation, end_pts: '9223372036854775808' } },
    { ...change, observation: { ...observation, category: 'species' } },
    { ...change, observation: { ...observation, category: ['bat'] } },
    { ...change, observation: { ...observation, activity: 'x'.repeat(121) } },
    { ...change, observation: { ...observation, count: true } },
    { ...change, observation: { ...observation, count: -1 } },
    { ...change, observation: { ...observation, count: 0.5 } },
    { ...change, observation: { ...observation, count: 100001 } },
    { ...change, observation: { ...observation, uncertain: 'true' } },
    { ...change, observation: { ...observation, notes: 'x'.repeat(2001) } },
    { ...change, observation: { ...observation, notes: '🦇'.repeat(2000) } },
    oversized,
    { expected_revision: 0, actor: 'Synthetic reviewer', action: 'delete_observation', observation_id: '../private' },
    { expected_revision: 0, actor: 'Synthetic reviewer', action: 'set_decision', decision: 'qa_reviewed', preview_id: null },
    { expected_revision: 0, actor: 'Synthetic reviewer', action: 'set_decision', decision: ['unreviewed'], preview_id: null },
    { expected_revision: 0, actor: 'Synthetic reviewer', action: 'set_decision', decision: 'unreviewed', preview_id: '../private' },
    { expected_revision: 0, actor: 'Synthetic reviewer', action: 'unable_to_assess', note: '' },
  ]) {
    assert.equal(isReviewChange(invalidChange), false, JSON.stringify(invalidChange));
    expectFailure(await runtime.saveReview(id, invalidChange), 'invalid');
  }
  for (const cursor of [-1, 0.5, true, '0', 2 ** 31, Number.MAX_SAFE_INTEGER + 1, '../private']) {
    assert.equal(isReviewCursor(cursor), false);
    expectFailure(await runtime.reviewHistory(id, cursor), 'invalid');
  }
  const unauthorized = new BackendClient(port, 'deliberately-incorrect-synthetic-token');
  expectFailure(await unauthorized.upgradeReviews(), 'unauthorized');
  expectFailure(await unauthorized.getWindowReview(id), 'unauthorized');
  expectFailure(await unauthorized.saveReview(id, change), 'unauthorized');
  expectFailure(await unauthorized.reviewHistory(id, 0), 'unauthorized');
  assert.deepEqual(await runtime.upgradeMedia(), { ok: true, value: { schema_version: 2 } });
  assert.deepEqual(await runtime.upgradeSummaries(), { ok: true, value: { schema_version: 3 } });
  expectFailure(await runtime.getWindowReview(id), 'review_schema_required');
  assert.deepEqual(await runtime.upgradeReviews(), { ok: true, value: { schema_version: 4 } });
  assert.deepEqual(await runtime.upgradeReviews(), { ok: true, value: { schema_version: 4 } });
  expectFailure(await runtime.getWindowReview(id), 'review_missing');
  expectFailure(await runtime.saveReview(id, change), 'review_missing');
  expectFailure(await runtime.reviewHistory(id, 0), 'review_missing');
});

test('real provisional review retains source spans and audit revisions across restart and source loss', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bat-review-persistence-'));
  const dataDir = path.join(directory, 'app-data');
  const first = new BackendRuntime();
  const reopened = new BackendRuntime();
  t.after(async () => {
    await Promise.all([first.stop(), reopened.stop()]);
    await rm(directory, { recursive: true, force: true });
  });
  const generated = spawnSync(python, ['-m', 'backend.tests.summary_fixtures', path.join(directory, 'originals')],
    { cwd: repoRoot, encoding: 'utf8', timeout: 15000 });
  assert.equal(generated.status, 0, generated.stderr);
  const source = JSON.parse(generated.stdout).quiet_9;
  const original = await readFile(source);
  assert.equal((await first.start({ python, repoRoot, dataDir })).ok, true);
  assert.equal((await first.upgradeMedia()).ok, true);
  const created = await first.createSession({ display_name: 'Synthetic review persistence', camera_ref: 'Synthetic camera' });
  assert.equal(created.ok, true);
  const sessionID = created.value.id;
  const imported = await first.importSelectedMedia(sessionID, [source]);
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal((await waitUntilTerminal(() => first.importStatus(imported.value.id), ['running'])).state, 'complete');
  assert.equal((await first.upgradeSummaries()).ok, true);
  const started = await first.startSummaries({ session_id: sessionID, window_seconds: 30 });
  assert.equal(started.ok, true, JSON.stringify(started));
  const run = await waitUntilTerminal(() => first.summaryRun(started.value.id), ['queued', 'running']);
  assert.equal(run.state, 'complete', JSON.stringify(run));
  assert.equal((await first.upgradeReviews()).ok, true);
  const segment = (await first.getMedia(sessionID)).value.segments[0];
  const windowID = run.windows[0].id;
  assert.equal(run.windows[0].stats.motion_pixels, 0);
  const initial = await first.getWindowReview(windowID);
  assert.equal(initial.ok, true, JSON.stringify(initial));
  assert.equal(initial.value.revision, 0);
  assert.equal(initial.value.decision, 'unreviewed');
  assert.deepEqual(initial.value.observations, []);
  const change = (revision, action, values) => ({ expected_revision: revision, actor: 'Synthetic reviewer', action, ...values });
  const observation = { segment_id: segment.id, start_pts: segment.metadata.first_pts, end_pts: segment.metadata.last_pts,
    category: 'uncertain', activity: null, count: null, uncertain: true, notes: 'Synthetic uncertainty; not a bat verdict.' };
  expectFailure(await first.saveReview(windowID, change(0, 'add_observation', { observation: {
    ...observation, start_pts: String(BigInt(observation.start_pts) - 1n),
  } })), 'review_invalid');
  const added = await first.saveReview(windowID, change(0, 'add_observation', { observation }));
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.value.revision, 1);
  assert.equal(added.value.decision, 'unreviewed', 'Saving an observation never completes first review');
  assert.equal(added.value.observations[0].count, null, 'Unknown count must remain unknown');
  const observationID = added.value.observations[0].id;
  const withoutPreview = await first.saveReview(windowID, change(1, 'set_decision', {
    decision: 'reviewed_with_observations', preview_id: null,
  }));
  expectFailure(withoutPreview, 'review_unavailable');
  const updated = await first.saveReview(windowID, change(1, 'update_observation', { observation_id: observationID,
    observation: { ...observation, notes: 'Synthetic revised provisional note.' } }));
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(updated.value.revision, 2);
  const preview = await first.startPreview({ segment_id: segment.id, source_pts: segment.metadata.first_pts });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const readyPreview = await waitUntilTerminal(() => first.previewStatus(preview.value.id), ['running']);
  assert.equal(readyPreview.state, 'ready', JSON.stringify(readyPreview));
  const reviewed = await first.saveReview(windowID, change(2, 'set_decision', {
    decision: 'reviewed_with_observations', preview_id: preview.value.id,
  }));
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  assert.equal(reviewed.value.revision, 3);
  assert.equal(reviewed.value.effective_decision, 'reviewed_with_observations');
  expectFailure(await first.saveReview(windowID, change(2, 'delete_observation', { observation_id: observationID })), 'review_conflict');
  const deleted = await first.saveReview(windowID, change(3, 'delete_observation', { observation_id: observationID }));
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  assert.equal(deleted.value.revision, 4);
  assert.equal(deleted.value.decision, 'unreviewed');
  assert.deepEqual(deleted.value.observations, []);
  const clear = await first.saveReview(windowID, change(4, 'set_decision', {
    decision: 'reviewed_no_discernible_event', preview_id: preview.value.id,
  }));
  assert.equal(clear.ok, true, JSON.stringify(clear));
  assert.equal(clear.value.revision, 5);
  const history = await first.reviewHistory(windowID, 0);
  assert.equal(history.ok, true, JSON.stringify(history));
  assert.deepEqual(history.value.events.map(event => event.revision), [1, 2, 3, 4, 5]);
  assert.deepEqual(history.value.events.map(event => event.action),
    ['add_observation', 'update_observation', 'set_decision', 'delete_observation', 'set_decision']);
  assert.ok(history.value.events.every(event => event.actor === 'Synthetic reviewer' && Number.isFinite(Date.parse(event.utc))));
  assert.ok(history.value.events.every(event => event.run_id === run.id && event.window_id === windowID &&
    event.segment_id === segment.id && event.source_sha256 === segment.metadata.sha256));
  assert.doesNotMatch(JSON.stringify(history.value), /source_path|image_path|bat-review-persistence-/);
  const firstPID = first.pid;
  await first.stop();
  expectExited(firstPID);
  assert.equal((await reopened.start({ python, repoRoot, dataDir })).ok, true);
  assert.deepEqual(await reopened.getWindowReview(windowID), clear);
  assert.deepEqual(await reopened.reviewHistory(windowID, 0), history);
  const reopenedRun = await reopened.summaryRun(run.id);
  assert.equal(reopenedRun.ok, true, JSON.stringify(reopenedRun));
  assert.equal(reopenedRun.value.review_progress.total, 1);
  assert.equal(reopenedRun.value.review_progress.reviewed, 1);
  assert.deepEqual(await readFile(source), original, 'Manual review and previews preserve original media bytes');
  await rm(source);
  const unavailableReview = await reopened.getWindowReview(windowID);
  assert.equal(unavailableReview.ok, true, JSON.stringify(unavailableReview));
  assert.equal(unavailableReview.value.decision, 'reviewed_no_discernible_event', 'Historical manual decision remains recorded');
  assert.equal(unavailableReview.value.effective_decision, 'unreviewed');
  assert.equal(unavailableReview.value.needs_reverification, true);
  expectFailure(await reopened.saveReview(windowID, change(5, 'set_decision', {
    decision: 'reviewed_no_discernible_event', preview_id: preview.value.id,
  })), 'review_unavailable');
  assert.deepEqual(await reopened.reviewHistory(windowID, 0), history, 'Revalidation and rejected saves cannot mutate append-only history');
});

test('review transport returns fixed messages instead of backend exception text or private paths', { timeout: 10000 }, async () => {
  const server = httpServer((_request, response) => {
    response.writeHead(409, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ detail: { code: 'review_conflict', message: 'Traceback at /private/synthetic/review.sqlite3' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new BackendClient(server.address().port, 'synthetic-error-redaction-token-only');
    const result = await client.getWindowReview('00000000-0000-4000-8000-000000000000');
    expectFailure(result, 'review_conflict');
    assert.doesNotMatch(result.error.message, /private|sqlite3|Traceback/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('invalid startup configuration is rejected before launching a backend', { timeout: 15000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bat-config-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const missingPython = path.join(dataDir, 'missing-python');

  for (const unsafeDir of ['relative-data', repoRoot, path.join(repoRoot, 'private'), path.join(repoRoot, '..private')]) {
    await t.test(`rejects data directory ${path.isAbsolute(unsafeDir) ? path.relative(repoRoot, unsafeDir) || '(repository root)' : unsafeDir}`, async () => {
      const runtime = new BackendRuntime();
      t.after(() => runtime.stop());
      const result = await runtime.start({ python: missingPython, repoRoot, dataDir: unsafeDir });
      expectFailure(result, 'unavailable');
      assert.match(result.error.message, /absolute directory outside the repository/);
      assert.equal(runtime.pid, undefined);
    });
  }

  for (const port of [0, -1, 65536, 1.5]) {
    await t.test(`rejects invalid port ${port}`, async () => {
      const runtime = new BackendRuntime();
      t.after(() => runtime.stop());
      const result = await runtime.start({ python: missingPython, repoRoot, dataDir, port });
      expectFailure(result, 'unavailable');
      assert.match(result.error.message, /valid TCP port/);
      assert.equal(runtime.pid, undefined);
    });
  }
});

test('missing Python produces an explicit startup failure and leaves no child', { timeout: 10000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bat-python-'));
  const runtime = new BackendRuntime();
  t.after(async () => {
    await runtime.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  const result = await runtime.start({ python: path.join(dataDir, 'missing-python'), repoRoot, dataDir });
  expectFailure(result, 'unavailable');
  assert.match(result.error.message, /could not start.*Python/i);
  assert.equal(runtime.pid, undefined);
  expectFailure(await runtime.health(), 'unavailable');
});

test('data directory symlink into the repository is rejected without creating app data', { timeout: 10000 }, async t => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bat-symlink-'));
  const alias = path.join(tempDir, 'checkout-alias');
  const directoryName = `rejected-app-data-${path.basename(tempDir)}`;
  const actualDataDir = path.join(repoRoot, directoryName);
  const runtime = new BackendRuntime();
  t.after(async () => {
    await runtime.stop();
    await rm(tempDir, { recursive: true, force: true });
    await rm(actualDataDir, { recursive: true, force: true });
  });
  try {
    await symlink(repoRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('This Windows environment does not permit creating a directory symlink');
      return;
    }
    throw error;
  }

  await assert.rejects(access(actualDataDir), { code: 'ENOENT' });
  const result = await runtime.start({ python, repoRoot, dataDir: path.join(alias, directoryName) });
  expectFailure(result, 'unavailable');
  assert.match(result.error.message, /absolute directory outside the repository/);
  assert.equal(runtime.pid, undefined);
  await assert.rejects(access(actualDataDir), { code: 'ENOENT' });
});

test('stop during port allocation cancels startup without launching a backend', { timeout: 10000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bat-cancel-start-'));
  const runtime = new BackendRuntime();
  t.after(async () => {
    await runtime.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const starting = runtime.start({ python, repoRoot, dataDir });
  await runtime.stop();
  const result = await starting;
  expectFailure(result, 'unavailable');
  assert.equal(runtime.pid, undefined);
  expectFailure(await runtime.health(), 'unavailable');
  assert.deepEqual(await readdir(dataDir), []);
});


test('incompatible SQLite databases fail with safe actionable messages', { timeout: 45000 }, async t => {
  for (const scenario of ['future-schema', 'unversioned']) {
    await t.test(scenario, async t => {
      const dataDir = await mkdtemp(path.join(tmpdir(), 'bat-invalid-db-'));
      const runtime = new BackendRuntime();
      t.after(async () => {
        await runtime.stop();
        await rm(dataDir, { recursive: true, force: true });
      });
      const dbPath = path.join(dataDir, 'bat_innovation.sqlite3');
      const prepare = scenario === 'future-schema'
        ? "db.execute('PRAGMA user_version=99')"
        : "db.execute('CREATE TABLE legacy (id INTEGER)')";
      const seeded = spawnSync(python, [
        '-c', 'import sqlite3, sys; db=sqlite3.connect(sys.argv[1]); ' +
          prepare + '; db.commit(); db.close()', dbPath,
      ], { cwd: repoRoot, encoding: 'utf8' });
      assert.equal(seeded.status, 0, 'Synthetic test database must be created successfully');
      const original = await readFile(dbPath);

      const result = await runtime.start({ python, repoRoot, dataDir });
      expectFailure(result, 'unavailable');
      assert.match(result.error.message, /local database/i);
      assert.match(result.error.message, /unsupported schema|unrecognised schema/i);
      assert.doesNotMatch(result.error.message, /Traceback|File "|RuntimeError|sqlite3\.|bat-invalid-db-/i);
      assert.equal(runtime.pid, undefined, 'A refused database must not leave a backend running');
      assert.deepEqual(await readFile(dbPath), original, 'Refused databases must remain unchanged');
    });
  }
});

test('import limits refusal stays specific and strips backend paths at the desktop boundary', async () => {
  const id = '00000000-0000-4000-8000-000000000000';
  const server = httpServer((req, response) => {
    assert.equal(req.url, '/api/media/import');
    assert.equal(req.method, 'POST');
    response.writeHead(409, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ detail: { code: 'import_limits_unavailable', message: 'Traceback at C:\\private\\synthetic.mp4' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new BackendClient(server.address().port, 'synthetic-redaction-token');
    const result = await client.importSelectedMedia(id, [path.join(tmpdir(), 'synthetic', 'missing.mp4')]);
    expectFailure(result, 'import_limits_unavailable');
    assert.match(result.error.message, /Media import process limits are unavailable/);
    assert.doesNotMatch(result.error.message, /private|Traceback|\.mp4/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
