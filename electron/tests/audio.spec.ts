import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, quit, type RunningShell } from './shell-helpers';
import { addVideos, cleanupDraftShell, closeWindow, createSurvey, fixtures, goTo, openAt, previewReady, selectFiles, summarize, findTracks } from './ui-helpers';

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

test('a detector recording proposes its sync from file clocks only with a declared clock, and its call marks name the tracks on screen', async () => {
  test.setTimeout(150_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-calls-e2e-'));
  const sources = fixtures<'two_dots' | 'call_wav'>('tracking_fixtures', join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    await createSurvey(shell, 'Synthetic call survey');
    await addVideos(shell, [sources.two_dots]);
    await summarize(shell);
    await findTracks(shell);
    await selectFiles(shell, [sources.call_wav]);
    await shell.page.getByRole('button', { name: 'Add audio (WAV)', exact: true }).click();
    const recording = shell.page.getByRole('listitem', { name: 'Recording detector-calls.wav' });
    await expect(recording).toContainText('file says it started 2026-08-10T21:00:00+01:00 (GUANO, unverified)');
    await recording.getByLabel('Label for detector-calls.wav', { exact: true }).fill('Detector at the roost');
    await recording.getByRole('button', { name: 'Save label', exact: true }).click();
    await expect(recording).toContainText('Detector at the roost - detector-calls.wav');
    // Without a declared camera clock there is nothing to compare the file clock with.
    await recording.getByRole('button', { name: 'Propose sync from file clocks', exact: true }).click();
    await expect(recording.getByRole('status')).toContainText('Declare the recording clock');
    await goTo(shell, 'Review');
    const view = await openAt(shell, 0);
    await view.getByLabel('Reviewer', { exact: true }).fill('Reviewer One');
    await previewReady(view);
    const audio = view.getByRole('region', { name: 'Audio', exact: true });
    await audio.getByText('Set the sync anchor at the displayed frame', { exact: true }).click();
    await audio.getByLabel('The same moment in the audio (seconds)', { exact: true }).fill('0');
    await audio.getByRole('button', { name: 'Save anchor', exact: true }).click();
    await expect(audio).toContainText('drift not corrected');
    await closeWindow(view);
    await goTo(shell, 'Watch');
    const lanes = shell.page.getByRole('region', { name: 'Audio lanes' });
    await lanes.getByRole('button', { name: 'Find calls', exact: true }).click();
    await expect(lanes.getByLabel('Calls in Detector at the roost', { exact: true })).toHaveText('2 call marks in this video', { timeout: 60_000 });
    const lane = lanes.getByRole('img', { name: 'Audio lane Detector at the roost' });
    const box = (await lane.boundingBox())!;
    // The first call is 0.2 s into a 0.76 s clip.
    await shell.page.mouse.click(box.x + box.width * 0.2 / 0.76, box.y + box.height / 2);
    await expect(lanes.getByRole('status', { name: 'Tracks during call' })).toContainText('tracks #1, #2 were on screen');
    await shell.page.getByRole('tab', { name: 'Tracks', exact: true }).click();
    await expect(shell.page.getByRole('region', { name: 'Track table' }).getByRole('cell', { name: 'call', exact: true }).first()).toBeVisible();
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});
