import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, quit, type RunningShell } from './shell-helpers';
import { addVideos, cleanupDraftShell, createSurvey, displayedPTS, fixtures, goTo, previewReady, summarize } from './ui-helpers';

test.skip(process.platform !== 'linux', 'Media processing E2E is verified on Linux only.');

test('candidate tracks are reviewed in 6 s blocks with frame stepping and "not a bat + next"', async () => {
  test.setTimeout(150_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-events-e2e-'));
  const sources = fixtures<'two_dots'>('tracking_fixtures', join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    await createSurvey(shell, 'Synthetic events survey');
    await addVideos(shell, [sources.two_dots]);
    await summarize(shell);
    await shell.page.getByRole('button', { name: 'Find tracks', exact: true }).click();
    await expect(shell.page.getByRole('status').filter({ hasText: /^Tracking complete: 2 tracks/ })).toBeVisible({ timeout: 60_000 });
    await goTo(shell, 'Events');
    const page = shell.page;
    await expect(page.getByRole('status').filter({ hasText: /^0 of 2 candidates decided$/ })).toBeVisible();
    await page.getByLabel('Reviewer', { exact: true }).fill('Reviewer One');
    const body = page.locator('main');
    await previewReady(body);
    await expect(page.getByLabel('Clip length', { exact: true })).toHaveValue('6');
    const before = await displayedPTS(body);
    await page.getByRole('button', { name: 'Next frame', exact: true }).click();
    await expect.poll(() => displayedPTS(body)).not.toBe(before);
    await page.getByLabel('Playback speed', { exact: true }).selectOption({ label: '0.25x' });
    expect(await page.getByLabel('Derived source preview', { exact: true }).evaluate(video => (video as HTMLVideoElement).playbackRate)).toBe(0.25);
    await page.getByRole('button', { name: /^Not a bat \+ next/ }).click();
    await expect(page.getByRole('status').filter({ hasText: /^1 of 2 candidates decided$/ })).toBeVisible();
    await expect(page.getByText('Candidate 1 of 1: track', { exact: false })).toBeVisible();
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});
