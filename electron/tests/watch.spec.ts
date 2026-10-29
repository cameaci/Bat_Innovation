import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, quit, type RunningShell } from './shell-helpers';
import { addVideos, cleanupDraftShell, createSurvey, fixtures, goTo, summarize, findTracks } from './ui-helpers';

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
    await findTracks(shell);
    await goTo(shell, 'Watch');
    const video = shell.page.getByLabel('Playback copy', { exact: true });
    await expect(video).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    // Seek to the middle of the clip: both synthetic dots are tracked there.
    await video.evaluate(element => { (element as HTMLVideoElement).currentTime = 0.2; });
    await expect(shell.page.getByLabel('Tracks at this frame', { exact: true })).toHaveText('2', { timeout: 15_000 });
    // Marker styles, hidden noise and the count board are one click or key away.
    for (const name of ['Boxes', 'Dots', 'Rings']) {
      await shell.page.getByRole('button', { name, exact: true }).click();
      await expect(shell.page.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(shell.page.getByLabel('Tracks at this frame', { exact: true })).toHaveText('2');
    }
    await expect(shell.page.getByRole('button', { name: 'Noise hidden', exact: true })).toBeVisible();
    await expect(shell.page.getByRole('button', { name: 'Count board (C)', exact: true })).toHaveText('Board: band (C)');
    await shell.page.keyboard.press('c');
    await expect(shell.page.getByRole('button', { name: 'Count board (C)', exact: true })).toHaveText('Board: corner (C)');
    await expect(shell.page.getByRole('status', { name: 'Display limit' })).toHaveCount(0);
    const frameLabel = shell.page.getByLabel('Frame number', { exact: true });
    await expect(frameLabel).toHaveText(/^frame \d+$/);
    const before = await frameLabel.textContent();
    await shell.page.keyboard.press('.');
    await expect(frameLabel).toHaveText(`frame ${Number(before!.slice(6)) + 1}`);
    // The track table lists every track; a group label is one action, and undo restores the earlier state.
    await shell.page.getByRole('tab', { name: 'Counts', exact: true }).click();
    await shell.page.getByLabel('Your name or initials', { exact: true }).fill('Reviewer One');
    await shell.page.getByRole('tab', { name: 'Tracks', exact: true }).click();
    const table = shell.page.getByRole('region', { name: 'Track table' });
    await table.getByRole('checkbox', { name: 'This video', exact: true }).check();
    await expect(table.getByLabel('Track table summary')).toHaveText(/^2 of \d+ shown, 0 selected$/);
    // Select by area: a polygon around the whole frame picks both tracks of this video.
    await table.getByRole('button', { name: 'Select by area', exact: true }).click();
    await expect(shell.page.getByRole('button', { name: /^Map: all tracks/ })).toBeVisible();
    const area = shell.page.getByLabel('Video drawing area', { exact: true });
    await area.scrollIntoViewIfNeeded();
    const box = (await area.boundingBox())!;
    const scale = Math.min(box.width / 128, box.height / 96), left = box.x + (box.width - 128 * scale) / 2, top = box.y + (box.height - 96 * scale) / 2;
    for (const [x, y] of [[1, 1], [127, 1], [127, 95], [1, 95]]) await shell.page.mouse.click(left + x * scale, top + y * scale);
    await shell.page.keyboard.press('Enter');
    await expect(table.getByLabel('Track table summary')).toHaveText(/^2 of \d+ shown, 2 selected$/);
    await table.getByLabel('Species', { exact: true }).fill('Pipistrellus pygmaeus');
    await table.getByRole('button', { name: 'Label 2 tracks', exact: true }).click();
    await expect(table.getByRole('status', { name: 'Label message' })).toHaveText('Labelled 2 tracks as exit.');
    await expect(table.getByRole('row').filter({ hasText: 'Pipistrellus pygmaeus' })).toHaveCount(2);
    await table.getByRole('button', { name: 'Undo label exit', exact: true }).click();
    await expect(table.getByRole('row').filter({ hasText: 'Pipistrellus pygmaeus' })).toHaveCount(0);
    // A row goes to the track's first frame.
    await table.getByRole('row').nth(1).click();
    await expect(table.getByRole('row').nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(shell.page.getByLabel('Tracks at this frame', { exact: true })).not.toHaveText('0', { timeout: 15_000 });
    // Three synchronised views of the same frame, side by side by default; V switches to one large view.
    for (const name of ['Bats view', 'Flight map view', 'Count view']) await expect(shell.page.getByRole('region', { name, exact: true })).toBeVisible();
    await expect(shell.page.getByRole('img', { name: 'Survey timeline', exact: true })).toBeVisible();
    await shell.page.keyboard.press('v');
    await expect(shell.page.getByRole('region', { name: 'Flight map view', exact: true })).toHaveCount(0);
    await shell.page.getByRole('button', { name: 'Flight map', exact: true }).click();
    await expect(shell.page.getByRole('region', { name: 'Flight map view', exact: true })).toBeVisible();
    await shell.page.getByRole('button', { name: 'Bats', exact: true }).click();
    // The enhanced view is prepared on demand and replaces the picture at the same source time.
    await shell.page.keyboard.press('e');
    const enhancedStatus = shell.page.getByRole('status', { name: 'Enhanced view status' });
    await expect(enhancedStatus).toContainText('no enhanced view yet');
    await enhancedStatus.getByRole('button', { name: 'Prepare enhanced view', exact: true }).click();
    await expect(enhancedStatus).toContainText('A derived display, not evidence', { timeout: 60_000 });
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await video.evaluate(element => { (element as HTMLVideoElement).currentTime = 0.2; });
    await expect(shell.page.getByLabel('Tracks at this frame', { exact: true })).toHaveText('2', { timeout: 15_000 });
    await shell.page.keyboard.press('e');
    await expect(enhancedStatus).toHaveCount(0);
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
