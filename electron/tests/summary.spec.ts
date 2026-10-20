import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { BatAPI, SummaryDetail } from '../src/contracts';
import { cleanup, launch, quit, type RunningShell } from './shell-helpers';

type Fixtures = Record<'quiet_65' | 'quiet_9' | 'empty_middle' | 'brightness_9' | 'single', string>;

function generateSources(directory: string): Fixtures {
  const result = spawnSync(process.env.BAT_PYTHON ?? 'python', [
    'backend/tests/summary_fixtures.py', directory,
  ], { cwd: resolve('.'), encoding: 'utf8', timeout: 45_000 });
  expect(result.status, result.stderr || 'Summary source generation failed').toBe(0);
  return JSON.parse(result.stdout) as Fixtures;
}

async function digest(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function importedSources(shell: RunningShell, paths: string[]): Promise<string> {
  await shell.page.getByLabel('Display name', { exact: true }).fill('Synthetic summary survey');
  await shell.page.getByLabel('Camera reference', { exact: true }).fill('Synthetic summary camera');
  await shell.page.getByRole('button', { name: 'Create session', exact: true }).click();
  await shell.page.getByRole('button', { name: 'Inspect media', exact: true }).click();
  await shell.page.getByRole('button', { name: 'Upgrade media storage', exact: true }).click();
  // Only the OS dialog boundary is substituted; decoding, source IDs, HTTP and SQLite stay real.
  await shell.application.evaluate(({ dialog }, originals) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: originals })) as typeof dialog.showOpenDialog;
  }, paths);
  await shell.page.getByRole('button', { name: 'Choose original videos', exact: true }).click();
  await expect(shell.page.getByRole('article', { name: /^Segment / })).toHaveCount(paths.length);
  const sessions = await shell.page.evaluate(() => (window as unknown as { batAPI: BatAPI }).batAPI.listSessions());
  if (!sessions.ok) throw new Error(sessions.error.message);
  return sessions.value[0]!.id;
}

async function latestRun(shell: RunningShell, sessionID: string): Promise<SummaryDetail> {
  const response = await shell.page.evaluate(async id => {
    const api = (window as unknown as { batAPI: BatAPI }).batAPI;
    const runs = await api.listSummaryRuns(id);
    if (!runs.ok) return runs;
    if (!runs.value[0]) throw new Error('No real summary manifest persisted.');
    return api.summaryRun(runs.value[0].id);
  }, sessionID);
  if (!response.ok) throw new Error(response.error.message);
  return response.value;
}

test.skip(process.platform !== 'linux', 'Summary processing and Electron lifecycle are currently verified on Linux only.');

test('all quiet, quality-flagged and incomplete source windows survive Electron reopening', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-summary-e2e-'));
  const fixtures = generateSources(join(directory, 'originals'));
  const paths = [fixtures.quiet_65, fixtures.quiet_9, fixtures.brightness_9, fixtures.empty_middle];
  const before = await Promise.all(paths.map(digest));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'app-data'));
    const sessionID = await importedSources(shell, paths);
    await shell.page.getByRole('button', { name: 'Upgrade summary storage', exact: true }).click();
    await expect(shell.page.getByRole('heading', { name: 'Motion summary windows', exact: true })).toBeVisible();
    await expect(shell.page.getByRole('button', { name: 'Generate motion summaries', exact: true })).toBeEnabled();
    await shell.page.getByRole('button', { name: 'Generate motion summaries', exact: true }).click();
    await expect(shell.page.getByRole('status').filter({ hasText: /^Run incomplete: 7\/8 windows complete/ })).toBeVisible();
    await expect(shell.page.getByRole('list', { name: 'All planned windows', exact: true }).getByRole('article')).toHaveCount(8);
    const quiet = shell.page.getByRole('article', { name: 'Window 3: summary-quiet-65.mp4', exact: true });
    await expect(quiet).toContainText('[60/1, 65/1)');
    await expect(quiet).toContainText('No motion evidence above threshold.');
    const empty = shell.page.getByRole('article', { name: 'Window 2: summary-empty-middle.mp4', exact: true });
    await expect(empty).toContainText('incomplete');
    await expect(empty).toContainText('no_decoded_frames');
    await expect(empty.getByRole('button', { name: 'Preview window source', exact: true })).toBeDisabled();
    await empty.getByRole('button', { name: 'Inspect summary', exact: true }).click();
    await expect(shell.page.getByText('No complete image exists for this window.', { exact: true })).toBeVisible();
    const quality = shell.page.getByRole('article', { name: 'Window 1: summary-brightness-9.mp4', exact: true });
    await expect(quality.getByRole('list', { name: 'Window quality flags', exact: true })).toBeVisible();
    await quality.getByRole('button', { name: 'Inspect summary', exact: true }).click();
    const image = shell.page.getByRole('img', { name: 'Reference and motion evidence for window 1', exact: true });
    await expect(image).toBeVisible();
    expect(await image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await image.getAttribute('src')).toMatch(/^blob:/);
    await expect(shell.page.locator('body')).toContainText('Cyan = early third, yellow = middle third, magenta = late third');
    const manifest = await latestRun(shell, sessionID);
    expect(manifest.counts.planned).toBe(8);
    expect(manifest.windows).toHaveLength(8);
    expect(JSON.stringify(manifest)).not.toContain(directory);
    expect(JSON.stringify(manifest)).not.toContain('image_path');
    const ready = manifest.windows.find(window => window.image && window.flags.length > 0)!;
    const bytes = await shell.page.evaluate(async id => {
      const result = await (window as unknown as { batAPI: BatAPI }).batAPI.summaryImage(id);
      if (!result.ok) throw new Error(result.error.message);
      return Array.from(result.value.bytes);
    }, ready.id);
    expect(createHash('sha256').update(Buffer.from(bytes)).digest('hex')).toBe(ready.image!.sha256);
    const invalid = await shell.page.evaluate(() => {
      const api = (window as unknown as { batAPI: BatAPI }).batAPI;
      return (api.summaryImage as (...args: unknown[]) => Promise<unknown>)('/not-an-image-id.png');
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'invalid' } });

    // Unsaved provenance edits must survive new summary controls and source navigation.
    await shell.page.getByRole('article', { name: 'Segment 2: summary-quiet-9.mp4', exact: true })
      .getByRole('button', { name: /^Move up/ }).click();
    await expect(shell.page.getByRole('button', { name: 'Generate motion summaries', exact: true })).toBeDisabled();
    await expect(shell.page.getByRole('button', { name: 'Refresh summary runs', exact: true })).toBeDisabled();
    await expect(quality.getByRole('button', { name: 'Preview window source', exact: true })).toBeDisabled();
    await expect(shell.page.getByLabel('Processing run', { exact: true })).toBeDisabled();
    await shell.page.getByRole('button', { name: 'Discard unsaved changes', exact: true }).click();
    await expect(quality.getByRole('button', { name: 'Preview window source', exact: true })).toBeEnabled();
    await quality.getByRole('button', { name: 'Preview window source', exact: true }).click();
    await expect(shell.page.getByRole('heading', { name: 'Source preview', exact: true })).toBeVisible();
    const target = manifest.windows.find(window => window.segment_id === manifest.windows[4]!.segment_id)!.preview_pts!;
    await expect(shell.page.getByLabel('Source PTS', { exact: true })).toHaveValue(target);
    await shell.page.getByRole('button', { name: 'Create preview', exact: true }).click();
    await expect(shell.page.getByText('Preview ready', { exact: true })).toBeVisible();
    await expect(shell.page.getByLabel('Derived source preview', { exact: true })).toBeVisible();
    await shell.page.getByRole('button', { name: 'Close preview', exact: true }).click();
    await quit(shell);
    shell = undefined;

    shell = await launch(join(directory, 'app-data'));
    await shell.page.getByRole('button', { name: 'Inspect media', exact: true }).click();
    await expect(shell.page.getByRole('status').filter({ hasText: /^Run incomplete: 7\/8 windows complete/ })).toBeVisible();
    await expect(shell.page.getByRole('list', { name: 'All planned windows', exact: true }).getByRole('article')).toHaveCount(8);
    const persisted = await latestRun(shell, sessionID);
    expect(persisted.id).toBe(manifest.id);
    expect(persisted.windows).toEqual(manifest.windows);
    expect(await Promise.all(paths.map(digest)), 'Summary and preview must not change source bytes').toEqual(before);
    await quit(shell);
    shell = undefined;
  } finally {
    await cleanup(shell);
    await rm(directory, { recursive: true, force: true });
  }
});

test('changed originals invalidate displayed derived evidence without removing the window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bat-summary-source-e2e-'));
  const fixtures = generateSources(join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'app-data'));
    const sessionID = await importedSources(shell, [fixtures.quiet_9]);
    await shell.page.getByRole('button', { name: 'Upgrade summary storage', exact: true }).click();
    await shell.page.getByRole('button', { name: 'Generate motion summaries', exact: true }).click();
    await expect(shell.page.getByRole('status').filter({ hasText: /^Run complete: 1\/1 windows complete/ })).toBeVisible();
    await expect(shell.page.getByRole('img', { name: 'Reference and motion evidence for window 1', exact: true })).toBeVisible();
    const run = await latestRun(shell, sessionID);
    await appendFile(fixtures.quiet_9, 'Synthetic changed source');
    await shell.page.getByRole('button', { name: 'Refresh summary runs', exact: true }).click();
    await expect(shell.page.getByRole('article', { name: 'Window 1: summary-quiet-9.mp4', exact: true })).toContainText('changed_source');
    await expect(shell.page.getByRole('img', { name: 'Reference and motion evidence for window 1', exact: true })).not.toBeVisible();
    await expect(shell.page.getByRole('list', { name: 'All planned windows', exact: true }).getByRole('article')).toHaveCount(1);
    await expect(shell.page.getByRole('button', { name: 'Preview window source', exact: true })).toBeDisabled();
    const refused = await shell.page.evaluate(id => (window as unknown as { batAPI: BatAPI }).batAPI.summaryImage(id), run.windows[0]!.id);
    expect(refused).toMatchObject({ ok: false, error: { code: 'changed_source' } });
    expect((await latestRun(shell, sessionID)).state).toBe('incomplete');
    await expect(shell.page.locator('body')).not.toContainText(directory);
    await quit(shell);
    shell = undefined;
  } finally {
    await cleanup(shell);
    await rm(directory, { recursive: true, force: true });
  }
});
