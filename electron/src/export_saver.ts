/** Native-directory publication of one bounded, verified provisional bundle. */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isExternalDataDirectory, isUUID } from './backend';
import type { BackendRuntime } from './backend';
import type { ApiResult, ExportManifest, ExportDiskManifest, ExportSaved, ExportKind } from './contracts';

export const EXPORT_FILES = { observations: 'provisional-observations.csv', audit: 'technical-window-audit.csv', tracks: 'provisional-tracks.csv',
  counts: 'provisional-counts.csv', manifest: 'manifest.json' } as const;
const PAYLOADS = ['observations', 'audit', 'tracks', 'counts'] as const;
const failure = () => ({ ok: false, error: { code: 'export_write_failed', message: 'The provisional bundle could not be saved completely. Check storage and retry; no partial CSV bundle was published.' } }) as const;
const empty = { cancelled: true, folder_name: '', files: [] };

export function validExportManifest(value: ExportManifest | null, runID: string): value is ExportManifest {
  return !!value && value.schema_version === 'bat-provisional-csv-v3' && value.run_id === runID &&
    value.provisional_label === 'PROVISIONAL — NOT ECOLOGICALLY FINALISED' && !!value.files &&
    Object.keys(value.files).length === 5 && (Object.keys(EXPORT_FILES) as ExportKind[]).every(kind => {
      const file = value.files[kind];
      return !!file && file.name === EXPORT_FILES[kind] && Number.isSafeInteger(file.bytes) && file.bytes > 0 &&
        file.bytes <= (kind === 'manifest' ? 65536 : 8 * 1024 * 1024) && /^[0-9a-f]{64}$/.test(file.sha256);
    });
}

/** The saved file deliberately has no manifest.json self-hash. That
 * descriptor is transport-only, computed from the final serialized bytes. */
export function validExportDiskManifest(value: unknown, runID: string): value is ExportDiskManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.schema_version !== 'bat-provisional-csv-v3' || row.run_id !== runID ||
      row.provisional_label !== 'PROVISIONAL — NOT ECOLOGICALLY FINALISED' ||
      typeof row.as_of_utc !== 'string' || !row.as_of_utc ||
      typeof row.manifest_complete !== 'boolean' || typeof row.processing_complete !== 'boolean' ||
      !row.counts || typeof row.counts !== 'object' || Array.isArray(row.counts) ||
      !row.files || typeof row.files !== 'object' || Array.isArray(row.files)) return false;
  const files = row.files as Record<string, unknown>;
  return Object.keys(files).length === PAYLOADS.length && PAYLOADS.every(kind => {
    const file = files[kind];
    if (!file || typeof file !== 'object' || Array.isArray(file)) return false;
    const entry = file as Record<string, unknown>;
    return entry.name === EXPORT_FILES[kind] && typeof entry.bytes === 'number' &&
      Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= 8 * 1024 * 1024 &&
      typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256) &&
      typeof entry.rows === 'number' && Number.isSafeInteger(entry.rows) &&
      entry.rows >= 0 && entry.rows <= 50000;
  });
}

/** NTFS journals directory metadata itself and Windows cannot flush a directory handle, so only POSIX syncs directories. */
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export class ExportSaver {
  private operation?: Promise<ApiResult<ExportSaved>>;
  private controller?: AbortController;
  private closed = false;
  private journal: string;
  constructor(private backend: BackendRuntime, private repoRoot: string, private dataDir: string) {
    this.journal = join(dataDir, 'export-save-pending.json');
  }
  private safeParent(parent: string): boolean {
    return isExternalDataDirectory(this.repoRoot, parent) && isExternalDataDirectory(this.dataDir, parent);
  }
  /** Restart recovery: only our recorded stage and empty reservation are removed.
   * A nonempty final directory was published atomically and must be retained. */
  async recover(): Promise<void> {
    // Output directories are created only after the complete intent is durable.
    await rm(this.journal + '.part', { force: true });
    let record: { parent: string; nonce: string };
    try {
      if ((await lstat(this.journal)).size > 4096) throw new Error('Invalid recovery record');
      record = JSON.parse(await readFile(this.journal, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('Export save recovery needs local storage attention');
    }
    if (typeof record.parent !== 'string' || !isUUID(record.nonce) || !this.safeParent(record.parent) || await realpath(record.parent) !== record.parent) throw new Error('Invalid export recovery');
    const stage = join(record.parent, `.bat-provisional-${record.nonce}.part`);
    const target = join(record.parent, `bat-provisional-${record.nonce}`);
    await rm(stage, { recursive: true, force: true });
    try { if ((await readdir(target)).length === 0) await rm(target, { recursive: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await unlink(this.journal);
  }
  save(id: string, chooseParent: () => Promise<string | null>): Promise<ApiResult<ExportSaved>> {
    if (!isUUID(id)) return Promise.resolve({ ok: false, error: { code: 'invalid', message: 'Choose a valid export ID.' } });
    if (this.closed || this.operation) return Promise.resolve({ ok: false, error: { code: 'export_busy', message: 'Another native export save is active.' } });
    this.controller = new AbortController();
    this.operation = this.perform(id, chooseParent, this.controller.signal).catch(failure).finally(() => { this.operation = undefined; this.controller = undefined; });
    return this.operation;
  }
  private async perform(id: string, chooseParent: () => Promise<string | null>, signal: AbortSignal): Promise<ApiResult<ExportSaved>> {
    let stage: string | undefined, target: string | undefined, published = false, journalOwned = false, intentOwned = false, stageOwned = false, targetOwned = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const state = await this.backend.exportStatus(id);
      if (!state.ok) return state;
      if (state.value.state !== 'ready' || !validExportManifest(state.value.manifest, state.value.run_id)) return failure();
      const selected = await chooseParent();
      if (selected === null || signal.aborted) return { ok: true, value: empty };
      const parent = await realpath(selected);
      if (!this.safeParent(parent) || !(await lstat(parent)).isDirectory()) return failure();
      const nonce = randomUUID();
      stage = join(parent, `.bat-provisional-${nonce}.part`);
      target = join(parent, `bat-provisional-${nonce}`);
      // Durable intent precedes filesystem mutation, so restart can clean a crash.
      const journal = await open(this.journal + '.part', 'wx', 0o600);
      intentOwned = true;
      try { await journal.writeFile(JSON.stringify({ parent, nonce })); await journal.sync(); }
      finally { await journal.close(); }
      await rename(this.journal + '.part', this.journal); intentOwned = false; journalOwned = true;
      await syncDirectory(this.dataDir);
      await mkdir(stage, { mode: 0o700 }); stageOwned = true;
      // POSIX rename replaces an empty directory, so reserve the name first. Windows rename never replaces a
      // directory, so the final rename itself refuses an existing name and no reservation is needed.
      if (process.platform !== 'win32') { await mkdir(target, { mode: 0o700 }); targetOwned = true; }
      timeout = setTimeout(() => this.controller?.abort(), 30000);
      for (const kind of Object.keys(EXPORT_FILES) as ExportKind[]) {
        signal.throwIfAborted();
        const path = join(stage, EXPORT_FILES[kind]);
        await this.backend.downloadExportFile(id, kind, state.value.manifest.files[kind], path, signal);
        const file = await open(path, 'r');
        try { await file.sync(); } finally { await file.close(); }
      }
      signal.throwIfAborted();
      // Validate the actual saved manifest, not just the three-file API
      // envelope. Only CSV entries can be embedded without a self-hash.
      const disk = JSON.parse(await readFile(join(stage, EXPORT_FILES.manifest), 'utf8')) as unknown;
      if (!validExportDiskManifest(disk, state.value.run_id) ||
          disk.as_of_utc !== state.value.manifest.as_of_utc ||
          PAYLOADS.some(kind => {
            const declared = state.value.manifest!.files[kind];
            const actual = disk.files[kind];
            return declared.name !== actual.name || declared.bytes !== actual.bytes ||
              declared.sha256 !== actual.sha256 || declared.rows !== actual.rows;
          })) throw new Error('Saved manifest does not match verified CSV descriptors');
      await syncDirectory(stage);
      await rename(stage, target); // replaces only the empty directory we just reserved (POSIX) or a missing name (Windows)
      stage = undefined;
      await syncDirectory(parent);
      published = true;
      await unlink(this.journal); journalOwned = false;
      return { ok: true, value: { cancelled: false, folder_name: `bat-provisional-${nonce}`, files: Object.values(EXPORT_FILES) } };
    } catch { return signal.aborted ? { ok: false, error: { code: 'export_cancelled', message: 'Export save cancelled; incomplete files were removed.' } } : failure(); }
    finally {
      if (timeout) clearTimeout(timeout);
      if (stage && stageOwned) await rm(stage, { recursive: true, force: true });
      if (target && targetOwned && !published) await rm(target, { recursive: true, force: true });
      if (intentOwned) await rm(this.journal + '.part', { force: true });
      if (journalOwned) await unlink(this.journal).catch(() => undefined); // recovery retains ownership if deletion fails
    }
  }
  async close(): Promise<void> {
    this.closed = true; this.controller?.abort();
    await this.operation;
  }
}
