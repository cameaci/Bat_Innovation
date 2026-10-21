import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ApiResult, Health, ImportJob, MediaSession, NewSession, PreviewJob, PreviewRequest, RecordingSession, SaveMedia, SummaryRequest, SummaryRun, SummaryDetail, ReviewChange, WindowReview, ReviewHistory } from './contracts';
import type { ExportJob, ExportKind, ExportFile, QAChange, WindowQA, QAHistory } from './contracts';

const unavailable = (message = 'Backend unavailable. Reopen the app after checking Python and the installed backend dependencies.') =>
  ({ ok: false, error: { code: 'unavailable', message } }) as const;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const isUUID = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const invalid = (message = 'Invalid application request.') => ({ ok: false, error: { code: 'invalid', message } }) as const;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const provenance = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 500;

export const MAX_REVIEW_BYTES = 8 * 1024;
export const isReviewCursor = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 2 ** 31;
export function isQAChange(input: unknown): input is QAChange {
  if (!object(input) || !exactKeys(input, ['actor', 'expected_revision', 'expected_first_review_revision', 'expected_evidence_revision', 'action', 'decision', 'note', 'suggestion', 'preview_id', 'confirmed']) ||
      !isReviewCursor(input.expected_revision) || !isReviewCursor(input.expected_first_review_revision) || !isReviewCursor(input.expected_evidence_revision) ||
      typeof input.actor !== 'string' || !input.actor.trim() || input.actor.length > 120 || input.confirmed !== true ||
      typeof input.note !== 'string' || input.note.length > 2000 || !(input.preview_id === null || isUUID(input.preview_id))) return false;
  if (input.action === 'retract') {
    if (input.decision !== null || !input.note.trim() || input.suggestion !== null || input.preview_id !== null) return false;
  } else if (input.action !== 'set_decision' || typeof input.decision !== 'string' || !['agree', 'disagree', 'needs_clarification', 'unassessable'].includes(input.decision) || (input.decision !== 'agree' && !input.note.trim())) return false;
  if (input.suggestion !== null) {
    const row = input.suggestion;
    if (!['disagree', 'needs_clarification'].includes(String(input.decision)) || !object(row) ||
      !exactKeys(row, ['observation_id', 'observation_revision', 'note', 'category', 'count']) || !isUUID(row.observation_id) ||
      !isReviewCursor(row.observation_revision) || row.observation_revision < 1 || typeof row.note !== 'string' || !row.note.trim() || row.note.length > 2000 ||
      !(row.category === null || typeof row.category === 'string' && ['bat','insect','bird','other','uncertain'].includes(row.category)) ||
      !(row.count === null || typeof row.count === 'number' && Number.isInteger(row.count) && row.count >= 0 && row.count <= 100000)) return false;
  }
  try { return Buffer.byteLength(JSON.stringify(input), 'utf8') <= MAX_REVIEW_BYTES; } catch { return false; }
}
const sourcePTS = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^-?\d{1,19}$/.test(value)) return false;
  const pts = BigInt(value);
  return pts >= -(2n ** 63n) && pts < 2n ** 63n;
};
export function isReviewChange(input: unknown): input is ReviewChange {
  if (!object(input) || !isReviewCursor(input.expected_revision) || typeof input.actor !== 'string' ||
      input.actor.trim().length < 1 || input.actor.length > 120 || typeof input.action !== 'string') return false;
  const common = ['actor', 'expected_revision', 'action'];
  if (input.action === 'set_decision') {
    if (!exactKeys(input, [...common, 'decision', 'preview_id']) ||
      (typeof input.decision !== 'string' || !['unreviewed', 'reviewed_with_observations', 'reviewed_no_discernible_event'].includes(input.decision)) ||
      !(input.preview_id === null || isUUID(input.preview_id))) return false;
  } else if (input.action === 'unable_to_assess') {
    if (!exactKeys(input, [...common, 'note']) || typeof input.note !== 'string' || input.note.trim().length < 1 || input.note.length > 2000) return false;
  } else if (input.action === 'delete_observation') {
    if (!exactKeys(input, [...common, 'observation_id']) || !isUUID(input.observation_id)) return false;
  } else if (input.action === 'add_observation' || input.action === 'update_observation') {
    if (!exactKeys(input, [...common, 'observation', ...(input.action === 'update_observation' ? ['observation_id'] : [])]) ||
      (input.action === 'update_observation' && !isUUID(input.observation_id))) return false;
    const row = input.observation;
    if (!object(row) || !exactKeys(row, ['segment_id', 'start_pts', 'end_pts', 'category', 'activity', 'count', 'uncertain', 'notes']) ||
      !isUUID(row.segment_id) || !sourcePTS(row.start_pts) || !sourcePTS(row.end_pts) || BigInt(row.start_pts) >= BigInt(row.end_pts) ||
      (typeof row.category !== 'string' || !['bat', 'insect', 'bird', 'other', 'uncertain'].includes(row.category)) ||
      !(row.activity === null || (typeof row.activity === 'string' && row.activity.length <= 120)) ||
      !(row.count === null || (typeof row.count === 'number' && Number.isInteger(row.count) && row.count >= 0 && row.count <= 100000)) ||
      typeof row.uncertain !== 'boolean' || typeof row.notes !== 'string' || row.notes.length > 2000) return false;
  } else return false;
  try { return Buffer.byteLength(JSON.stringify(input), 'utf8') <= MAX_REVIEW_BYTES; } catch { return false; }
}

export const MAX_SUMMARY_BYTES = 4 * 1024 * 1024;
export function isSummaryRequest(input: unknown): input is SummaryRequest {
  return object(input) && exactKeys(input, ['session_id', 'window_seconds']) && isUUID(input.session_id) &&
    typeof input.window_seconds === 'number' && Number.isInteger(input.window_seconds) && input.window_seconds >= 1 && input.window_seconds <= 120;
}

export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
export function isPreviewRequest(input: unknown): input is PreviewRequest {
  if (!object(input) || !exactKeys(input, ['segment_id', 'source_pts']) || !isUUID(input.segment_id) ||
      typeof input.source_pts !== 'string' || !/^-?\d{1,19}$/.test(input.source_pts)) return false;
  const pts = BigInt(input.source_pts);
  return pts >= -(2n ** 63n) && pts < 2n ** 63n;
}

export function isSaveMedia(input: unknown): input is SaveMedia {
  if (!object(input) || !exactKeys(input, ['segment_ids', 'continuity', 'clock_anchor']) ||
    !Array.isArray(input.segment_ids) || !input.segment_ids.every(isUUID) || new Set(input.segment_ids).size !== input.segment_ids.length ||
    !Array.isArray(input.continuity) || input.continuity.length !== input.segment_ids.length) return false;
  const segmentIDs = input.segment_ids as string[];
  if (!input.continuity.every((row: unknown) => object(row) && exactKeys(row, ['segment_id', 'status', 'provenance']) &&
    isUUID(row.segment_id) && segmentIDs.includes(row.segment_id) && ['unknown', 'known_contiguous', 'known_gap'].includes(String(row.status)) &&
    (row.status === 'unknown' ? row.provenance === null : provenance(row.provenance)))) return false;
  if (new Set(input.continuity.map(row => row.segment_id)).size !== segmentIDs.length) return false;
  const first = input.continuity.find(row => row.segment_id === segmentIDs[0]);
  if (first && first.status !== 'unknown') return false;
  const anchor = input.clock_anchor;
  return anchor === null || (object(anchor) && exactKeys(anchor, ['segment_id', 'utc', 'provenance']) &&
    isUUID(anchor.segment_id) && segmentIDs.includes(anchor.segment_id) && provenance(anchor.provenance) &&
    typeof anchor.utc === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(anchor.utc) && Number.isFinite(Date.parse(anchor.utc)));
}

// Only known error codes cross the desktop boundary; arbitrary response text never does.
const mediaErrors: Record<string, string> = {
  export_busy: 'Another export or this processing run is active. Wait or cancel, then retry.',
  export_too_large: 'Export exceeds a row, byte, CPU, memory, snapshot or time limit. No partial export was published.',
  export_stale: 'Export evidence or coverage changed or is inconsistent. Refresh and retry.',
  export_write_failed: 'The provisional export could not be written. Check local storage and retry.',
  export_missing: 'This export or run is unavailable. Generate the provisional export again.',
  export_schema_required: 'Explicitly upgrade to QA schema 5 before exporting provisional CSVs.',
  export_limits_unavailable: 'Safe export process limits are currently verified on Linux only.',
  export_cancelled: 'Export cancelled. Incomplete managed files were removed.',
  qa_schema_required: 'Use Upgrade QA storage before independent second review.',
  qa_upgrade_failed: 'QA storage could not be upgraded. The existing database was preserved.',
  qa_invalid: 'Confirm a supported QA action, reviewer label, written rationale and observation suggestion.',
  qa_conflict: 'QA, first review or evidence changed. Your QA draft is retained; discard and reload before retrying.',
  qa_same_actor: 'QA must use a different normalized first-review label. Distinct labels alone do not prove distinct humans.',
  qa_unavailable: 'Current complete evidence, a valid first review and an original preview are required. Record an unassessable note if needed.',
  qa_busy: 'A media or review operation is active. Keep your QA draft and retry when it stops.',
  review_schema_required: 'Use Upgrade review storage before saving manual review.',
  review_upgrade_failed: 'Review storage could not be upgraded. The existing database was preserved.',
  review_invalid: 'Check the reviewer label, exact source PTS span and provisional fields.',
  review_conflict: 'This window changed since the form was loaded. Your draft is retained; discard it and reload before retrying.',
  review_missing: 'The selected run, window or observation is unavailable. Refresh after saving or discarding your draft.',
  review_unavailable: 'Original evidence cannot currently be verified. Use unable to assess, or restore valid evidence and create a source preview.',
  review_busy: 'A media operation is active. Keep your draft and retry after it stops.',
  summary_image_missing: 'The generated image is missing. Its original window remains in the manifest; generate a new run.',
  summary_no_sources: 'Import original recordings before generating summaries.',
  coverage_mismatch: 'Decoded source coverage differs from imported metadata. The run remains incomplete.',
  image_unavailable: 'A derived image is missing or corrupt. Its window remains incomplete.',
  incomplete_coverage: 'Some planned windows have no valid output. Inspect all coverage records.',
  incomplete_run: 'Processing ended before this window completed. Its coverage record remains visible.',
  summary_upgrade_failed: 'Summary storage needs an explicit upgrade from media schema version 2. The existing database was preserved.',
  summary_upgrade_required: 'Use Upgrade summary storage before processing windows.',
  summary_busy: 'A media operation is running. Wait for it or cancel it before starting another.',
  summary_missing: 'This summary run or window is unavailable. Refresh the session.',
  summary_not_ready: 'This window has no complete image. Its coverage record remains visible.',
  summary_limits_unavailable: 'Summary resource limits are unavailable on this platform. Windows execution remains unverified.',
  summary_limit: 'This run exceeds a time, frame, memory, image, source or disk limit. Incomplete windows remain visible.',
  summary_failed: 'Summary processing failed. Inspect the coverage records and original recordings before retrying.',
  summary_image_invalid: 'This derived image is missing or corrupt. Its window remains incomplete; start a new run to regenerate it.',
  invalid_summary: 'Choose an imported session and an integer window duration from 1 to 120 seconds.',
  unknown_end: 'The final frame duration is unknown. The open final interval remains incomplete.',
  no_decoded_frames: 'No original frames were decoded in this planned interval. Coverage is incomplete.',
  interrupted: 'Processing was interrupted. Completed windows are retained; remaining windows are incomplete.',
  schema_upgrade_required: 'Media storage needs an explicit upgrade. Use Upgrade media storage before importing.',
  schema_upgrade_failed: 'Media storage could not be upgraded. Close the app and check the local database before retrying.',
  session_missing: 'This session no longer exists. Refresh the session list.',
  job_missing: 'This import is no longer available. Refresh the session media.',
  import_limits_unavailable: 'Media import process limits are unavailable on this platform. Only Linux development imports are verified.',
  import_busy: 'A media import is already running. Wait for it or cancel it before importing again.',
  invalid_sources: 'Choose readable local .MTS or .MP4 original files using the native picker.',
  invalid_timeline: 'Check segment order, continuity evidence and the optional UTC clock anchor.',
  duplicate_source: 'A selected source is already imported. Choose different original files.',
  cancelled: 'Media operation cancelled. Inspect its status and any completed outputs before retrying.',
  missing_source: 'A source file is missing. Restore the selected original file and refresh media.',
  unreadable_metadata: 'Media metadata could not be read. Check the original file and supported format.',
  unsupported_codec: 'This media codec or container is unsupported. Choose a supported .MTS or .MP4 original.',
  decode_failed: 'The original could not be decoded. Check that the file is complete and supported.',
  unknown_timing: 'Reliable source timing or frame boundaries are unavailable. Exact source-time processing is blocked.',
  changed_source: 'A source file changed since import. Restore the original file before using its metadata.',
  import_failed: 'Media import failed. Check the original files and local storage, then retry.',
  unreadable_source: 'The original exists but cannot be read. Check its storage access and permissions.',
  segment_missing: 'This source segment is unavailable. Refresh the session media.',
  outside_source: 'Choose a source PTS from the first through the last decoded frame. The segment end has no new frame.',
  unseekable_source: 'A reliable bounded seek could not reach this source frame. This recording is not supported for preview.',
  preview_busy: 'A preview is running. Wait for it or cancel it before starting another media operation.',
  preview_missing: 'This preview expired or was replaced. Request a new preview from the saved segment.',
  preview_not_ready: 'This preview has no complete content. Wait for it or request a new preview.',
  preview_limits_unavailable: 'Preview resource limits are not available on this platform. Windows preview execution remains unverified.',
  preview_limit: 'This preview exceeds the time, frame, memory, dimensions or byte limit. Choose another source time or supported recording.',
  preview_failed: 'Preview generation failed. Check the original recording and local storage before retrying.',
};
function mediaFailure(code: unknown) {
  return typeof code === 'string' && Object.hasOwn(mediaErrors, code) ? { code, message: mediaErrors[code] } : { code: 'backend', message: 'Media request failed. Refresh media and check the selected originals.' };
}
type ApiRoute = '/api/exports' | `/api/exports/${string}` | `/api/exports/${string}/cancel` | '/api/qa/upgrade' | `/api/summary-windows/${string}/qa` | `/api/summary-windows/${string}/qa-actions` | `/api/summary-windows/${string}/qa-history?after_revision=${number}` | '/api/reviews/upgrade' | `/api/summary-windows/${string}/review` | `/api/summary-windows/${string}/review-actions` | `/api/summary-windows/${string}/review-history?after_revision=${number}` | '/api/health' | '/api/sessions' | '/api/media/upgrade' | '/api/media/import' |
  `/api/sessions/${string}/media` | `/api/media/import/${string}` | `/api/media/import/${string}/cancel` |
  '/api/summaries/upgrade' | '/api/summaries' | `/api/summaries/${string}` | `/api/summaries/${string}/cancel` | `/api/sessions/${string}/summary-runs` |
  '/api/media/preview' | `/api/media/preview/${string}` | `/api/media/preview/${string}/cancel`;

/** Read only known, redacted startup codes from the Python process. */
function safeStartupFailure(output: string): string | undefined {
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
  private readingPreview = false;
  constructor(private readonly port: number, private readonly token: string) {}

  private call<T>(path: ApiRoute, method: 'GET' | 'POST' | 'PUT' = 'GET', input?: unknown): Promise<ApiResult<T>> {
    return new Promise((resolve) => {
      const body = input === undefined ? undefined : JSON.stringify(input);
      const req = request({
        hostname: '127.0.0.1', port: this.port, path,
        method,
        headers: { 'X-Bat-Token': this.token, ...(body === undefined ? {} : {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        }) },
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          data += chunk;
          if (data.length > 4 * 1024 * 1024) res.destroy(new Error('Response too large'));
        });
        res.on('error', () => resolve(unavailable()));
        res.on('end', () => {
          if (res.statusCode === 401) {
            resolve({ ok: false, error: { code: 'unauthorized', message: 'Backend token rejected. Close and reopen the app.' } });
            return;
          }
          if (res.statusCode !== 200 && res.statusCode !== 201 && res.statusCode !== 202) {
            let failure = { code: res.statusCode === 422 ? 'invalid' : 'backend', message: res.statusCode === 422 ? 'The submitted fields are invalid. Check the form and try again.' : `Backend request failed (HTTP ${res.statusCode}).` };
            try {
              const parsed: unknown = JSON.parse(data);
              if (object(parsed) && object(parsed.detail) && typeof parsed.detail.code === 'string' && Object.hasOwn(mediaErrors, parsed.detail.code)) {
                failure = mediaFailure(parsed.detail.code);
              }
            } catch { /* Use a fixed message when the response is not recognised. */ }
            resolve({ ok: false, error: failure });
            return;
          }
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
    if (result.ok && (result.value?.status !== 'ok' || result.value.storage !== 'ready')) {
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
    return this.call('/api/sessions', 'POST', { display_name: input.display_name.trim(), camera_ref: input.camera_ref.trim() });
  }
  getMedia(sessionID: string): Promise<ApiResult<MediaSession>> {
    return isUUID(sessionID) ? this.call(`/api/sessions/${sessionID}/media`) : Promise.resolve(invalid());
  }
  upgradeMedia(): Promise<ApiResult<{ schema_version: 2 | 3 | 4 | 5 }>> { return this.call('/api/media/upgrade', 'POST'); }
  saveMedia(sessionID: string, input: SaveMedia): Promise<ApiResult<MediaSession>> {
    return isUUID(sessionID) && isSaveMedia(input) ? this.call(`/api/sessions/${sessionID}/media`, 'PUT', input) : Promise.resolve(invalid('Use only selected segment IDs, continuity evidence and an optional UTC clock anchor.'));
  }
  // Called only by the main process after a native selection. Never exposed in BatAPI.
  importSelectedMedia(sessionID: string, paths: string[]): Promise<ApiResult<ImportJob>> {
    return isUUID(sessionID) && Array.isArray(paths) && paths.length > 0 && paths.every(path => typeof path === 'string' && isAbsolute(path)) ?
      this.job('/api/media/import', 'POST', { session_id: sessionID, paths }) : Promise.resolve(invalid());
  }
  importStatus(jobID: string): Promise<ApiResult<ImportJob>> {
    return isUUID(jobID) ? this.job(`/api/media/import/${jobID}`) : Promise.resolve(invalid());
  }
  cancelImport(jobID: string): Promise<ApiResult<ImportJob>> {
    return isUUID(jobID) ? this.job(`/api/media/import/${jobID}/cancel`, 'POST') : Promise.resolve(invalid());
  }
  private async job(route: ApiRoute, method: 'GET' | 'POST' = 'GET', input?: unknown): Promise<ApiResult<ImportJob>> {
    const result = await this.call<ImportJob>(route, method, input);
    if (result.ok && result.value.error) result.value.error = mediaFailure(result.value.error.code);
    return result;
  }

  startPreview(input: PreviewRequest): Promise<ApiResult<PreviewJob>> {
    return isPreviewRequest(input) ? this.previewJob('/api/media/preview', 'POST', input) : Promise.resolve(invalid('Select a segment ID and an integer source PTS only.'));
  }
  previewStatus(jobID: string): Promise<ApiResult<PreviewJob>> {
    return isUUID(jobID) ? this.previewJob(`/api/media/preview/${jobID}`) : Promise.resolve(invalid());
  }
  cancelPreview(jobID: string): Promise<ApiResult<PreviewJob>> {
    return isUUID(jobID) ? this.previewJob(`/api/media/preview/${jobID}/cancel`, 'POST') : Promise.resolve(invalid());
  }
  private async previewJob(route: ApiRoute, method: 'GET' | 'POST' = 'GET', input?: unknown): Promise<ApiResult<PreviewJob>> {
    const result = await this.call<PreviewJob>(route, method, input);
    if (result.ok && result.value.error) result.value.error = mediaFailure(result.value.error.code);
    return result;
  }
  startExport(runID: string): Promise<ApiResult<ExportJob>> {
    return isUUID(runID) ? this.exportJob('/api/exports', 'POST', { run_id: runID }) : Promise.resolve(invalid());
  }
  exportStatus(jobID: string): Promise<ApiResult<ExportJob>> {
    return isUUID(jobID) ? this.exportJob(`/api/exports/${jobID}`) : Promise.resolve(invalid());
  }
  cancelExport(jobID: string): Promise<ApiResult<ExportJob>> {
    return isUUID(jobID) ? this.exportJob(`/api/exports/${jobID}/cancel`, 'POST', {}) : Promise.resolve(invalid());
  }
  private async exportJob(route: ApiRoute, method: 'GET' | 'POST' = 'GET', input?: unknown): Promise<ApiResult<ExportJob>> {
    const result = await this.call<ExportJob>(route, method, input);
    if (result.ok && result.value.error) result.value.error = mediaFailure(result.value.error.code);
    return result;
  }
  /** Privileged disk sink only. Never exposed through the renderer bridge. */
  async downloadExportFile(jobID: string, kind: ExportKind, file: ExportFile, destination: string, signal: AbortSignal): Promise<void> {
    if (!isUUID(jobID) || !['observations', 'audit', 'manifest'].includes(kind) || !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1 || file.bytes > (kind === 'manifest' ? 65536 : 8 * 1024 * 1024) || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error('Invalid export');
    const req = request({ hostname: '127.0.0.1', port: this.port, path: `/api/exports/${jobID}/files/${kind}`, headers: { 'X-Bat-Token': this.token }, signal });
    const timeout = setTimeout(() => req.destroy(new Error('Export read timed out')), 30000);
    try {
      const res = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        req.once('response', resolve); req.once('error', reject); req.end();
      });
      const mime = kind === 'manifest' ? 'application/json' : 'text/csv; charset=utf-8';
      if (res.statusCode !== 200 || res.headers['content-type'] !== mime || res.headers['content-length'] !== String(file.bytes)) {
        res.destroy(); throw new Error('Invalid export response');
      }
      let size = 0;
      const hash = createHash('sha256');
      const verify = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > file.bytes) callback(new Error('Export exceeds its byte limit'));
        else { hash.update(chunk); callback(null, chunk); }
      } });
      await pipeline(res, verify, createWriteStream(destination, { flags: 'wx', mode: 0o600, highWaterMark: 65536 }), { signal });
      if (size !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error('Incomplete export');
    } finally { clearTimeout(timeout); req.destroy(); }
  }
  upgradeQA(): Promise<ApiResult<{ schema_version: 5 }>> { return this.call('/api/qa/upgrade', 'POST'); }
  getWindowQA(windowID: string): Promise<ApiResult<WindowQA>> {
    return isUUID(windowID) ? this.call(`/api/summary-windows/${windowID}/qa`) : Promise.resolve(invalid());
  }
  saveQA(windowID: string, input: QAChange): Promise<ApiResult<WindowQA>> {
    return isUUID(windowID) && isQAChange(input) ? this.call(`/api/summary-windows/${windowID}/qa-actions`, 'POST', input) : Promise.resolve(invalid());
  }
  qaHistory(windowID: string, afterRevision: number): Promise<ApiResult<QAHistory>> {
    return isUUID(windowID) && isReviewCursor(afterRevision) ? this.call(`/api/summary-windows/${windowID}/qa-history?after_revision=${afterRevision}`) : Promise.resolve(invalid());
  }
  upgradeReviews(): Promise<ApiResult<{ schema_version: 4 | 5 }>> { return this.call('/api/reviews/upgrade', 'POST'); }
  getWindowReview(windowID: string): Promise<ApiResult<WindowReview>> {
    return isUUID(windowID) ? this.call(`/api/summary-windows/${windowID}/review`) : Promise.resolve(invalid());
  }
  saveReview(windowID: string, input: ReviewChange): Promise<ApiResult<WindowReview>> {
    return isUUID(windowID) && isReviewChange(input) ? this.call(`/api/summary-windows/${windowID}/review-actions`, 'POST', input) : Promise.resolve(invalid('Use an attributed review action, current revision and exact source PTS fields only.'));
  }
  reviewHistory(windowID: string, afterRevision: number): Promise<ApiResult<ReviewHistory>> {
    return isUUID(windowID) && isReviewCursor(afterRevision) ? this.call(`/api/summary-windows/${windowID}/review-history?after_revision=${afterRevision}`) : Promise.resolve(invalid());
  }
  upgradeSummaries(): Promise<ApiResult<{ schema_version: 3 | 4 | 5 }>> { return this.call('/api/summaries/upgrade', 'POST'); }
  async listSummaryRuns(sessionID: string): Promise<ApiResult<SummaryRun[]>> {
    if (!isUUID(sessionID)) return invalid();
    const result = await this.call<SummaryRun[]>(`/api/sessions/${sessionID}/summary-runs`);
    if (result.ok) result.value.forEach(run => { if (run.error) run.error = mediaFailure(run.error.code); });
    return result;
  }
  startSummaries(input: SummaryRequest): Promise<ApiResult<SummaryDetail>> {
    return isSummaryRequest(input) ? this.summary('/api/summaries', 'POST', input) : Promise.resolve(invalid());
  }
  summaryRun(runID: string): Promise<ApiResult<SummaryDetail>> {
    return isUUID(runID) ? this.summary(`/api/summaries/${runID}`) : Promise.resolve(invalid());
  }
  cancelSummaries(runID: string): Promise<ApiResult<SummaryDetail>> {
    return isUUID(runID) ? this.summary(`/api/summaries/${runID}/cancel`, 'POST') : Promise.resolve(invalid());
  }
  private async summary(route: ApiRoute, method: 'GET' | 'POST' = 'GET', input?: unknown): Promise<ApiResult<SummaryDetail>> {
    const result = await this.call<SummaryDetail>(route, method, input);
    if (result.ok) {
      if (result.value.error) result.value.error = mediaFailure(result.value.error.code);
      result.value.windows.forEach(window => { if (window.error) window.error = mediaFailure(window.error.code); });
    }
    return result;
  }
  summaryImage(windowID: string): Promise<ApiResult<{ bytes: Uint8Array }>> {
    return isUUID(windowID) ? this.binary(`/api/summary-windows/${windowID}/image`, 'image/png', MAX_SUMMARY_BYTES) : Promise.resolve(invalid());
  }

  // A separate fixed binary route, capped before buffering or crossing IPC. No general HTTP bridge.
  previewContent(jobID: string): Promise<ApiResult<{ bytes: Uint8Array }>> {
    if (!isUUID(jobID)) return Promise.resolve(invalid());
    return this.binary(`/api/media/preview/${jobID}/content`, 'video/webm', MAX_PREVIEW_BYTES);
  }
  private binary(path: string, mime: 'video/webm' | 'image/png', maxBytes: number): Promise<ApiResult<{ bytes: Uint8Array }>> {
    if (this.readingPreview) return Promise.resolve({ ok: false, error: mediaFailure('preview_busy') });
    this.readingPreview = true;
    return new Promise<ApiResult<{ bytes: Uint8Array }>>(resolve => {
      const req = request({ hostname: '127.0.0.1', port: this.port,
        path, headers: { 'X-Bat-Token': this.token } }, res => {
        const chunks: Buffer[] = [];
        let size = 0;
        const limit = res.statusCode === 200 ? maxBytes : 4096;
        if (Number(res.headers['content-length']) > limit) res.destroy(new Error('Response too large'));
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) res.destroy(new Error('Response too large'));
          else chunks.push(chunk);
        });
        res.on('error', () => resolve(unavailable('Derived content could not be read within its byte or time limit.')));
        res.on('end', () => {
          if (res.statusCode === 401) {
            resolve({ ok: false, error: { code: 'unauthorized', message: 'Backend token rejected. Close and reopen the app.' } });
          } else if (res.statusCode === 200 && size > 0 && res.headers['content-type'] === mime) {
            resolve({ ok: true, value: { bytes: new Uint8Array(Buffer.concat(chunks, size)) } });
          } else {
            let failure = mediaFailure(undefined);
            try { failure = mediaFailure(JSON.parse(Buffer.concat(chunks).toString('utf8')).detail?.code); } catch { /* Fixed safe failure. */ }
            resolve({ ok: false, error: failure });
          }
        });
      });
      const deadline = setTimeout(() => req.destroy(new Error('Derived content read timed out')), 3000);
      req.on('close', () => clearTimeout(deadline));
      req.on('error', () => resolve(unavailable()));
      req.end();
    }).finally(() => { this.readingPreview = false; });
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
  private async ready<T>(operation: (client: BackendClient) => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    const health = await this.health();
    return health.ok && this.client ? operation(this.client) : health as ApiResult<T>;
  }
  getMedia(sessionID: string): Promise<ApiResult<MediaSession>> { return this.ready(client => client.getMedia(sessionID)); }
  upgradeMedia(): Promise<ApiResult<{ schema_version: 2 | 3 | 4 | 5 }>> { return this.ready(client => client.upgradeMedia()); }
  saveMedia(sessionID: string, input: SaveMedia): Promise<ApiResult<MediaSession>> { return this.ready(client => client.saveMedia(sessionID, input)); }
  importSelectedMedia(sessionID: string, paths: string[]): Promise<ApiResult<ImportJob>> { return this.ready(client => client.importSelectedMedia(sessionID, paths)); }
  importStatus(jobID: string): Promise<ApiResult<ImportJob>> { return this.ready(client => client.importStatus(jobID)); }
  cancelImport(jobID: string): Promise<ApiResult<ImportJob>> { return this.ready(client => client.cancelImport(jobID)); }
  startPreview(input: PreviewRequest): Promise<ApiResult<PreviewJob>> { return this.ready(client => client.startPreview(input)); }
  previewStatus(jobID: string): Promise<ApiResult<PreviewJob>> { return this.ready(client => client.previewStatus(jobID)); }
  cancelPreview(jobID: string): Promise<ApiResult<PreviewJob>> { return this.ready(client => client.cancelPreview(jobID)); }
  previewContent(jobID: string): Promise<ApiResult<{ bytes: Uint8Array }>> { return this.ready(client => client.previewContent(jobID)); }

  startExport(runID: string): Promise<ApiResult<ExportJob>> { return this.ready(client => client.startExport(runID)); }
  exportStatus(jobID: string): Promise<ApiResult<ExportJob>> { return this.ready(client => client.exportStatus(jobID)); }
  cancelExport(jobID: string): Promise<ApiResult<ExportJob>> { return this.ready(client => client.cancelExport(jobID)); }
  async downloadExportFile(jobID: string, kind: ExportKind, file: ExportFile, destination: string, signal: AbortSignal): Promise<void> {
    const health = await this.health();
    if (!health.ok || !this.client) throw new Error('Backend unavailable');
    await this.client.downloadExportFile(jobID, kind, file, destination, signal);
  }
  upgradeQA(): Promise<ApiResult<{ schema_version: 5 }>> { return this.ready(client => client.upgradeQA()); }
  getWindowQA(windowID: string): Promise<ApiResult<WindowQA>> { return this.ready(client => client.getWindowQA(windowID)); }
  saveQA(windowID: string, input: QAChange): Promise<ApiResult<WindowQA>> { return this.ready(client => client.saveQA(windowID, input)); }
  qaHistory(windowID: string, afterRevision: number): Promise<ApiResult<QAHistory>> { return this.ready(client => client.qaHistory(windowID, afterRevision)); }
  upgradeReviews(): Promise<ApiResult<{ schema_version: 4 | 5 }>> { return this.ready(client => client.upgradeReviews()); }
  getWindowReview(windowID: string): Promise<ApiResult<WindowReview>> { return this.ready(client => client.getWindowReview(windowID)); }
  saveReview(windowID: string, input: ReviewChange): Promise<ApiResult<WindowReview>> { return this.ready(client => client.saveReview(windowID, input)); }
  reviewHistory(windowID: string, afterRevision: number): Promise<ApiResult<ReviewHistory>> { return this.ready(client => client.reviewHistory(windowID, afterRevision)); }
  upgradeSummaries(): Promise<ApiResult<{ schema_version: 3 | 4 | 5 }>> { return this.ready(client => client.upgradeSummaries()); }
  listSummaryRuns(sessionID: string): Promise<ApiResult<SummaryRun[]>> { return this.ready(client => client.listSummaryRuns(sessionID)); }
  startSummaries(input: SummaryRequest): Promise<ApiResult<SummaryDetail>> { return this.ready(client => client.startSummaries(input)); }
  summaryRun(runID: string): Promise<ApiResult<SummaryDetail>> { return this.ready(client => client.summaryRun(runID)); }
  cancelSummaries(runID: string): Promise<ApiResult<SummaryDetail>> { return this.ready(client => client.cancelSummaries(runID)); }
  summaryImage(windowID: string): Promise<ApiResult<{ bytes: Uint8Array }>> { return this.ready(client => client.summaryImage(windowID)); }

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
