import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { BatAPI } from '../src/contracts';
import { cleanup, launch, quit, type RunningShell } from './shell-helpers';
import { addVideos, createSurvey, digests, fixtures, goTo, latestRun, openSurvey, openWindow, previewReady, summarize, windowCard, windowCards } from './ui-helpers';

type Sources = 'quiet_65' | 'quiet_9' | 'empty_middle' | 'brightness_9' | 'single';
const SURVEY = 'Synthetic summary survey';

test.skip(process.platform !== 'linux', 'Summary processing and Electron lifecycle are currently verified on Linux only.');

test('all quiet, quality-flagged and incomplete source windows survive Electron reopening', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-summary-e2e-'));
  const sources = fixtures<Sources>('summary_fixtures', join(directory, 'originals'));
  const paths = [sources.quiet_65, sources.quiet_9, sources.brightness_9, sources.empty_middle];
  const before = await digests(paths);
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'app-data'));
    const { page } = shell;
    const sessionID = await createSurvey(shell, SURVEY);
    await addVideos(shell, paths);
    await summarize(shell, /^Run incomplete: 7 of 8 windows complete/);
    // Process shows the run's status only; the images are looked through on the Review page.
    await expect(page.getByRole('region', { name: 'Results' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Review all 8 windows', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Review', exact: true, level: 1 })).toBeVisible();
    await expect(windowCards(shell)).toHaveCount(8);
    await expect(page.getByRole('status').filter({ hasText: /^0 of 8 windows$/ })).toBeVisible();

    const empty = windowCard(shell, 'Window 0:30 - 1:00 of summary-empty-middle.mp4');
    await expect(empty).toContainText(/incomplete: no decoded frames/i);
    let view = await openWindow(shell, 'Window 0:30 - 1:00 of summary-empty-middle.mp4');
    await expect(view.getByText('Incomplete: no image')).toBeVisible();
    await expect(view.getByLabel('Derived source preview')).toHaveCount(0);
    await view.getByRole('button', { name: 'Close window' }).click();

    view = await openWindow(shell, 'Window 1:00 - 1:05 of summary-quiet-65.mp4');
    await expect(view).toContainText('No motion evidence above threshold.');
    await view.getByText('Technical details').click();
    await expect(view).toContainText('[60/1, 65/1)');
    await view.getByRole('button', { name: 'Close window' }).click();

    await expect(windowCard(shell, 'Window 0:00 - 0:09 of summary-brightness-9.mp4')).toContainText(/flag/);
    view = await openWindow(shell, 'Window 0:00 - 0:09 of summary-brightness-9.mp4');
    await expect(view.getByRole('list', { name: 'Window quality flags', exact: true })).toContainText('brightness change');
    const image = view.getByRole('img', { name: /^Reference and motion evidence for Window 0:00 - 0:09 of summary-brightness-9\.mp4/ });
    await expect(image).toBeVisible();
    expect(await image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await image.getAttribute('src')).toMatch(/^blob:/);
    await expect(view).toContainText('Cyan = early, yellow = middle, magenta = late third of the window');
    await previewReady(view);
    await view.getByRole('button', { name: 'Close window' }).click();

    const manifest = await latestRun(shell, sessionID);
    expect(manifest.counts.planned).toBe(8);
    expect(manifest.windows).toHaveLength(8);
    expect(JSON.stringify(manifest)).not.toContain(directory);
    expect(JSON.stringify(manifest)).not.toContain('image_path');
    const ready = manifest.windows.find(window => window.image && window.flags.includes('brightness_transition'))!;
    const bytes = await page.evaluate(async id => {
      const result = await (window as unknown as { batAPI: BatAPI }).batAPI.summaryImage(id);
      if (!result.ok) throw new Error(result.error.message);
      return Array.from(result.value.bytes);
    }, ready.id);
    expect(createHash('sha256').update(Buffer.from(bytes)).digest('hex')).toBe(ready.image!.sha256);
    const invalid = await page.evaluate(() => {
      const api = (window as unknown as { batAPI: BatAPI }).batAPI;
      return (api.summaryImage as (...args: unknown[]) => Promise<unknown>)('/not-an-image-id.png');
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'invalid' } });

    // Unsaved timeline edits block new runs until they are saved or discarded.
    await goTo(shell, 'Process');
    await page.getByRole('article', { name: /summary-quiet-9\.mp4/ }).getByRole('button', { name: /^Move summary-quiet-9\.mp4 up/ }).click();
    await expect(page.getByRole('button', { name: 'Generate motion summaries', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Generate motion summaries', exact: true })).toBeEnabled();
    await quit(shell);
    shell = undefined;

    shell = await launch(join(directory, 'app-data'));
    await openSurvey(shell, SURVEY);
    await expect(shell.page.getByRole('status').filter({ hasText: /^Run incomplete: 7 of 8 windows complete/ })).toBeVisible();
    await goTo(shell, 'Review');
    await expect(windowCards(shell)).toHaveCount(8);
    const persisted = await latestRun(shell, sessionID);
    expect(persisted.id).toBe(manifest.id);
    expect(persisted.windows).toEqual(manifest.windows);
    expect(await digests(paths), 'Summary and preview must not change source bytes').toEqual(before);
    await quit(shell);
    shell = undefined;
  } finally {
    await cleanup(shell);
    await rm(directory, { recursive: true, force: true });
  }
});

test('changed originals invalidate displayed derived evidence without removing the window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bat-summary-source-e2e-'));
  const sources = fixtures<Sources>('summary_fixtures', join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'app-data'));
    const sessionID = await createSurvey(shell, SURVEY);
    await addVideos(shell, [sources.quiet_9]);
    await summarize(shell, /^Run complete: 1 of 1 windows complete/);
    await goTo(shell, 'Review');
    const label = 'Window 0:00 - 0:09 of summary-quiet-9.mp4';
    await expect(windowCard(shell, label).getByRole('img')).toBeVisible();
    const run = await latestRun(shell, sessionID);
    await appendFile(sources.quiet_9, 'Synthetic changed source');
    await shell.page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(windowCard(shell, label)).toContainText('changed source');
    await expect(windowCard(shell, label).getByRole('img')).toHaveCount(0);
    await expect(windowCards(shell)).toHaveCount(1);
    const view = await openWindow(shell, label);
    await expect(view.getByText('The original video is missing or changed.')).toBeVisible();
    await expect(view.getByLabel('Derived source preview')).toHaveCount(0);
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
