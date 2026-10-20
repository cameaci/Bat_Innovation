import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { BatAPI, QAHistory, SummaryDetail, WindowQA } from '../src/contracts';
import { cleanup, launch, quit, type RunningShell } from './shell-helpers';

function sources(directory: string): Record<string, string> {
  const result = spawnSync(process.env.BAT_PYTHON ?? 'python', ['-m', 'backend.tests.summary_fixtures', directory], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 15000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, string>;
}

async function prepare(shell: RunningShell, paths: string[]): Promise<SummaryDetail> {
  await shell.page.getByRole('button', { name: 'Create session', exact: true }).click();
  await shell.page.getByRole('button', { name: 'Inspect media', exact: true }).click();
  await shell.page.getByRole('button', { name: 'Upgrade media storage', exact: true }).click();
  // Only the OS picker result is injected; decoding, previews, API and SQLite stay real.
  await shell.application.evaluate(({ dialog }, originals) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: originals })) as typeof dialog.showOpenDialog;
  }, paths);
  await shell.page.getByRole('button', { name: 'Choose original videos', exact: true }).click();
  await expect(shell.page.getByRole('article', { name: /^Segment / })).toHaveCount(paths.length);
  await shell.page.getByRole('button', { name: 'Upgrade summary storage', exact: true }).click();
  await shell.page.getByRole('button', { name: 'Generate motion summaries', exact: true }).click();
  await expect(shell.page.getByRole('status').filter({ hasText: /^Run (complete|incomplete):/ })).toBeVisible();
  await shell.page.getByRole('button', { name: 'Upgrade review storage', exact: true }).click();
  await shell.page.getByRole('button', { name: 'Upgrade QA storage', exact: true }).click();
  await expect(shell.page.getByRole('heading', { name: 'Independent second review', exact: true })).toBeVisible();
  return shell.page.evaluate(async () => {
    const api = (window as unknown as { batAPI: BatAPI }).batAPI;
    const sessions = await api.listSessions(); if (!sessions.ok) throw new Error(sessions.error.message);
    const runs = await api.listSummaryRuns(sessions.value[0]!.id); if (!runs.ok) throw new Error(runs.error.message);
    const detail = await api.summaryRun(runs.value[0]!.id); if (!detail.ok) throw new Error(detail.error.message);
    return detail.value;
  });
}

async function saved(shell: RunningShell, id: string): Promise<WindowQA> {
  const result = await shell.page.evaluate(id => (window as unknown as { batAPI: BatAPI }).batAPI.getWindowQA(id), id);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function history(shell: RunningShell, id: string): Promise<QAHistory> {
  const result = await shell.page.evaluate(id => (window as unknown as { batAPI: BatAPI }).batAPI.qaHistory(id, 0), id);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function preview(shell: RunningShell) {
  await shell.page.getByRole('button', { name: 'Preview selected window source', exact: true }).click();
  await shell.page.getByRole('button', { name: 'Create preview', exact: true }).click();
  await expect(shell.page.getByText('Preview ready', { exact: true })).toBeVisible();
}

async function firstReview(shell: RunningShell, run: SummaryDetail, observation: boolean) {
  await shell.page.getByLabel('Reviewer label', { exact: true }).fill('Synthetic first reviewer');
  await expect(shell.page.getByLabel('QA reviewer label', { exact: true })).toBeDisabled();
  if (observation) {
    await shell.page.getByRole('button', { name: 'Add provisional observation', exact: true }).click();
    await shell.page.getByLabel('Observation end source PTS (exclusive)', { exact: true }).fill(String(BigInt(run.windows[0]!.preview_pts!) + 1n));
    await shell.page.getByLabel('Observation notes', { exact: true }).fill('Synthetic provisional visual evidence');
    await shell.page.getByRole('button', { name: 'Save observation', exact: true }).click();
  }
  await preview(shell);
  await shell.page.getByRole('button', { name: observation ? 'Mark reviewed with observations' : 'Mark reviewed: no discernible event', exact: true }).click();
  await expect(shell.page.getByRole('status').filter({ hasText: /^First review progress: 1\// })).toBeVisible();
  await expect(shell.page.getByLabel('QA reviewer label', { exact: true })).toBeEnabled();
}

const confirm = (shell: RunningShell) => shell.page.getByRole('checkbox', { name: 'I confirm this is my explicit second-review action', exact: true });
const panel = (shell: RunningShell) => shell.page.getByRole('region', { name: 'Independent second review', exact: true });

async function clean(shell: RunningShell | undefined) {
  if (shell) await shell.application.evaluate(({ dialog }) => { dialog.showMessageBoxSync = (() => 1) as typeof dialog.showMessageBoxSync; }).catch(() => undefined);
  await cleanup(shell);
}

test.skip(process.platform !== 'linux', 'QA source-processing and desktop acceptance currently run locally on Linux only.');

test('independent QA decisions, suggestions and disagreement history survive restart without altering first review', async () => {
  test.setTimeout(120000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-qa-e2e-'));
  const fixtures = sources(join(directory, 'originals'));
  const paths = [fixtures.quiet_65!, fixtures.empty_middle!];
  const hashes = await Promise.all(paths.map(async p => createHash('sha256').update(await readFile(p)).digest('hex')));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    const run = await prepare(shell, paths), row = run.windows[0]!;
    expect(run.windows).toHaveLength(6);
    await expect(shell.page.getByRole('list', { name: 'All planned windows', exact: true }).getByRole('article')).toHaveCount(6);
    await expect(shell.page.getByRole('status').filter({ hasText: /^Second-review QA coverage: 0\/6 agreed;/ })).toBeVisible();
    expect((await saved(shell, row.id)).revision).toBe(0);
    expect((await history(shell, row.id)).events).toEqual([]);
    await expect(shell.page.getByRole('button', { name: 'Save QA decision', exact: true })).toBeDisabled();
    await firstReview(shell, run, true);
    const firstBefore = await shell.page.evaluate(id => (window as unknown as { batAPI: BatAPI }).batAPI.reviewHistory(id, 0), row.id);
    await shell.page.getByLabel('QA reviewer label', { exact: true }).fill(' SYNTHETIC FIRST REVIEWER ');
    await confirm(shell).check();
    await shell.page.getByRole('button', { name: 'Save QA decision', exact: true }).click();
    await expect(panel(shell).getByRole('alert')).toContainText('different normalized');
    expect((await saved(shell, row.id)).revision).toBe(0);
    await shell.page.getByLabel('QA reviewer label', { exact: true }).fill('Synthetic second reviewer');
    await shell.page.getByLabel('QA decision', { exact: true }).selectOption('disagree');
    await shell.page.getByLabel('QA rationale', { exact: true }).fill('Synthetic weak visual evidence needs reassessment');
    const originalObservation = (await saved(shell, row.id)).first_review.observations[0]!;
    await shell.page.getByLabel('Optional observation disagreement reference', { exact: true }).selectOption(originalObservation.id);
    await shell.page.getByLabel('Provisional suggestion note', { exact: true }).fill('Synthetic unknown count retained');
    await shell.page.getByLabel('Suggested visual category (provisional)', { exact: true }).selectOption('uncertain');
    await confirm(shell).check();
    await shell.page.getByRole('button', { name: 'Save QA decision', exact: true }).click();
    await expect(panel(shell).getByRole('status').filter({ hasText: /^Second-review QA: disagree/ })).toBeVisible();
    const disagreed = await saved(shell, row.id);
    expect(disagreed.suggestion?.count).toBeNull();
    expect(disagreed.suggestion?.original_observation.start_pts).toBe(originalObservation.start_pts);
    await shell.page.getByRole('button', { name: 'Close preview', exact: true }).click();
    await shell.page.getByLabel('QA decision', { exact: true }).selectOption('needs_clarification');
    await shell.page.getByLabel('QA rationale', { exact: true }).fill('Clarify this synthetic observation');
    await confirm(shell).check();
    await shell.page.getByRole('button', { name: 'Save QA decision', exact: true }).click();
    await expect(panel(shell).getByRole('status').filter({ hasText: /^Second-review QA: needs clarification/ })).toBeVisible();
    await shell.page.getByRole('button', { name: 'Next QA pending window', exact: true }).click();
    await expect(shell.page.getByRole('heading', { name: 'Inspect window 2', exact: true })).toBeVisible();
    await shell.page.getByLabel('QA reviewer label', { exact: true }).fill('Synthetic second reviewer');
    await shell.page.getByLabel('QA decision', { exact: true }).selectOption('unassessable');
    await shell.page.getByLabel('QA rationale', { exact: true }).fill('First review is still pending');
    await confirm(shell).check();
    await shell.page.getByRole('button', { name: 'Save QA decision', exact: true }).click();
    await expect(panel(shell).getByRole('status').filter({ hasText: /^Second-review QA: unassessable/ })).toBeVisible();
    await shell.page.getByRole('button', { name: 'Previous window', exact: true }).click();
    await preview(shell);
    await shell.page.getByLabel('QA decision', { exact: true }).selectOption('agree');
    await confirm(shell).check();
    await shell.page.getByRole('button', { name: 'Save QA decision', exact: true }).click();
    await expect(panel(shell).getByRole('status').filter({ hasText: /^Second-review QA: agree/ })).toBeVisible();
    await shell.page.getByLabel('QA rationale', { exact: true }).fill('Retract own synthetic assessment');
    await confirm(shell).check();
    await shell.page.getByRole('button', { name: 'Retract QA decision', exact: true }).click();
    await expect(panel(shell).getByRole('status').filter({ hasText: /^Second-review QA: pending/ })).toBeVisible();
    await shell.page.getByLabel('QA rationale', { exact: true }).fill('New explicit synthetic QA action');
    await confirm(shell).check();
    await shell.page.getByRole('button', { name: 'Save QA decision', exact: true }).click();
    await expect(panel(shell).getByRole('status').filter({ hasText: /^Second-review QA: agree/ })).toBeVisible();
    await shell.page.getByRole('button', { name: 'Close preview', exact: true }).click();
    const audit = await history(shell, row.id);
    expect(audit.events.map(event => event.after.decision)).toEqual(['disagree','needs_clarification','agree','pending','agree']);
    expect(await shell.page.evaluate(id => (window as unknown as { batAPI: BatAPI }).batAPI.reviewHistory(id, 0), row.id)).toEqual(firstBefore);
    expect(await Promise.all(paths.map(async p => createHash('sha256').update(await readFile(p)).digest('hex')))).toEqual(hashes);
    await quit(shell); shell = undefined;
    shell = await launch(join(directory, 'data'));
    await shell.page.getByRole('button', { name: 'Inspect media', exact: true }).click();
    await expect(panel(shell).getByRole('status').filter({ hasText: /^Second-review QA: agree/ })).toBeVisible();
    expect(await history(shell, row.id)).toEqual(audit);
    await shell.page.getByRole('button', { name: 'Show QA audit history', exact: true }).click();
    await expect(panel(shell).getByText('Append-only QA history (5 shown)', { exact: true })).toBeVisible();
    await appendFile(paths[0]!, 'Synthetic negative source mutation');
    await shell.page.getByRole('button', { name: 'Refresh summary runs', exact: true }).click();
    await expect(panel(shell).getByRole('alert').filter({ hasText: /Stale QA/ })).toBeVisible();
    await expect(shell.page.getByRole('status').filter({ hasText: /^Second-review QA coverage: 0\/6 agreed;/ })).toBeVisible();
    expect(await history(shell, row.id)).toEqual(audit);
    await expect(shell.page.locator('body')).not.toContainText(directory);
    await quit(shell); shell = undefined;
  } finally { await clean(shell); await rm(directory, { recursive: true, force: true }); }
});

test('QA drafts survive protected navigation, native close, concurrent first-review change and backend loss', async () => {
  test.setTimeout(120000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-qa-dirty-'));
  const fixtures = sources(join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    const run = await prepare(shell, [fixtures.quiet_9!]), row = run.windows[0]!;
    await firstReview(shell, run, false);
    await shell.page.getByRole('button', { name: 'Close preview', exact: true }).click();
    await shell.page.getByLabel('QA reviewer label', { exact: true }).fill('Unsaved synthetic QA reviewer');
    await shell.page.getByLabel('QA decision', { exact: true }).selectOption('needs_clarification');
    const notes = shell.page.getByLabel('QA rationale', { exact: true });
    await notes.fill('Retain QA draft'); await notes.press('ArrowRight'); await notes.press('u'); await notes.press('g');
    await expect(notes).toHaveValue('Retain QA draftug');
    await expect(shell.page.getByLabel('Reviewer label', { exact: true })).toBeDisabled();
    for (const name of ['Next QA pending window','Next unreviewed window','Return to gallery','Refresh summary runs','Generate motion summaries']) await expect(shell.page.getByRole('button', { name, exact: true })).toBeDisabled();
    await expect(shell.page.getByLabel('Window filter', { exact: true })).toBeDisabled();
    await expect(shell.page.getByLabel('Processing run', { exact: true })).toBeDisabled();
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
    await shell.page.getByLabel('QA decision', { exact: true }).selectOption('unassessable');
    await confirm(shell).check();
    await shell.page.getByRole('button', { name: 'Save QA decision', exact: true }).click();
    await expect(panel(shell).getByRole('alert')).toContainText('changed');
    expect((await history(shell, row.id)).events).toEqual([]);
    await expect(notes).toHaveValue('Retain QA draftug');
    process.kill(shell.backendPid, 'SIGSTOP');
    await shell.page.getByRole('button', { name: 'Save QA decision', exact: true }).click();
    process.kill(shell.backendPid, 'SIGKILL');
    await expect(panel(shell).getByRole('alert')).toContainText(/Backend unavailable|local backend is unavailable/i);
    await expect(notes).toHaveValue('Retain QA draftug');
    await expect(shell.page.getByLabel('QA reviewer label', { exact: true })).toHaveValue('Unsaved synthetic QA reviewer');
    await expect(panel(shell).getByRole('status').filter({ hasText: /^Unsaved QA draft/ })).toBeVisible();
    await shell.application.evaluate(() => { (globalThis as unknown as { qaDialog: { response: number } }).qaDialog.response = 1; });
    await quit(shell); shell = undefined;
    shell = await launch(join(directory, 'data'));
    await shell.page.getByRole('button', { name: 'Inspect media', exact: true }).click();
    expect((await saved(shell, row.id)).revision).toBe(0);
    expect((await history(shell, row.id)).events).toEqual([]);
    await quit(shell); shell = undefined;
  } finally { await clean(shell); await rm(directory, { recursive: true, force: true }); }
});
