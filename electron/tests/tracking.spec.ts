import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, quit, type RunningShell } from './shell-helpers';
import { addVideos, cleanupDraftShell, createSurvey, fixtures, goTo, openAt, previewReady, summarize, windowCards, hideProcessing } from './ui-helpers';

test.skip(process.platform !== 'linux', 'Media processing E2E is verified on Linux only.');

test('tracks are computed from a finished summary run and drawn as trails over the original frames', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-tracking-e2e-'));
  const sources = fixtures<'two_dots'>('tracking_fixtures', join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    await createSurvey(shell, 'Synthetic tracking survey');
    const find = shell.page.getByRole('button', { name: 'Find tracks', exact: true });
    await expect(find).toBeDisabled();
    await addVideos(shell, [sources.two_dots]);
    await summarize(shell);
    await find.click();
    // Starting a step opens the processing window; hidden, the step runs on and the sidebar brings it back.
    const processing = shell.page.getByRole('dialog', { name: 'Processing', exact: true });
    await expect(processing.getByRole('listitem', { name: 'Motion summaries: Done', exact: true })).toBeVisible();
    await hideProcessing(shell);
    await expect(shell.page.getByRole('status').filter({ hasText: /^Tracking complete: 2 tracks \(unverified\)$/ })).toBeVisible({ timeout: 60_000 });
    await shell.page.getByRole('button', { name: /^Processing/ }).click();
    await expect(processing.getByRole('listitem', { name: 'Tracks: Done', exact: true })).toContainText('2 tracks found (candidates, unverified)');
    await expect(processing.getByRole('listitem', { name: 'Add videos: Done', exact: true })).toContainText('1 video added');
    await processing.getByRole('link', { name: 'Open Watch', exact: true }).first().click();
    await expect(shell.page.getByRole('heading', { name: 'Watch', exact: true, level: 1 })).toBeVisible();
    await expect(processing).toBeHidden();
    await goTo(shell, 'Review');
    await expect(windowCards(shell).first()).toContainText('2 tracks (unverified)');
    const view = await openAt(shell, 0);
    await expect(view.getByRole('list', { name: 'Tracks in this window', exact: true }).getByRole('listitem')).toHaveCount(2);
    await previewReady(view);
    const video = view.getByLabel('Derived source preview', { exact: true });
    await video.evaluate(element => { (element as HTMLVideoElement).currentTime = 0.5; });
    await expect(view.getByRole('img', { name: 'Tracks and gates', exact: true }).locator('[data-track] polyline')).toHaveCount(2);
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});
