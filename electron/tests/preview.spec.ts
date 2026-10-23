import { spawnSync } from 'node:child_process';
import { appendFile, chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import type { BatAPI, MediaSegment } from '../src/contracts';
import { cleanup, launch, quit, type RunningShell } from './shell-helpers';
import { addVideos, createSurvey, dialog, digests, displayedPTS, fixtures, getMedia, goTo, openSurvey, summarize } from './ui-helpers';

type Marker = 'cfr_mp4' | 'nonzero_mts' | 'irregular_mp4' | 'short_mp4' | 'long_mp4';
const SURVEY = 'Synthetic preview survey';

async function prepared(shell: RunningShell, paths: Record<Marker, string>): Promise<MediaSegment[]> {
  const sessionID = await createSurvey(shell, SURVEY);
  await addVideos(shell, Object.values(paths));
  await summarize(shell);
  await goTo(shell, 'Review');
  const media = await getMedia(shell, sessionID);
  expect(media.clock_anchor).toBeNull();
  return media.segments;
}

async function openFile(shell: RunningShell, filename: string): Promise<Locator> {
  await shell.page.getByRole('article', { name: new RegExp(`of ${filename.replaceAll('.', '\\.')}$`) }).getByRole('button').click();
  const view = dialog(shell);
  await expect(view.getByText('Preview ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  return view;
}

async function closeFile(view: Locator): Promise<void> {
  await view.getByRole('button', { name: 'Close window', exact: true }).click();
  await expect(view).toBeHidden();
}

function rationalText(numerator: number, denominator: number): string {
  let left = Math.abs(numerator), right = denominator;
  while (right) [left, right] = [right, left % right];
  return `${numerator / left}/${denominator / left}`;
}

async function timing(view: Locator, label: string): Promise<string | null> {
  return view.getByText(label, { exact: true }).evaluate(element => element.nextElementSibling?.textContent ?? null);
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

/** Request a preview at an exact original PTS through the dialog's Exact position control. */
async function exact(view: Locator, sourcePTS: string): Promise<void> {
  const details = view.locator('details', { hasText: 'Exact position' });
  if (!(await details.evaluate(element => (element as HTMLDetailsElement).open))) await details.getByText('Exact position').click();
  await view.getByLabel('Source PTS', { exact: true }).fill(sourcePTS);
  await view.getByRole('button', { name: 'Create preview', exact: true }).click();
}

async function requestMarker(view: Locator, sourcePTS: string, expectedIndex: number): Promise<void> {
  await exact(view, sourcePTS);
  await expect(view.getByText('Preview ready', { exact: true })).toBeVisible();
  const video = view.getByLabel('Derived source preview', { exact: true });
  await expect(video).toBeVisible();
  const decoded = await marker(video);
  expect(decoded.index, `Requested source PTS ${sourcePTS} must display its actual marker`).toBe(expectedIndex);
  expect(decoded.paused).toBe(true);
  expect(decoded.duration).toBeGreaterThan(0);
  expect(decoded.duration).toBeLessThanOrEqual(2.001);
}

test.skip(process.platform !== 'linux', 'Preview resource guards and Electron lifecycle are currently verified on Linux only.');

test('window previews display real marker frames with exact VFR and nonzero-origin mapping', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-preview-e2e-'));
  const paths = fixtures<Marker>('preview_fixtures', join(directory, 'originals'));
  const originals = await digests(Object.values(paths));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    await prepared(shell, paths);
    for (const entry of [
      { filename: 'marker-cfr.mp4', origin: 0, step: 512, denominator: 12800, indices: [4, 7] },
      { filename: 'marker-nonzero.mts', origin: 129600, step: 3600, denominator: 90000, indices: [4, 7] },
      { filename: 'marker-irregular.mp4', origin: 0, step: 512, denominator: 12800, indices: [4, 7] },
      { filename: 'marker-short.mp4', origin: 0, step: 512, denominator: 12800, indices: [1, 2] },
      { filename: 'marker-long.mp4', origin: 0, step: 512, denominator: 12800, indices: [64, 79] },
    ]) {
      // Opening a window previews its first decoded frame automatically.
      const view = await openFile(shell, entry.filename);
      expect((await marker(view.getByLabel('Derived source preview', { exact: true }))).index).toBe(0);
      await expect.poll(() => displayedPTS(view)).toBe(String(entry.origin));
      for (const index of entry.indices) {
        const pts = String(entry.origin + index * entry.step);
        await requestMarker(view, pts, index);
        await expect.poll(() => displayedPTS(view)).toBe(pts);
        await expect.poll(() => timing(view, 'Displayed segment elapsed (seconds)')).toBe(rationalText(index * entry.step, entry.denominator));
        await expect(view.getByLabel('Displayed original frame')).toContainText(`source time ${rationalText(entry.origin + index * entry.step, entry.denominator)} s`);
      }
      await closeFile(view);
    }
    const view = await openFile(shell, 'marker-irregular.mp4');
    expect((await marker(view.getByLabel('Derived source preview', { exact: true }), 0.16)).index).toBe(4);
    await expect.poll(() => displayedPTS(view)).toBe('2048');
    // 1024 lies in a VFR gap; the chosen policy is the first decoded PTS at or after it.
    await requestMarker(view, '1024', 3);
    await expect.poll(() => displayedPTS(view)).toBe('1536');
    expect(await timing(view, 'Requested / actual first source PTS')).toBe('1024 / 1536');
    expect(await timing(view, 'Seek delta (seconds)')).toBe('1/25');
    await closeFile(view);
    expect(await digests(Object.values(paths)), 'Preview generation never changes original source bytes').toEqual(originals);
    await expect(shell.page.locator('body')).not.toContainText(directory);
    await quit(shell);
    shell = undefined;
    expect(await readdir(join(directory, 'data', 'previews'))).toEqual([]);
    shell = await launch(join(directory, 'data'));
    await openSurvey(shell, SURVEY, 'Review');
    const reopened = await openFile(shell, 'marker-nonzero.mts');
    await requestMarker(reopened, '144000', 4);
    await expect.poll(() => displayedPTS(reopened)).toBe('144000');
    await closeFile(reopened);
    await quit(shell);
    shell = undefined;
    expect(await readdir(join(directory, 'data', 'previews'))).toEqual([]);
  } finally {
    await cleanup(shell);
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid requests, cancellation and changed or missing originals clear displayed content', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-preview-errors-'));
  const paths = fixtures<Marker>('preview_fixtures', join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    const segments = await prepared(shell, paths);
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
    let view = await openFile(shell, 'marker-nonzero.mts');
    await exact(view, '0');
    await expect(view.getByRole('alert')).toContainText('first through the last decoded frame');
    await expect(view.getByLabel('Derived source preview', { exact: true })).toHaveCount(0);
    await closeFile(view);
    view = await openFile(shell, 'marker-short.mp4');
    await view.getByRole('button', { name: 'Cancel preview', exact: true }).click();
    await expect(view.getByRole('status').filter({ hasText: /cancel/i })).toBeVisible();
    await expect(view.getByLabel('Derived source preview', { exact: true })).toHaveCount(0);
    await requestMarker(view, '0', 0);
    await appendFile(paths.short_mp4, 'Synthetic source changed after preview.');
    await expect(view.getByRole('alert')).toContainText(/changed/i);
    await expect(view.getByLabel('Derived source preview', { exact: true })).toHaveCount(0);
    await closeFile(view);
    view = await openFile(shell, 'marker-cfr.mp4');
    await rm(paths.cfr_mp4);
    await expect(view.getByRole('alert')).toContainText(/missing|unavailable/i);
    await expect(view.getByLabel('Derived source preview', { exact: true })).toHaveCount(0);
    await expect(shell.page.locator('body')).not.toContainText(directory);
    await closeFile(view);
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
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-preview-permissions-'));
  const paths = fixtures<Marker>('preview_fixtures', join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    const segments = await prepared(shell, paths);
    const view = await openFile(shell, 'marker-irregular.mp4');
    await chmod(paths.irregular_mp4, 0o000);
    await expect(view.getByRole('alert')).toContainText(/cannot be read|permissions|access/i);
    await expect(view.getByLabel('Derived source preview', { exact: true })).toHaveCount(0);
    await closeFile(view);
    // Unknown end is a supported persisted import state; exercise the real API refusal.
    const short = segments.find(segment => segment.metadata.filename === 'marker-short.mp4')!;
    const prepared_ = spawnSync(process.env.BAT_PYTHON ?? 'python', ['-c',
      'import json,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); row=db.execute("SELECT metadata_json FROM segment WHERE id=?",(sys.argv[2],)).fetchone(); value=json.loads(row[0]); value["end_time"]=None; value["elapsed_end"]=None; db.execute("UPDATE segment SET metadata_json=? WHERE id=?",(json.dumps(value),sys.argv[2])); db.commit(); db.close()',
      join(directory, 'data', 'bat_innovation.sqlite3'), short.id,
    ], { cwd: resolve('.'), encoding: 'utf8', timeout: 5000 });
    expect(prepared_.status, 'Synthetic unknown-end fixture must be saved').toBe(0);
    const refused = await shell.page.evaluate(id => (window as unknown as { batAPI: BatAPI }).batAPI.startPreview({ segment_id: id, source_pts: '0' }), short.id);
    expect(refused).toMatchObject({ ok: false, error: { code: 'unknown_timing' } });
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
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-preview-stop-'));
  const paths = fixtures<Marker>('preview_fixtures', join(directory, 'originals'));
  let shell: RunningShell | undefined;
  let stoppedPID: number | undefined;
  async function stopWorker(backendPID: number): Promise<number> {
    const deadline = Date.now() + 5000;
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
    await prepared(shell, paths);
    // Opening the window starts its preview; stop the real worker mid-encode.
    const opening = shell.page.getByRole('article', { name: /of marker-long\.mp4$/ }).getByRole('button').click();
    stoppedPID = await stopWorker(shell.backendPid);
    await opening;
    const view = dialog(shell);
    await view.getByRole('button', { name: 'Cancel preview', exact: true }).click();
    await expect.poll(() => exited(stoppedPID!)).toBe(true);
    stoppedPID = undefined;
    await expect(view.getByLabel('Derived source preview', { exact: true })).toHaveCount(0);
    expect(await readdir(join(directory, 'data', 'previews'))).toEqual([]);
    const restarting = exact(view, '0');
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
