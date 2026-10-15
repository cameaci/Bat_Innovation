import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { BatAPI } from '../src/contracts';

interface RunningShell {
  application: ElectronApplication;
  page: Page;
  backendPid: number;
  tokenDigest: string;
}

function launchEnvironment(dataDir: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && name !== 'BAT_API_TOKEN' && name !== 'BAT_API_PORT') environment[name] = value;
  }
  environment.BAT_APP_DATA_DIR = dataDir;
  environment.BAT_PYTHON = process.env.BAT_PYTHON ?? 'python';
  return environment;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function backendChildren(parentPid: number): number[] {
  const result = spawnSync('ps', ['--ppid', String(parentPid), '-o', 'pid=,args='], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !(result.status === 1 && !result.stdout.trim())) {
    throw new Error('Could not inspect Electron child processes.');
  }
  return result.stdout.split('\n')
    .filter((line) => /\s-m\s+backend\.app(?:\s|$)/.test(line))
    .map((line) => Number(line.trim().split(/\s+/, 1)[0]));
}

async function launch(dataDir: string): Promise<RunningShell> {
  const application = await _electron.launch({
    args: ['--no-sandbox', resolve('electron')],
    env: launchEnvironment(dataDir),
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByText('Backend ready', { exact: true })).toBeVisible();
    const mainPid = await application.evaluate(() => process.pid);
    const children = backendChildren(mainPid);
    expect(children, 'The shell must own exactly one Python backend').toHaveLength(1);
    const backendPid = children[0]!;
    const childEnvironment = (await readFile(`/proc/${backendPid}/environ`, 'utf8')).split('\0');
    const tokenEntry = childEnvironment.find((entry) => entry.startsWith('BAT_API_TOKEN='));
    expect(Boolean(tokenEntry), 'Backend receives a generated launch token').toBe(true);
    const token = tokenEntry!.slice('BAT_API_TOKEN='.length);
    expect(token.length >= 32, 'Launch token has at least 32 characters').toBe(true);
    return {
      application,
      page,
      backendPid,
      // Compare hashes, so a failed assertion never prints a launch credential.
      tokenDigest: createHash('sha256').update(token).digest('hex'),
    };
  } catch (error) {
    await application.close();
    throw error;
  }
}

async function quit(shell: RunningShell): Promise<void> {
  // Playwright's close calls app.quit(), exercising the real before-quit lifecycle.
  await shell.application.close();
  await expect.poll(() => isRunning(shell.backendPid), {
    message: 'Electron shutdown must reap its backend child',
    timeout: 10_000,
  }).toBe(false);
}

async function cleanup(shell: RunningShell | undefined): Promise<void> {
  if (!shell) return;
  try {
    await shell.application.close();
  } finally {
    if (isRunning(shell.backendPid)) {
      // A failing test must not leave its synthetic backend running.
      process.kill(shell.backendPid, 'SIGKILL');
    }
  }
}

test.skip(process.platform !== 'linux', 'Linux /proc verifies backend credentials and process cleanup; Windows is unverified.');

test('real backend readiness, SQLite session persistence and narrow renderer bridge', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bat-shell-test-'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(dataDir);
    const { page } = shell;
    expect(page.url()).toBe('app://bat/index.html');
    expect(await page.evaluate(() => ({
      nodeProcess: typeof (globalThis as { process?: unknown }).process,
      nodeRequire: typeof (globalThis as { require?: unknown }).require,
      bridge: Object.keys((window as unknown as { batAPI: BatAPI }).batAPI).sort(),
      bridgeFrozen: Object.isFrozen((window as unknown as { batAPI: BatAPI }).batAPI),
    }))).toEqual({
      nodeProcess: 'undefined',
      nodeRequire: 'undefined',
      bridge: ['createSession', 'health', 'listSessions'],
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

    await page.getByLabel('Display name', { exact: true }).fill('Synthetic persistence survey');
    await page.getByLabel('Camera reference', { exact: true }).fill('Synthetic camera A');
    await page.getByRole('button', { name: 'Create session', exact: true }).click();
    await expect(page.getByRole('row', { name: /Synthetic persistence survey.*Synthetic camera A/ })).toBeVisible();
    await page.reload();
    await expect(page.getByText('Backend ready', { exact: true })).toBeVisible();
    await expect(page.getByRole('row', { name: /Synthetic persistence survey.*Synthetic camera A/ })).toBeVisible();

    const firstTokenDigest = shell.tokenDigest;
    await quit(shell);
    shell = undefined;
    shell = await launch(dataDir);
    expect(shell.tokenDigest, 'Each app launch gets a fresh credential').not.toBe(firstTokenDigest);
    await expect(shell.page.getByRole('row', { name: /Synthetic persistence survey.*Synthetic camera A/ })).toBeVisible();
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
    await expect.poll(() => isRunning(shell!.backendPid)).toBe(false);
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
