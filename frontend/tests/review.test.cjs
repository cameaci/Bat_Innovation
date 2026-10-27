const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const repoRoot = path.resolve(__dirname, '../..');
function expectFailure(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
}

let rendererModuleNumber = 0;
async function rendererModule(name) {
  // Compile the real renderer helper with the already-pinned TypeScript compiler.
  // Deferred functions below exercise scheduling, not simulated media decoding.
  const ts = require('typescript');
  const source = await readFile(path.join(repoRoot, `frontend/src/${name}.ts`), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
  } });
  return import('data:text/javascript;base64,' + Buffer.from(outputText + `\n// isolated test ${rendererModuleNumber++}`).toString('base64'));
}
const rendererBinary = () => rendererModule('binary');
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const bytesResult = () => ({ ok: true, value: { bytes: new Uint8Array([1]) } });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('renderer serializes PNG and WebM reads with preview priority and FIFO thumbnails', async () => {
  const { readMediaBytes } = await rendererBinary();
  const gate = deferred();
  const calls = [];
  let active = 0, peak = 0;
  const read = (name, wait = Promise.resolve()) => async () => {
    calls.push(name); active += 1; peak = Math.max(peak, active);
    await wait; active -= 1;
    return bytesResult();
  };
  const first = readMediaBytes(read('first PNG', gate.promise));
  const a = readMediaBytes(read('thumbnail A'));
  const b = readMediaBytes(read('thumbnail B'));
  const selected = readMediaBytes(read('selected PNG'), { priority: 1 });
  const preview = readMediaBytes(read('preview WebM'), { priority: 2 });
  await nextTurn();
  assert.deepEqual(calls, ['first PNG']);
  gate.resolve();
  assert.ok((await Promise.all([first, a, b, selected, preview])).every(result => result.ok));
  assert.deepEqual(calls, ['first PNG', 'preview WebM', 'selected PNG', 'thumbnail A', 'thumbnail B']);
  assert.equal(peak, 1);
});

test('replaced gallery views cancel queued reads without invoking their media route', async () => {
  const { readMediaBytes } = await rendererBinary();
  const gate = deferred();
  const first = readMediaBytes(async () => { await gate.promise; return bytesResult(); });
  const controller = new AbortController();
  let called = false;
  const obsolete = readMediaBytes(async () => { called = true; return bytesResult(); }, { signal: controller.signal });
  controller.abort();
  expectFailure(await obsolete, 'cancelled');
  gate.resolve();
  assert.equal((await first).ok, true);
  await nextTurn();
  assert.equal(called, false);
});

test('aborting an inflight renderer read keeps the reservation until its real transfer settles', async () => {
  const { readMediaBytes } = await rendererBinary();
  const gate = deferred();
  const controller = new AbortController();
  let nextCalled = false;
  const first = readMediaBytes(async () => { await gate.promise; return bytesResult(); }, { signal: controller.signal });
  await nextTurn();
  controller.abort();
  const next = readMediaBytes(async () => { nextCalled = true; return bytesResult(); }, { priority: 2 });
  await nextTurn();
  assert.equal(nextCalled, false);
  gate.resolve();
  expectFailure(await first, 'cancelled');
  assert.equal((await next).ok, true);
});

test('renderer releases its media reservation after thrown, rejected and missing-bridge reads', async () => {
  const { readMediaBytes } = await rendererBinary();
  const thrown = readMediaBytes(() => { throw new Error('Synthetic transport failure'); });
  const rejected = readMediaBytes(() => Promise.reject(new Error('Synthetic rejected read')));
  const missing = readMediaBytes(() => undefined);
  const final = readMediaBytes(async () => bytesResult());
  for (const result of await Promise.all([thrown, rejected, missing])) expectFailure(result, 'unavailable');
  assert.equal((await final).ok, true);
});

test('renderer bounds queued media work and a cancelled card frees a pending slot', async () => {
  const { readMediaBytes, MAX_QUEUED_BINARY_READS } = await rendererBinary();
  assert.equal(MAX_QUEUED_BINARY_READS, 16);
  const gate = deferred();
  const first = readMediaBytes(async () => { await gate.promise; return bytesResult(); });
  const controller = new AbortController();
  const queued = Array.from({ length: MAX_QUEUED_BINARY_READS }, (_, index) => readMediaBytes(async () => bytesResult(), index === 0 ? { signal: controller.signal } : {}));
  let overflowCalled = false;
  expectFailure(await readMediaBytes(async () => { overflowCalled = true; return bytesResult(); }), 'media_busy');
  controller.abort();
  expectFailure(await queued[0], 'cancelled');
  const replacement = readMediaBytes(async () => bytesResult());
  gate.resolve();
  assert.ok((await Promise.all([first, ...queued.slice(1), replacement])).every(result => result.ok));
  assert.equal(overflowCalled, false);
});

test('an already cancelled view never starts a renderer media operation', async () => {
  const { readMediaBytes } = await rendererBinary();
  const controller = new AbortController();
  controller.abort();
  let called = false;
  expectFailure(await readMediaBytes(async () => { called = true; return bytesResult(); }, { signal: controller.signal }), 'cancelled');
  assert.equal(called, false);
  assert.equal((await readMediaBytes(async () => bytesResult())).ok, true);
});

function sourceEvidence() {
  const interval = { start_pts: { num: '9007199254740993', den: '1' }, end_pts: { num: '9007199254741003', den: '1' } };
  const timeBase = { num: '1', den: '90000' };
  const selected = { id: 'window-a', run_id: 'run-a', segment_id: 'segment-a', source_sha256: 'original-sha', source_state: 'ready', time_base: timeBase, interval };
  const binding = { window_id: 'window-a', run_id: 'run-a', segment_id: 'segment-a', source_sha256: 'original-sha', time_base: timeBase, interval, source_first_pts: '9007199254740993', source_last_pts: '9007199254741010', source_end_pts: { num: '9007199254741011', den: '1' } };
  const frame = { windowID: 'window-a', previewID: 'preview-a', segmentID: 'segment-a', sourceSHA256: 'original-sha', timeBase, sourcePTS: '9007199254740994' };
  return { selected, binding, frame };
}

test('displayed source PTS retains integer precision beyond Number safe range', async () => {
  const { displayedPTSFor } = await rendererModule('sourceFrame');
  const { selected, binding, frame } = sourceEvidence();
  assert.equal(displayedPTSFor(frame, selected, binding, 'preview-a', 'start'), '9007199254740994');
  assert.equal(displayedPTSFor({ ...frame, sourcePTS: '9007199254740993' }, selected, binding, 'preview-a', 'start'), '9007199254740993');
  assert.equal(displayedPTSFor({ ...frame, sourcePTS: '9007199254740992' }, selected, binding, 'preview-a', 'start'), null);
});

test('displayed PTS checks rational half-open window bounds without rounding or inferred ticks', async () => {
  const { displayedPTSFor } = await rendererModule('sourceFrame');
  const { selected, binding, frame } = sourceEvidence();
  const interval = { start_pts: { num: '18014398509481987', den: '2' }, end_pts: { num: '9007199254741000', den: '1' } };
  selected.interval = binding.interval = interval;
  assert.equal(displayedPTSFor({ ...frame, sourcePTS: '9007199254740993' }, selected, binding, 'preview-a', 'start'), null);
  assert.equal(displayedPTSFor(frame, selected, binding, 'preview-a', 'start'), frame.sourcePTS);
  const boundary = { ...frame, sourcePTS: '9007199254741000' };
  assert.equal(displayedPTSFor(boundary, selected, binding, 'preview-a', 'start'), null);
  assert.equal(displayedPTSFor(boundary, selected, binding, 'preview-a', 'end'), boundary.sourcePTS);
  assert.equal(displayedPTSFor({ ...boundary, sourcePTS: '9007199254741001' }, selected, binding, 'preview-a', 'end'), null);
});

test('displayed PTS requires the same window, run, original source, timebase and live preview', async () => {
  const { displayedPTSFor } = await rendererModule('sourceFrame');
  const { selected, binding, frame } = sourceEvidence();
  for (const mismatch of [{ windowID: 'other' }, { previewID: 'other' }, { segmentID: 'other' }, { sourceSHA256: 'changed' }, { timeBase: { num: '1', den: '1000' } }]) {
    assert.equal(displayedPTSFor({ ...frame, ...mismatch }, selected, binding, 'preview-a', 'start'), null);
  }
  for (const mismatch of [{ run_id: 'other' }, { window_id: 'other' }, { source_sha256: 'changed' }]) {
    assert.equal(displayedPTSFor(frame, selected, { ...binding, ...mismatch }, 'preview-a', 'start'), null);
  }
  assert.equal(displayedPTSFor(frame, { ...selected, source_state: 'changed_source' }, binding, 'preview-a', 'start'), null);
  assert.equal(displayedPTSFor(frame, selected, binding, null, 'start'), null);
  assert.equal(displayedPTSFor(null, selected, binding, 'preview-a', 'start'), null);
  assert.equal(displayedPTSFor({ ...frame, timeBase: { num: '2', den: '180000' } }, selected, binding, 'preview-a', 'start'), frame.sourcePTS);
});

test('unknown final source timing never produces a fabricated displayed-frame endpoint', async () => {
  const { displayedPTSFor } = await rendererModule('sourceFrame');
  const { selected, binding, frame } = sourceEvidence();
  selected.interval = binding.interval = { ...selected.interval, end_pts: null };
  binding.source_end_pts = null;
  const last = { ...frame, sourcePTS: binding.source_last_pts };
  assert.equal(displayedPTSFor(last, selected, binding, 'preview-a', 'start'), null);
  assert.equal(displayedPTSFor(last, selected, binding, 'preview-a', 'end'), binding.source_last_pts);
  assert.equal(displayedPTSFor({ ...last, sourcePTS: '9007199254741011' }, selected, binding, 'preview-a', 'end'), null);
});

test('malformed or out-of-range displayed source evidence is ineligible', async () => {
  const { displayedPTSFor } = await rendererModule('sourceFrame');
  const { selected, binding, frame } = sourceEvidence();
  for (const sourcePTS of ['1.5', '9007199254740994.0', '01', '9223372036854775808', '-9223372036854775809']) {
    assert.equal(displayedPTSFor({ ...frame, sourcePTS }, selected, binding, 'preview-a', 'start'), null);
  }
  assert.equal(displayedPTSFor({ ...frame, timeBase: { num: '1', den: '0' } }, selected, binding, 'preview-a', 'start'), null);
  assert.equal(displayedPTSFor(frame, selected, { ...binding, interval: { ...binding.interval, start_pts: { num: '0', den: '1' } } }, 'preview-a', 'start'), null);
});

test('setup guide measures a clicked detection and warns about badly placed gates', async () => {
  const guide = await rendererModule('lib/setupGuide');
  const result = { detections: [{ pts: '400', accepted: [[100, 100, 110, 110], [300, 50, 304, 54]], rejected: [], measures: [[78, 14.2, 1], [12, 30, -1]] }] };
  const measured = guide.measureAt(result, 400, [104, 106], 12);
  assert.deepEqual(measured, { area: 78, contrast: 14.2, polarity: 'light', targetPx: 10 });
  assert.equal(guide.measureAt(result, 440, [104, 106], 12), null, 'only the displayed frame is measured');
  assert.equal(guide.measureAt(result, 400, [600, 600], 12), null, 'a click far from any detection measures nothing');
  const settings = { target_px: 12, polarity: 'both', threshold: 7, target_speed: 4 };
  assert.deepEqual(guide.applyMeasured(settings, measured), { ...settings, target_px: 10, polarity: 'light', threshold: 7 });
  assert.equal(guide.applyMeasured(settings, { ...measured, contrast: 6.4 }).threshold, 3);
  const frame = { frame_w: 640, frame_h: 360 };
  const across = { ...frame, kind: 'line', points: [[320, 20], [320, 340]] };
  const rightwards = Array.from({ length: 10 }, () => [100, 3]);
  assert.deepEqual(guide.gateWarnings(across, [], rightwards), []);
  assert.match(guide.gateWarnings({ ...frame, kind: 'line', points: [[20, 180], [600, 180]] }, [], rightwards).join(' '), /along this line/);
  assert.match(guide.gateWarnings({ ...frame, kind: 'rect', points: [[2, 2], [200, 2], [200, 200], [2, 200]] }, [], []).join(' '), /frame edge/);
  assert.match(guide.gateWarnings(across, [[[300, 150], [340, 150], [340, 190], [300, 190]]], []).join(' '), /excluded zone/);
  assert.equal(guide.testWarnings({ frames: 100, repeated_frames: 32, gain_jumps: 1, limit_frames: 0, static_detections: 0 }).length, 2);
});

test('the declared recording clock is shown in its own offset', async () => {
  const time = await rendererModule('lib/time');
  assert.equal(time.anchoredClock('2026-08-10T21:08:13.584+01:00', 1.5), '21:08:15.084');
  assert.equal(time.anchoredClock('2026-08-10T23:59:59.900Z', 0.2), '00:00:00.100');
  assert.equal(time.anchoredClock('not a time', 1), null);
});

test('the track table joins labels and gate crossings, filters and selects by area', async () => {
  const table = await rendererModule('lib/trackTable');
  const segment = (id, first) => ({ id, metadata: { time_base: { num: '1', den: '1000' }, first_pts: String(first) } });
  const segments = [segment('s1', 0), segment('s2', 5000)];
  const candidate = (id, segment_id, index, first, last, quality, points = 10) => ({ track_id: id, segment_id, track_index: index, first_pts: String(first),
    last_pts: String(last), point_count: points, quality, window_id: null, revision: 0, decision: null });
  const candidates = [candidate('b', 's2', 0, 6000, 6500, 'uncertain', 4), candidate('a', 's1', 1, 2000, 4000, 'coherent', 30), candidate('n', 's1', 0, 1000, 1100, 'noise')];
  const labels = { events: [], custom: [], categories: ['exit'], tracks: { a: { category: 'exit', species: 'Pipistrellus pygmaeus', comment: '', actor: 'R', utc: '', event_id: 'e' } } };
  const crossings = [{ track_id: 'a', direction: 'A_to_B' }, { track_id: 'b', direction: 'B_to_A' }];
  const rows = table.trackRows(candidates, labels, crossings, 'B_to_A', segments);
  assert.deepEqual(rows.map(row => row.id), ['n', 'a', 'b'], 'survey order: video, then time');
  assert.deepEqual(rows.map(row => row.crossings), [[], ['out'], ['in']]);
  assert.equal(rows[1].seconds, 2);
  assert.equal(rows[2].start, 1, 'seconds from the start of its own video');
  assert.equal(rows[1].category, 'exit');
  const all = { quality: 'all', label: 'all', crossed: false, video: null };
  assert.deepEqual(table.filterRows(rows, { ...all, label: 'unlabelled' }, 'time').map(row => row.id), ['n', 'b']);
  assert.deepEqual(table.filterRows(rows, { ...all, crossed: true, video: 's1' }, 'time').map(row => row.id), ['a']);
  assert.deepEqual(table.filterRows(rows, all, 'points').map(row => row.id), ['a', 'n', 'b']);
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(table.inside([5, 5], square), true);
  assert.equal(table.inside([15, 5], square), false);
  assert.deepEqual(table.tracksInArea([{ id: 'in', x: [20, 5], y: [20, 5] }, { id: 'out', x: [20, 30], y: [5, 5] }], square), ['in']);
  assert.equal(table.categoryName('fly_by'), 'fly-by');
});

test('the emergence profile has a column per minute of each video and a running net', async () => {
  const profile = await rendererModule('lib/profile');
  const layer = { bins: [{ segment_id: 'v1', minute: 1, entered: 1, exited: 4 }, { segment_id: 'v2', minute: 0, entered: 0, exited: 2 }],
    first_exit: null, last_exit: null, peak_minute: null, peak_exits_per_second: 0 };
  const columns = profile.profileColumns(layer, [{ id: 'v1', minutes: 3 }, { id: 'v2', minutes: 1 }]);
  assert.deepEqual(columns.map(column => [column.video, column.minute, column.exited, column.entered, column.net]),
    [[1, 0, 0, 0, 0], [1, 1, 4, 1, 3], [1, 2, 0, 0, 3], [2, 0, 2, 0, 5]]);
  assert.equal(columns.reduce((sum, column) => sum + column.exited, 0), 6, 'columns add up to the layer');
  // The declared clock is stored in UTC; the typed sunset carries its own offset.
  assert.equal(profile.sunsetMinute('2026-08-10T19:50:30Z', '21:04+01:00'), 13.5);
  assert.equal(profile.sunsetMinute('2026-08-10T23:10:00Z', '21:04+01:00'), -186, 'a clock after midnight refers to the evening before');
  assert.equal(profile.sunsetMinute('2026-08-10T19:50:30Z', '21:04'), null, 'no offset, no position');
  assert.equal(profile.sunsetMinute('not a clock', '21:04+01:00'), null);
});

test('the evidence report has every section, the provisional banner and escapes every entry', async () => {
  const report = await rendererModule('lib/report');
  const segment = { id: 's1', position: 0, continuity: 'unknown', continuity_provenance: null, source_state: 'ready', modality: 'active_ir',
    metadata: { filename: '<img src=x onerror=1>.mp4', sha256: 'a'.repeat(64), width: 128, height: 96, time_base: { num: '1', den: '1000' }, first_pts: '0',
      elapsed_end: { num: '125', den: '1' }, elapsed_last_time: { num: '124', den: '1' } } };
  const layer = { bins: [{ segment_id: 's1', minute: 0, entered: 1, exited: 3 }], first_exit: { segment_id: 's1', seconds: 12 }, last_exit: { segment_id: 's1', seconds: 50 },
    peak_minute: { segment_id: 's1', minute: 0, exited: 3 }, peak_exits_per_second: 1 };
  const counts = { gate: { id: 'g1', name: 'Gable <b>', kind: 'line', points: [[64, 0], [64, 96]], frame_w: 128, frame_h: 96, revision: 2, entry_direction: 'B_to_A', hysteresis_px: 3 },
    algorithm_version: 'gate-hysteresis-v2-m2', invalid_spans: [], profile: { layers: { algorithm: layer, reviewer: layer, qa: null }, sunset: { sunset: '21:04+01:00', source: 'almanac', actor: 'R', revision: 1, utc: '' },
      clock_segment_id: null, minutes_after_sunset: null, note: '' },
    layers: { algorithm: { entered: 1, exited: 3, net: 2, coherent: 4, uncertain: 1 }, reviewer: { entered: 1, exited: 3, net: 2, state: 'accepted', unresolved: 0, accepted: { actor: 'R', current: true } }, qa: null } };
  const html = report.reportHTML({ generatedUTC: '2026-10-28T00:00:00Z', session: { display_name: 'Survey "1"', camera_ref: 'cam' }, segments: [segment], anchor: null,
    review: { total: 5, reviewed: 2, unreviewed: 3 }, windows: 5, tracking: { id: 't', algorithm_version: 'tracks-v3', parameter_hash: 'h', parameters: { settings: {} }, track_counts: { s1: 1 }, finished_at_utc: 'x' },
    counts: [counts], sampleChecks: {}, labels: { events: [], custom: [], categories: [], tracks: { k: { category: 'exit', species: 'Myotis <i>', comment: '', actor: 'R', utc: '', event_id: 'e' } } },
    tracks: [{ segmentID: 's1', shown: 1, total: 1, paths: [{ index: 0, uncertain: false, points: [[1, 2], [3, 4]] }] }] });
  for (const name of report.REPORT_SECTIONS) assert.ok(html.includes(`<h2>${name}</h2>`), name);
  assert.match(html, /PROVISIONAL - NOT ECOLOGICALLY FINALISED/);
  assert.ok(!html.includes('<img') && !html.includes('Gable <b>') && html.includes('Gable &lt;b&gt;') && !html.includes('<i>') && !/<script/i.test(html), 'entries are escaped and the page has no script');
  assert.match(html, /2 of 5 planned windows have a first review/);
  assert.match(html, /Sunset 21:04\+01:00/);
  assert.match(html, /3 exits in minute 1 of video 1/);
});
