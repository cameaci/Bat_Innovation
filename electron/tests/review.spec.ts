import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { BatAPI } from '../src/contracts';
import { launch, quit, type RunningShell } from './shell-helpers';
import { cleanupDraftShell, closeWindow as close, digests, expand, fixtures, goTo, latestRun, openAt as open, openSurvey, preparedReview,
  previewReady, reviewProgress as progress, savedReview, windowCards } from './ui-helpers';

type Fixture = 'quiet_65' | 'quiet_9' | 'empty_middle' | 'brightness_9' | 'single';
const SURVEY = 'Synthetic first review';
const prepared = (shell: RunningShell, paths: string[]) => preparedReview(shell, paths, SURVEY);

test.skip(process.platform !== 'linux', 'First-review media processing and Electron lifecycle are locally verified on Linux only.');

test('explicit first review keeps all quiet and incomplete windows visible with zero-to-many audited observations', async () => {
  test.setTimeout(150_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-review-e2e-'));
  const sources = fixtures<Fixture>('summary_fixtures', join(directory, 'originals'));
  const paths = [sources.quiet_65, sources.empty_middle];
  const before = await digests(paths);
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    const sessionID = await prepared(shell, paths);
    await expect(progress(shell, 0, 6)).toBeVisible();
    await expect(windowCards(shell)).toHaveCount(6);
    const run = await latestRun(shell, sessionID);
    expect(run.windows).toHaveLength(6);
    const first = run.windows[0]!;
    expect(await savedReview(shell, first.id)).toMatchObject({ revision: 0, decision: 'unreviewed', effective_decision: 'unreviewed', observations: [] });

    let view = await open(shell, 0);
    await expect(view.getByText('1 of 6', { exact: true })).toBeVisible();
    await view.getByRole('button', { name: 'Next window', exact: true }).click();
    await expect(view.getByText('2 of 6', { exact: true })).toBeVisible();
    await view.getByRole('button', { name: 'Previous window', exact: true }).click();
    await expect(view.getByText('1 of 6', { exact: true })).toBeVisible();
    expect((await savedReview(shell, first.id)).revision, 'Navigation alone never writes a review').toBe(0);

    await view.getByLabel('Reviewer', { exact: true }).fill('Synthetic reviewer');
    await view.getByRole('button', { name: /^Add observation/ }).click();
    await expand(view, 'Exact source PTS');
    const start = await view.getByLabel('Observation start source PTS', { exact: true }).inputValue();
    expect(start).toMatch(/^-?\d+$/);
    await view.getByLabel('Observation end source PTS (exclusive)', { exact: true }).fill(String(BigInt(start) + 1n));
    await view.getByLabel('Notes', { exact: true }).fill('Synthetic weak visual evidence');
    await view.getByRole('button', { name: 'Save observation', exact: true }).click();
    const observations = view.getByRole('list', { name: 'Saved provisional observations', exact: true });
    await expect(observations.getByRole('listitem')).toHaveCount(1);
    await expect(observations).toContainText('Count unknown');
    await expect(observations).toContainText('uncertain');
    expect((await savedReview(shell, first.id)).decision, 'An observation is not a decision').toBe('unreviewed');

    // A cancelled observation draft leaves no audit record.
    await view.getByRole('button', { name: /^Add observation/ }).click();
    await view.getByLabel('Notes', { exact: true }).fill('Discarded synthetic note');
    await view.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(view.getByLabel('Notes', { exact: true })).toHaveCount(0);
    expect((await savedReview(shell, first.id)).revision).toBe(1);

    await view.getByRole('button', { name: /^Add observation/ }).click();
    await expand(view, 'Exact source PTS');
    await view.getByLabel('Observation start source PTS', { exact: true }).fill(start);
    await view.getByLabel('Observation end source PTS (exclusive)', { exact: true }).fill(String(BigInt(start) + 2n));
    await view.getByLabel('What moved', { exact: true }).selectOption('insect');
    await view.getByLabel('Count', { exact: true }).fill('2');
    await view.getByRole('button', { name: 'Save observation', exact: true }).click();
    await expect(observations.getByRole('listitem')).toHaveCount(2);
    await observations.getByRole('listitem').first().getByRole('button', { name: 'Edit observation', exact: true }).click();
    await view.getByLabel('Behaviour (optional)', { exact: true }).fill('Synthetic uncertain passing');
    await view.getByRole('button', { name: 'Save observation', exact: true }).click();
    await expect(observations.getByRole('listitem').first()).toContainText('Synthetic uncertain passing');
    await observations.getByRole('listitem').last().getByRole('button', { name: 'Delete observation', exact: true }).click();
    await expect(observations.getByRole('listitem')).toHaveCount(1);

    // The decision needs a ready preview of this exact window (the review receipt).
    await previewReady(view);
    await view.getByRole('button', { name: 'Mark reviewed with observations', exact: true }).click();
    await expect.poll(async () => (await savedReview(shell!, first.id)).decision).toBe('reviewed_with_observations');
    await view.getByRole('button', { name: 'Next unreviewed window', exact: true }).click();
    await expect(view.getByText('2 of 6', { exact: true })).toBeVisible();
    await expect(view.getByLabel('Reviewer', { exact: true }), 'The reviewer label carries across windows').toHaveValue('Synthetic reviewer');
    await expand(view, 'Unable to assess, undo, history');
    await view.getByLabel('Unable-to-assess note', { exact: true }).fill('Synthetic uncertainty remains unresolved');
    await view.getByRole('button', { name: 'Save unable-to-assess note', exact: true }).click();
    await expect.poll(async () => (await savedReview(shell!, run.windows[1]!.id)).revision).toBe(1);
    expect((await savedReview(shell, run.windows[1]!.id)).effective_decision, 'Unable to assess is a note, not a review').toBe('unreviewed');

    await view.getByRole('button', { name: 'Previous window', exact: true }).click();
    await expect(view.getByText('1 of 6', { exact: true })).toBeVisible();
    await expand(view, 'Unable to assess, undo, history');
    await view.getByRole('button', { name: 'Show review history', exact: true }).click();
    await expect(view.getByText('Review history (5 shown)', { exact: true })).toBeVisible();
    await close(view);
    await expect(progress(shell, 1, 6)).toBeVisible();
    const persisted = await savedReview(shell, first.id);
    expect(persisted.observations).toHaveLength(1);
    expect(persisted.observations[0]).toMatchObject({ start_pts: start, end_pts: String(BigInt(start) + 1n), count: null, uncertain: true });

    await quit(shell); shell = undefined;
    shell = await launch(join(directory, 'data'));
    await openSurvey(shell, SURVEY, 'Review');
    await expect(progress(shell, 1, 6)).toBeVisible();
    expect(await savedReview(shell, first.id)).toEqual(persisted);

    // A new processing run starts with every window unreviewed again.
    await goTo(shell, 'Process');
    await shell.page.getByRole('button', { name: 'Generate motion summaries', exact: true }).click();
    await expect.poll(async () => {
      const latest = await latestRun(shell!, sessionID);
      return latest.id !== run.id && latest.state !== 'running' && latest.state !== 'queued';
    }, { timeout: 60_000 }).toBe(true);
    await goTo(shell, 'Review');
    await expect(progress(shell, 0, 6)).toBeVisible();
    expect((await latestRun(shell, sessionID)).review_progress?.reviewed).toBe(0);
    expect(await digests(paths), 'Review, preview and new runs must leave original bytes unchanged').toEqual(before);
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});

test('dirty review drafts survive stale saves and cancelled native close, reload and quit', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-review-dirty-e2e-'));
  const sources = fixtures<Fixture>('summary_fixtures', join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    const sessionID = await prepared(shell, [sources.quiet_65]);
    const first = (await latestRun(shell, sessionID)).windows[0]!;
    const view = await open(shell, 0);
    await view.getByLabel('Reviewer', { exact: true }).fill('Synthetic draft reviewer');
    await view.getByRole('button', { name: /^Add observation/ }).click();
    await expand(view, 'Exact source PTS');
    const start = await view.getByLabel('Observation start source PTS', { exact: true }).inputValue();
    await view.getByLabel('Observation end source PTS (exclusive)', { exact: true }).fill(String(BigInt(start) + 1n));
    await view.getByLabel('Notes', { exact: true }).fill('Draft must survive cancelled close');

    await view.getByRole('button', { name: 'Next window', exact: true }).click();
    await expect(view.getByRole('alert').filter({ hasText: 'Save or discard your changes before moving to another window.' })).toBeVisible();
    await expect(view.getByText('1 of 3', { exact: true })).toBeVisible();
    // The in-app close asks first; declining keeps the draft.
    await shell.page.evaluate(() => { window.confirm = () => false; });
    await view.getByRole('button', { name: 'Close window', exact: true }).click();
    await expect(view.getByLabel('Notes', { exact: true })).toHaveValue('Draft must survive cancelled close');

    // Only the physical native confirmation return is substituted; main-process close guards run normally.
    await shell.application.evaluate(({ dialog }) => {
      const state = { calls: 0, response: 0, buttons: [] as string[] };
      (globalThis as unknown as { reviewDialog: typeof state }).reviewDialog = state;
      dialog.showMessageBoxSync = ((...args: unknown[]) => {
        const options = args.at(-1) as { buttons?: string[] };
        state.calls += 1; state.buttons = options.buttons ?? [];
        return state.response;
      }) as typeof dialog.showMessageBoxSync;
    });
    const calls = () => shell!.application.evaluate(() => (globalThis as unknown as { reviewDialog: { calls: number } }).reviewDialog.calls);
    await shell.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await expect.poll(calls).toBe(1);
    await expect(view.getByLabel('Notes', { exact: true })).toHaveValue('Draft must survive cancelled close');
    await shell.application.evaluate(({ app }) => { app.quit(); });
    await expect.poll(calls).toBe(2);
    await shell.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.reload());
    await expect.poll(calls).toBe(3);
    await expect(view.getByLabel('Notes', { exact: true })).toHaveValue('Draft must survive cancelled close');
    expect(await shell.page.evaluate(() => (window as unknown as { batAPI: BatAPI }).batAPI.health())).toMatchObject({ ok: true, value: { status: 'ok' } });

    const external = await shell.page.evaluate(id => (window as unknown as { batAPI: BatAPI }).batAPI.saveReview(id, {
      actor: 'Another synthetic reviewer', expected_revision: 0, action: 'unable_to_assess', note: 'External revision',
    }), first.id);
    expect(external.ok).toBe(true);
    await view.getByRole('button', { name: 'Save observation', exact: true }).click();
    await expect(view.getByRole('alert').filter({ hasText: /changed|conflict|revision/i }).first()).toBeVisible();
    await expect(view.getByLabel('Notes', { exact: true })).toHaveValue('Draft must survive cancelled close');
    expect((await savedReview(shell, first.id)).observations).toEqual([]);

    // Stop the real backend before dispatching save, then kill it with that request
    // outstanding. No successful action or unavailable response is substituted.
    process.kill(shell.backendPid, 'SIGSTOP');
    await view.getByRole('button', { name: 'Save observation', exact: true }).click();
    process.kill(shell.backendPid, 'SIGKILL');
    await expect(view.getByRole('alert').filter({ hasText: /^Backend unavailable\./ }).first()).toBeVisible();
    await expect(view.getByLabel('Reviewer', { exact: true })).toHaveValue('Synthetic draft reviewer');
    await expect(view.getByLabel('Observation start source PTS', { exact: true })).toHaveValue(start);
    await expect(view.getByLabel('Observation end source PTS (exclusive)', { exact: true })).toHaveValue(String(BigInt(start) + 1n));
    await expect(view.getByLabel('Notes', { exact: true })).toHaveValue('Draft must survive cancelled close');
    await shell.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await expect.poll(calls).toBe(4);
    await expect(view.getByLabel('Notes', { exact: true })).toHaveValue('Draft must survive cancelled close');
    expect(await shell.application.evaluate(() => (globalThis as unknown as { reviewDialog: { buttons: string[] } }).reviewDialog.buttons))
      .toEqual(['Keep editing', 'Discard draft']);
    await shell.application.evaluate(() => { (globalThis as unknown as { reviewDialog: { response: number } }).reviewDialog.response = 1; });
    await quit(shell); shell = undefined;

    shell = await launch(join(directory, 'data'));
    await openSurvey(shell, SURVEY, 'Review');
    const reopened = await open(shell, 0);
    await expand(reopened, 'Unable to assess, undo, history');
    await expect(reopened.getByText('Saved note: External revision', { exact: true })).toBeVisible();
    expect((await savedReview(shell, first.id)).revision).toBe(1);
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid evidence requires explicit re-review after restoration and preserves earlier human actions', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-review-invalid-e2e-'));
  const sources = fixtures<Fixture>('summary_fixtures', join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    const sessionID = await prepared(shell, [sources.quiet_9]);
    const run = await latestRun(shell, sessionID);
    const row = run.windows[0]!;
    let view = await open(shell, 0);
    await view.getByLabel('Reviewer', { exact: true }).fill('Synthetic no-event reviewer');
    await previewReady(view);
    await view.getByRole('button', { name: /^No activity seen/ }).click();
    await expect.poll(async () => (await savedReview(shell!, row.id)).revision).toBe(1);
    await close(view);
    await expect(progress(shell, 1, 1)).toBeVisible();
    expect(await savedReview(shell, row.id)).toMatchObject({ revision: 1, decision: 'reviewed_no_discernible_event', observations: [] });

    // A missing derived summary invalidates the decision until a human reviews again.
    const imagePath = join(directory, 'data', 'summaries', run.id, `${row.id}.png`);
    const imageBytes = await readFile(imagePath);
    await rm(imagePath);
    await shell.page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(progress(shell, 0, 1)).toBeVisible();
    await writeFile(imagePath, imageBytes);
    expect((await savedReview(shell, row.id)).effective_decision, 'Restoring bytes does not silently restore a decision').toBe('unreviewed');
    await shell.page.getByRole('button', { name: 'Refresh', exact: true }).click();
    view = await open(shell, 0);
    await previewReady(view);
    await expect(view.getByRole('button', { name: /^No activity seen/ })).toBeEnabled();
    await view.getByRole('button', { name: /^No activity seen/ }).click();
    await expect.poll(async () => (await savedReview(shell!, row.id)).revision).toBe(2);
    await close(view);
    await expect(progress(shell, 1, 1)).toBeVisible();

    await appendFile(sources.quiet_9, 'Synthetic external change after human review');
    await shell.page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(progress(shell, 0, 1)).toBeVisible();
    view = await open(shell, 0);
    await expect(view.getByRole('alert').filter({ hasText: /^Needs a new check: the earlier decision \(Reviewed: no activity\)/ })).toBeVisible();
    await expect(view.getByText('Not reviewed', { exact: true })).toBeVisible();
    await expect(view.getByRole('button', { name: /^No activity seen/ })).toBeDisabled();
    expect(await savedReview(shell, row.id)).toMatchObject({ revision: 2, decision: 'reviewed_no_discernible_event', effective_decision: 'unreviewed', needs_reverification: true });
    await expand(view, 'Unable to assess, undo, history');
    await view.getByRole('button', { name: 'Show review history', exact: true }).click();
    await expect(view.getByText('Review history (2 shown)', { exact: true })).toBeVisible();
    await expect(view.getByRole('listitem').filter({ hasText: /Synthetic no-event reviewer · set decision$/ })).toHaveCount(2);
    await close(view);
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});
