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
export interface PlaybackCopy {
  id: string;
  segment_id: string;
  state: 'queued' | 'running' | 'ready' | 'failed' | 'cancelled' | 'interrupted';
  width: number | null;
  height: number | null;
  frame_count: number | null;
  duration_ms: number | null;
  bytes: number | null;
  started_at_utc: string;
  finished_at_utc: string | null;
  error: string | null;
}

export interface PlaybackStatus { session_id: string; active: boolean; proxies: PlaybackCopy[] }

/** Every playback-copy frame mapped to its exact source PTS (Phase 2 W1). */
export interface PlaybackFrames {
  id: string;
  segment_id: string;
  width: number;
  height: number;
  duration_ms: number;
  source_pts: string[];
  proxy_ms: number[];
}

/** tracks-v2 settings (Phase 2). Defaults are starting values, not validated thresholds. Polygons are in source pixels. */
export interface TrackingSettings {
  target_px: number;
  polarity: 'both' | 'light' | 'dark';
  sensitivity: number;
  activity: 'sparse' | 'normal' | 'dense';
  detection_area: [number, number][][];
  exclusions: [number, number][][];
  max_gap_s: number;
  min_track_s: number;
  join_gap_s: number;
  min_displacement_targets: number;
}
export interface SceneEvent { id?: string; segment_id?: string; kind: 'camera_moved' | 'lighting_change' | 'glitch'; start_pts: string; end_pts: string; details: Record<string, unknown> }
export interface TrackingTestInput { segment_id: string; start_pts: string; end_pts: string; settings: TrackingSettings }
export interface TrackingTestResult {
  segment_id: string; start_pts: string; end_pts: string;
  stats: Record<string, unknown> & { detections: number; rejected_size: number; tracks: number; coherent: number; uncertain: number; noise: number; joins: number };
  detections: { pts: string; accepted: [number, number, number, number][]; rejected: [number, number, number, number, string][] }[];
  tracks: TrackRecord[];
  events: SceneEvent[];
}
export interface TrackingTest { id: string; state: 'running' | 'complete' | 'failed'; error: string | null; result: TrackingTestResult | null }

/** Track points per grid cell in 10 s bins (sparse [cell, count]); points, not individuals. */
export interface FlightMap {
  segment_id: string; width: number; height: number; columns: number; rows: number; bin_seconds: number; first_pts: string;
  bins: { index: number; cells: [number, number][] }[];
}

export interface TrackingRun {
  id: string;
  summary_run_id: string;
  session_id: string;
  state: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
  algorithm_version: string;
  parameter_hash: string;
  parameters: Record<string, unknown>;
  /** Per segment: tracks-v1 runs report framewide_frames, tracks-v2 runs disturbed_frames, quality counts and scene events. */
  stats: Record<string, Record<string, unknown> & { frames: number; tracks: number; framewide_frames?: number; disturbed_frames?: number }>;
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
export interface CountReview { action: 'confirm' | 'reject' | 'clear' | 'add_missed' | 'accept'; key: string | null; flipped: boolean; count: number; rationale: string; actor: string; revision: number; utc: string; direction?: GateDirection | null; segment_id?: string | null; pts?: string | null }
/** A derived crossing inside a valid gate span; only coherent tracks feed the algorithm proposal. */
export interface Crossing { key: string; track_id: string; track_index: number; segment_id: string; pts: string; direction: GateDirection; window_id: string | null; quality: 'coherent' | 'uncertain'; review: CountReview | null }
/** A camera move or a new video not marked contiguous: counting is paused until one reconfirmation. */
export interface InvalidSpan { segment_id: string; anchor_kind: 'camera_moved' | 'segment_start'; anchor_id: string; reason: 'camera_moved' | 'new_video'; from_pts: string | null; resume_pts: string | null }
export interface ValidSpan { from_pts: number | null; to_pts: number | null; points: [number, number][] }
/** A reviewer's manual count of one span at normal speed or slower, compared with the gate's proposal; never changes a count. */
export interface SampleCheckInput extends PlaybackProof { actor: string; segment_id: string; start_pts: string; end_pts: string; presses: { pts: string; kind: 'entry' | 'exit' }[] }
export interface SampleCheck {
  id: string; tracking_run_id: string; gate_id: string; gate_revision: number; segment_id: string; start_pts: string; end_pts: string; actor: string; utc: string;
  presses: [string, 'entry' | 'exit'][];
  receipt: { kind: 'playback_copy'; proxy_id: string; max_rate: number; intervals: [string, string][] };
  result: { manual: { entry: number; exit: number }; algorithm: { entry: number; exit: number }; uncertain_in_span: number; tolerance_seconds: string;
    matched: { pts: string; kind: 'entry' | 'exit'; key: string; crossing_pts: string }[];
    missed_by_algorithm: { pts: string; kind: 'entry' | 'exit' }[];
    extra_in_algorithm: { key: string; pts: string; kind: 'entry' | 'exit'; track_index: number }[] };
}
export interface ReconfirmInput { actor: string; anchor_kind: InvalidSpan['anchor_kind']; anchor_id: string; points: [number, number][] | null; note: string }
export interface GateCounts {
  gate: Gate; tracking_run_id: string; algorithm_version: string; revision: number; review_revision: number; reviewers: string[];
  crossings: Crossing[]; missed: CountReview[]; skipped_segments: string[];
  invalid_spans: InvalidSpan[];
  valid_spans: Record<string, ValidSpan[]>;
  layers: {
    algorithm: CountTotals & { coherent: number; uncertain: number; noise_crossings: number; invalid_spans: number };
    reviewer: CountTotals & { state: 'ready' | 'unresolved' | 'accepted'; unresolved: number; rejected: number; reviewed: number; crossings: number; added: number;
      accepted: { actor: string; utc: string; current: boolean } | null };
    qa: { decision: 'approve' | 'reject'; actor: string; note: string; utc: string; review_revision: number; stale: boolean; counts: CountTotals | null } | null;
  };
}
export interface CountReviewInput {
  actor: string; expected_revision: number; action: CountReview['action']; key: string | null; flipped: boolean; count: number;
  direction: GateDirection | null; segment_id: string | null; pts: string | null; rationale: string;
}
export interface CountQAInput { actor: string; expected_revision: number; review_revision: number; decision: 'approve' | 'reject'; note: string }

export interface Candidate {
  track_id: string; segment_id: string; track_index: number; first_pts: string; last_pts: string; point_count: number; window_id: string | null; quality: TrackQuality;
  revision: number; decision: { decision: 'bat' | 'not_bat' | 'uncertain'; actor: string; note: string; utc: string } | null;
}
export type AudioSourceMode = 'full_spectrum' | 'heterodyne' | 'frequency_division' | 'time_expansion' | 'unknown';
export interface AudioSource {
  id: string; session_id: string; sha256: string; source_mode: AudioSourceMode; channel: number; retunable: boolean;
  metadata: { sample_rate: number; channels: number; frames: number; codec: string; filename: string };
  anchor: { revision: number; actor: string; segment_id: string; video_pts: string; audio_sample: number; note: string; utc: string } | null;
}
export interface AudioAnchorInput { actor: string; expected_revision: number; segment_id: string; video_pts: string; audio_sample: number; note: string }
export interface AudioDeriveInput { segment_id: string; start_pts: string; seconds: number; kind: 'spectrogram' | 'heterodyne'; tune_hz: number | null }
export interface AudioDerived {
  id: string; kind: 'spectrogram' | 'heterodyne'; audio_id: string; segment_id: string; mime: string; bytes: number; sha256: string;
  sample_rate: number; start_sample: number; end_sample: number; requested_start_sample: number; requested_end_sample: number;
  start_offset_seconds: number; covered_seconds: number; anchor_revision: number; drift_corrected: false;
  frequency_max_hz?: number; tune_hz?: number;
}
/** Continuous viewing in the playback copy: frame PTS intervals and the fastest speed used (at most 4x counts). */
export interface PlaybackProof { proxy_id: string; intervals: [string, string][]; max_rate: number }
/** A decision proven by an original preview or by watching the track in the playback copy (exactly one). */
export interface CandidateDecisionInput { actor: string; expected_revision: number; decision: 'bat' | 'not_bat' | 'uncertain'; note: string; preview_id: string | null; playback: PlaybackProof | null }
export interface WatchedInput { actor: string; items: (PlaybackProof & { window_id: string })[] }

/** points: [source_pts, x, y, area] in original source pixels. */
export type TrackQuality = 'coherent' | 'uncertain' | 'noise' | 'unrated';
export interface TrackRecord {
  id: string; segment_id: string; track_index: number; first_pts: string; last_pts: string; point_count: number;
  bbox: [number, number, number, number]; points: [string, number, number, number][];
  /** tracks-v2 quality class; 'unrated' for tracks of earlier runs. Rules are parameters, not approved thresholds. */
  quality: TrackQuality;
  metrics: Record<string, number>;
}
/** Tracks for display: noise left out unless asked for; when the points budget is reached, shown < total. */
export interface TrackPage { tracks: TrackRecord[]; shown: number; total: number; noise_hidden: number }

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

export interface PreviewRequest { segment_id: string; source_pts: string; clip_seconds?: 2 | 6 | 12 }
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
  clip_seconds?: 2 | 6 | 12;
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

export type ExportKind = 'observations' | 'audit' | 'tracks' | 'counts' | 'manifest';
export interface ExportFile { name: string; bytes: number; sha256: string; rows?: number }
export interface ExportManifest {
  schema_version: 'bat-provisional-csv-v3';
  /** Latest complete tracking run included in tracks and counts CSVs, or null. */
  tracking?: { tracking_run_id: string; algorithm_version: string; parameter_sha256: string; tracks: number; gates: number; note: string } | null;
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
  files: Pick<ExportManifest['files'], 'observations' | 'audit' | 'tracks' | 'counts'>;
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
  startTracking(summaryRunID: string, settings: TrackingSettings): Promise<ApiResult<TrackingRun>>;
  startTrackingTest(input: TrackingTestInput): Promise<ApiResult<TrackingTest>>;
  trackingTest(testID: string): Promise<ApiResult<TrackingTest>>;
  trackingEvents(runID: string): Promise<ApiResult<SceneEvent[]>>;
  startPlayback(sessionID: string): Promise<ApiResult<PlaybackStatus>>;
  playbackStatus(sessionID: string): Promise<ApiResult<PlaybackStatus>>;
  cancelPlayback(sessionID: string): Promise<ApiResult<PlaybackStatus>>;
  playbackFrames(proxyID: string): Promise<ApiResult<PlaybackFrames>>;
  trackingRun(runID: string): Promise<ApiResult<TrackingRun>>;
  listTracking(summaryRunID: string): Promise<ApiResult<TrackingRun[]>>;
  cancelTracking(runID: string): Promise<ApiResult<TrackingRun>>;
  getTracks(runID: string, segmentID: string, startPTS: string, endPTS: string | null, includeNoise: boolean): Promise<ApiResult<TrackPage>>;
  listGates(sessionID: string): Promise<ApiResult<Gate[]>>;
  saveGate(sessionID: string, gateID: string | null, change: GateChange): Promise<ApiResult<Gate>>;
  getCounts(runID: string, gateID: string): Promise<ApiResult<GateCounts>>;
  saveCountReview(runID: string, gateID: string, input: CountReviewInput): Promise<ApiResult<GateCounts>>;
  listSampleChecks(runID: string, gateID: string): Promise<ApiResult<SampleCheck[]>>;
  saveSampleCheck(runID: string, gateID: string, input: SampleCheckInput): Promise<ApiResult<SampleCheck>>;
  saveCountQA(runID: string, gateID: string, input: CountQAInput): Promise<ApiResult<GateCounts>>;
  reconfirmGate(runID: string, gateID: string, input: ReconfirmInput): Promise<ApiResult<GateCounts>>;
  listCandidates(runID: string): Promise<ApiResult<Candidate[]>>;
  getFlightMap(runID: string, segmentID: string): Promise<ApiResult<FlightMap>>;
  listAudio(sessionID: string): Promise<ApiResult<AudioSource[]>>;
  chooseAudio(sessionID: string, sourceMode: AudioSourceMode, channel: number): Promise<ApiResult<AudioSource[] | null>>;
  setAudioAnchor(audioID: string, input: AudioAnchorInput): Promise<ApiResult<AudioSource>>;
  deriveAudio(audioID: string, input: AudioDeriveInput): Promise<ApiResult<AudioDerived>>;
  audioContent(derivedID: string, kind: 'spectrogram' | 'heterodyne'): Promise<ApiResult<{ bytes: Uint8Array }>>;
  decideCandidate(runID: string, trackID: string, input: CandidateDecisionInput): Promise<ApiResult<Candidate>>;
  markWatched(input: WatchedInput): Promise<ApiResult<unknown[]>>;
  importStatus(jobID: string): Promise<ApiResult<ImportJob>>;
  cancelImport(jobID: string): Promise<ApiResult<ImportJob>>;
  saveMedia(sessionID: string, input: SaveMedia): Promise<ApiResult<MediaSession>>;
  startPreview(input: PreviewRequest): Promise<ApiResult<PreviewJob>>;
  previewStatus(jobID: string): Promise<ApiResult<PreviewJob>>;
  cancelPreview(jobID: string): Promise<ApiResult<PreviewJob>>;
  previewContent(jobID: string): Promise<ApiResult<{ bytes: Uint8Array }>>;
}
