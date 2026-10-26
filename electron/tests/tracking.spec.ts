import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, quit, type RunningShell } from './shell-helpers';
import { addVideos, cleanupDraftShell, createSurvey, fixtures, goTo, openAt, previewReady, summarize, windowCards } from './ui-helpers';

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
    await expect(shell.page.getByRole('status').filter({ hasText: /^Tracking complete: 2 tracks \(unverified\)$/ })).toBeVisible({ timeout: 60_000 });
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
