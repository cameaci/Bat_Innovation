import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ApiResult, Health, NewSession, RecordingSession } from './contracts';

const unavailable = (message = 'Backend unavailable. Reopen the app after checking Python, ffmpeg and ffprobe.') =>
  ({ ok: false, error: { code: 'unavailable', message } }) as const;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Read only known, redacted startup codes from the Python process. */
function safeStartupFailure(output: string): string | undefined {
  const mediaTool = output.match(/Required media tool is unavailable: (ffmpeg|ffprobe)\b/);
  if (mediaTool) return 'Required media tool is unavailable: ' + mediaTool[1] + '. Install it on PATH and reopen the app.';
  if (output.includes('BAT_STARTUP_ERROR:database_schema')) {
    return 'The local database has an unsupported schema version. Open it with a compatible app version or restore a supported backup. The database was not changed.';
  }
  if (output.includes('BAT_STARTUP_ERROR:database_unreadable')) {
    return 'The local database could not be read. Preserve the original file and check its storage permissions or restore a known-good backup.';
  }
  return undefined;
}

/** Fixed routes only. This client lives in the main process, never in React. */
export class BackendClient {
  constructor(private readonly port: number, private readonly token: string) {}

  private call<T>(path: '/api/health' | '/api/sessions', input?: NewSession): Promise<ApiResult<T>> {
    return new Promise((resolve) => {
      const body = input === undefined ? undefined : JSON.stringify(input);
      const req = request({
        hostname: '127.0.0.1', port: this.port, path,
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'X-Bat-Token': this.token, ...(body === undefined ? {} : {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        }) },
      }, (res) => {
        if (res.statusCode === 401) {
          res.resume();
          resolve({ ok: false, error: { code: 'unauthorized', message: 'Backend token rejected. Close and reopen the app.' } });
          return;
        }
        if (res.statusCode !== 200 && res.statusCode !== 201) {
          res.resume();
          resolve({ ok: false, error: {
            code: res.statusCode === 422 ? 'invalid' : 'backend',
            message: res.statusCode === 422 ? 'Display name and camera reference must contain 1-120 characters.' : `Backend request failed (HTTP ${res.statusCode}).`,
          } });
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          data += chunk;
          if (data.length > 4 * 1024 * 1024) res.destroy(new Error('Response too large'));
        });
        res.on('error', () => resolve(unavailable()));
        res.on('end', () => {
          try { resolve({ ok: true, value: JSON.parse(data) as T }); }
          catch { resolve({ ok: false, error: { code: 'backend', message: 'Backend returned an invalid response.' } }); }
        });
      });
      // An absolute deadline also covers a server that accepts but never completes a response.
      const timeout = setTimeout(() => req.destroy(new Error('Request timed out')), 3000);
      req.on('close', () => clearTimeout(timeout));
      req.on('error', () => resolve(unavailable()));
      req.end(body);
    });
  }

  async health(): Promise<ApiResult<Health>> {
    const result = await this.call<Health>('/api/health');
    if (result.ok && (result.value?.status !== 'ok' || result.value.storage !== 'ready' || result.value.media_tools !== 'ready')) {
      return { ok: false, error: { code: 'backend', message: 'Backend readiness response was not recognised.' } };
    }
    return result;
  }
  listSessions(): Promise<ApiResult<RecordingSession[]>> { return this.call('/api/sessions'); }
  createSession(input: NewSession): Promise<ApiResult<RecordingSession>> {
    if (!input || typeof input.display_name !== 'string' || typeof input.camera_ref !== 'string' ||
      [input.display_name, input.camera_ref].some((value) => value.trim().length < 1 || value.length > 120) ||
      Object.keys(input).some((key) => key !== 'display_name' && key !== 'camera_ref')) {
      return Promise.resolve({ ok: false, error: { code: 'invalid', message: 'Provide only a display name and camera reference, each 1-120 characters.' } });
    }
    return this.call('/api/sessions', { display_name: input.display_name.trim(), camera_ref: input.camera_ref.trim() });
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('No loopback port available')); return; }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

/** Resolve existing ancestors too, so a symlink cannot redirect app data into the checkout. */
export function isExternalDataDirectory(repoRoot: string, dataDir: string): boolean {
  if (!isAbsolute(dataDir)) return false;
  try {
    let ancestor = dataDir;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    const actual = resolve(realpathSync(ancestor), relative(ancestor, dataDir));
    const withinRepo = relative(realpathSync(repoRoot), actual);
    return withinRepo === '..' || withinRepo.startsWith(`..${sep}`) || isAbsolute(withinRepo);
  } catch { return false; }
}

export interface BackendOptions { python: string; repoRoot: string; dataDir: string; port?: number }

/** Owns exactly one child. Never attaches to, or kills, a process found by port. */
export class BackendRuntime {
  private child?: ChildProcess;
  private closed: Promise<void> = Promise.resolve();
  private client?: BackendClient;
  private starting?: Promise<ApiResult<Health>>;
  private stopping?: Promise<void>;
  private stopped = false;
  private failure = unavailable();
  get pid(): number | undefined { return this.child?.pid; }

  start(options: BackendOptions): Promise<ApiResult<Health>> {
    // Preserve a single launch even when multiple renderer requests arrive together.
    this.starting ??= this.launch(options);
    return this.starting;
  }

  private async launch(options: BackendOptions): Promise<ApiResult<Health>> {
    if (!isExternalDataDirectory(options.repoRoot, options.dataDir)) {
      this.failure = unavailable('App data must be an absolute directory outside the repository.');
      return this.failure;
    }
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
      this.failure = unavailable('BAT_API_PORT must be a valid TCP port.');
      return this.failure;
    }
    try {
      const port = options.port ?? await freePort();
      if (this.stopped) return this.failure;
      const token = randomBytes(32).toString('hex');
      this.client = new BackendClient(port, token);
      const child = spawn(options.python, ['-m', 'backend.app'], {
        cwd: options.repoRoot, shell: false, windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, BAT_APP_DATA_DIR: options.dataDir, BAT_API_TOKEN: token, BAT_API_PORT: String(port) },
      });
      this.child = child;
      this.closed = new Promise<void>((resolve) => {
        child.once('error', () => { this.failure = unavailable('Backend could not start. Check BAT_PYTHON and the installed Python requirements.'); });
        child.once('close', () => { this.child = undefined; resolve(); });
      });
      // Do not echo stderr: tracebacks can contain private paths. Surface known prerequisite failures only.
      let stderr = '';
      child.stderr?.on('data', (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-8192);
        const diagnostic = safeStartupFailure(stderr);
        if (diagnostic) this.failure = unavailable(diagnostic);
      });
      const deadline = Date.now() + 15000;
      while (!this.stopped && this.child && Date.now() < deadline) {
        const result = await this.client.health();
        if (result.ok && this.child && !this.stopped) return result;
        if (!result.ok && result.error.code === 'unauthorized') {
          await this.stop();
          return result;
        }
        await delay(100);
      }
    } catch {
      this.failure = unavailable('Backend could not start. Check Python, the local data directory and available loopback ports.');
    }
    await this.stop();
    return this.failure;
  }

  async health(): Promise<ApiResult<Health>> {
    const ready = await this.starting;
    if (!ready?.ok || !this.child || !this.client || this.stopped) return ready && !ready.ok ? ready : this.failure;
    return this.client.health();
  }
  async listSessions(): Promise<ApiResult<RecordingSession[]>> {
    const health = await this.health();
    return health.ok && this.client ? this.client.listSessions() : health as ApiResult<RecordingSession[]>;
  }
  async createSession(input: NewSession): Promise<ApiResult<RecordingSession>> {
    const health = await this.health();
    return health.ok && this.client ? this.client.createSession(input) : health as ApiResult<RecordingSession>;
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.stopping ??= this.stopChild();
    return this.stopping;
  }
  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await this.closed; }
    finally { clearTimeout(timeout); }
  }
}
