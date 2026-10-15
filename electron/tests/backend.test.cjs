const assert = require('node:assert/strict');
const { access, mkdtemp, readdir, rm, symlink } = require('node:fs/promises');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { BackendClient, BackendRuntime } = require('../dist/backend.js');

const repoRoot = path.resolve(__dirname, '../..');
const python = process.env.BAT_PYTHON || 'python';

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

test('real backend persists sessions across runtime restart and rejects unauthorized access', { timeout: 45000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bat-runtime-'));
  const first = new BackendRuntime();
  const reopened = new BackendRuntime();
  t.after(async () => {
    await Promise.all([first.stop(), reopened.stop()]);
    await rm(dataDir, { recursive: true, force: true });
  });

  const port = await availablePort();
  const options = { python, repoRoot, dataDir, port };
  const [ready, sameLaunch] = await Promise.all([first.start(options), first.start(options)]);
  assert.deepEqual(ready, { ok: true, value: { status: 'ok', storage: 'ready', media_tools: 'ready' } });
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
  expectFailure(await first.health(), 'unavailable');
  expectFailure(await unauthorized.health(), 'unavailable');

  const restarted = await reopened.start({ python, repoRoot, dataDir });
  assert.deepEqual(restarted, ready);
  assert.deepEqual(await reopened.listSessions(), { ok: true, value: [created.value] });
  const reopenedPid = reopened.pid;
  await reopened.stop();
  expectExited(reopenedPid);
  assert.equal(reopened.pid, undefined);
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
