import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { launch, quit, type RunningShell } from './shell-helpers';
import { addVideos, cleanupDraftShell, closeWindow, createSurvey, fixtures, goTo, openAt, previewReady, summarize } from './ui-helpers';

test.skip(process.platform !== 'linux', 'Media processing E2E is verified on Linux only.');

/** Click a point given in original source pixels on the gate drawing area. */
async function clickSource(view: Locator, x: number, y: number): Promise<void> {
  const area = view.getByRole('img', { name: 'Gate drawing area', exact: true });
  const point = await area.evaluate((svg, [sx, sy]) => {
    const matrix = (svg as SVGSVGElement).getScreenCTM()!;
    const screen = new DOMPoint(sx, sy).matrixTransform(matrix);
    return { x: screen.x, y: screen.y };
  }, [x, y] as const);
  await view.page().mouse.click(point.x, point.y);
}

test('a drawn gate yields separate algorithm, reviewer and QA counts with audit', async () => {
  test.setTimeout(150_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-gates-e2e-'));
  const sources = fixtures<'two_dots'>('tracking_fixtures', join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    await createSurvey(shell, 'Synthetic gate survey');
    await addVideos(shell, [sources.two_dots]);
    await summarize(shell);
    await shell.page.getByRole('button', { name: 'Find tracks', exact: true }).click();
    await expect(shell.page.getByRole('status').filter({ hasText: /^Tracking complete: 2 tracks/ })).toBeVisible({ timeout: 60_000 });
    await goTo(shell, 'Review');
    const view = await openAt(shell, 0);
    await view.getByLabel('Reviewer', { exact: true }).fill('Reviewer One');
    await previewReady(view);
    await view.getByRole('button', { name: 'Draw a gate', exact: true }).click();
    await view.getByLabel('Gate name', { exact: true }).fill('Synthetic gap');
    await view.getByLabel('Side A means', { exact: true }).fill('Inside roost');
    await view.getByLabel('Side B means', { exact: true }).fill('Outside');
    await clickSource(view, 64, 2);
    await clickSource(view, 64, 94);
    await expect(view.getByRole('status').filter({ hasText: /^2 points placed\.$/ })).toBeVisible();
    await view.getByRole('button', { name: 'Save gate', exact: true }).click();
    await expect(view.getByRole('list', { name: 'Active gates', exact: true })).toContainText('Synthetic gap');
    await closeWindow(view);

    await goTo(shell, 'Counts');
    const algorithm = shell.page.getByRole('region', { name: 'Algorithm (unverified)', exact: true });
    await expect(algorithm.getByRole('status')).toHaveText('Entered 1 · Exited 1 · Net 0');
    const crossings = shell.page.getByRole('list', { name: 'Gate crossings', exact: true }).getByRole('listitem');
    await expect(crossings).toHaveCount(2);
    await shell.page.getByLabel('Reviewer', { exact: true }).fill('Reviewer One');
    await crossings.first().getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(crossings.first()).toContainText('Confirmed · count 1');
    const reviewer = shell.page.getByRole('region', { name: 'Reviewer-adjusted', exact: true });
    await expect(reviewer).toContainText('1 of 2 crossings reviewed');
    const qa = shell.page.getByRole('region', { name: 'QA-approved', exact: true });
    await qa.getByLabel('QA reviewer', { exact: true }).fill('reviewer one');
    await qa.getByRole('button', { name: 'Approve reviewed counts', exact: true }).click();
    await expect(shell.page.getByRole('alert').filter({ hasText: 'different person' })).toBeVisible();
    await qa.getByLabel('QA reviewer', { exact: true }).fill('QA Two');
    await qa.getByRole('button', { name: 'Approve reviewed counts', exact: true }).click();
    await expect(qa.getByRole('status')).toHaveText(/^Entered [01] · Exited [01] · Net -?[01]$/);
    await expect(algorithm.getByRole('status')).toHaveText('Entered 1 · Exited 1 · Net 0');
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});
