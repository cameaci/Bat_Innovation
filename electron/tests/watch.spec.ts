import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, quit, type RunningShell } from './shell-helpers';
import { addVideos, cleanupDraftShell, createSurvey, fixtures, goTo, summarize } from './ui-helpers';

test.skip(process.platform !== 'linux', 'Media processing E2E is verified on Linux only.');

test('Watch plays the prepared copy continuously and rings every tracked target at the displayed frame', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-watch-e2e-'));
  const sources = fixtures<'two_dots' | 'crossing'>('tracking_fixtures', join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    await createSurvey(shell, 'Synthetic watch survey');
    await addVideos(shell, [sources.two_dots, sources.crossing]);
    await summarize(shell);
    await shell.page.getByRole('button', { name: 'Find tracks', exact: true }).click();
    await expect(shell.page.getByRole('status').filter({ hasText: /^Tracking complete:/ })).toBeVisible({ timeout: 60_000 });
    await goTo(shell, 'Watch');
    const video = shell.page.getByLabel('Playback copy', { exact: true });
    await expect(video).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    // Seek to the middle of the clip: both synthetic dots are tracked there.
    await video.evaluate(element => { (element as HTMLVideoElement).currentTime = 0.2; });
    await expect(shell.page.getByLabel('Tracks at this frame', { exact: true })).toHaveText('2', { timeout: 15_000 });
    const frameLabel = shell.page.getByLabel('Frame number', { exact: true });
    await expect(frameLabel).toHaveText(/^frame \d+$/);
    const before = await frameLabel.textContent();
    await shell.page.keyboard.press('.');
    await expect(frameLabel).toHaveText(`frame ${Number(before!.slice(6)) + 1}`);
    await shell.page.getByRole('button', { name: '4x', exact: true }).click();
    expect(await video.evaluate(element => (element as HTMLVideoElement).playbackRate)).toBe(4);
    // At the end of the first video, playback continues with the next one.
    await video.evaluate(element => { const player = element as HTMLVideoElement; player.currentTime = player.duration - 0.05; void player.play(); });
    await expect(shell.page.getByRole('tablist', { name: 'Videos' }).getByRole('tab', { selected: true })).toContainText('2. ', { timeout: 15_000 });
    // The playback scheme serves ready copies by ID only.
    const refused = await shell.page.evaluate(() => new Promise<boolean>(resolve => {
      const probe = document.createElement('video');
      probe.onerror = () => resolve(true);
      probe.onloadedmetadata = () => resolve(false);
      probe.src = 'bat-media://proxy/../../etc/passwd';
    }));
    expect(refused).toBe(true);
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});
