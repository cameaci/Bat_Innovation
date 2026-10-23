import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { BatAPI } from '../src/contracts';
import { launch, quit, type RunningShell } from './shell-helpers';
import { addVideos, cleanupDraftShell as cleanup, createSurvey, digests, fixtures, getMedia, openSurvey, pickerSpy, selectFiles, videos } from './ui-helpers';

type Media = 'cfr_mp4' | 'nonzero_mts' | 'irregular_mp4' | 'short_mp4';
const SURVEY = 'Synthetic media survey';

test.skip(process.platform !== 'linux', 'Electron lifecycle assertions currently use Linux /proc; Windows is unverified.');

test('native selection inspects real media and persists explicit video order across reopening', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-media-e2e-'));
  const media = fixtures<Media>('media_fixtures', join(directory, 'originals'));
  const selected = [media.cfr_mp4, media.nonzero_mts, media.irregular_mp4];
  const hashes = await digests(selected);
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'app-data'));
    const { page } = shell;
    const sessionID = await createSurvey(shell, SURVEY, 'Synthetic camera A');
    await selectFiles(shell, selected);
    const injection = await page.evaluate(async (id) => {
      const choose = (window as unknown as { batAPI: BatAPI }).batAPI.chooseMedia as (...args: unknown[]) => Promise<unknown>;
      return choose(id, { paths: ['/not-selected/synthetic.mp4'] });
    }, sessionID);
    expect(injection).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect((await pickerSpy(shell)).calls).toBe(0);

    // A native-dialog failure must not forward its potentially private error text.
    await shell.application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (async () => { throw new Error('/private/synthetic-picker-error'); }) as typeof dialog.showOpenDialog;
    });
    await page.getByRole('button', { name: 'Add videos', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('The native file picker could not open');
    await expect(page.locator('body')).not.toContainText('/private/synthetic-picker-error');
    expect((await getMedia(shell, sessionID)).segments).toEqual([]);
    await addVideos(shell, selected);
    const picker = await pickerSpy(shell);
    expect(picker.calls).toBe(1);
    expect(picker.options?.properties).toEqual(expect.arrayContaining(['openFile', 'multiSelections']));
    expect(picker.options?.filters?.flatMap((filter) => filter.extensions).sort()).toEqual(['mp4', 'mts']);
    expect(picker.options?.defaultPath).toBeUndefined();

    const inspected = await getMedia(shell, sessionID);
    expect(inspected.schema_version).toBe(8);
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
    const mts = page.getByRole('article', { name: /nonzero\.mts/ });
    await mts.getByText('Source details', { exact: true }).click();
    await expect(mts).toContainText('mpeg2video');
    await expect(mts).toContainText('129600');
    await expect(page.locator('body')).not.toContainText(directory);

    await mts.getByRole('button', { name: /^Move nonzero\.mts up/ }).click();
    // An unsaved timeline must not be silently replaced by refresh, import or page navigation.
    await expect(page.getByRole('button', { name: 'Refresh videos', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Add videos', exact: true })).toBeDisabled();
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Review', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await page.getByRole('navigation').getByRole('link', { name: 'Review', exact: true }).click({ force: true });
    await expect(page.getByRole('heading', { name: 'Process', exact: true })).toBeVisible();
    expect((await getMedia(shell, sessionID)).segments.map(segment => segment.metadata.filename)).toEqual(['cfr.mp4', 'nonzero.mts', 'irregular.mp4']);
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(videos(shell).first()).toHaveAccessibleName('Video 1: cfr.mp4');
    await expect(page.getByRole('button', { name: 'Refresh videos', exact: true })).toBeEnabled();
    await mts.getByRole('button', { name: /^Move nonzero\.mts up/ }).click();
    await page.getByRole('button', { name: 'Save timeline', exact: true }).click();
    await expect.poll(async () => (await getMedia(shell!, sessionID)).segments.map((segment) => segment.metadata.filename))
      .toEqual(['nonzero.mts', 'cfr.mp4', 'irregular.mp4']);
    // The UI leaves its unsaved state only after the save returns; a reload before that is (correctly) guarded.
    await expect(page.getByRole('button', { name: 'Refresh videos', exact: true })).toBeEnabled();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Process', exact: true })).toBeVisible();
    await expect(videos(shell).first()).toHaveAccessibleName('Video 1: nonzero.mts');
    await quit(shell);
    shell = undefined;

    shell = await launch(join(directory, 'app-data'));
    await openSurvey(shell, SURVEY);
    await expect(videos(shell).first()).toHaveAccessibleName('Video 1: nonzero.mts');
    const reopened = await getMedia(shell, sessionID);
    expect(reopened.clock_anchor).toBeNull();
    expect(reopened.segments.every((segment) => segment.continuity === 'unknown')).toBe(true);
    // Clock provenance edits are protected by the same unsaved-changes guard.
    await shell.page.getByText('Real-world clock (optional)').click();
    await shell.page.getByLabel('Anchored video').selectOption(reopened.segments[0]!.id);
    await shell.page.getByLabel('First frame time (UTC)').fill('2026-10-15T20:00:00Z');
    await shell.page.getByLabel('Source of this time').fill('Synthetic clock reference');
    await expect(shell.page.getByRole('button', { name: 'Refresh videos', exact: true })).toBeDisabled();
    await expect(shell.page.getByRole('link', { name: 'Back to surveys' })).toHaveAttribute('aria-disabled', 'true');
    await shell.page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(shell.page.getByLabel('Anchored video')).toHaveValue('');
    expect((await getMedia(shell, sessionID)).clock_anchor).toBeNull();
    await shell.page.getByLabel('Anchored video').selectOption(reopened.segments[0]!.id);
    await shell.page.getByLabel('First frame time (UTC)').fill('2026-10-15T20:00:00Z');
    await shell.page.getByLabel('Source of this time').fill('Synthetic clock reference');
    await shell.page.getByRole('button', { name: 'Save timeline', exact: true }).click();
    await expect.poll(async () => (await getMedia(shell!, sessionID)).clock_anchor?.utc).toBe('2026-10-15T20:00:00Z');
    await expect(shell.page.getByRole('button', { name: 'Refresh videos', exact: true })).toBeEnabled();
    expect(await digests(selected), 'Inspection and reordering must leave original bytes unchanged').toEqual(hashes);
    await quit(shell);
    shell = undefined;
  } finally {
    await cleanup(shell);
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupt batches attach nothing and changed or missing originals remain explicit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bat-media-failure-'));
  const media = fixtures<Media>('media_fixtures', join(directory, 'originals'));
  const corrupt = join(directory, 'originals', 'corrupt.mp4');
  await writeFile(corrupt, 'Synthetic corrupt media, not a video.');
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'app-data'));
    const { page } = shell;
    const sessionID = await createSurvey(shell, SURVEY);
    await selectFiles(shell, [media.cfr_mp4, corrupt]);
    await page.getByRole('button', { name: 'Add videos', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(/metadata|decode|corrupt|media/i);
    expect((await getMedia(shell, sessionID)).segments).toEqual([]);
    await expect(videos(shell)).toHaveCount(0);

    await addVideos(shell, [media.short_mp4]);
    expect((await getMedia(shell, sessionID)).segments[0]!.metadata).toMatchObject({ frame_count: 3, elapsed_end: { num: '3', den: '25' } });

    await appendFile(media.short_mp4, 'Synthetic changed source');
    await page.getByRole('button', { name: 'Refresh videos', exact: true }).click();
    await expect(page.getByRole('article', { name: /short\.mp4/ })).toContainText(/source changed/i);
    expect((await getMedia(shell, sessionID)).segments[0]!.source_state).toBe('changed_source');
    await rm(media.short_mp4);
    await page.getByRole('button', { name: 'Refresh videos', exact: true }).click();
    await expect(page.getByRole('article', { name: /short\.mp4/ })).toContainText(/source missing/i);
    const missing = await getMedia(shell, sessionID);
    expect(missing.segments[0]!.source_state).toBe('missing_source');
    expect(JSON.stringify(missing)).not.toContain(directory);
    await expect(page.locator('body')).not.toContainText(directory);
    await quit(shell);
    shell = undefined;
  } finally {
    await cleanup(shell);
    await rm(directory, { recursive: true, force: true });
  }
});

test('unsupported-platform import refusal reaches the picker UI without source inspection or worker creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bat-import-guard-e2e-'));
  const originalPython = process.env.BAT_PYTHON;
  const resolved = spawnSync(originalPython ?? 'python', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  expect(resolved.status, resolved.stderr).toBe(0);
  const wrapper = join(directory, 'guarded-python');
  // Negative fixture: report an unsupported platform (neither Linux nor Windows) through the one
  // supported() gate, not sys.platform. Real Electron/token/HTTP/SQLite stay intact; no source may be touched.
  await writeFile(wrapper, `#!${resolved.stdout.trim()}
import os, runpy, sys
sys.path.insert(0, os.getcwd())
from backend.app import imports, workers
workers.supported = lambda: False
def forbidden(*args, **kwargs):
    raise AssertionError("Import accessed a source or created a worker")
imports.selected_sources = forbidden
imports.Thread = forbidden
imports.media.inspect_source = forbidden
runpy.run_module("backend.app", run_name="__main__")
`, { mode: 0o700 });
  let shell: RunningShell | undefined;
  try {
    process.env.BAT_PYTHON = wrapper;
    shell = await launch(join(directory, 'data'));
    const sessionID = await createSurvey(shell, SURVEY);
    const before = await getMedia(shell, sessionID);
    await selectFiles(shell, [join(directory, 'synthetic-private-missing.mp4')]);
    await shell.page.getByRole('button', { name: 'Add videos', exact: true }).click();
    await expect(shell.page.getByRole('alert')).toContainText('Media import process limits are unavailable');
    await expect(shell.page.locator('body')).not.toContainText('synthetic-private-missing');
    expect((await pickerSpy(shell)).calls).toBe(1);
    expect(await getMedia(shell, sessionID)).toEqual(before);
    expect(before.segments).toEqual([]);
    expect(before.active_import).toBeNull();
    await quit(shell); shell = undefined;
  } finally {
    if (originalPython === undefined) delete process.env.BAT_PYTHON;
    else process.env.BAT_PYTHON = originalPython;
    await cleanup(shell);
    await rm(directory, { recursive: true, force: true });
  }
});
