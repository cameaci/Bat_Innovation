import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test';

export interface RunningShell {
  application: ElectronApplication;
  page: Page;
  backendPid: number;
  tokenDigest: string | null;
}

export function launchEnvironment(dataDir: string): Record<string, string> {
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

export function backendChildren(parentPid: number): number[] {
  if (process.platform === 'win32') {
    if (!Number.isSafeInteger(parentPid) || parentPid <= 0) throw new Error('Invalid parent PID.');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parentPid}" | Where-Object { $_.CommandLine -match '\\s-m\\s+backend\\.app(?:\\s|$)' } | ForEach-Object { $_.ProcessId }`],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Could not inspect Electron child processes.');
    return result.stdout.trim() ? result.stdout.trim().split(/\s+/).map(Number) : [];
  }
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

export async function launch(dataDir: string): Promise<RunningShell> {
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
    let tokenDigest: string | null = null;
    if (process.platform === 'linux') {
      const childEnvironment = (await readFile(`/proc/${backendPid}/environ`, 'utf8')).split('\0');
      const tokenEntry = childEnvironment.find((entry) => entry.startsWith('BAT_API_TOKEN='));
      expect(Boolean(tokenEntry), 'Backend receives a generated launch token').toBe(true);
      const token = tokenEntry!.slice('BAT_API_TOKEN='.length);
      expect(token.length >= 32, 'Launch token has at least 32 characters').toBe(true);
      // Compare hashes, so a failed assertion never prints a launch credential.
      tokenDigest = createHash('sha256').update(token).digest('hex');
    }
    return {
      application,
      page,
      backendPid,
      tokenDigest,
    };
  } catch (error) {
    await application.close();
    throw error;
  }
}

export async function quit(shell: RunningShell): Promise<void> {
  // Playwright's close calls app.quit(), exercising the real before-quit lifecycle.
  await shell.application.close();
  await expect.poll(() => isRunning(shell.backendPid), {
    message: 'Electron shutdown must reap its backend child',
    timeout: 10_000,
  }).toBe(false);
}

export async function cleanup(shell: RunningShell | undefined): Promise<void> {
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
