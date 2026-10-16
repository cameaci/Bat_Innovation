export interface Health {
  status: 'ok';
  storage: 'ready';
  media_tools: 'ready';
}

export interface RecordingSession {
  id: string;
  display_name: string;
  camera_ref: string;
  created_at_utc: string;
}

export interface NewSession {
  display_name: string;
  camera_ref: string;
}

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

export interface Rational { num: string; den: string }
export type Continuity = 'unknown' | 'known_contiguous' | 'known_gap';

export interface MediaMetadata {
  filename: string;
  size_bytes: number;
  sha256: string;
  container: string;
  streams: { index: number; type: string; codec: string; time_base: Rational | null }[];
  video_stream_index: number;
  codec: string;
  width: number;
  height: number;
  time_base: Rational;
  first_pts: string;
  last_pts: string;
  first_time: Rational;
  last_time: Rational;
  elapsed_last_time: Rational;
  end_time: Rational | null;
  elapsed_end: Rational | null;
  frame_count: number;
  reported_duration: Rational | null;
  average_rate: Rational | null;
  base_rate: Rational | null;
  rotation: number | null;
  field_order: string | null;
  interlaced: boolean;
  warnings: string[];
}

export interface MediaSegment {
  id: string;
  position: number;
  continuity: Continuity;
  continuity_provenance: string | null;
  source_state: 'ready' | 'missing_source' | 'unreadable_source' | 'changed_source';
  metadata: MediaMetadata;
}

export interface ClockAnchorInput { segment_id: string; utc: string; provenance: string }
export interface ClockAnchor extends ClockAnchorInput { source_pts: string; time_base: Rational; source_time: Rational }
export interface MediaSession {
  session_id: string;
  schema_version: number;
  segments: MediaSegment[];
  clock_anchor: ClockAnchor | null;
  active_import?: ImportJob | null;
}
export interface SaveMedia {
  segment_ids: string[];
  continuity: { segment_id: string; status: Continuity; provenance: string | null }[];
  clock_anchor: ClockAnchorInput | null;
}
export interface ImportJob {
  id: string;
  session_id: string;
  state: 'running' | 'complete' | 'failed' | 'cancelled';
  phase: string;
  filename: string | null;
  files_done: number;
  files_total: number;
  progress_value: number;
  error: { code: string; message: string } | null;
}

export interface PreviewRequest { segment_id: string; source_pts: string }
export interface PreviewFrame {
  source_pts: string;
  source_time: Rational;
  elapsed: Rational;
  preview_ms: number;
}
export interface PreviewManifest {
  segment_id: string;
  source_sha256: string;
  requested_pts: string;
  actual_pts: string;
  time_base: Rational;
  seek_error: Rational;
  source_start: Rational;
  source_last: Rational;
  source_end: Rational;
  elapsed_start: Rational;
  elapsed_end: Rational;
  preview_duration_ms: number;
  width: number;
  height: number;
  frames: PreviewFrame[];
  warnings: string[];
}
export interface PreviewJob {
  id: string;
  segment_id: string;
  state: 'running' | 'ready' | 'failed' | 'cancelled';
  phase: string;
  error: { code: string; message: string } | null;
  manifest: PreviewManifest | null;
}

export interface BatAPI {
  health(): Promise<ApiResult<Health>>;
  listSessions(): Promise<ApiResult<RecordingSession[]>>;
  createSession(input: NewSession): Promise<ApiResult<RecordingSession>>;
  getMedia(sessionID: string): Promise<ApiResult<MediaSession>>;
  upgradeMedia(): Promise<ApiResult<{ schema_version: 2 }>>;
  chooseMedia(sessionID: string): Promise<ApiResult<ImportJob | null>>;
  importStatus(jobID: string): Promise<ApiResult<ImportJob>>;
  cancelImport(jobID: string): Promise<ApiResult<ImportJob>>;
  saveMedia(sessionID: string, input: SaveMedia): Promise<ApiResult<MediaSession>>;
  startPreview(input: PreviewRequest): Promise<ApiResult<PreviewJob>>;
  previewStatus(jobID: string): Promise<ApiResult<PreviewJob>>;
  cancelPreview(jobID: string): Promise<ApiResult<PreviewJob>>;
  previewContent(jobID: string): Promise<ApiResult<{ bytes: Uint8Array }>>;
}
