import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { MediaSegment, Rational, SummaryDetail, SummaryRun, SummaryWindow } from '../../electron/src/contracts';
import { getAPI } from './api';
import { readMediaBytes } from './binary';
import { ReviewPanel } from './ReviewPanel';
import { QAPanel } from './QAPanel';
import { ExportPanel } from './ExportPanel';
import { SummaryGallery } from './SummaryGallery';
import type { WindowSourceFrame } from './sourceFrame';

const unavailable = 'The local backend is unavailable. Summary status could not be verified; retry after checking the backend.';
const activeRun = (run: SummaryRun | null) => run?.state === 'queued' || run?.state === 'running';
const rational = (value: Rational | null | undefined) => value ? `${value.num}/${value.den}` : 'Unknown';
const interval = (start: Rational, end: Rational | null) => `[${rational(start)}, ${rational(end)})`;

const flagMeaning: Record<string, string> = {
  unknown_end_unassessable: 'The final source-time endpoint is unknown, so time-coloured motion evidence cannot be assessed.',
  framewide_change: 'Change covers a large part of the frame. Check camera movement, lighting and artefacts in the original.',
  brightness_transition: 'A large brightness change may reflect IR switching or illumination. Evidence was retained.',
  declared_timestamp_gap: 'Decoded frame durations leave a timestamp gap. The interval does not establish continuous imagery.',
  gap_examples_truncated: 'Only bounded gap examples are stored; the total gap count remains visible.',
  source_speed_unverified: 'Original recording speed has not been verified.',
  derived_grayscale_evidence: 'Grayscale codec conversion can affect weak changes and retain compression noise.',
  rotation_not_applied: 'Source rotation was not applied.',
  rotation_unverified: 'Source rotation is unknown.',
  interlaced_not_deinterlaced: 'Interlaced content was not deinterlaced.',
  field_order_unverified: 'Interlace field order is unknown.',
  insufficient_comparison_frames: 'There are too few frames to assess motion in this window.',
};

export function SummaryWindows({ sessionID, segments, disabled, reviewDisabled, reviewEnabled, qaEnabled, previewReceipt, displayedSourceFrame, onBusyChange, onDraftChange, onPreview }: {
  sessionID: string;
  segments: MediaSegment[];
  disabled: boolean;
  reviewDisabled: boolean;
  reviewEnabled: boolean;
  qaEnabled: boolean;
  previewReceipt: { windowID: string; previewID: string } | null;
  displayedSourceFrame?: WindowSourceFrame | null;
  onBusyChange: (busy: boolean) => void;
  onDraftChange: (dirty: boolean) => void;
  onPreview: (segment: MediaSegment, sourcePTS: string, windowID: string) => void;
}) {
  const [runs, setRuns] = useState<SummaryRun[]>([]);
  const [runID, setRunID] = useState('');
  const [detail, setDetail] = useState<SummaryDetail | null>(null);
  const [selectedID, setSelectedID] = useState('');
  const [action, setAction] = useState<'loading' | 'starting' | 'cancelling' | null>('loading');
  const [exportBusy, setExportBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState('');
  const [imageURL, setImageURL] = useState<string | null>(null);
  const [imageError, setImageError] = useState('');
  const [firstDirty, setFirstDirty] = useState(false);
  const [qaDirty, setQADirty] = useState(false);
  const reviewDirty = firstDirty || qaDirty;
  const [reviewRefresh, setReviewRefresh] = useState(0);
  const draftActive = useRef(false);
  draftActive.current = reviewDirty;
  const selectedSnapshot = useRef<SummaryWindow | null>(null);
  const inspectionHeading = useRef<HTMLHeadingElement>(null);
  const imageFailureAt = useRef(0);
  const processing = activeRun(detail);
  const checking = runID !== '' && detail === null;
  const baseBusy = action !== null || processing || cancelling || checking;
  const busy = baseBusy || exportBusy;
  const currentSelected = detail?.windows.find(window => window.id === selectedID);
  if (currentSelected) selectedSnapshot.current = currentSelected;
  const selected = currentSelected ?? (reviewDirty ? selectedSnapshot.current : null);

  useEffect(() => {
    onBusyChange(busy || reviewDirty);
    return () => onBusyChange(false);
  }, [busy, reviewDirty, onBusyChange]);
  useEffect(() => { onDraftChange(reviewDirty); return () => onDraftChange(false); }, [reviewDirty, onDraftChange]);

  async function loadRuns() {
    if (reviewDirty) return;
    setAction('loading'); setError(''); setVerified(false);
    try {
      const result = await getAPI()?.listSummaryRuns(sessionID);
      if (!result?.ok) setError(result?.error.message ?? unavailable);
      else {
        setRuns(result.value);
        setRunID(current => result.value.find(activeRun)?.id ?? (result.value.some(run => run.id === current) ? current : result.value[0]?.id ?? ''));
        setRefresh(current => current + 1);
      }
    } catch { setError(unavailable); }
    finally { setAction(null); }
  }

  useEffect(() => { void loadRuns(); }, [sessionID]);

  // Active runs need progress updates. Terminal manifests are revalidated less often;
  // image/preview reads and review saves still validate the original independently.
  useEffect(() => {
    if (!runID) { setVerified(false); setDetail(null); return; }
    if (detail?.id !== runID) { setVerified(false); setDetail(null); selectedSnapshot.current = null; }
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    let polling = false;
    let running = detail?.id === runID && activeRun(detail);
    async function poll() {
      if (!current || polling) return;
      if (!running && document.hidden) { timer = setTimeout(() => void poll(), 30000); return; }
      polling = true;
      try {
        const result = await getAPI()?.summaryRun(runID);
        if (!current) return;
        if (!result?.ok) { setError(result?.error.message ?? unavailable); setVerified(false); }
        else if (result.value.session_id !== sessionID || result.value.id !== runID) {
          setError('The summary run does not match this session. Refresh summary runs.'); setVerified(false);
        } else {
          const value = result.value;
          running = activeRun(value);
          setDetail(value); setVerified(true); setError('');
          setRuns(previous => [value, ...previous.filter(run => run.id !== value.id)]);
          setSelectedID(previous => draftActive.current || value.windows.some(window => window.id === previous) ? previous : value.windows[0]?.id ?? '');
          if (!activeRun(value)) setCancelling(false);
        }
      } catch { if (current) { setError(unavailable); setVerified(false); } }
      finally { polling = false; }
      if (current) timer = setTimeout(() => void poll(), running ? 1000 : 30000);
    }
    function visible() { if (!document.hidden && !running) { clearTimeout(timer); void poll(); } }
    void poll();
    document.addEventListener('visibilitychange', visible);
    return () => { current = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [runID, sessionID, refresh, reviewRefresh, reviewEnabled, qaEnabled]);

  // The inspection retains one full image, separately from the bounded gallery page.
  useEffect(() => {
    setImageURL(null); setImageError('');
    if (!verified || selected?.status !== 'complete' || !selected.image || (selected.source_state && selected.source_state !== 'ready')) return;
    let current = true;
    let url: string | undefined;
    const controller = new AbortController();
    const id = selected.id;
    async function loadImage() {
      try {
        const result = await readMediaBytes(() => getAPI()?.summaryImage(id), { signal: controller.signal, priority: 1 });
        if (!current) return;
        if (!result.ok) { setImageError(result.error.message); imageFailed(); return; }
        const bytes = new Uint8Array(result.value.bytes);
        if (bytes.byteLength < 1 || bytes.byteLength > 4 * 1024 * 1024) { setImageError('The summary image is empty or exceeds its 4 MiB limit.'); imageFailed(); return; }
        url = URL.createObjectURL(new Blob([bytes.buffer], { type: 'image/png' }));
        setImageURL(url);
      } catch { if (current) { setImageError(unavailable); imageFailed(); } }
    }
    void loadImage();
    return () => { current = false; controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [selected?.id, selected?.image?.sha256, selected?.status, selected?.source_state, verified, refresh]);

  function imageFailed() {
    // A page may contain several bad artifacts. One refresh establishes their
    // current manifest state instead of fetching it again for every thumbnail.
    if (Date.now() - imageFailureAt.current < 30000) return;
    imageFailureAt.current = Date.now();
    setVerified(false);
    setRefresh(value => value + 1);
  }

  async function start() {
    if (disabled || busy || reviewDirty) return;
    setAction('starting'); setError(''); setVerified(false);
    try {
      const result = await getAPI()?.startSummaries({ session_id: sessionID, window_seconds: 30 });
      if (!result?.ok) setError(result?.error.message ?? unavailable);
      else {
        setRuns(previous => [result.value, ...previous.filter(run => run.id !== result.value.id)]);
        setRunID(result.value.id); setDetail(result.value); setSelectedID('');
      }
    } catch { setError(unavailable); }
    finally { setAction(null); }
  }

  async function cancel() {
    if (!detail || !processing || action !== null || reviewDirty) return;
    setCancelling(true); setAction('cancelling'); setError('');
    try {
      const result = await getAPI()?.cancelSummaries(detail.id);
      if (!result?.ok) setError(result?.error.message ?? unavailable);
      else { setDetail(result.value); if (!activeRun(result.value)) setCancelling(false); }
    } catch { setError(unavailable); }
    finally { setAction(null); }
  }

  function inspect(id: string) {
    if (disabled || busy || reviewDirty) return;
    setSelectedID(id);
    requestAnimationFrame(() => {
      inspectionHeading.current?.focus();
      inspectionHeading.current?.scrollIntoView({ block: 'start' });
    });
  }

  function preview(window: SummaryWindow) {
    const segment = segments.find(value => value.id === window.segment_id);
    if (!disabled && !busy && (!reviewDirty || window.id === selectedID) && verified && segment?.source_state === 'ready' && window.preview_pts !== null && (!window.source_state || window.source_state === 'ready')) onPreview(segment, window.preview_pts, window.id);
  }

  function navigate(offset: number | 'unreviewed' | 'qa') {
    if (!detail || disabled || busy || reviewDirty) return;
    const position = detail.windows.findIndex(window => window.id === selectedID);
    const next = typeof offset === 'string'
      ? [...detail.windows.slice(position + 1), ...detail.windows.slice(0, position)].find(window => offset === 'qa' ? window.qa?.status !== 'agree' : !window.review || window.review.effective_decision === 'unreviewed')
      : detail.windows[position + offset];
    if (next) inspect(next.id);
  }

  function gallery() {
    if (disabled || busy || reviewDirty) return;
    const heading = document.getElementById('window-gallery');
    heading?.focus(); heading?.scrollIntoView({ block: 'start' });
  }

  function shortcut(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.repeat || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || disabled || busy || reviewDirty) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest('input, textarea, select, button, a, summary, video, audio, [contenteditable], [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="slider"], [role="checkbox"], [role="radio"], [role="switch"], [role="spinbutton"], [role="menuitem"]')) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); navigate(-1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); navigate(1); }
    else if (event.key.toLowerCase() === 'u') { event.preventDefault(); navigate('unreviewed'); }
    else if (event.key.toLowerCase() === 'g') { event.preventDefault(); gallery(); }
  }

  return <section className="summary-windows" aria-labelledby="summary-heading" aria-busy={action !== null}>
    <h2 id="summary-heading">Motion summary windows</h2>
    <p className="detail">Every planned interval remains listed, including quiet, quality-flagged, failed and incomplete windows. A summary is derived motion evidence, not a bat classification or proof of absence. Check the original recording.</p>
    <div className="media-actions">
      <button type="button" onClick={() => void start()} disabled={disabled || busy || reviewDirty || segments.length === 0}>Generate motion summaries</button>
      <button type="button" onClick={() => void loadRuns()} disabled={disabled || busy || reviewDirty}>Refresh summary runs</button>
      {processing && <button type="button" onClick={() => void cancel()} disabled={action !== null || cancelling || reviewDirty}>{cancelling ? 'Cancellation in progress...' : 'Cancel summary run'}</button>}
    </div>
    <p className="detail">New runs use 30-second per-segment windows. Each rerun has its own manifest and keeps prior output traceability. Segments are never joined.</p>
    <p className="detail">Active processing refreshes each second. Finished runs are revalidated every 30 seconds while this window is visible; use Refresh summary runs to check sooner. Original preview and saved review actions validate their source independently.</p>
    {error && <div className="error" role="alert"><strong>Summary operation failed</strong><p>{error}</p></div>}
    {action === 'loading' && <p role="status">Loading summary runs...</p>}
    {action === 'starting' && <p role="status">Planning all source windows and starting processing...</p>}
    {runs.length === 0 && action === null && <p>No summary runs saved.</p>}
    {runs.length > 0 && <><label htmlFor="summary-run">Processing run</label><select id="summary-run" value={runID} disabled={disabled || busy || reviewDirty} onChange={event => { setRunID(event.target.value); setSelectedID(''); }}>
      {runs.map(run => <option key={run.id} value={run.id}>{run.started_at_utc} · {run.state} · {run.id}</option>)}
    </select></>}
    {detail && <>
      {qaEnabled && <ExportPanel key={runID} runID={runID} disabled={disabled || baseBusy} dirty={reviewDirty || reviewDisabled} onBusyChange={setExportBusy} />}
      <p role="status">Run {detail.state}: {detail.counts.complete}/{detail.counts.planned} windows complete; {detail.counts.failed} failed; {detail.counts.incomplete} incomplete; {detail.counts.pending} pending; {detail.counts.running} running.{cancelling && ' Cancellation requested; waiting for resource cleanup.'}</p>
      {detail.review_progress && <p role="status" className="review-progress">First review progress: {detail.review_progress.reviewed}/{detail.review_progress.total} reviewed; {detail.review_progress.unreviewed} unreviewed; {detail.review_progress.quality_flagged} quality-flagged; {detail.review_progress.failed} failed; {detail.review_progress.incomplete} incomplete; {detail.review_progress.needs_reverification} need re-verification. All planned windows remain in the denominator.</p>}
      {detail.qa_progress && <p role="status" className="review-progress">Second-review QA coverage: {detail.qa_progress.agree}/{detail.qa_progress.total} agreed; {detail.qa_progress.disagree} disagreed; {detail.qa_progress.needs_clarification} need clarification; {detail.qa_progress.pending} pending; {detail.qa_progress.unassessable} unassessable; {detail.qa_progress.needs_reverification} stale. All planned windows remain in the denominator; this is not ecological finalisation.</p>}
      {detail.error && <p className="source-warning" role="alert">{detail.error.code}: {detail.error.message}</p>}
      <details className="summary-provenance"><summary>Processing provenance and parameters</summary><dl className="media-timing">
        <dt>Run ID</dt><dd>{detail.id}</dd>
        <dt>Algorithm</dt><dd>{detail.algorithm_version}</dd>
        <dt>Parameter SHA256</dt><dd className="source-hash">{detail.parameter_hash}</dd>
        <dt>Started / finished (UTC)</dt><dd>{detail.started_at_utc} / {detail.finished_at_utc ?? 'Not finished'}</dd>
      </dl><pre>{JSON.stringify(detail.parameters, null, 2)}</pre></details>
      <p className="detail">Intervals below are exact half-open [start, end) values. Rational seconds and PTS are separate from an optional saved clock anchor. Timestamp gaps do not prove recorded imagery between frames.</p>
      <SummaryGallery key={runID} windows={detail.windows} segments={segments} selectedID={selectedID} disabled={disabled || busy || reviewDirty} previewDisabled={disabled || busy} verified={verified} reviewEnabled={reviewEnabled} onInspect={inspect} onPreview={preview} onImageFailure={imageFailed} />
      {detail.windows.length !== detail.counts.planned && <p role="alert" className="source-warning">The visible manifest count does not match the planned count. This run cannot establish complete source coverage.</p>}
    </>}
    {selected && <div className="summary-inspection" role="region" aria-label="Selected summary window" tabIndex={0} onKeyDown={shortcut}>
      <h3 ref={inspectionHeading} tabIndex={-1}>Inspect window {selected.index + 1}</h3>
      <p className="detail">Run window {(detail?.windows.findIndex(window => window.id === selected.id) ?? -1) + 1}; segment window {selected.index + 1}. Keyboard on this inspection area: Left/Right for previous/next, U for next unreviewed, G for gallery. Shortcuts do not run inside controls.</p>
      <div className="media-actions"><button type="button" disabled={disabled || busy || reviewDirty} onClick={gallery}>Return to gallery</button><button type="button" disabled={disabled || busy || !verified || selected.preview_pts === null || selected.source_state !== undefined && selected.source_state !== 'ready'} onClick={() => preview(selected)}>Preview selected window source</button></div>
      {reviewEnabled && <nav className="media-actions" aria-label="Window review navigation">
        <button type="button" disabled={disabled || busy || reviewDirty || detail?.windows[0]?.id === selected.id} onClick={() => navigate(-1)}>Previous window</button>
        <button type="button" disabled={disabled || busy || reviewDirty || detail?.windows.at(-1)?.id === selected.id} onClick={() => navigate(1)}>Next window</button>
        <button type="button" disabled={disabled || busy || reviewDirty || !detail?.windows.some(window => window.id !== selected.id && (!window.review || window.review.effective_decision === 'unreviewed'))} onClick={() => navigate('unreviewed')}>Next unreviewed window</button>
        {qaEnabled && <button type="button" disabled={disabled || busy || reviewDirty || !detail?.windows.some(window => window.id !== selected.id && window.qa?.status !== 'agree')} onClick={() => navigate('qa')}>Next QA pending window</button>}
      </nav>}
      {selected.flags.length > 0 && <ul className="source-warning" aria-label="Selected window quality warnings">{selected.flags.map(flag => <li key={flag}>{flag}: {flagMeaning[flag] ?? 'Inspect the original recording.'}</li>)}</ul>}
      <p className="detail">Left: source reference/context. Right: motion evidence. Cyan = early third, yellow = middle third, magenta = late third of this window's source-time interval. Overlapping evidence combines colours. These colours do not identify animals.</p>
      {imageURL ? <img src={imageURL} alt={`Reference and motion evidence for window ${selected.index + 1}`} onError={() => { URL.revokeObjectURL(imageURL); setImageURL(null); setImageError('The generated summary image could not be displayed. Refresh summary runs and retry.'); imageFailed(); }} /> : <p>{imageError ? 'Summary image unavailable.' : !verified ? 'Source validation is unavailable; no image is displayed.' : selected.status !== 'complete' || !selected.image ? 'No complete image exists for this window.' : selected.source_state && selected.source_state !== 'ready' ? 'The original source is unavailable or changed; no derived image is displayed.' : 'Loading summary image...'}</p>}
      {imageError && <p role="alert" className="source-warning">{imageError}</p>}
      <dl className="media-timing">
        <dt>Window / segment ID</dt><dd>{selected.id} / {selected.segment_id}</dd>
        <dt>Source PTS interval</dt><dd>{interval(selected.interval.start_pts, selected.interval.end_pts)}</dd>
        <dt>Source timebase (seconds)</dt><dd>{rational(selected.time_base)}</dd>
        <dt>Source time interval (seconds)</dt><dd>{interval(selected.interval.start_time, selected.interval.end_time)}</dd>
        <dt>Segment elapsed interval (seconds)</dt><dd>{interval(selected.interval.elapsed_start, selected.interval.elapsed_end)}</dd>
        <dt>Decoded first / last PTS</dt><dd>{selected.stats.first_pts ?? 'Unknown'} / {selected.stats.last_pts ?? 'Unknown'}</dd>
        <dt>Decoded frames / comparisons</dt><dd>{selected.stats.frame_count ?? 'Unavailable'} / {selected.stats.comparison_count ?? 'Unavailable'}</dd>
        <dt>Decoded PTS SHA256</dt><dd className="source-hash">{selected.stats.pts_digest ?? 'Unavailable'}</dd>
        <dt>Source SHA256</dt><dd className="source-hash">{selected.source_sha256}</dd>
        <dt>Image SHA256 / bytes</dt><dd className="source-hash">{selected.image ? `${selected.image.sha256} / ${selected.image.bytes}` : 'Unavailable'}</dd>
        <dt>Motion pixels / early, middle, late</dt><dd>{selected.stats.motion_pixels ?? 'Unavailable'} / {selected.stats.phase_pixels?.join(', ') ?? 'Unavailable'}</dd>
        <dt>Timestamp gaps / maximum spacing (seconds)</dt><dd>{selected.stats.gap_count ?? 'Unavailable'} / {rational(selected.stats.max_spacing)}</dd>
        <dt>Preview source PTS</dt><dd>{selected.preview_pts ?? 'Unavailable'}</dd>
      </dl>
      {(selected.stats.gaps?.length ?? 0) > 0 && <details><summary>Timestamp gap examples ({selected.stats.gaps?.length} shown; {selected.stats.gap_examples_recorded ?? selected.stats.gaps?.length} stored; {selected.stats.gap_count} total)</summary><ul>{selected.stats.gaps?.map((gap, index) => <li key={index}>{interval(gap.start, gap.end)} source seconds</li>)}</ul></details>}
      {!currentSelected && reviewDirty && <p role="alert" className="source-warning">The selected window is missing from the latest manifest. Your review draft is retained. Saving is unavailable until the original window is restored.</p>}
      {reviewEnabled && <ReviewPanel key={`review:${selected.id}`} window={selected} previewID={previewReceipt?.windowID === selected.id ? previewReceipt.previewID : null} displayedSourceFrame={displayedSourceFrame} disabled={reviewDisabled || busy || !verified || !currentSelected || qaDirty} onDirtyChange={setFirstDirty} onSaved={() => setReviewRefresh(value => value + 1)} />}
      {qaEnabled && <QAPanel key={`qa:${selected.id}`} window={selected} previewID={previewReceipt?.windowID === selected.id ? previewReceipt.previewID : null} disabled={reviewDisabled || busy || !verified || !currentSelected || firstDirty} onDirtyChange={setQADirty} onSaved={() => setReviewRefresh(value => value + 1)} />}
    </div>}
  </section>;
}
