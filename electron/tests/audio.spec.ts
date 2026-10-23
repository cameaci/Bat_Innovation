import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, quit, type RunningShell } from './shell-helpers';
import { addVideos, cleanupDraftShell, createSurvey, fixtures, goTo, openAt, previewReady, selectFiles, summarize } from './ui-helpers';

test.skip(process.platform !== 'linux', 'Media processing E2E is verified on Linux only.');

test('a full-spectrum WAV is anchored to a video frame and shown as a spectrogram with a heterodyne monitor', async () => {
  test.setTimeout(150_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-audio-e2e-'));
  const sources = fixtures<'two_dots' | 'tone_wav'>('tracking_fixtures', join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    await createSurvey(shell, 'Synthetic audio survey');
    await addVideos(shell, [sources.two_dots]);
    await summarize(shell);
    await selectFiles(shell, [sources.tone_wav]);
    await shell.page.getByRole('button', { name: 'Add audio (WAV)', exact: true }).click();
    const recordings = shell.page.getByRole('list', { name: 'Audio recordings', exact: true });
    await expect(recordings).toContainText('detector-45khz.wav');
    await expect(recordings).toContainText('384 kHz');
    await expect(recordings).toContainText('Not synchronised');
    await goTo(shell, 'Review');
    const view = await openAt(shell, 0);
    await view.getByLabel('Reviewer', { exact: true }).fill('Reviewer One');
    await previewReady(view);
    const audio = view.getByRole('region', { name: 'Audio', exact: true });
    await expect(audio).toContainText('not synchronised to this video');
    await audio.getByText('Set the sync anchor at the displayed frame', { exact: true }).click();
    await audio.getByLabel('The same moment in the audio (seconds)', { exact: true }).fill('0');
    await audio.getByRole('button', { name: 'Save anchor', exact: true }).click();
    await expect(audio).toContainText('drift not corrected');
    await audio.getByRole('button', { name: 'Show spectrogram', exact: true }).click();
    await expect(audio.getByRole('img', { name: /^Spectrogram, 0 to 192 kHz/ })).toBeVisible();
    await audio.getByRole('button', { name: 'Listen (heterodyne)', exact: true }).click();
    await expect.poll(() => audio.getByLabel('Heterodyne audio', { exact: true }).evaluate(element => (element as HTMLAudioElement).src.startsWith('blob:'))).toBe(true);
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});
