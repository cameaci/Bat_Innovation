import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import type { BatAPI, MediaSegment } from '../src/contracts';
import { cleanup, launch, quit, type RunningShell } from './shell-helpers';

type FixtureName = 'cfr_mp4' | 'nonzero_mts' | 'irregular_mp4' | 'short_mp4' | 'long_mp4';
type MarkerPaths = Record<FixtureName, string>;

function generateMarkers(directory: string): MarkerPaths {
  const result = spawnSync(process.env.BAT_PYTHON ?? 'python', [
    'backend/tests/preview_fixtures.py', directory,
  ], { cwd: resolve('.'), encoding: 'utf8', timeout: 45_000 });
  expect(result.status, result.stderr || 'Marker generation failed').toBe(0);
  return JSON.parse(result.stdout) as MarkerPaths;
}

async function hashes(paths: MarkerPaths): Promise<string[]> {
  return Promise.all(Object.values(paths).map(async (path) => createHash('sha256').update(await readFile(path)).digest('hex')));
}

async function importedMarkers(shell: RunningShell, paths: MarkerPaths): Promise<MediaSegment[]> {
  const { page } = shell;
  await page.getByRole('button', { name: 'Create session', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect media', exact: true }).click();
  await page.getByRole('button', { name: 'Upgrade media storage', exact: true }).click();
  // Only the OS selection boundary is replaced; the real imported IDs feed previews.
  await shell.application.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: files })) as typeof dialog.showOpenDialog;
  }, Object.values(paths));
  await page.getByRole('button', { name: 'Choose original videos', exact: true }).click();
  await expect(page.getByRole('article', { name: /marker-long\.mp4/ })).toBeVisible();
  const inventory = await page.evaluate(async () => {
    const api = (window as unknown as { batAPI: BatAPI }).batAPI;
    const sessions = await api.listSessions();
    if (!sessions.ok) return sessions;
    return api.getMedia(sessions.value[0]!.id);
  });
  expect(inventory.ok).toBe(true);
  if (!inventory.ok || !('segments' in inventory.value)) throw new Error('Real marker inventory was not available.');
  expect(inventory.value.clock_anchor).toBeNull();
  return inventory.value.segments;
}

async function openPreview(shell: RunningShell, filename: string): Promise<void> {
  await shell.page.getByRole('article', { name: new RegExp(filename.replaceAll('.', '\\.')) })
    .getByRole('button', { name: 'Preview source', exact: true }).click();
  await expect(shell.page.getByRole('heading', { name: 'Source preview', exact: true })).toBeVisible();
}

async function closePreview(shell: RunningShell): Promise<void> {
  await shell.page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await expect(shell.page.getByRole('heading', { name: 'Source preview', exact: true })).not.toBeVisible();
}

async function displayedPTS(shell: RunningShell): Promise<string | null> {
  return shell.page.getByText('Displayed source PTS', { exact: true })
    .evaluate((label) => label.nextElementSibling?.textContent ?? null);
}

function rationalText(numerator: number, denominator: number): string {
  let left = Math.abs(numerator), right = denominator;
  while (right) [left, right] = [right, left % right];
  return `${numerator / left}/${denominator / left}`;
}

async function timingValue(shell: RunningShell, label: string): Promise<string | null> {
  return shell.page.getByText(label, { exact: true }).evaluate((element) => element.nextElementSibling?.textContent ?? null);
}

async function marker(video: Locator, seekSeconds?: number): Promise<{ index: number; duration: number; paused: boolean }> {
  return video.evaluate(async (element, seek) => {
    const player = element as HTMLVideoElement;
    if (player.readyState < 2) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('Preview frame did not load.')), 5000);
        player.addEventListener('loadeddata', () => { window.clearTimeout(timer); resolve(); }, { once: true });
        player.addEventListener('error', () => { window.clearTimeout(timer); reject(new Error('Browser preview decode failed.')); }, { once: true });
      });
    }
    if (seek !== undefined && Math.abs(player.currentTime - seek) > 0.000001) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('Browser preview seek did not finish.')), 5000);
        player.addEventListener('seeked', () => { window.clearTimeout(timer); resolve(); }, { once: true });
        player.currentTime = seek;
      });
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const canvas = document.createElement('canvas');
    canvas.width = player.videoWidth;
    canvas.height = player.videoHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(player, 0, 0);
    let index = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      if (context.getImageData(15 + bit * 20, 60, 1, 1).data[0]! > 128) index |= 1 << bit;
    }
    return { index, duration: player.duration, paused: player.paused };
  }, seekSeconds);
}

async function requestMarker(shell: RunningShell, sourcePTS: string, expectedIndex: number): Promise<void> {
  await shell.page.getByLabel('Source PTS', { exact: true }).fill(sourcePTS);
  await shell.page.getByRole('button', { name: 'Create preview', exact: true }).click();
  await expect(shell.page.getByText('Preview ready', { exact: true })).toBeVisible();
  const video = shell.page.getByLabel('Derived source preview', { exact: true });
  await expect(video).toBeVisible();
  const decoded = await marker(video);
  expect(decoded.index, `Clicked source PTS ${sourcePTS} must display its actual marker`).toBe(expectedIndex);
  expect(decoded.paused).toBe(true);
  expect(decoded.duration).toBeGreaterThan(0);
  expect(decoded.duration).toBeLessThanOrEqual(2.001);
}

test.skip(process.platform !== 'linux', 'Preview resource guards and Electron lifecycle are currently verified on Linux only.');

test('imported source PTS displays real marker frames with exact VFR and nonzero-origin mapping', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-preview-e2e-'));
  const paths = generateMarkers(join(directory, 'originals'));
  const originals = await hashes(paths);
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    await importedMarkers(shell, paths);
    for (const entry of [
      { filename: 'marker-cfr.mp4', origin: 0, step: 512, denominator: 12800, indices: [0, 4, 7] },
      { filename: 'marker-nonzero.mts', origin: 129600, step: 3600, denominator: 90000, indices: [0, 4, 7] },
      { filename: 'marker-irregular.mp4', origin: 0, step: 512, denominator: 12800, indices: [0, 4, 7] },
      { filename: 'marker-short.mp4', origin: 0, step: 512, denominator: 12800, indices: [0, 1, 2] },
      { filename: 'marker-long.mp4', origin: 0, step: 512, denominator: 12800, indices: [0, 64, 79] },
    ]) {
      await openPreview(shell, entry.filename);
      await shell.page.getByRole('button', { name: 'First frame', exact: true }).click();
      await expect(shell.page.getByLabel('Source PTS', { exact: true })).toHaveValue(String(entry.origin));
      for (const index of entry.indices) {
        const pts = String(entry.origin + index * entry.step);
        await requestMarker(shell, pts, index);
        await expect.poll(() => displayedPTS(shell!)).toBe(pts);
        await expect.poll(() => timingValue(shell!, 'Displayed segment elapsed (seconds)'))
          .toBe(rationalText(index * entry.step, entry.denominator));
        await expect.poll(() => timingValue(shell!, 'Displayed source time (seconds)'))
          .toBe(rationalText(entry.origin + index * entry.step, entry.denominator));
      }
      await shell.page.getByRole('button', { name: 'Last frame', exact: true }).click();
      await expect(shell.page.getByLabel('Source PTS', { exact: true }))
        .toHaveValue(String(entry.origin + entry.indices.at(-1)! * entry.step));
      await closePreview(shell);
    }

    await openPreview(shell, 'marker-irregular.mp4');
    await requestMarker(shell, '0', 0);
    expect((await marker(shell.page.getByLabel('Derived source preview', { exact: true }), 0.16)).index).toBe(4);
    await expect.poll(() => displayedPTS(shell!)).toBe('2048');
    // 1024 lies in a VFR gap; the chosen policy is the first decoded PTS at or after it.
    await requestMarker(shell, '1024', 3);
    await expect.poll(() => displayedPTS(shell!)).toBe('1536');
    expect(await timingValue(shell, 'Requested / actual first source PTS')).toBe('1024 / 1536');
    expect(await timingValue(shell, 'Seek delta (seconds)')).toBe('1/25');
    await closePreview(shell);
    expect(await hashes(paths), 'Preview generation never changes original source bytes').toEqual(originals);
    await expect(shell.page.locator('body')).not.toContainText(directory);
    await quit(shell);
    shell = undefined;
    expect(await readdir(join(directory, 'data', 'previews'))).toEqual([]);

    shell = await launch(join(directory, 'data'));
    await shell.page.getByRole('button', { name: 'Inspect media', exact: true }).click();
    await openPreview(shell, 'marker-nonzero.mts');
    await requestMarker(shell, '144000', 4);
    await expect.poll(() => displayedPTS(shell!)).toBe('144000');
    await closePreview(shell);
    await quit(shell);
    shell = undefined;
    expect(await readdir(join(directory, 'data', 'previews'))).toEqual([]);
  } finally {
    await cleanup(shell);
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid requests, cancellation and changed or missing originals clear displayed content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bat-preview-errors-'));
  const paths = generateMarkers(join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    const segments = await importedMarkers(shell, paths);
    const rejected = await shell.page.evaluate(async (segmentID) => {
      const api = (window as unknown as { batAPI: BatAPI }).batAPI;
      const start = api.startPreview as (input: unknown) => ReturnType<BatAPI['startPreview']>;
      return Promise.all([
        start({ segment_id: segmentID, source_pts: '0', source_path: '/not-selected/synthetic.mp4' }),
        api.previewContent('/not-a-preview-id'),
      ]);
    }, segments[0]!.id);
    expect(rejected).toEqual([
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'invalid' }) }),
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'invalid' }) }),
    ]);
    await openPreview(shell, 'marker-nonzero.mts');
    await shell.page.getByLabel('Source PTS', { exact: true }).fill('0');
    await shell.page.getByRole('button', { name: 'Create preview', exact: true }).click();
    await expect(shell.page.getByRole('alert')).toContainText('first through the last decoded frame');
    await expect(shell.page.getByLabel('Derived source preview', { exact: true })).toHaveCount(0);
    await closePreview(shell);

    await openPreview(shell, 'marker-short.mp4');
    await requestMarker(shell, '0', 0);
    await shell.page.getByRole('button', { name: 'Cancel preview', exact: true }).click();
    await expect(shell.page.getByRole('status').filter({ hasText: /cancel/i })).toBeVisible();
    await expect(shell.page.getByLabel('Derived source preview', { exact: true })).toHaveCount(0);
    await requestMarker(shell, '0', 0);
    await appendFile(paths.short_mp4, 'Synthetic source changed after preview.');
    await expect(shell.page.getByRole('alert')).toContainText(/changed/i);
    await expect(shell.page.getByLabel('Derived source preview', { exact: true })).toHaveCount(0);
    await closePreview(shell);

    await openPreview(shell, 'marker-cfr.mp4');
    await requestMarker(shell, '0', 0);
    await rm(paths.cfr_mp4);
    await expect(shell.page.getByRole('alert')).toContainText(/missing|unavailable/i);
    await expect(shell.page.getByLabel('Derived source preview', { exact: true })).toHaveCount(0);
    await expect(shell.page.locator('body')).not.toContainText(directory);
    await closePreview(shell);
    await quit(shell);
    shell = undefined;
    expect(await readdir(join(directory, 'data', 'previews'))).toEqual([]);
  } finally {
    await cleanup(shell);
    await rm(directory, { recursive: true, force: true });
  }
});

test('unreadable originals and unknown final timing produce explicit preview errors', async () => {
  test.skip(process.getuid?.() === 0, 'The real permission check requires an unprivileged Linux user; backend injection coverage also runs as root.');
  const directory = await mkdtemp(join(tmpdir(), 'bat-preview-permissions-'));
  const paths = generateMarkers(join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    const segments = await importedMarkers(shell, paths);
    await openPreview(shell, 'marker-irregular.mp4');
    await requestMarker(shell, '0', 0);
    await chmod(paths.irregular_mp4, 0o000);
    await expect(shell.page.getByRole('alert')).toContainText(/cannot be read|permissions|access/i);
    await expect(shell.page.getByLabel('Derived source preview', { exact: true })).toHaveCount(0);
    await closePreview(shell);

    // Unknown end is a supported persisted import state; exercise the real API/UI refusal.
    const short = segments.find(segment => segment.metadata.filename === 'marker-short.mp4')!;
    const prepared = spawnSync(process.env.BAT_PYTHON ?? 'python', ['-c',
      'import json,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); row=db.execute("SELECT metadata_json FROM segment WHERE id=?",(sys.argv[2],)).fetchone(); value=json.loads(row[0]); value["end_time"]=None; value["elapsed_end"]=None; db.execute("UPDATE segment SET metadata_json=? WHERE id=?",(json.dumps(value),sys.argv[2])); db.commit(); db.close()',
      join(directory, 'data', 'bat_innovation.sqlite3'), short.id,
    ], { cwd: resolve('.'), encoding: 'utf8', timeout: 5000 });
    expect(prepared.status, 'Synthetic unknown-end fixture must be saved').toBe(0);
    await openPreview(shell, 'marker-short.mp4');
    await shell.page.getByRole('button', { name: 'Create preview', exact: true }).click();
    await expect(shell.page.getByRole('alert')).toContainText(/timing|frame boundaries/i);
    await expect(shell.page.getByLabel('Derived source preview', { exact: true })).toHaveCount(0);
    await expect(shell.page.locator('body')).not.toContainText(directory);
    await closePreview(shell);
    await quit(shell);
    shell = undefined;
    expect(await readdir(join(directory, 'data', 'previews'))).toEqual([]);
  } finally {
    await cleanup(shell);
    await chmod(paths.irregular_mp4, 0o600);
    await rm(directory, { recursive: true, force: true });
  }
});

test('a running preview can be cancelled and Electron shutdown reaps its worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bat-preview-stop-'));
  const paths = generateMarkers(join(directory, 'originals'));
  let shell: RunningShell | undefined;
  let stoppedPID: number | undefined;

  async function stopWorker(backendPID: number): Promise<number> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const children = spawnSync('ps', ['--ppid', String(backendPID), '-o', 'pid=,args='], { encoding: 'utf8' });
      const line = children.stdout.split('\n').find(value => /\s-m\s+backend\.app\.preview_worker(?:\s|$)/.test(value));
      if (line) {
        const pid = Number(line.trim().split(/\s+/, 1)[0]);
        try { process.kill(pid, 'SIGSTOP'); return pid; } catch { /* A completed child is retried until the deadline. */ }
      }
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error('The real preview worker did not start.');
  }

  function exited(pid: number): boolean {
    try { process.kill(pid, 0); return false; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
  }

  try {
    shell = await launch(join(directory, 'data'));
    await importedMarkers(shell, paths);
    await openPreview(shell, 'marker-long.mp4');
    const creating = shell.page.getByRole('button', { name: 'Create preview', exact: true }).click();
    stoppedPID = await stopWorker(shell.backendPid);
    await creating;
    await shell.page.getByRole('button', { name: 'Cancel preview', exact: true }).click();
    await expect.poll(() => exited(stoppedPID!)).toBe(true);
    stoppedPID = undefined;
    await expect(shell.page.getByRole('button', { name: 'Create preview', exact: true })).toBeEnabled();
    await expect(shell.page.getByLabel('Derived source preview', { exact: true })).toHaveCount(0);
    expect(await readdir(join(directory, 'data', 'previews'))).toEqual([]);

    const restarting = shell.page.getByRole('button', { name: 'Create preview', exact: true }).click();
    stoppedPID = await stopWorker(shell.backendPid);
    await restarting;
    const workerPID = stoppedPID;
    await quit(shell);
    shell = undefined;
    await expect.poll(() => exited(workerPID)).toBe(true);
    stoppedPID = undefined;
    expect(await readdir(join(directory, 'data', 'previews'))).toEqual([]);
  } finally {
    await cleanup(shell);
    if (stoppedPID && !exited(stoppedPID)) process.kill(stoppedPID, 'SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});
