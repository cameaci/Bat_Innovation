import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type Locator } from '@playwright/test';
import type { BatAPI, MediaSession, SummaryDetail, WindowQA, WindowReview, QAHistory } from '../src/contracts';
import { cleanup, type RunningShell } from './shell-helpers';

/** Run one synthetic fixture generator (never real media) and return its name -> path map. */
export function fixtures<T extends string>(script: 'media_fixtures' | 'summary_fixtures' | 'preview_fixtures' | 'gallery_fixtures' | 'tracking_fixtures', directory: string): Record<T, string> {
  const result = spawnSync(process.env.BAT_PYTHON ?? 'python', ['-m', `backend.tests.${script}`, directory],
    { cwd: resolve('.'), encoding: 'utf8', timeout: 45_000 });
  expect(result.status, result.stderr || `${script} failed`).toBe(0);
  return JSON.parse(result.stdout) as Record<T, string>;
}

export async function digests(paths: string[]): Promise<string[]> {
  return Promise.all(paths.map(async path => createHash('sha256').update(await readFile(path)).digest('hex')));
}

export interface PickerSpy { calls: number; options: Electron.OpenDialogOptions | null }

/** Replace only the OS dialog boundary. All IPC, HTTP, decoding and SQLite remain real. */
export async function selectFiles(shell: RunningShell, paths: string[]): Promise<void> {
  await shell.application.evaluate(({ dialog }, selected) => {
    const spy: PickerSpy = { calls: 0, options: null };
    (dialog as typeof dialog & { pickerSpy: PickerSpy }).pickerSpy = spy;
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      spy.calls += 1;
      spy.options = args[args.length - 1] as Electron.OpenDialogOptions;
      return { canceled: false, filePaths: selected };
    }) as typeof dialog.showOpenDialog;
  }, paths);
}

export async function pickerSpy(shell: RunningShell): Promise<PickerSpy> {
  return shell.application.evaluate(({ dialog }) => (dialog as typeof dialog & { pickerSpy: PickerSpy }).pickerSpy);
}

/** Create a survey from the Surveys page and land on its Process page. */
export async function createSurvey(shell: RunningShell, name = 'Synthetic survey', camera = 'Synthetic camera'): Promise<string> {
  const { page } = shell;
  await page.getByRole('button', { name: 'New survey' }).first().click();
  await page.getByLabel('Survey name', { exact: true }).fill(name);
  await page.getByLabel('Camera', { exact: true }).fill(camera);
  await page.getByRole('button', { name: 'Create survey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Process', exact: true })).toBeVisible();
  const id = /#\/surveys\/([0-9a-f-]{36})\//.exec(page.url())?.[1];
  expect(id, 'The survey route carries its ID').toBeTruthy();
  return id!;
}

export const videos = (shell: RunningShell) => shell.page.getByRole('list', { name: 'Videos', exact: true }).getByRole('article');

export async function addVideos(shell: RunningShell, paths: string[]): Promise<void> {
  const before = await videos(shell).count();
  await selectFiles(shell, paths);
  await shell.page.getByRole('button', { name: 'Add videos', exact: true }).click();
  await expect(videos(shell)).toHaveCount(before + paths.length, { timeout: 60_000 });
}

/** Generate summaries on the Process page and wait for a terminal run. */
export async function summarize(shell: RunningShell, state: RegExp = /^Run (complete|incomplete):/): Promise<void> {
  await shell.page.getByRole('button', { name: 'Generate motion summaries', exact: true }).click();
  await expect(shell.page.getByRole('status').filter({ hasText: state })).toBeVisible({ timeout: 60_000 });
}

export async function goTo(shell: RunningShell, page: 'Process' | 'Watch' | 'Review' | 'Events' | 'Export'): Promise<void> {
  await shell.page.getByRole('navigation').getByRole('link', { name: page, exact: true }).click();
  await expect(shell.page.getByRole('heading', { name: page, exact: true, level: 1 })).toBeVisible();
}

/** Open the survey with this display name from the Surveys page (after a relaunch). */
export async function openSurvey(shell: RunningShell, name: string, page: 'Process' | 'Watch' | 'Review' | 'Events' | 'Export' = 'Process'): Promise<void> {
  await shell.page.getByRole('link', { name: `Open survey ${name}`, exact: true }).click();
  await expect(shell.page.getByRole('heading', { name: 'Process', exact: true })).toBeVisible();
  if (page !== 'Process') await goTo(shell, page);
}

export const windowCards = (shell: RunningShell) => shell.page.getByRole('list', { name: /planned windows$/ }).getByRole('article');
export const windowCard = (shell: RunningShell, label: string) => shell.page.getByRole('article', { name: label, exact: true });
export const dialog = (shell: RunningShell) => shell.page.getByRole('dialog');

/** Open a window card's review dialog from the Review page. */
export async function openWindow(shell: RunningShell, label: string): Promise<Locator> {
  await windowCard(shell, label).getByRole('button').click();
  const opened = dialog(shell);
  await expect(opened).toBeVisible();
  return opened;
}

/** The dialog auto-starts the original preview; a ready clip is the review receipt. */
export async function previewReady(view: Locator): Promise<void> {
  await expect(view.getByText('Preview ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(view.getByLabel('Derived source preview', { exact: true })).toBeVisible();
  await expect(view.getByText(/^Watch the original video/)).toHaveCount(0);
}

/** Open the window card at this gallery position. */
export async function openAt(shell: RunningShell, index: number): Promise<Locator> {
  await windowCards(shell).nth(index).getByRole('button').click();
  const opened = dialog(shell);
  await expect(opened).toBeVisible();
  return opened;
}

export async function closeWindow(view: Locator): Promise<void> {
  await view.getByRole('button', { name: 'Close window', exact: true }).click();
  await expect(view).toBeHidden();
}

/** Open a collapsed <details> section by its summary text (idempotent). */
export async function expand(view: Locator, summary: string): Promise<void> {
  const details = view.locator(`xpath=.//details[summary[normalize-space()="${summary}"]]`);
  if (!(await details.evaluate(element => (element as HTMLDetailsElement).open))) await details.locator('xpath=./summary').click();
}

/** The Review page progress line, for example "1 of 6 windows". */
export const reviewProgress = (shell: RunningShell, reviewed: number, total: number) =>
  shell.page.getByRole('status').filter({ hasText: new RegExp(`^${reviewed} of ${total} windows$`) });

/** Create a survey, add originals, summarise them and land on the Review page. */
export async function preparedReview(shell: RunningShell, paths: string[], name: string): Promise<string> {
  const sessionID = await createSurvey(shell, name, 'Synthetic review camera');
  await addVideos(shell, paths);
  await summarize(shell);
  await goTo(shell, 'Review');
  return sessionID;
}

/** Fail-safe teardown: accept any pending native or in-page discard prompt, then stop the app. */
export async function cleanupDraftShell(shell: RunningShell | undefined): Promise<void> {
  if (shell) await shell.application.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = (() => 1) as typeof dialog.showMessageBoxSync;
  }).catch(() => undefined);
  if (shell) await shell.page.evaluate(() => { window.confirm = () => true; }).catch(() => undefined);
  await cleanup(shell);
}

export async function displayedPTS(view: Locator): Promise<string | null> {
  const text = await view.getByLabel('Displayed original frame', { exact: true }).textContent().catch(() => null);
  return /Displayed source PTS (-?\d+)/.exec(text ?? '')?.[1] ?? null;
}

async function call<T>(shell: RunningShell, action: string, ...args: unknown[]): Promise<T> {
  const result = await shell.page.evaluate(([name, values]) => {
    const api = (window as unknown as { batAPI: Record<string, (...input: unknown[]) => Promise<unknown>> }).batAPI;
    return api[name as string]!(...(values as unknown[]));
  }, [action, args] as const) as { ok: true; value: T } | { ok: false; error: { message: string } };
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

export const getMedia = (shell: RunningShell, sessionID: string) => call<MediaSession>(shell, 'getMedia', sessionID);
export const savedReview = (shell: RunningShell, windowID: string) => call<WindowReview>(shell, 'getWindowReview', windowID);
export const savedQA = (shell: RunningShell, windowID: string) => call<WindowQA>(shell, 'getWindowQA', windowID);
export const qaHistory = (shell: RunningShell, windowID: string) => call<QAHistory>(shell, 'qaHistory', windowID, 0);

export async function latestRun(shell: RunningShell, sessionID: string): Promise<SummaryDetail> {
  const runs = await call<{ id: string }[]>(shell, 'listSummaryRuns', sessionID);
  expect(runs.length, 'A summary run was persisted').toBeGreaterThan(0);
  return call<SummaryDetail>(shell, 'summaryRun', runs[0]!.id);
}

export type Bridge = BatAPI;
