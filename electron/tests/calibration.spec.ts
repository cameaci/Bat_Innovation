import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { TrackingRun } from '../src/contracts';
import { launch, quit, type RunningShell } from './shell-helpers';
import { addVideos, cleanupDraftShell, createSurvey, fixtures, goTo, summarize } from './ui-helpers';

test.skip(process.platform !== 'linux', 'Media processing E2E is verified on Linux only.');

test('tracking is set up on the footage: draw an excluded zone, test 10 s, then track the survey with those settings', async () => {
  test.setTimeout(150_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-calibration-e2e-'));
  const sources = fixtures<'two_dots'>('tracking_fixtures', join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    const sessionID = await createSurvey(shell, 'Synthetic calibration survey');
    await addVideos(shell, [sources.two_dots]);
    await summarize(shell);
    await goTo(shell, 'Watch');
    const video = shell.page.getByLabel('Playback copy', { exact: true });
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    await shell.page.getByRole('tab', { name: 'Setup', exact: true }).click();
    // Exclude the lower half of the frame, where the second dot flies.
    await shell.page.getByRole('button', { name: 'Exclude a zone', exact: true }).click();
    const area = shell.page.getByLabel('Video drawing area', { exact: true });
    await area.scrollIntoViewIfNeeded();
    const box = (await area.boundingBox())!;
    const scale = Math.min(box.width / 128, box.height / 96), left = box.x + (box.width - 128 * scale) / 2, top = box.y + (box.height - 96 * scale) / 2;
    for (const [x, y] of [[1, 50], [127, 50], [127, 95], [1, 95]] as const) await shell.page.mouse.click(left + x * scale, top + y * scale);
    await shell.page.getByRole('button', { name: 'Finish shape', exact: true }).click();
    await expect(shell.page.getByRole('list', { name: 'Search areas and excluded zones' })).toContainText('Excluded zone 1 (4 points)');
    await video.evaluate(element => { (element as HTMLVideoElement).currentTime = 0; });
    await shell.page.getByRole('button', { name: 'Test 10 s from here', exact: true }).click();
    await expect(shell.page.getByRole('status', { name: 'Test result' })).toContainText('1 stable track', { timeout: 60_000 });
    await shell.page.getByRole('button', { name: 'Looks good - track whole survey', exact: true }).click();
    await expect.poll(async () => {
      const runs = await shell!.page.evaluate(async id => {
        const api = (window as unknown as { batAPI: { listSummaryRuns: (id: string) => Promise<{ ok: boolean; value: { id: string }[] }>; listTracking: (id: string) => Promise<{ ok: boolean; value: TrackingRun[] }> } }).batAPI;
        const summaries = await api.listSummaryRuns(id);
        return (await api.listTracking(summaries.value[0]!.id)).value;
      }, sessionID);
      return runs[0]?.state === 'complete' ? JSON.stringify((runs[0].parameters as { settings: { exclusions: unknown[] } }).settings.exclusions.length) + runs[0].track_counts : 'waiting';
    }, { timeout: 60_000 }).toMatch(/^1/);
    await shell.page.getByRole('tab', { name: 'Tracks', exact: true }).click();
    await video.evaluate(element => { (element as HTMLVideoElement).currentTime = 0.2; });
    await expect(shell.page.getByLabel('Tracks at this frame', { exact: true })).toHaveText('1', { timeout: 15_000 });
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});
