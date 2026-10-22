import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import type { BatAPI, SummaryWindow } from '../src/contracts';
import { launch, quit, type RunningShell } from './shell-helpers';
import { cleanupDraftShell, closeWindow, digests, expand, fixtures, latestRun, openAt, openSurvey, preparedReview, previewReady,
  qaHistory as history, savedQA as saved, savedReview, windowCards } from './ui-helpers';

type Fixture = 'quiet_65' | 'quiet_9' | 'empty_middle';
const SURVEY = 'Synthetic QA survey';
const panel = (view: Locator) => view.getByRole('region', { name: 'Independent second review', exact: true });
const confirm = (view: Locator) => view.getByRole('checkbox', { name: 'I confirm this is my explicit second-review action', exact: true });
const coverage = (shell: RunningShell, agreed: number) => shell.page.getByText(new RegExp(`^Second review: ${agreed} agreed,`));
const reviewHistory = (shell: RunningShell, id: string) => shell.page.evaluate(windowID => (window as unknown as { batAPI: BatAPI }).batAPI.reviewHistory(windowID, 0), id);

async function openQA(shell: RunningShell, index: number): Promise<Locator> {
  const view = await openAt(shell, index);
  await expand(view, 'Second review (QA)');
  return view;
}

/** Record the first review through the dialog; QA is locked while that draft is open. */
async function firstReview(shell: RunningShell, view: Locator, row: SummaryWindow, observation: boolean): Promise<void> {
  await view.getByLabel('Reviewer', { exact: true }).fill('Synthetic first reviewer');
  if (observation) {
    await view.getByRole('button', { name: /^Add observation/ }).click();
    await expect(view.getByLabel('QA reviewer', { exact: true }), 'QA is locked while a first-review draft is open').toBeDisabled();
    await expand(view, 'Exact source PTS');
    const start = await view.getByLabel('Observation start source PTS', { exact: true }).inputValue();
    await view.getByLabel('Observation end source PTS (exclusive)', { exact: true }).fill(String(BigInt(start) + 1n));
    await view.getByLabel('Notes', { exact: true }).fill('Synthetic provisional visual evidence');
    await view.getByRole('button', { name: 'Save observation', exact: true }).click();
    await expect(view.getByRole('list', { name: 'Saved provisional observations', exact: true }).getByRole('listitem')).toHaveCount(1);
  }
  await previewReady(view);
  await view.getByRole('button', { name: observation ? /^Mark reviewed with observations/ : /^No activity seen/ }).click();
  await expect.poll(async () => (await savedReview(shell, row.id)).effective_decision).toBe(observation ? 'reviewed_with_observations' : 'reviewed_no_discernible_event');
  await expect(view.getByLabel('QA reviewer', { exact: true })).toBeEnabled();
}

async function saveQA(shell: RunningShell, view: Locator, row: SummaryWindow, status: string): Promise<void> {
  await confirm(view).check();
  await view.getByRole('button', { name: 'Save QA decision', exact: true }).click();
  await expect.poll(async () => (await saved(shell, row.id)).status).toBe(status);
  await expect(panel(view).getByText(status.replaceAll('_', ' '), { exact: true })).toBeVisible();
}

test.skip(process.platform !== 'linux', 'QA source-processing and desktop acceptance currently run locally on Linux only.');

test('independent QA decisions, suggestions and disagreement history survive restart without altering first review', async () => {
  test.setTimeout(150_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-qa-e2e-'));
  const sources = fixtures<Fixture>('summary_fixtures', join(directory, 'originals'));
  const paths = [sources.quiet_65, sources.empty_middle];
  const hashes = await digests(paths);
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    const sessionID = await preparedReview(shell, paths, SURVEY);
    const run = await latestRun(shell, sessionID), row = run.windows[0]!;
    expect(run.windows).toHaveLength(6);
    await expect(windowCards(shell)).toHaveCount(6);
    await expect(coverage(shell, 0)).toContainText('(of 6)');
    expect((await saved(shell, row.id)).revision).toBe(0);
    expect((await history(shell, row.id)).events).toEqual([]);

    let view = await openQA(shell, 0);
    await expect(view.getByRole('button', { name: 'Save QA decision', exact: true })).toBeDisabled();
    await firstReview(shell, view, row, true);
    const firstBefore = await reviewHistory(shell, row.id);

    // The second reviewer must be a different person (normalised label).
    await view.getByLabel('QA reviewer', { exact: true }).fill(' SYNTHETIC FIRST REVIEWER ');
    await confirm(view).check();
    await view.getByRole('button', { name: 'Save QA decision', exact: true }).click();
    await expect(panel(view).getByRole('alert')).toContainText('different normalized');
    expect((await saved(shell, row.id)).revision).toBe(0);

    await view.getByLabel('QA reviewer', { exact: true }).fill('Synthetic second reviewer');
    await view.getByLabel('QA decision', { exact: true }).selectOption('disagree');
    await view.getByLabel(/^QA rationale/).fill('Synthetic weak visual evidence needs reassessment');
    const originalObservation = (await saved(shell, row.id)).first_review.observations[0]!;
    await view.getByLabel('About one observation (optional)', { exact: true }).selectOption(originalObservation.id);
    await view.getByLabel('Suggestion', { exact: true }).fill('Synthetic unknown count retained');
    await view.getByLabel('Suggested category', { exact: true }).selectOption('uncertain');
    await saveQA(shell, view, row, 'disagree');
    const disagreed = await saved(shell, row.id);
    expect(disagreed.suggestion?.count).toBeNull();
    expect(disagreed.suggestion?.original_observation.start_pts).toBe(originalObservation.start_pts);

    await view.getByLabel('QA decision', { exact: true }).selectOption('needs_clarification');
    await view.getByLabel(/^QA rationale/).fill('Clarify this synthetic observation');
    await saveQA(shell, view, row, 'needs_clarification');

    // Window 2 has no first review yet: QA may only record that it is unassessable.
    await view.getByRole('button', { name: 'Next window', exact: true }).click();
    await expect(view.getByText('2 of 6', { exact: true })).toBeVisible();
    await expand(view, 'Second review (QA)');
    await view.getByLabel('QA reviewer', { exact: true }).fill('Synthetic second reviewer');
    await view.getByLabel('QA decision', { exact: true }).selectOption('unassessable');
    await view.getByLabel(/^QA rationale/).fill('First review is still pending');
    await saveQA(shell, view, run.windows[1]!, 'unassessable');

    await view.getByRole('button', { name: 'Previous window', exact: true }).click();
    await expect(view.getByText('1 of 6', { exact: true })).toBeVisible();
    await previewReady(view);
    await view.getByLabel('QA decision', { exact: true }).selectOption('agree');
    await saveQA(shell, view, row, 'agree');
    await view.getByLabel(/^QA rationale/).fill('Retract own synthetic assessment');
    await confirm(view).check();
    await view.getByRole('button', { name: 'Retract QA decision', exact: true }).click();
    await expect.poll(async () => (await saved(shell!, row.id)).status).toBe('pending');
    await view.getByLabel(/^QA rationale/).fill('New explicit synthetic QA action');
    await view.getByLabel('QA decision', { exact: true }).selectOption('agree');
    await saveQA(shell, view, row, 'agree');
    await closeWindow(view);

    const audit = await history(shell, row.id);
    expect(audit.events.map(event => event.after.decision)).toEqual(['disagree', 'needs_clarification', 'agree', 'pending', 'agree']);
    expect(await reviewHistory(shell, row.id), 'QA never edits the first review').toEqual(firstBefore);
    expect(await digests(paths)).toEqual(hashes);
    await expect(coverage(shell, 1)).toBeVisible();

    await quit(shell); shell = undefined;
    shell = await launch(join(directory, 'data'));
    await openSurvey(shell, SURVEY, 'Review');
    await expect(coverage(shell, 1)).toBeVisible();
    view = await openQA(shell, 0);
    await expect(panel(view).getByText('agree', { exact: true })).toBeVisible();
    expect(await history(shell, row.id)).toEqual(audit);
    await panel(view).getByRole('button', { name: 'Show QA history', exact: true }).click();
    await expect(panel(view).getByText('QA history (5 shown)', { exact: true })).toBeVisible();
    await closeWindow(view);

    await appendFile(paths[0]!, 'Synthetic negative source mutation');
    await shell.page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(coverage(shell, 0)).toBeVisible();
    view = await openQA(shell, 0);
    await expect(panel(view).getByRole('alert').filter({ hasText: /^This QA decision is out of date/ })).toBeVisible();
    expect(await history(shell, row.id)).toEqual(audit);
    await expect(shell.page.locator('body')).not.toContainText(directory);
    await closeWindow(view);
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});

test('QA drafts survive protected navigation, native close, concurrent first-review change and backend loss', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-qa-dirty-'));
  const sources = fixtures<Fixture>('summary_fixtures', join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    const sessionID = await preparedReview(shell, [sources.quiet_9], SURVEY);
    const row = (await latestRun(shell, sessionID)).windows[0]!;
    const view = await openQA(shell, 0);
    await firstReview(shell, view, row, false);
    await view.getByLabel('QA reviewer', { exact: true }).fill('Unsaved synthetic QA reviewer');
    await view.getByLabel('QA decision', { exact: true }).selectOption('needs_clarification');
    const notes = view.getByLabel(/^QA rationale/);
    // Typing "u" in a text field must not trigger the "next unreviewed" shortcut.
    await notes.fill('Retain QA draft'); await notes.press('ArrowRight'); await notes.press('u'); await notes.press('g');
    await expect(notes).toHaveValue('Retain QA draftug');
    await expect(view.getByLabel('Reviewer', { exact: true }), 'First review is locked while a QA draft is open').toBeDisabled();
    await shell.page.evaluate(() => { window.confirm = () => false; });
    await view.getByRole('button', { name: 'Close window', exact: true }).click();
    await expect(notes).toHaveValue('Retain QA draftug');

    await shell.application.evaluate(({ dialog }) => {
      const state = { calls: 0, response: 0 };
      (globalThis as unknown as { qaDialog: typeof state }).qaDialog = state;
      dialog.showMessageBoxSync = (() => { state.calls += 1; return state.response; }) as typeof dialog.showMessageBoxSync;
    });
    await shell.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await shell.application.evaluate(({ app }) => app.quit());
    await shell.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.reload());
    await expect.poll(() => shell!.application.evaluate(() => (globalThis as unknown as { qaDialog: { calls: number } }).qaDialog.calls)).toBe(3);
    await expect(notes).toHaveValue('Retain QA draftug');

    const external = await shell.page.evaluate(id => (window as unknown as { batAPI: BatAPI }).batAPI.saveReview(id, {
      actor: 'Synthetic first reviewer', expected_revision: 1, action: 'unable_to_assess', note: 'Concurrent synthetic first-review revision',
    }), row.id);
    expect(external.ok).toBe(true);
    await view.getByLabel('QA decision', { exact: true }).selectOption('unassessable');
    await confirm(view).check();
    await view.getByRole('button', { name: 'Save QA decision', exact: true }).click();
    await expect(panel(view).getByRole('alert').filter({ hasText: 'changed' }).first()).toBeVisible();
    expect((await history(shell, row.id)).events).toEqual([]);
    await expect(notes).toHaveValue('Retain QA draftug');

    process.kill(shell.backendPid, 'SIGSTOP');
    await view.getByRole('button', { name: 'Save QA decision', exact: true }).click();
    process.kill(shell.backendPid, 'SIGKILL');
    await expect(panel(view).getByRole('alert').filter({ hasText: /Backend unavailable|local backend is unavailable/i }).first()).toBeVisible();
    await expect(notes).toHaveValue('Retain QA draftug');
    await expect(view.getByLabel('QA reviewer', { exact: true })).toHaveValue('Unsaved synthetic QA reviewer');
    await expect(panel(view).getByRole('button', { name: 'Discard QA draft', exact: true })).toBeVisible();
    await shell.application.evaluate(() => { (globalThis as unknown as { qaDialog: { response: number } }).qaDialog.response = 1; });
    await quit(shell); shell = undefined;

    shell = await launch(join(directory, 'data'));
    await openSurvey(shell, SURVEY, 'Review');
    expect((await saved(shell, row.id)).revision).toBe(0);
    expect((await history(shell, row.id)).events).toEqual([]);
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});
