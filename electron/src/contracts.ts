export interface Health {
  status: 'ok';
  storage: 'ready';
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
  /** Declared at import; rendered thermal is display luminance, never temperature. Absent before storage v6. */
  modality?: Modality;
  modality_provenance?: string | null;
}

export type Modality = 'active_ir' | 'rendered_thermal';

/** A derived tracking run over one summary run (feature expansion E2). Tracks are review aids, not animals. */
export interface TrackingRun {
  id: string;
  summary_run_id: string;
  session_id: string;
  state: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
  algorithm_version: string;
  parameter_hash: string;
  parameters: Record<string, unknown>;
  stats: Record<string, { frames: number; candidates: number; framewide_frames: number; candidate_limit_frames: number; tracks: number }>;
  error: string | null;
  started_at_utc: string;
  finished_at_utc: string | null;
  track_counts: Record<string, number>;
  /** Present on a single-run read: tracks overlapping each summary window ID. */
  window_counts?: Record<string, number>;
}
export type GateDirection = 'A_to_B' | 'B_to_A' | 'out_to_in' | 'in_to_out';
export interface GateValue {
  name: string; kind: 'line' | 'rect' | 'polygon'; points: [number, number][]; frame_w: number; frame_h: number;
  label_a: string; label_b: string; entry_direction: 'A_to_B' | 'B_to_A' | 'out_to_in'; hysteresis_px: number;
}
export interface Gate extends GateValue { id: string; session_id: string; revision: number; state: 'active' | 'retired' }
export interface GateChange { actor: string; expected_revision: number; value: GateValue | null }
export interface CountTotals { entered: number; exited: number; net: number }
export interface CountReview { action: 'confirm' | 'reject' | 'clear' | 'add_missed'; key: string | null; flipped: boolean; count: number; rationale: string; actor: string; revision: number; utc: string; direction?: GateDirection | null; segment_id?: string | null; pts?: string | null }
export interface Crossing { key: string; track_id: string; segment_id: string; pts: string; direction: GateDirection; window_id: string | null; scene_changed: boolean; review: CountReview | null }
export interface GateCounts {
  gate: Gate; tracking_run_id: string; algorithm_version: string; revision: number; review_revision: number; reviewers: string[];
  crossings: Crossing[]; missed: CountReview[]; skipped_segments: string[];
  layers: {
    algorithm: CountTotals & { excluded_scene_changed: number };
    reviewer: CountTotals & { reviewed: number; crossings: number; added: number };
    qa: { decision: 'approve' | 'reject'; actor: string; note: string; utc: string; review_revision: number; stale: boolean; counts: CountTotals | null } | null;
  };
}
export interface CountReviewInput {
  actor: string; expected_revision: number; action: CountReview['action']; key: string | null; flipped: boolean; count: number;
  direction: GateDirection | null; segment_id: string | null; pts: string | null; rationale: string;
}
export interface CountQAInput { actor: string; expected_revision: number; review_revision: number; decision: 'approve' | 'reject'; note: string }

/** points: [source_pts, x, y, area] in original source pixels. */
export interface TrackRecord {
  id: string; segment_id: string; track_index: number; first_pts: string; last_pts: string; point_count: number;
  bbox: [number, number, number, number]; points: [string, number, number, number][];
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

export interface SummaryRequest { session_id: string; window_seconds: number }
export type SummaryState = 'queued' | 'running' | 'complete' | 'incomplete' | 'failed' | 'cancelled' | 'interrupted';
export interface SummaryRun {
  id: string;
  session_id: string;
  state: SummaryState;
  algorithm_version: string;
  parameters: Record<string, unknown>;
  parameter_hash: string;
  started_at_utc: string;
  finished_at_utc: string | null;
  error: { code: string; message: string } | null;
  counts: { planned: number; pending: number; complete: number; running: number; incomplete: number; failed: number };
}
export interface SummaryWindow {
  qa?: QAHeader;
  review?: ReviewHeader;
  id: string;
  run_id: string;
  segment_id: string;
  index: number;
  status: 'planned' | 'running' | 'complete' | 'incomplete' | 'failed';
  source_sha256: string;
  source_state?: MediaSegment['source_state'];
  time_base: Rational;
  interval: { start_pts: Rational; end_pts: Rational | null; start_time: Rational; end_time: Rational | null; elapsed_start: Rational; elapsed_end: Rational | null };
  stats: { frame_count?: number; first_pts?: string | null; last_pts?: string | null; pts_digest?: string; motion_pixels?: number | null; comparison_count?: number; gap_count?: number; gap_examples_recorded?: number; max_spacing?: Rational | null; gaps?: { start: Rational; end: Rational }[]; phase_pixels?: number[] | null; preview_pts?: string | null; motion_state?: 'quiet' | 'evidence' | 'unassessable' };
  flags: string[];
  error: { code: string; message: string } | null;
  preview_pts: string | null;
  image: { sha256: string; bytes: number } | null;
}
export interface SummaryDetail extends SummaryRun { windows: SummaryWindow[]; review_progress?: ReviewProgress; qa_progress?: QAProgress }

export type ReviewDecision = 'unreviewed' | 'reviewed_with_observations' | 'reviewed_no_discernible_event';
export interface ProvisionalObservationInput {
  segment_id: string;
  start_pts: string;
  end_pts: string;
  category: 'bat' | 'insect' | 'bird' | 'other' | 'uncertain';
  activity: string | null;
  count: number | null;
  uncertain: boolean;
  notes: string;
}
export interface ProvisionalObservation extends ProvisionalObservationInput { id: string }
export interface ReviewProjection {
  revision: number;
  decision: ReviewDecision;
  observations: ProvisionalObservation[];
  unable_note: string;
  verification: Record<string, unknown> | null;
  actor: string | null;
  updated_at_utc: string | null;
}
export interface ReviewBinding {
  run_id: string;
  window_id: string;
  segment_id: string;
  source_sha256: string;
  parameter_hash: string;
  time_base: Rational;
  interval: SummaryWindow['interval'];
  source_first_pts: string;
  source_last_pts: string;
  source_end_pts: Rational | null;
}
export interface WindowReview extends ReviewProjection {
  run_id: string;
  window_id: string;
  source_state: MediaSegment['source_state'];
  can_verify: boolean;
  needs_reverification: boolean;
  verification_warning: string | null;
  effective_decision: ReviewDecision;
  binding: ReviewBinding;
}
export interface ReviewHeader {
  revision: number;
  decision: ReviewDecision;
  effective_decision: ReviewDecision;
  needs_reverification: boolean;
  verification_warning: string | null;
  observation_count: number;
}
export interface ReviewProgress {
  total: number;
  reviewed: number;
  unreviewed: number;
  quality_flagged: number;
  failed: number;
  incomplete: number;
  needs_reverification: number;
}
export type ReviewChange = { actor: string; expected_revision: number } & (
  | { action: 'add_observation'; observation: ProvisionalObservationInput }
  | { action: 'update_observation'; observation_id: string; observation: ProvisionalObservationInput }
  | { action: 'delete_observation'; observation_id: string }
  | { action: 'set_decision'; decision: ReviewDecision; preview_id: string | null }
  | { action: 'unable_to_assess'; note: string }
);
export interface ReviewEvent {
  revision: number;
  utc: string;
  actor: string;
  action: ReviewChange['action'];
  run_id: string;
  window_id: string;
  segment_id: string;
  source_sha256: string;
  parameter_hash: string;
  time_base: Rational;
  interval: SummaryWindow['interval'];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  observation_id: string | null;
  span: { start_pts: string; end_pts: string } | null;
}
export interface ReviewHistory { events: ReviewEvent[]; next_after_revision: number | null }

export type QAStatus = 'pending' | 'agree' | 'disagree' | 'needs_clarification' | 'unassessable';
export interface QAHeader {
  has_disagreement: boolean;
  revision: number;
  decision: QAStatus;
  status: QAStatus;
  needs_reverification: boolean;
  warning: string | null;
  can_decide: boolean;
  current_evidence_revision: number;
}
export interface QASuggestion {
  observation_id: string;
  observation_revision: number;
  note: string;
  category: ProvisionalObservationInput['category'] | null;
  count: number | null;
}
export interface QAChange {
  actor: string;
  expected_revision: number;
  expected_first_review_revision: number;
  expected_evidence_revision: number;
  action: 'set_decision' | 'retract';
  decision: Exclude<QAStatus, 'pending'> | null;
  note: string;
  suggestion: QASuggestion | null;
  preview_id: string | null;
  confirmed: boolean;
}
export interface WindowQA extends QAHeader {
  window_id: string;
  run_id: string;
  actor: string | null;
  note: string;
  suggestion: (QASuggestion & { original_observation: ProvisionalObservation }) | null;
  updated_at_utc: string | null;
  first_review_revision: number;
  evidence_revision: number;
  binding: ReviewBinding & { evidence_revision: number };
  first_review: { revision: number; actor: string | null; effective_decision: ReviewDecision; observations: (ProvisionalObservation & { revision: number })[] };
}
export interface QAProgress {
  total: number;
  agree: number;
  disagree: number;
  needs_clarification: number;
  pending: number;
  unassessable: number;
  needs_reverification: number;
}
export interface QAHistory {
  events: { revision: number; utc: string; actor: string; action: string; first_review_revision: number; evidence_revision: number; before: Record<string, unknown>; after: Record<string, unknown> }[];
  next_after_revision: number | null;
}

export type ExportKind = 'observations' | 'audit' | 'manifest';
export interface ExportFile { name: string; bytes: number; sha256: string; rows?: number }
export interface ExportManifest {
  schema_version: 'bat-provisional-csv-v1';
  provisional_label: string;
  as_of_utc: string;
  run_id: string;
  manifest_complete: boolean;
  processing_complete: boolean;
  counts: { planned: number; actual: number; missing: number; reviewed: number; first_stale: number; qa_stale: number; timestamp_gaps: number; evidence_flagged: number; processing: Record<string, number>; qa: Record<string, number> };
  files: Record<ExportKind, ExportFile>;
}
/** On-disk manifest describes the two payload CSVs. The manifest.json
 * descriptor (including its SHA256) exists only in the authenticated
 * transport manifest: a file cannot embed its own content hash. */
export type ExportDiskManifest = Omit<ExportManifest, 'files'> & {
  files: Pick<ExportManifest['files'], 'observations' | 'audit'>;
};
export interface ExportJob {
  id: string;
  run_id: string;
  state: 'working' | 'ready' | 'failed' | 'cancelled';
  error: { code: string; message: string } | null;
  manifest: ExportManifest | null;
}
export interface ExportSaved { cancelled: boolean; folder_name: string; files: string[] }
export interface BatAPI {
  startExport(runID: string): Promise<ApiResult<ExportJob>>;
  exportStatus(jobID: string): Promise<ApiResult<ExportJob>>;
  cancelExport(jobID: string): Promise<ApiResult<ExportJob>>;
  saveExportBundle(jobID: string): Promise<ApiResult<ExportSaved>>;
  upgradeQA(): Promise<ApiResult<{ schema_version: 5 }>>;
  getWindowQA(windowID: string): Promise<ApiResult<WindowQA>>;
  saveQA(windowID: string, input: QAChange): Promise<ApiResult<WindowQA>>;
  qaHistory(windowID: string, afterRevision: number): Promise<ApiResult<QAHistory>>;
  upgradeReviews(): Promise<ApiResult<{ schema_version: 4 | 5 }>>;
  getWindowReview(windowID: string): Promise<ApiResult<WindowReview>>;
  saveReview(windowID: string, input: ReviewChange): Promise<ApiResult<WindowReview>>;
  reviewHistory(windowID: string, afterRevision: number): Promise<ApiResult<ReviewHistory>>;
  setDraftDirty(dirty: boolean): Promise<ApiResult<{ dirty: boolean }>>;
  upgradeSummaries(): Promise<ApiResult<{ schema_version: 3 | 4 | 5 }>>;
  listSummaryRuns(sessionID: string): Promise<ApiResult<SummaryRun[]>>;
  startSummaries(input: SummaryRequest): Promise<ApiResult<SummaryDetail>>;
  summaryRun(runID: string): Promise<ApiResult<SummaryDetail>>;
  cancelSummaries(runID: string): Promise<ApiResult<SummaryDetail>>;
  summaryImage(windowID: string): Promise<ApiResult<{ bytes: Uint8Array }>>;
  health(): Promise<ApiResult<Health>>;
  listSessions(): Promise<ApiResult<RecordingSession[]>>;
  createSession(input: NewSession): Promise<ApiResult<RecordingSession>>;
  getMedia(sessionID: string): Promise<ApiResult<MediaSession>>;
  upgradeMedia(): Promise<ApiResult<{ schema_version: 2 | 3 | 4 | 5 }>>;
  chooseMedia(sessionID: string, modality: Modality): Promise<ApiResult<ImportJob | null>>;
  upgradeStorage(): Promise<ApiResult<{ schema_version: number }>>;
  startTracking(summaryRunID: string): Promise<ApiResult<TrackingRun>>;
  trackingRun(runID: string): Promise<ApiResult<TrackingRun>>;
  listTracking(summaryRunID: string): Promise<ApiResult<TrackingRun[]>>;
  cancelTracking(runID: string): Promise<ApiResult<TrackingRun>>;
  getTracks(runID: string, segmentID: string, startPTS: string, endPTS: string | null): Promise<ApiResult<TrackRecord[]>>;
  listGates(sessionID: string): Promise<ApiResult<Gate[]>>;
  saveGate(sessionID: string, gateID: string | null, change: GateChange): Promise<ApiResult<Gate>>;
  getCounts(runID: string, gateID: string): Promise<ApiResult<GateCounts>>;
  saveCountReview(runID: string, gateID: string, input: CountReviewInput): Promise<ApiResult<GateCounts>>;
  saveCountQA(runID: string, gateID: string, input: CountQAInput): Promise<ApiResult<GateCounts>>;
  importStatus(jobID: string): Promise<ApiResult<ImportJob>>;
  cancelImport(jobID: string): Promise<ApiResult<ImportJob>>;
  saveMedia(sessionID: string, input: SaveMedia): Promise<ApiResult<MediaSession>>;
  startPreview(input: PreviewRequest): Promise<ApiResult<PreviewJob>>;
  previewStatus(jobID: string): Promise<ApiResult<PreviewJob>>;
  cancelPreview(jobID: string): Promise<ApiResult<PreviewJob>>;
  previewContent(jobID: string): Promise<ApiResult<{ bytes: Uint8Array }>>;
}
