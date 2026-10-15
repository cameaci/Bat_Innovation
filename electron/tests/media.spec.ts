import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { BatAPI, MediaSession } from '../src/contracts';
import { cleanup, launch, quit, type RunningShell } from './shell-helpers';

interface Fixtures {
  cfr_mp4: string;
  nonzero_mts: string;
  irregular_mp4: string;
  short_mp4: string;
}

interface PickerSpy {
  calls: number;
  options: Electron.OpenDialogOptions | null;
}

function generateMedia(directory: string): Fixtures {
  const result = spawnSync(process.env.BAT_PYTHON ?? 'python', [
    'backend/tests/media_fixtures.py', directory,
  ], { cwd: resolve('.'), encoding: 'utf8', timeout: 45_000 });
  expect(result.status, result.stderr || 'Synthetic media generation failed').toBe(0);
  return JSON.parse(result.stdout) as Fixtures;
}

async function digest(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function nativeSelection(shell: RunningShell, paths: string[]): Promise<void> {
  // Replace only the OS dialog boundary. All IPC, HTTP, decoding and SQLite remain real.
  await shell.application.evaluate(({ dialog }, selected) => {
    const spy: PickerSpy = { calls: 0, options: null };
    const instrumented = dialog as typeof dialog & { pickerSpy: PickerSpy };
    instrumented.pickerSpy = spy;
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      spy.calls += 1;
      spy.options = args[args.length - 1] as Electron.OpenDialogOptions;
      return { canceled: false, filePaths: selected };
    }) as typeof dialog.showOpenDialog;
  }, paths);
}

async function pickerSpy(shell: RunningShell): Promise<PickerSpy> {
  return shell.application.evaluate(({ dialog }) => (
    dialog as typeof dialog & { pickerSpy: PickerSpy }
  ).pickerSpy);
}

async function createAndOpenMedia(shell: RunningShell): Promise<string> {
  const { page } = shell;
  await page.getByLabel('Display name', { exact: true }).fill('Synthetic media survey');
  await page.getByLabel('Camera reference', { exact: true }).fill('Synthetic camera A');
  await page.getByRole('button', { name: 'Create session', exact: true }).click();
  await page.getByRole('row', { name: /Synthetic media survey.*Synthetic camera A/ })
    .getByRole('button', { name: 'Inspect media', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Session media', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Upgrade media storage', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose original videos', exact: true })).toBeEnabled();
  const sessions = await page.evaluate(() => (window as unknown as { batAPI: BatAPI }).batAPI.listSessions());
  expect(sessions.ok).toBe(true);
  if (!sessions.ok) throw new Error(sessions.error.message);
  expect(sessions.value).toHaveLength(1);
  return sessions.value[0]!.id;
}

async function getMedia(shell: RunningShell, sessionID: string): Promise<MediaSession> {
  const response = await shell.page.evaluate((id) => (
    window as unknown as { batAPI: BatAPI }
  ).batAPI.getMedia(id), sessionID);
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error(response.error.message);
  return response.value;
}

test.skip(process.platform !== 'linux', 'Electron lifecycle assertions currently use Linux /proc; Windows is unverified.');

test('native selection inspects real media and persists explicit segment order across reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bat-media-e2e-'));
  const fixtures = generateMedia(join(directory, 'originals'));
  const selected = [fixtures.cfr_mp4, fixtures.nonzero_mts, fixtures.irregular_mp4];
  const hashes = await Promise.all(selected.map(digest));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'app-data'));
    const sessionID = await createAndOpenMedia(shell);
    await nativeSelection(shell, selected);
    const injection = await shell.page.evaluate(async (id) => {
      const choose = (window as unknown as { batAPI: BatAPI }).batAPI.chooseMedia as (...args: unknown[]) => Promise<unknown>;
      return choose(id, { paths: ['/not-selected/synthetic.mp4'] });
    }, sessionID);
    expect(injection).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect((await pickerSpy(shell)).calls).toBe(0);

    // A native-dialog failure must not forward its potentially private error text.
    await shell.application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (async () => { throw new Error('/private/synthetic-picker-error'); }) as typeof dialog.showOpenDialog;
    });
    await shell.page.getByRole('button', { name: 'Choose original videos', exact: true }).click();
    await expect(shell.page.getByRole('alert')).toContainText('The native file picker could not open');
    await expect(shell.page.locator('body')).not.toContainText('/private/synthetic-picker-error');
    expect((await getMedia(shell, sessionID)).segments).toEqual([]);
    await nativeSelection(shell, selected);
    await shell.page.getByRole('button', { name: 'Choose original videos', exact: true }).click();
    await expect(shell.page.getByRole('article', { name: /irregular\.mp4/ })).toBeVisible();
    const picker = await pickerSpy(shell);
    expect(picker.calls).toBe(1);
    expect(picker.options?.properties).toEqual(expect.arrayContaining(['openFile', 'multiSelections']));
    expect(picker.options?.filters?.flatMap((filter) => filter.extensions).sort()).toEqual(['mp4', 'mts']);
    expect(picker.options?.defaultPath).toBeUndefined();

    const inspected = await getMedia(shell, sessionID);
    expect(inspected.schema_version).toBe(2);
    expect(inspected.clock_anchor).toBeNull();
    expect(inspected.segments.map((segment) => segment.metadata.filename)).toEqual(['cfr.mp4', 'nonzero.mts', 'irregular.mp4']);
    expect(inspected.segments.every((segment) => segment.continuity === 'unknown' && segment.continuity_provenance === null)).toBe(true);
    expect(inspected.segments[0]!.metadata).toMatchObject({ codec: 'h264', first_pts: '0', frame_count: 8, width: 96, height: 64 });
    expect(inspected.segments[1]!.metadata).toMatchObject({
      codec: 'mpeg2video', first_pts: '129600', time_base: { num: '1', den: '90000' },
      first_time: { num: '36', den: '25' }, elapsed_end: { num: '8', den: '25' },
    });
    expect(inspected.segments[2]!.metadata).toMatchObject({
      frame_count: 6, elapsed_last_time: { num: '7', den: '25' }, elapsed_end: { num: '8', den: '25' },
    });
    expect(JSON.stringify(inspected)).not.toContain(directory);
    expect(JSON.stringify(inspected)).not.toContain('source_path');
    await shell.page.getByRole('article', { name: /nonzero\.mts/ }).getByText('Source metadata', { exact: true }).click();
    await expect(shell.page.getByRole('article', { name: /nonzero\.mts/ })).toContainText('mpeg2video');
    await expect(shell.page.locator('body')).not.toContainText(directory);

    await shell.page.getByRole('article', { name: /nonzero\.mts/ }).getByRole('button', { name: /^Move up/ }).click();
    await shell.page.getByRole('button', { name: 'Save order', exact: true }).click();
    await expect.poll(async () => (await getMedia(shell!, sessionID)).segments.map((segment) => segment.metadata.filename))
      .toEqual(['nonzero.mts', 'cfr.mp4', 'irregular.mp4']);
    await shell.page.reload();
    await expect(shell.page.getByText('Backend ready', { exact: true })).toBeVisible();
    await shell.page.getByRole('button', { name: 'Inspect media', exact: true }).click();
    await expect(shell.page.getByRole('article').first()).toHaveAccessibleName('Segment 1: nonzero.mts');
    await quit(shell);
    shell = undefined;

    shell = await launch(join(directory, 'app-data'));
    await shell.page.getByRole('button', { name: 'Inspect media', exact: true }).click();
    await expect(shell.page.getByRole('article').first()).toHaveAccessibleName('Segment 1: nonzero.mts');
    const reopened = await getMedia(shell, sessionID);
    expect(reopened.clock_anchor).toBeNull();
    expect(reopened.segments.every((segment) => segment.continuity === 'unknown')).toBe(true);
    expect(await Promise.all(selected.map(digest)), 'Inspection and reordering must leave original bytes unchanged').toEqual(hashes);
    await quit(shell);
    shell = undefined;
  } finally {
    await cleanup(shell);
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupt batches attach nothing and changed or missing originals remain explicit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bat-media-failure-'));
  const fixtures = generateMedia(join(directory, 'originals'));
  const corrupt = join(directory, 'originals', 'corrupt.mp4');
  await writeFile(corrupt, 'Synthetic corrupt media, not a video.');
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'app-data'));
    const sessionID = await createAndOpenMedia(shell);
    await nativeSelection(shell, [fixtures.cfr_mp4, corrupt]);
    await shell.page.getByRole('button', { name: 'Choose original videos', exact: true }).click();
    await expect(shell.page.getByRole('alert')).toContainText(/metadata|decode|corrupt|media/i);
    expect((await getMedia(shell, sessionID)).segments).toEqual([]);
    await expect(shell.page.getByRole('article')).toHaveCount(0);

    await nativeSelection(shell, [fixtures.short_mp4]);
    await shell.page.getByRole('button', { name: 'Choose original videos', exact: true }).click();
    await expect(shell.page.getByRole('article', { name: /short\.mp4/ })).toBeVisible();
    const imported = await getMedia(shell, sessionID);
    expect(imported.segments[0]!.metadata).toMatchObject({ frame_count: 3, elapsed_end: { num: '3', den: '25' } });

    await appendFile(fixtures.short_mp4, 'Synthetic changed source');
    await shell.page.getByRole('button', { name: 'Refresh media', exact: true }).click();
    await expect(shell.page.getByRole('article', { name: /short\.mp4/ })).toContainText(/changed.source|source.*changed/i);
    expect((await getMedia(shell, sessionID)).segments[0]!.source_state).toBe('changed_source');
    await rm(fixtures.short_mp4);
    await shell.page.getByRole('button', { name: 'Refresh media', exact: true }).click();
    await expect(shell.page.getByRole('article', { name: /short\.mp4/ })).toContainText(/missing.source|source.*missing/i);
    const missing = await getMedia(shell, sessionID);
    expect(missing.segments[0]!.source_state).toBe('missing_source');
    expect(JSON.stringify(missing)).not.toContain(directory);
    await expect(shell.page.locator('body')).not.toContainText(directory);
    await quit(shell);
    shell = undefined;
  } finally {
    await cleanup(shell);
    await rm(directory, { recursive: true, force: true });
  }
});
