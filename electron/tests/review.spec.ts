import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { BatAPI, SummaryDetail, WindowReview } from '../src/contracts';
import { cleanup, launch, quit, type RunningShell } from './shell-helpers';

type Fixtures = Record<'quiet_65' | 'quiet_9' | 'empty_middle' | 'brightness_9' | 'single', string>;

function generateSources(directory: string): Fixtures {
  const result = spawnSync(process.env.BAT_PYTHON ?? 'python', [
    'backend/tests/summary_fixtures.py', directory,
  ], { cwd: resolve('.'), encoding: 'utf8', timeout: 45_000 });
  expect(result.status, result.stderr || 'Review source generation failed').toBe(0);
  return JSON.parse(result.stdout) as Fixtures;
}

async function hashes(paths: string[]): Promise<string[]> {
  return Promise.all(paths.map(async path => createHash('sha256').update(await readFile(path)).digest('hex')));
}

async function preparedShell(shell: RunningShell, paths: string[]): Promise<string> {
  await shell.page.getByLabel('Display name', { exact: true }).fill('Synthetic first review');
  await shell.page.getByLabel('Camera reference', { exact: true }).fill('Synthetic review camera');
  await shell.page.getByRole('button', { name: 'Create session', exact: true }).click();
  await shell.page.getByRole('button', { name: 'Inspect media', exact: true }).click();
  await shell.page.getByRole('button', { name: 'Upgrade media storage', exact: true }).click();
  // Substitute only native file selection; original decoding, jobs and all persistence stay real.
  await shell.application.evaluate(({ dialog }, originals) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: originals })) as typeof dialog.showOpenDialog;
  }, paths);
  await shell.page.getByRole('button', { name: 'Choose original videos', exact: true }).click();
  await expect(shell.page.getByRole('article', { name: /^Segment / })).toHaveCount(paths.length);
  await shell.page.getByRole('button', { name: 'Upgrade summary storage', exact: true }).click();
  await shell.page.getByRole('button', { name: 'Generate motion summaries', exact: true }).click();
  await expect(shell.page.getByRole('status').filter({ hasText: /^Run (complete|incomplete):/ })).toBeVisible();
  await expect(shell.page.getByRole('heading', { name: 'Manual first review', exact: true })).not.toBeVisible();
  await shell.page.getByRole('button', { name: 'Upgrade review storage', exact: true }).click();
  await expect(shell.page.getByRole('heading', { name: 'Manual first review', exact: true })).toBeVisible();
  const sessions = await shell.page.evaluate(() => (window as unknown as { batAPI: BatAPI }).batAPI.listSessions());
  if (!sessions.ok) throw new Error(sessions.error.message);
  return sessions.value[0]!.id;
}

async function latestRun(shell: RunningShell, sessionID: string): Promise<SummaryDetail> {
  const result = await shell.page.evaluate(async id => {
    const api = (window as unknown as { batAPI: BatAPI }).batAPI;
    const runs = await api.listSummaryRuns(id);
    if (!runs.ok) return runs;
    return api.summaryRun(runs.value[0]!.id);
  }, sessionID);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function savedReview(shell: RunningShell, windowID: string): Promise<WindowReview> {
  const result = await shell.page.evaluate(id => (window as unknown as { batAPI: BatAPI }).batAPI.getWindowReview(id), windowID);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function cleanupDraftShell(shell: RunningShell | undefined): Promise<void> {
  if (shell) await shell.application.evaluate(({ dialog }) => {
    // A failed assertion must not leave a physical modal dialog or backend child running.
    dialog.showMessageBoxSync = (() => 1) as typeof dialog.showMessageBoxSync;
  }).catch(() => undefined);
  await cleanup(shell);
}

async function openReceipt(shell: RunningShell, windowID: string): Promise<void> {
  const manifest = await shell.page.evaluate(async id => {
    const result = await (window as unknown as { batAPI: BatAPI }).batAPI.getWindowReview(id);
    return result.ok ? result.value : null;
  }, windowID);
  expect(manifest).not.toBeNull();
  await shell.page.getByRole('button', { name: 'Preview window source', exact: true }).first().click();
  await shell.page.getByRole('button', { name: 'Create preview', exact: true }).click();
  await expect(shell.page.getByText('Preview ready', { exact: true })).toBeVisible();
  await expect(shell.page.getByLabel('Derived source preview', { exact: true })).toBeVisible();
  await expect(shell.page.getByText('Source preview receipt available for this window.', { exact: true })).toBeVisible();
}

test.skip(process.platform !== 'linux', 'First-review media processing and Electron lifecycle are locally verified on Linux only.');

test('explicit first review keeps all quiet and incomplete windows visible with zero-to-many audited observations', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-review-e2e-'));
  const fixtures = generateSources(join(directory, 'originals'));
  const paths = [fixtures.quiet_65, fixtures.empty_middle];
  const before = await hashes(paths);
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    const sessionID = await preparedShell(shell, paths);
    await expect(shell.page.getByRole('status').filter({ hasText: /^First review progress: 0\/6 reviewed; 6 unreviewed;/ })).toBeVisible();
    const run = await latestRun(shell, sessionID);
    expect(run.windows).toHaveLength(6);
    const first = run.windows[0]!;
    const initial = await savedReview(shell, first.id);
    expect(initial).toMatchObject({ revision: 0, decision: 'unreviewed', effective_decision: 'unreviewed', observations: [] });
    await shell.page.getByRole('button', { name: 'Next window', exact: true }).click();
    await expect(shell.page.getByRole('heading', { name: 'Inspect window 2', exact: true })).toBeVisible();
    await shell.page.getByRole('button', { name: 'Previous window', exact: true }).click();
    expect((await savedReview(shell, first.id)).revision).toBe(0);
    await shell.page.getByLabel('Reviewer label', { exact: true }).fill('Synthetic reviewer');
    await shell.page.getByRole('button', { name: 'Add provisional observation', exact: true }).click();
    const start = first.preview_pts!;
    await expect(shell.page.getByLabel('Observation start source PTS', { exact: true })).toHaveValue(start);
    await shell.page.getByLabel('Observation end source PTS (exclusive)', { exact: true }).fill(String(BigInt(start) + 1n));
    await shell.page.getByLabel('Observation notes', { exact: true }).fill('Synthetic weak visual evidence');
    await shell.page.getByRole('button', { name: 'Save observation', exact: true }).click();
    const observations = shell.page.getByRole('list', { name: 'Saved provisional observations', exact: true });
    await expect(observations.getByRole('listitem')).toHaveCount(1);
    await expect(observations).toContainText('Count unknown');
    await expect(observations).toContainText('Uncertain');
    expect((await savedReview(shell, first.id)).decision).toBe('unreviewed');
    // Discard must also restore the saved audit attribution, not only form
    // fields. Otherwise the next action could be signed by a discarded actor.
    await shell.page.getByLabel('Reviewer label', { exact: true }).fill('Discarded temporary reviewer');
    await shell.page.getByRole('button', { name: 'Discard review draft', exact: true }).click();
    await expect(shell.page.getByLabel('Reviewer label', { exact: true })).toHaveValue('Synthetic reviewer');
    expect((await savedReview(shell, first.id)).revision).toBe(1);
    await shell.page.getByRole('button', { name: 'Add provisional observation', exact: true }).click();
    await shell.page.getByLabel('Observation end source PTS (exclusive)', { exact: true }).fill(String(BigInt(start) + 2n));
    await shell.page.getByLabel('Provisional visual category', { exact: true }).selectOption('insect');
    await shell.page.getByLabel('Count (blank means unknown)', { exact: true }).fill('2');
    await shell.page.getByRole('button', { name: 'Save observation', exact: true }).click();
    await expect(observations.getByRole('listitem')).toHaveCount(2);
    await observations.getByRole('listitem').first().getByRole('button', { name: 'Edit observation', exact: true }).click();
    await shell.page.getByLabel('Optional activity / behaviour', { exact: true }).fill('Synthetic uncertain passing');
    await shell.page.getByRole('button', { name: 'Save observation', exact: true }).click();
    await expect(observations.getByRole('listitem').first()).toContainText('Synthetic uncertain passing');
    await observations.getByRole('listitem').last().getByRole('button', { name: 'Delete observation', exact: true }).click();
    await expect(observations.getByRole('listitem')).toHaveCount(1);
    await expect(shell.page.getByRole('button', { name: 'Mark reviewed with observations', exact: true })).toBeDisabled();
    await openReceipt(shell, first.id);
    await shell.page.getByRole('button', { name: 'Mark reviewed with observations', exact: true }).click();
    await expect(shell.page.getByRole('status').filter({ hasText: /^First review progress: 1\/6 reviewed;/ })).toBeVisible();
    expect((await savedReview(shell, first.id)).decision).toBe('reviewed_with_observations');
    await shell.page.getByRole('button', { name: 'Close preview', exact: true }).click();
    await shell.page.getByRole('button', { name: 'Next unreviewed window', exact: true }).click();
    await expect(shell.page.getByRole('heading', { name: 'Inspect window 2', exact: true })).toBeVisible();
    await shell.page.getByLabel('Reviewer label', { exact: true }).fill('Synthetic reviewer');
    await shell.page.getByLabel('Unable-to-assess annotation', { exact: true }).fill('Synthetic uncertainty remains unresolved');
    await shell.page.getByRole('button', { name: 'Save unable-to-assess annotation', exact: true }).click();
    expect((await savedReview(shell, run.windows[1]!.id)).effective_decision).toBe('unreviewed');
    await expect(shell.page.getByRole('status').filter({ hasText: /^First review progress: 1\/6 reviewed;/ })).toBeVisible();
    await shell.page.getByRole('button', { name: 'Previous window', exact: true }).click();
    await shell.page.getByRole('button', { name: 'Show review audit history', exact: true }).click();
    await expect(shell.page.getByText('Append-only review history (5 shown)', { exact: true })).toBeVisible();
    const persisted = await savedReview(shell, first.id);
    expect(persisted.observations).toHaveLength(1);
    expect(persisted.observations[0]).toMatchObject({ start_pts: start, end_pts: String(BigInt(start) + 1n), count: null, uncertain: true });
    await quit(shell); shell = undefined;
    shell = await launch(join(directory, 'data'));
    await shell.page.getByRole('button', { name: 'Inspect media', exact: true }).click();
    await expect(shell.page.getByRole('status').filter({ hasText: /^First review progress: 1\/6 reviewed;/ })).toBeVisible();
    expect(await savedReview(shell, first.id)).toEqual(persisted);
    await shell.page.getByRole('button', { name: 'Generate motion summaries', exact: true }).click();
    await expect(shell.page.getByRole('status').filter({ hasText: /^First review progress: 0\/6 reviewed;/ })).toBeVisible();
    const fresh = await latestRun(shell, sessionID);
    expect(fresh.id).not.toBe(run.id);
    expect(fresh.review_progress?.reviewed).toBe(0);
    expect(await hashes(paths), 'Review, preview and new runs must leave original bytes unchanged').toEqual(before);
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});

test('dirty review drafts survive stale saves and cancelled native close, reload and quit', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-review-dirty-e2e-'));
  const fixtures = generateSources(join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    const sessionID = await preparedShell(shell, [fixtures.quiet_65]);
    const run = await latestRun(shell, sessionID);
    const first = run.windows[0]!;
    await shell.page.getByLabel('Reviewer label', { exact: true }).fill('Synthetic draft reviewer');
    await shell.page.getByRole('button', { name: 'Add provisional observation', exact: true }).click();
    await shell.page.getByLabel('Observation end source PTS (exclusive)', { exact: true }).fill(String(BigInt(first.preview_pts!) + 1n));
    await shell.page.getByLabel('Observation notes', { exact: true }).fill('Draft must survive cancelled close');
    for (const name of ['Refresh summary runs', 'Generate motion summaries', 'Next window', 'Next unreviewed window']) {
      await expect(shell.page.getByRole('button', { name, exact: true })).toBeDisabled();
    }
    await expect(shell.page.getByLabel('Processing run', { exact: true })).toBeDisabled();
    await expect(shell.page.getByRole('button', { name: 'Inspect summary', exact: true }).last()).toBeDisabled();
    await expect(shell.page.getByRole('button', { name: 'Preview window source', exact: true }).first()).toBeEnabled();
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
    await shell.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await expect.poll(() => shell!.application.evaluate(() => (globalThis as unknown as { reviewDialog: { calls: number } }).reviewDialog.calls)).toBe(1);
    await expect(shell.page.getByLabel('Observation notes', { exact: true })).toHaveValue('Draft must survive cancelled close');
    await shell.application.evaluate(({ app }) => { app.quit(); });
    await expect.poll(() => shell!.application.evaluate(() => (globalThis as unknown as { reviewDialog: { calls: number } }).reviewDialog.calls)).toBe(2);
    await shell.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.reload());
    await expect.poll(() => shell!.application.evaluate(() => (globalThis as unknown as { reviewDialog: { calls: number } }).reviewDialog.calls)).toBe(3);
    await expect(shell.page.getByLabel('Observation notes', { exact: true })).toHaveValue('Draft must survive cancelled close');
    const health = await shell.page.evaluate(() => (window as unknown as { batAPI: BatAPI }).batAPI.health());
    expect(health).toMatchObject({ ok: true, value: { status: 'ok' } });
    const external = await shell.page.evaluate(id => (window as unknown as { batAPI: BatAPI }).batAPI.saveReview(id, {
      actor: 'Another synthetic reviewer', expected_revision: 0, action: 'unable_to_assess', note: 'External revision',
    }), first.id);
    expect(external.ok).toBe(true);
    await shell.page.getByRole('button', { name: 'Save observation', exact: true }).click();
    await expect(shell.page.getByRole('alert').filter({ hasText: /changed|conflict|revision/i })).toBeVisible();
    await expect(shell.page.getByLabel('Observation notes', { exact: true })).toHaveValue('Draft must survive cancelled close');
    expect((await savedReview(shell, first.id)).observations).toEqual([]);
    // Stop the real backend before dispatching save, then kill it with that request
    // outstanding. No successful action or unavailable response is substituted.
    process.kill(shell.backendPid, 'SIGSTOP');
    await shell.page.getByRole('button', { name: 'Save observation', exact: true }).click();
    process.kill(shell.backendPid, 'SIGKILL');
    await expect(shell.page.getByRole('alert').filter({ hasText: /Backend unavailable/i })).toBeVisible();
    await expect(shell.page.getByLabel('Reviewer label', { exact: true })).toHaveValue('Synthetic draft reviewer');
    await expect(shell.page.getByLabel('Observation start source PTS', { exact: true })).toHaveValue(first.preview_pts!);
    await expect(shell.page.getByLabel('Observation end source PTS (exclusive)', { exact: true })).toHaveValue(String(BigInt(first.preview_pts!) + 1n));
    await expect(shell.page.getByLabel('Observation notes', { exact: true })).toHaveValue('Draft must survive cancelled close');
    await expect(shell.page.getByRole('status').filter({ hasText: /^Unsaved review draft\./ })).toBeVisible();
    await expect(shell.page.getByRole('button', { name: 'Next window', exact: true })).toBeDisabled();
    await shell.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await expect.poll(() => shell!.application.evaluate(() => (globalThis as unknown as { reviewDialog: { calls: number } }).reviewDialog.calls)).toBe(4);
    await expect(shell.page.getByLabel('Observation notes', { exact: true })).toHaveValue('Draft must survive cancelled close');
    const dialog = await shell.application.evaluate(() => (globalThis as unknown as { reviewDialog: { buttons: string[] } }).reviewDialog.buttons);
    expect(dialog).toEqual(['Keep editing', 'Discard draft']);
    await shell.application.evaluate(() => { (globalThis as unknown as { reviewDialog: { response: number } }).reviewDialog.response = 1; });
    await quit(shell); shell = undefined;
    shell = await launch(join(directory, 'data'));
    await shell.page.getByRole('button', { name: 'Inspect media', exact: true }).click();
    await expect(shell.page.getByText('Saved unresolved annotation: External revision', { exact: true })).toBeVisible();
    expect((await savedReview(shell, first.id)).revision).toBe(1);
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid evidence requires explicit re-review after restoration and preserves earlier human actions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bat-review-invalid-e2e-'));
  const fixtures = generateSources(join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    const sessionID = await preparedShell(shell, [fixtures.quiet_9]);
    const run = await latestRun(shell, sessionID);
    const row = run.windows[0]!;
    await shell.page.getByLabel('Reviewer label', { exact: true }).fill('Synthetic no-event reviewer');
    await openReceipt(shell, row.id);
    await shell.page.getByRole('button', { name: 'Mark reviewed: no discernible event', exact: true }).click();
    await expect(shell.page.getByRole('status').filter({ hasText: /^First review progress: 1\/1 reviewed;/ })).toBeVisible();
    await shell.page.getByRole('button', { name: 'Close preview', exact: true }).click();
    const before = await savedReview(shell, row.id);
    expect(before).toMatchObject({ revision: 1, decision: 'reviewed_no_discernible_event', observations: [] });
    const imagePath = join(directory, 'data', 'summaries', run.id, `${row.id}.png`);
    const imageBytes = await readFile(imagePath);
    await rm(imagePath);
    await expect(shell.page.getByRole('status').filter({ hasText: /^First review progress: 0\/1 reviewed;/ })).toBeVisible();
    await writeFile(imagePath, imageBytes);
    expect((await savedReview(shell, row.id)).effective_decision).toBe('unreviewed');
    await openReceipt(shell, row.id);
    await expect(shell.page.getByRole('button', { name: 'Mark reviewed: no discernible event', exact: true })).toBeEnabled();
    await shell.page.getByRole('button', { name: 'Mark reviewed: no discernible event', exact: true }).click();
    await expect(shell.page.getByRole('status').filter({ hasText: /^First review progress: 1\/1 reviewed;/ })).toBeVisible();
    await shell.page.getByRole('button', { name: 'Close preview', exact: true }).click();
    expect((await savedReview(shell, row.id)).revision).toBe(2);
    await appendFile(fixtures.quiet_9, 'Synthetic external change after human review');
    await expect(shell.page.getByRole('status').filter({ hasText: /^First review progress: 0\/1 reviewed;/ })).toBeVisible();
    await expect(shell.page.getByRole('alert').filter({ hasText: /^Re-verification required\. Historical decision:/ })).toBeVisible();
    await expect(shell.page.getByRole('status').filter({ hasText: /^First review: unreviewed/ })).toBeVisible();
    const after = await savedReview(shell, row.id);
    expect(after).toMatchObject({ revision: 2, decision: 'reviewed_no_discernible_event', effective_decision: 'unreviewed', needs_reverification: true });
    await shell.page.getByRole('button', { name: 'Show review audit history', exact: true }).click();
    await expect(shell.page.getByText('Append-only review history (2 shown)', { exact: true })).toBeVisible();
    await expect(shell.page.getByText('Synthetic no-event reviewer', { exact: false }).last()).toBeVisible();
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});
