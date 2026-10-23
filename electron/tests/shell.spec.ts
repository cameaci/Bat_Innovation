import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import type { BatAPI } from '../src/contracts';
import { backendChildren, cleanup, launch, launchEnvironment, quit, type RunningShell } from './shell-helpers';
import { createSurvey } from './ui-helpers';

test.skip(process.platform !== 'linux', 'Linux /proc verifies backend credentials and process cleanup; Windows is unverified.');

test('real backend readiness, SQLite session persistence and narrow renderer bridge', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bat-shell-test-'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(dataDir);
    const { page } = shell;
    await expect(page.getByText('SQLite storage ready.', { exact: true })).toBeVisible();
    await expect(page.getByText(/FFmpeg and ffprobe available/)).toHaveCount(0);
    expect(page.url()).toMatch(/^app:\/\/bat\/index\.html(#\/)?$/);
    expect(await page.evaluate(() => ({
      nodeProcess: typeof (globalThis as { process?: unknown }).process,
      nodeRequire: typeof (globalThis as { require?: unknown }).require,
      bridge: Object.keys((window as unknown as { batAPI: BatAPI }).batAPI).sort(),
      bridgeFrozen: Object.isFrozen((window as unknown as { batAPI: BatAPI }).batAPI),
    }))).toEqual({
      nodeProcess: 'undefined',
      nodeRequire: 'undefined',
      bridge: ['cancelExport', 'cancelImport', 'cancelPreview', 'cancelSummaries', 'cancelTracking', 'chooseMedia', 'createSession', 'decideCandidate', 'exportStatus', 'getCounts', 'getHeatmap', 'getMedia', 'getTracks', 'getWindowQA', 'getWindowReview', 'health', 'importStatus', 'listCandidates', 'listGates', 'listSessions', 'listSummaryRuns', 'listTracking', 'previewContent', 'previewStatus', 'qaHistory', 'reviewHistory', 'saveCountQA', 'saveCountReview', 'saveExportBundle', 'saveGate', 'saveMedia', 'saveQA', 'saveReview', 'setDraftDirty', 'startExport', 'startPreview', 'startSummaries', 'startTracking', 'summaryImage', 'summaryRun', 'trackingRun', 'upgradeMedia', 'upgradeQA', 'upgradeReviews', 'upgradeStorage', 'upgradeSummaries'],
      bridgeFrozen: true,
    });
    expect(await page.evaluate(() => new Promise<string>((resolve) => {
      const timer = window.setTimeout(() => resolve('No CSP violation'), 1000);
      document.addEventListener('securitypolicyviolation', (event) => {
        window.clearTimeout(timer);
        resolve(event.effectiveDirective);
      }, { once: true });
      void fetch('http://127.0.0.1:65534/api/health').catch(() => {});
    })), 'CSP prevents the renderer bypassing the bridge with HTTP requests').toBe('connect-src');
    expect(await page.evaluate(() => window.open('https://example.invalid') === null)).toBe(true);
    expect(await shell.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

    const survey = page.getByRole('link', { name: 'Open survey Synthetic persistence survey', exact: true });
    await createSurvey(shell, 'Synthetic persistence survey', 'Synthetic camera A');
    // A brand-new database starts at the current schema: no storage upgrade is offered.
    await expect(page.getByRole('region', { name: 'Storage upgrade' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Back to surveys' }).click();
    await expect(survey).toContainText('Synthetic camera A');
    await page.reload();
    await expect(page.getByText('Backend ready', { exact: true })).toBeVisible();
    await expect(survey).toContainText('Synthetic camera A');

    const firstTokenDigest = shell.tokenDigest;
    await quit(shell);
    shell = undefined;
    shell = await launch(dataDir);
    expect(shell.tokenDigest, 'Each app launch gets a fresh credential').not.toBe(firstTokenDigest);
    await expect(shell.page.getByRole('link', { name: 'Open survey Synthetic persistence survey', exact: true })).toContainText('Synthetic camera A');
    await quit(shell);
    shell = undefined;
  } finally {
    await cleanup(shell);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a terminated real backend produces an explicit unavailable state', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bat-shell-test-'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(dataDir);
    process.kill(shell.backendPid, 'SIGTERM');
    await expect.poll(() => backendChildren(shell!.application.process().pid!)).toEqual([]);
    await shell.page.getByRole('button', { name: /^Refresh/ }).click();
    await expect(shell.page.getByRole('alert')).toContainText(/backend.*unavailable|cannot.*backend|could not.*backend/i);
    await expect(shell.page.getByText('Backend ready', { exact: true })).not.toBeVisible();
    await quit(shell);
    shell = undefined;
  } finally {
    await cleanup(shell);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('backend startup failure is visible and the shell still quits cleanly', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bat-shell-test-'));
  let application: ElectronApplication | undefined;
  try {
    application = await _electron.launch({
      args: ['--no-sandbox', resolve('electron')],
      env: { ...launchEnvironment(dataDir), BAT_PYTHON: join(dataDir, 'missing-python') },
    });
    const page = await application.firstWindow();
    await expect(page.getByRole('alert')).toContainText(/backend.*unavailable/i);
    await expect(page.getByText('Backend ready', { exact: true })).not.toBeVisible();
    const mainPid = await application.evaluate(() => process.pid);
    expect(backendChildren(mainPid)).toEqual([]);
    await application.close();
    application = undefined;
  } finally {
    await application?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
