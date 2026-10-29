import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, quit, type RunningShell } from './shell-helpers';
import { addVideos, cleanupDraftShell, createSurvey, fixtures, goTo, summarize, findTracks } from './ui-helpers';

test.skip(process.platform !== 'linux', 'Media processing E2E is verified on Linux only.');

test('a gate counts tracked bats live; a camera move pauses it for one reconfirmation before the count is accepted', async () => {
  test.setTimeout(180_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-counting-e2e-'));
  const sources = fixtures<'moved_camera'>('tracking_fixtures', join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    await createSurvey(shell, 'Synthetic counting survey');
    await addVideos(shell, [sources.moved_camera]);
    await summarize(shell);
    await findTracks(shell);
    await goTo(shell, 'Watch');
    const video = shell.page.getByLabel('Playback copy', { exact: true });
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    await shell.page.getByRole('tab', { name: 'Counts', exact: true }).click();
    await shell.page.getByLabel('Your name or initials', { exact: true }).fill('Reviewer One');
    // Draw a vertical line gate at x = 64 of the 128 x 96 frame.
    await shell.page.getByRole('button', { name: 'Draw a gate', exact: true }).click();
    const area = shell.page.getByLabel('Video drawing area', { exact: true });
    await area.scrollIntoViewIfNeeded();
    const box = (await area.boundingBox())!;
    const scale = Math.min(box.width / 128, box.height / 96), left = box.x + (box.width - 128 * scale) / 2, top = box.y + (box.height - 96 * scale) / 2;
    await shell.page.mouse.click(left + 64 * scale, top + 1 * scale);
    await shell.page.mouse.click(left + 64 * scale, top + 95 * scale);
    await shell.page.getByRole('button', { name: 'Save gate', exact: true }).click();
    const paused = shell.page.getByRole('list', { name: 'Paused gate spans' }).getByRole('listitem');
    await expect(paused).toHaveCount(1, { timeout: 15_000 });
    await expect(paused).toContainText('Camera moved');
    await expect(shell.page.getByLabel('Count quality', { exact: true })).toContainText('1 paused span');
    await expect(shell.page.getByRole('button', { name: 'Accept count', exact: true })).toBeDisabled();
    // The first target crossed before the move: the live tally counts it once the playhead has passed it.
    await video.evaluate(element => { (element as HTMLVideoElement).currentTime = 1.9; });
    await expect.poll(async () => Number(await shell!.page.getByLabel('Entered so far', { exact: true }).textContent()) +
      Number(await shell!.page.getByLabel('Exited so far', { exact: true }).textContent()), { timeout: 15_000 }).toBe(1);
    await paused.getByRole('button', { name: 'Reconfirm gate', exact: true }).click();
    await expect(shell.page.getByLabel('Count quality', { exact: true })).toContainText('0 paused spans');
    await shell.page.getByRole('button', { name: 'Accept count', exact: true }).click();
    await expect(shell.page.getByRole('button', { name: 'Accepted by Reviewer One', exact: true })).toBeVisible();
    // QA is an independent second person.
    await shell.page.getByRole('button', { name: 'Approve counts', exact: true }).click();
    await expect(shell.page.getByRole('alert').filter({ hasText: 'different person' })).toBeVisible();
    await shell.page.getByLabel('Your name or initials', { exact: true }).fill('QA Two');
    await shell.page.getByRole('button', { name: 'Approve counts', exact: true }).click();
    await expect(shell.page.getByText('QA approve by QA Two', { exact: true })).toBeVisible();
    // The emergence profile of the gate, per layer, with a typed sunset (not computed).
    const profile = shell.page.getByRole('region', { name: 'Emergence profile' });
    await expect(profile.getByLabel('Flow metrics', { exact: true })).toContainText(/First exit (video 1 at|none)/);
    await profile.getByRole('button', { name: 'QA', exact: true }).click();
    await expect(profile.getByRole('button', { name: 'QA', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await profile.getByLabel('Sunset time', { exact: true }).fill('21:04+01:00');
    await profile.getByLabel('Sunset source', { exact: true }).fill('Almanac for the site');
    await profile.getByRole('button', { name: 'Save sunset', exact: true }).click();
    await expect(profile).toContainText('Sunset 21:04+01:00 (Almanac for the site), entered by QA Two', { timeout: 15_000 });
    await expect(profile).toContainText('Declare the recording clock');
    await video.evaluate(element => { (element as HTMLVideoElement).currentTime = 4.3; });
    await expect.poll(async () => Number(await shell!.page.getByLabel('Entered so far', { exact: true }).textContent()) +
      Number(await shell!.page.getByLabel('Exited so far', { exact: true }).textContent()), { timeout: 15_000 }).toBe(2);
    // Sample check: count the whole clip by hand at 1x and compare with the proposal; counts stay as they are.
    await video.evaluate(element => { const player = element as HTMLVideoElement; player.pause(); player.currentTime = 0; });
    await expect(shell.page.getByLabel('Frame number', { exact: true })).toHaveText('frame 1', { timeout: 15_000 });
    await shell.page.getByRole('button', { name: 'Check a sample from here', exact: true }).click();
    await expect(shell.page.getByRole('status', { name: 'Sample check running' })).toBeVisible();
    await video.evaluate(element => { void (element as HTMLVideoElement).play(); });
    await shell.page.locator('body').press(']');
    await expect(shell.page.getByLabel('Presses so far', { exact: true })).toHaveText('0 entries, 1 exits');
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).ended), { timeout: 30_000 }).toBe(true);
    await shell.page.getByRole('button', { name: 'Finish and compare', exact: true }).click();
    const check = shell.page.getByRole('list', { name: 'Sample checks' }).getByRole('listitem');
    await expect(check).toHaveCount(1, { timeout: 15_000 });
    await expect(check).toContainText('by QA Two');
    await expect(check).toContainText(/You: 0 in, 1 out - algorithm: \d+ in, \d+ out/);
    // Site template: save this setup with its gate, apply it again, and the placed gate waits for one reconfirmation.
    await shell.page.getByRole('tab', { name: 'Setup', exact: true }).click();
    await shell.page.getByLabel('Template name', { exact: true }).fill('Synthetic roost');
    await shell.page.getByRole('button', { name: 'Save current setup', exact: true }).click();
    await expect(shell.page.getByRole('status', { name: 'Template message' })).toContainText('Saved "Synthetic roost" with 1 gate');
    await shell.page.getByRole('button', { name: 'Apply to this survey', exact: true }).click();
    await expect(shell.page.getByRole('status', { name: 'Template message' })).toContainText('1 gate placed');
    await shell.page.getByRole('tab', { name: 'Counts', exact: true }).click();
    await shell.page.getByLabel('Gate', { exact: true }).selectOption({ index: 1 });
    await expect(shell.page.getByRole('list', { name: 'Paused gate spans' })).toContainText('comes from a site template', { timeout: 15_000 });
    // A bent line of three points is a third gate; all gates are counted together, each reviewed on its own.
    await shell.page.getByRole('button', { name: 'New gate', exact: true }).click();
    await shell.page.getByLabel('Gate name', { exact: true }).fill('Bent edge');
    await area.scrollIntoViewIfNeeded();
    const box2 = (await area.boundingBox())!;
    const scale2 = Math.min(box2.width / 128, box2.height / 96), left2 = box2.x + (box2.width - 128 * scale2) / 2, top2 = box2.y + (box2.height - 96 * scale2) / 2;
    for (const [x, y] of [[40, 2], [40, 48], [90, 94]]) await shell.page.mouse.click(left2 + x * scale2, top2 + y * scale2);
    await expect(shell.page.getByText('3 points placed.', { exact: true })).toBeVisible();
    await expect(shell.page.getByRole('list', { name: 'Active gates' }).getByRole('listitem')).toHaveCount(2);
    await shell.page.getByRole('button', { name: 'Save gate', exact: true }).click();
    await expect(shell.page.getByLabel('Gate', { exact: true }).getByRole('option')).toHaveCount(3, { timeout: 15_000 });
    await shell.page.getByLabel('Gate', { exact: true }).selectOption({ label: 'Bent edge' });
    await expect(shell.page.getByRole('region', { name: 'Emergence profile' })).toContainText('Emergence profile: Bent edge');
    // A highlights video with the overlay burnt in, saved through the native dialog and checked against its hash.
    await goTo(shell, 'Export');
    const videos = shell.page.getByRole('region', { name: 'Review videos' });
    await videos.getByRole('button', { name: 'Render video', exact: true }).click();
    const rendered = videos.getByRole('list', { name: 'Rendered videos' }).getByRole('listitem').first();
    await expect(rendered).toContainText('source frames drawn', { timeout: 60_000 });
    const target = join(directory, 'highlights.webm');
    await shell.application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog; }, target);
    await rendered.getByRole('button', { name: 'Save video...', exact: true }).click();
    await expect(videos.getByRole('status')).toHaveText(`Saved ${target}`);
    expect((await stat(target)).size).toBeGreaterThan(1000);
    // The PDF evidence report is printed from a script-free page and saved through the native dialog.
    const pdf = join(directory, 'report.pdf');
    await shell.application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog; }, pdf);
    const reportCard = shell.page.getByRole('region', { name: 'Evidence report' });
    await reportCard.getByRole('button', { name: 'Save PDF report...', exact: true }).click();
    await expect(reportCard.getByRole('status')).toHaveText(`Saved ${pdf}`, { timeout: 30_000 });
    expect((await readFile(pdf)).subarray(0, 5).toString()).toBe('%PDF-');
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});
