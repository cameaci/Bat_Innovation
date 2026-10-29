import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, quit, type RunningShell } from './shell-helpers';
import { addVideos, cleanupDraftShell, createSurvey, fixtures, getMedia, goTo, openAt, summarize, videos, windowCards } from './ui-helpers';

test.skip(process.platform !== 'linux', 'Media processing E2E is verified on Linux only.');

test('rendered thermal video is declared at import and labelled as not temperature throughout review', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-thermal-e2e-'));
  const sources = fixtures<'quiet_9'>('summary_fixtures', join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    const sessionID = await createSurvey(shell, 'Synthetic thermal survey');
    await shell.page.getByLabel('Video type', { exact: true }).selectOption('rendered_thermal');
    await addVideos(shell, [sources.quiet_9]);
    await expect(videos(shell).first()).toContainText('Rendered thermal');
    await expect(videos(shell).first()).toContainText('Rendered thermal - no radiometric temperature analysis.');
    expect((await getMedia(shell, sessionID)).segments[0]).toMatchObject({ modality: 'rendered_thermal', modality_provenance: 'declared at import' });
    await summarize(shell);
    await goTo(shell, 'Review');
    await expect(windowCards(shell).first()).toContainText('Rendered thermal');
    const view = await openAt(shell, 0);
    await expect(view.getByText('Rendered thermal - no radiometric temperature analysis.', { exact: true })).toBeVisible();
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});
