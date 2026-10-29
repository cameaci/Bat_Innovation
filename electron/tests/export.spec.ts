import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { BatAPI } from '../src/contracts';
import { launch, quit, type RunningShell } from './shell-helpers';
import { cleanupDraftShell, closeWindow, digests, expand, fixtures, goTo, latestRun, openAt, preparedReview, savedReview, windowCards } from './ui-helpers';

test.skip(process.platform !== 'linux', 'Export process limits and native save acceptance are verified locally on Linux only.');

test('provisional native CSV export includes all windows despite filters, protects drafts and persists a complete bundle', async () => {
  test.setTimeout(150_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-export-e2e-')), data = join(directory, 'data'), destination = join(directory, 'saved');
  await mkdir(destination);
  const sources = fixtures<'quiet_65' | 'empty_middle'>('summary_fixtures', join(directory, 'originals'));
  const paths = [sources.quiet_65, sources.empty_middle];
  const hashes = await digests(paths);
  let shell: RunningShell | undefined;
  try {
    shell = await launch(data);
    const sessionID = await preparedReview(shell, paths, 'Synthetic export survey');
    const run = await latestRun(shell, sessionID);
    expect(run.windows).toHaveLength(6);
    expect(run.state).toBe('incomplete');
    // Draft state reaches the main process from a React effect; let it commit before probing the bridge.
    const startExport = async () => {
      await shell!.page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      return shell!.page.evaluate(id => (window as unknown as { batAPI: BatAPI }).batAPI.startExport(id), run.id);
    };

    // An open first-review draft blocks export, in the UI and at the bridge.
    const view = await openAt(shell, 0);
    await view.getByLabel('Reviewer', { exact: true }).fill('=Synthetic first reviewer');
    await view.getByRole('button', { name: /^Add observation/ }).click();
    await expect(view.getByRole('button', { name: 'Save observation', exact: true })).toBeVisible();
    expect((await startExport()).ok, 'The main process refuses export while a review draft is open').toBe(false);
    await view.getByRole('button', { name: 'Cancel', exact: true }).click();

    // An open QA draft blocks export too.
    await expand(view, 'Second review (QA)');
    await view.getByLabel('QA reviewer', { exact: true }).fill('Unsaved synthetic QA');
    await expect(view.getByRole('button', { name: 'Discard QA draft', exact: true })).toBeVisible();
    expect((await startExport()).ok).toBe(false);
    await view.getByRole('button', { name: 'Discard QA draft', exact: true }).click();

    // Save a genuine provisional observation; it never completes review on its own.
    await view.getByRole('button', { name: /^Add observation/ }).click();
    await expand(view, 'Exact source PTS');
    const start = await view.getByLabel('Observation start source PTS', { exact: true }).inputValue();
    await view.getByLabel('Observation end source PTS (exclusive)', { exact: true }).fill(String(BigInt(start) + 1n));
    await view.getByLabel('Notes', { exact: true }).fill('=SUM(1,2)\n"Synthetic", provisional');
    await view.getByRole('button', { name: 'Save observation', exact: true }).click();
    await expect(view.getByRole('list', { name: 'Saved provisional observations', exact: true }).getByRole('listitem')).toHaveCount(1);
    expect((await savedReview(shell, run.windows[0]!.id)).effective_decision).toBe('unreviewed');
    await closeWindow(view);

    // A gallery filter is a view only; the export always covers every planned window.
    await shell.page.getByRole('toolbar', { name: 'Window filter', exact: true }).getByRole('button', { name: /^Failed or incomplete \d+$/ }).click();
    await expect(windowCards(shell)).toHaveCount(1);
    await goTo(shell, 'Export');
    const exportPanel = shell.page.getByRole('region', { name: 'Provisional CSV export', exact: true });
    const action = exportPanel.getByRole('button', { name: 'Export provisional CSVs', exact: true });
    await expect(action).toBeDisabled();
    await exportPanel.getByRole('checkbox', { name: 'I understand these CSVs are provisional and not final ecological reports.', exact: true }).check();
    await expect(action).toBeEnabled();
    await action.click();
    await expect(exportPanel.getByRole('status').filter({ hasText: /^Ready: 6 planned windows, 0 reviewed, 5 QA pending\.$/ })).toBeVisible();
    await expect(exportPanel).toContainText('processing INCOMPLETE');

    await shell.application.evaluate(({ dialog }) => { dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog; });
    await exportPanel.getByRole('button', { name: 'Save provisional CSV bundle...', exact: true }).click();
    await expect(shell.page.getByText('Save cancelled. Choose a folder when ready.', { exact: true })).toBeVisible();
    expect(await readdir(destination)).toEqual([]);
    await shell.application.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog; }, destination);
    await exportPanel.getByRole('button', { name: 'Save provisional CSV bundle...', exact: true }).click();
    await expect(shell.page.getByText(/^Saved in a new folder named /)).toBeVisible();
    const folders = await readdir(destination); expect(folders).toHaveLength(1);
    const folder = join(destination, folders[0]!);
    const parse = spawnSync(process.env.BAT_PYTHON ?? 'python', ['-c',
      'import csv,json,sys; from pathlib import Path; from backend.app.csv_export import decode_text,NUMERIC; p=Path(sys.argv[1]); print(json.dumps({k:[{a:b if a in NUMERIC else decode_text(b) for a,b in r.items()} for r in csv.DictReader((p/f).open(newline=""))] for k,f in [("audit","technical-window-audit.csv"),("observations","provisional-observations.csv")]}))', folder],
      { cwd: resolve('.'), encoding: 'utf8', timeout: 15000 });
    expect(parse.status, parse.stderr).toBe(0);
    const records = JSON.parse(parse.stdout) as { audit: Record<string, string>[]; observations: Record<string, string>[] };
    expect(records.audit).toHaveLength(6); expect(records.observations).toHaveLength(1);
    expect(records.audit.every(row => row.run_id === run.id)).toBe(true);
    expect(records.audit.some(row => row.processing_status === 'incomplete')).toBe(true);
    // Spreadsheet formula prefixes and quotes survive as data, not formulas.
    expect(records.observations[0]!.first_review_actor).toBe('=Synthetic first reviewer');
    expect(records.observations[0]!.count).toBe('');
    expect(records.observations[0]!.start_pts).toBe(start);
    expect(records.observations[0]!.notes).toBe('=SUM(1,2)\n"Synthetic", provisional');
    expect(await readFile(join(folder, 'technical-window-audit.csv'), 'utf8')).not.toContain(directory);
    await quit(shell); shell = undefined;
    expect(await readdir(join(data, 'exports'))).toEqual([]);
    shell = await launch(data); await quit(shell); shell = undefined;
    expect(await readdir(folder)).toEqual(['manifest.json', 'provisional-counts.csv', 'provisional-observations.csv', 'provisional-tracks.csv', 'technical-window-audit.csv']);
    expect(await digests(paths)).toEqual(hashes);
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});
