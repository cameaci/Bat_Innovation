import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, quit, type RunningShell } from './shell-helpers';
import { addVideos, cleanupDraftShell, createSurvey, fixtures, goTo, summarize, findTracks } from './ui-helpers';

test.skip(process.platform !== 'linux', 'Media processing E2E is verified on Linux only.');

test('the reel asks only about uncertain tracks, and a quiet video watched end to end is marked in one step', async () => {
  test.setTimeout(180_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-reel-e2e-'));
  const sources = fixtures<'gappy' | 'quiet'>('tracking_fixtures', join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    await createSurvey(shell, 'Synthetic reel survey');
    await addVideos(shell, [sources.gappy, sources.quiet]);
    await summarize(shell);
    await findTracks(shell);
    await goTo(shell, 'Watch');
    const video = shell.page.getByLabel('Playback copy', { exact: true });
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    await shell.page.getByRole('tab', { name: 'Counts', exact: true }).click();
    await shell.page.getByLabel('Your name or initials', { exact: true }).fill('Reviewer One');
    await shell.page.getByRole('tab', { name: 'Review', exact: true }).click();
    await shell.page.getByRole('button', { name: 'Review 1 uncertain event', exact: true }).click();
    await expect(shell.page.getByRole('status', { name: 'Reel item' })).toContainText('Event 1 of 1: uncertain track #1');
    // The event loops at normal speed; deciding needs it to have played.
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused), { timeout: 10_000 }).toBe(false);
    await shell.page.waitForTimeout(1200);
    await shell.page.keyboard.press('b');
    await expect(shell.page.getByRole('status', { name: 'Reel item' })).toHaveCount(0, { timeout: 10_000 });
    await expect(shell.page.getByRole('button', { name: 'Review 0 uncertain events', exact: true })).toBeDisabled();
    // Watch the quiet second video from its first to its last frame at normal speed.
    await shell.page.getByRole('tablist', { name: 'Videos' }).getByRole('tab').nth(1).click();
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await expect(shell.page.getByLabel('Frame number', { exact: true })).toHaveText('frame 1');
    await shell.page.keyboard.press(' ');
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).ended), { timeout: 15_000 }).toBe(true);
    const mark = shell.page.getByRole('button', { name: /^Mark 1 watched window: no activity seen/ });
    await expect(mark).toBeEnabled({ timeout: 5_000 });
    await shell.page.keyboard.press('m');
    await expect(shell.page.getByLabel('Window progress', { exact: true })).toContainText('1 of 2 reviewed', { timeout: 15_000 });
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});
