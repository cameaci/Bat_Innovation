import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, quit, type RunningShell } from './shell-helpers';
import { addVideos, cleanupDraftShell, closeWindow, createSurvey, digests, expand, findTracks, goTo,
  latestRun, openAt, openSurvey, previewReady, savedReview, summarize, windowCards } from './ui-helpers';

// Opt in only with authorised local footage. Paths and captured evidence never belong in Git.
const configured = process.env.BAT_UI_TEST_MEDIA;
const artifacts = process.env.BAT_UI_TEST_ARTIFACTS;
const media = configured ? JSON.parse(configured) as { path: string; modality: 'active_ir' | 'rendered_thermal' }[] : [];

test.skip(process.platform !== 'win32' || !configured || !artifacts, 'Requires explicitly selected local Windows footage and an external artifact directory.');

for (const [index, source] of media.entries()) {
  test(`local Windows footage ${index + 1}: full desktop review and provisional outputs`, async () => {
    test.setTimeout(300_000);
    expect(isAbsolute(source.path)).toBe(true);
    expect(['active_ir', 'rendered_thermal']).toContain(source.modality);
    const output = resolve(artifacts!);
    const fromRepo = relative(resolve('.'), output);
    expect(fromRepo.startsWith('..') || isAbsolute(fromRepo), 'Private outputs must stay outside the checkout').toBe(true);
    await mkdir(output, { recursive: true });
    const directory = await mkdtemp(join(tmpdir(), 'bat-local-ux-'));
    const data = join(directory, 'data');
    const name = `Local technical review ${index + 1}`;
    const before = await digests([source.path]);
    const errors: string[] = [];
    let shell: RunningShell | undefined;
    const capture = async (label: string) => {
      await expect.poll(() => shell!.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        { message: 'The desktop page must not overflow horizontally at 1536 x 960' }).toBe(true);
      await shell!.page.screenshot({ path: join(output, `footage-${index + 1}-${label}.png`), fullPage: true });
    };
    try {
      shell = await launch(data);
      shell.page.on('pageerror', error => errors.push(error.message));
      await shell.application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.setContentSize(1536, 960);
      });
      await capture('surveys');
      const sessionID = await createSurvey(shell, name, 'Local technical test');
      await shell.page.getByLabel('Video type', { exact: true }).selectOption(source.modality);
      await addVideos(shell, [source.path]);
      await capture('import');
      await summarize(shell, /^Run complete:/);
      await findTracks(shell);
      await capture('process');
      const run = await latestRun(shell, sessionID);
      expect(run.counts.complete).toBe(run.counts.planned);
      expect(run.windows.length).toBeGreaterThan(0);
      await goTo(shell, 'Watch');
      const video = shell.page.getByLabel('Playback copy', { exact: true });
      await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState),
        { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
      await video.evaluate(element => {
        const player = element as HTMLVideoElement;
        player.currentTime = Math.min(1, player.duration / 2);
      });
      await shell.page.getByRole('button', { name: '4x', exact: true }).click();
      expect(await video.evaluate(element => (element as HTMLVideoElement).playbackRate)).toBe(4);
      await video.evaluate(async element => { await (element as HTMLVideoElement).play(); });
      await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(1);
      await video.evaluate(element => (element as HTMLVideoElement).pause());
      await capture('watch');
      await goTo(shell, 'Review');
      await expect(windowCards(shell)).toHaveCount(run.windows.length);
      await capture('gallery');
      const view = await openAt(shell, 0);
      await previewReady(view);
      const trackList = view.getByRole('list', { name: 'Tracks in this window', exact: true });
      if (await trackList.count()) {
        expect(await trackList.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(160);
      }
      await view.getByLabel('Reviewer', { exact: true }).fill('Technical UI test');
      await expand(view, 'Unable to assess, undo, history');
      await view.getByLabel('Unable-to-assess note', { exact: true }).fill('Technical workflow test only. No ecological assessment was performed.');
      await view.getByRole('button', { name: 'Save unable-to-assess note', exact: true }).click();
      await expect.poll(async () => (await savedReview(shell!, run.windows[0]!.id)).revision).toBe(1);
      expect((await savedReview(shell, run.windows[0]!.id)).effective_decision).toBe('unreviewed');
      await capture('review');
      await closeWindow(view);
      await goTo(shell, 'Export');
      const report = shell.page.getByRole('region', { name: 'Evidence report' });
      await shell.application.evaluate(({ dialog }) => {
        dialog.showSaveDialog = (async () => ({ canceled: true, filePath: '' })) as typeof dialog.showSaveDialog;
      });
      await report.getByRole('button', { name: 'Save PDF report...', exact: true }).click();
      await expect(report.getByRole('button', { name: 'Save PDF report...', exact: true })).toBeEnabled();
      const pdf = join(output, `footage-${index + 1}-report.pdf`);
      await shell.application.evaluate(({ dialog }, file) => {
        dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
      }, pdf);
      await report.getByRole('button', { name: 'Save PDF report...', exact: true }).click();
      await expect(report.getByRole('status')).toHaveText(`Saved ${pdf}`, { timeout: 30_000 });
      expect((await readFile(pdf)).subarray(0, 5).toString()).toBe('%PDF-');
      const csv = shell.page.getByRole('region', { name: 'Provisional CSV export', exact: true });
      await csv.getByRole('checkbox').check();
      await csv.getByRole('button', { name: 'Export provisional CSVs', exact: true }).click();
      await expect(csv.getByRole('button', { name: 'Save provisional CSV bundle...', exact: true })).toBeEnabled({ timeout: 60_000 });
      const destination = join(output, `footage-${index + 1}-csv`);
      await mkdir(destination, { recursive: true });
      await shell.application.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
      }, destination);
      await csv.getByRole('button', { name: 'Save provisional CSV bundle...', exact: true }).click();
      await expect(shell.page.getByText(/^Saved in a new folder named /)).toBeVisible();
      const folders = await readdir(destination);
      expect(folders).toHaveLength(1);
      expect(await readdir(join(destination, folders[0]!))).toEqual([
        'manifest.json', 'provisional-counts.csv', 'provisional-observations.csv', 'provisional-tracks.csv', 'technical-window-audit.csv',
      ]);
      await capture('export');
      await quit(shell); shell = undefined;
      shell = await launch(data);
      await openSurvey(shell, name, 'Review');
      expect((await savedReview(shell, run.windows[0]!.id)).revision).toBe(1);
      await quit(shell); shell = undefined;
      expect(await digests([source.path]), 'The real original must remain byte-identical').toEqual(before);
      expect(errors).toEqual([]);
    } finally {
      await cleanupDraftShell(shell);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
