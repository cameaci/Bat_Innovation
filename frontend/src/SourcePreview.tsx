import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ClockAnchor, MediaSegment, PreviewFrame, PreviewJob, Rational } from '../../electron/src/contracts';
import { getAPI } from './api';

const rational = (value: Rational) => `${value.num}/${value.den}`;
const unavailable = 'The local backend is unavailable. Close the preview and retry after checking the backend.';

export function SourcePreview({ segment, initialPTS, clockAnchor, onClose, onReady }: {
  segment: MediaSegment;
  initialPTS?: string;
  clockAnchor: ClockAnchor | null;
  onClose: () => void;
  onReady?: (previewID: string | null) => void;
}) {
  const [sourcePTS, setSourcePTS] = useState(initialPTS ?? segment.metadata.first_pts);
  const [job, setJob] = useState<PreviewJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [pendingCancellation, setPendingCancellation] = useState<string | null>(null);
  const [url, setURL] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [displayed, setDisplayed] = useState<PreviewFrame | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const generation = useRef(0);
  const activeJob = useRef<string | null>(null);
  const clipURL = useRef<string | null>(null);
  const readyCallback = useRef(onReady);
  readyCallback.current = onReady;

  function clearClip() {
    readyCallback.current?.(null);
    if (video.current) {
      video.current.pause();
      video.current.removeAttribute('src');
      video.current.load();
    }
    if (clipURL.current) URL.revokeObjectURL(clipURL.current);
    clipURL.current = null;
    setURL(null);
    setLoaded(false);
    setDisplayed(null);
  }

  function releaseJob() {
    const id = activeJob.current;
    activeJob.current = null;
    if (id) void getAPI()?.cancelPreview(id).catch(() => undefined);
  }

  function invalidate() {
    generation.current += 1;
    clearClip();
    releaseJob();
    setJob(null);
    setStarting(false);
    setPendingCancellation(null);
  }

  function fail(message: string) {
    invalidate();
    setError(message);
    setNotice('');
  }

  useEffect(() => {
    heading.current?.focus();
    heading.current?.scrollIntoView({ block: 'start' });
    return () => {
      readyCallback.current?.(null);
      generation.current += 1;
      releaseJob();
      if (clipURL.current) URL.revokeObjectURL(clipURL.current);
      clipURL.current = null;
    };
  }, []);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    invalidate();
    setError(''); setNotice('');
    const requested = sourcePTS.trim();
    if (!/^-?\d+$/.test(requested)) {
      setError('Enter an integer source PTS using the imported source timebase.');
      return;
    }
    const ticket = generation.current;
    setStarting(true);
    try {
      const api = getAPI();
      if (!api) { fail(unavailable); return; }
      const result = await api.startPreview({ segment_id: segment.id, source_pts: requested });
      if (ticket !== generation.current) {
        if (result.ok) void api.cancelPreview(result.value.id).catch(() => undefined);
        return;
      }
      if (!result.ok) { fail(result.error.message); return; }
      if (result.value.segment_id !== segment.id) { fail('The preview response does not match the selected source.'); return; }
      activeJob.current = result.value.id;
      setJob(result.value);
      setStarting(false);
    } catch { if (ticket === generation.current) fail(unavailable); }
  }

  // Status revalidates source identity even after bytes have been loaded into the player.
  useEffect(() => {
    if (!job) return;
    const id = job.id;
    const ticket = generation.current;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const current = () => active && ticket === generation.current;
    async function poll() {
      try {
        const api = getAPI();
        if (!api) { if (current()) fail(unavailable); return; }
        const result = await api.previewStatus(id);
        if (!current()) return;
        if (!result.ok) { fail(result.error.message); return; }
        const value = result.value;
        if (value.segment_id !== segment.id) { fail('The preview no longer matches the selected source.'); return; }
        if (value.state === 'failed' || value.state === 'cancelled') {
          fail(value.error?.message ?? (value.state === 'cancelled' ? 'Preview cancelled or expired. Create a new preview to continue.' : 'Preview generation failed. Check the selected source.'));
          return;
        }
        setJob(value);
        if (value.state === 'ready' && !clipURL.current) {
          if (!value.manifest || value.manifest.segment_id !== segment.id || value.manifest.source_sha256 !== segment.metadata.sha256) {
            fail('The preview identity does not match the imported original. Refresh the session media.'); return;
          }
          const content = await api.previewContent(id);
          if (!current()) return;
          if (!content.ok) { fail(content.error.message); return; }
          const bytes = new Uint8Array(content.value.bytes);
          if (bytes.byteLength < 1 || bytes.byteLength > 8 * 1024 * 1024) { fail('The preview content is empty or exceeds its 8 MiB limit.'); return; }
          clipURL.current = URL.createObjectURL(new Blob([bytes.buffer], { type: 'video/webm' }));
          setURL(clipURL.current);
        }
        if (current()) timer = setTimeout(() => void poll(), value.state === 'ready' ? 1000 : 500);
      } catch { if (current()) fail(unavailable); }
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [job?.id]);

  useEffect(() => {
    if (!pendingCancellation) return;
    const ticket = generation.current;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      try {
        const result = await getAPI()?.previewStatus(pendingCancellation!);
        if (!active || ticket !== generation.current) return;
        if (!result?.ok) setError(result?.error.message ?? unavailable);
        else if (result.value.state === 'cancelled' || result.value.state === 'failed') {
          activeJob.current = null;
          setPendingCancellation(null);
          setError('');
          setNotice('Preview stopped. No preview is displayed.');
          return;
        }
      } catch { if (active && ticket === generation.current) setError(unavailable); }
      if (active && ticket === generation.current) timer = setTimeout(() => void check(), 1000);
    }
    timer = setTimeout(() => void check(), 500);
    return () => { active = false; clearTimeout(timer); };
  }, [pendingCancellation]);

  const manifest = job?.manifest;
  useLayoutEffect(() => {
    const player = video.current;
    if (!url || !player || !manifest) return;
    if (typeof player.requestVideoFrameCallback !== 'function') {
      fail('This browser cannot identify displayed preview frames reliably. Source-time playback is unavailable.');
      return;
    }
    let active = true;
    let callback: number;
    function frame(_now: number, metadata: VideoFrameCallbackMetadata) {
      if (!active || !player) return;
      const milliseconds = metadata.mediaTime * 1000;
      const mapped = manifest!.frames.find(value => Math.abs(value.preview_ms - milliseconds) <= 0.5001);
      if (!mapped) { fail('The displayed frame could not be matched to an original source PTS. Create a new preview.'); return; }
      setDisplayed(mapped);
      callback = player.requestVideoFrameCallback(frame);
    }
    callback = player.requestVideoFrameCallback(frame);
    return () => { active = false; player.cancelVideoFrameCallback(callback); };
  }, [url, manifest]);

  function target(value: string) {
    invalidate(); setSourcePTS(value); setError(''); setNotice('');
  }

  async function cancel() {
    const id = activeJob.current;
    if (!pendingCancellation) generation.current += 1;
    clearClip(); setJob(null); setStarting(false);
    setPendingCancellation(id);
    const ticket = generation.current;
    setError(''); setNotice('Cancellation requested. No preview is displayed.');
    if (id) {
      try {
        const result = await getAPI()?.cancelPreview(id);
        if (ticket === generation.current) {
          if (!result?.ok) setError(result?.error.message ?? unavailable);
          else if (result.value.state === 'running') setNotice('Cancellation is in progress. No preview is displayed.');
          else {
            activeJob.current = null; setPendingCancellation(null);
            setNotice('Preview cancelled. No preview is displayed.');
          }
        }
      } catch { if (ticket === generation.current) setError(unavailable); }
    }
  }

  function close() { invalidate(); onClose(); }

  return <section className="source-preview" aria-labelledby="preview-heading">
    <h2 id="preview-heading" ref={heading} tabIndex={-1}>Source preview</h2>
    <p><strong>{segment.metadata.filename}</strong></p>
    <p className="detail">Derived VP9/WebM display clip, limited to 2 seconds and 8 MiB. The original is unchanged. The player timer is preview-relative; original-speed provenance remains unverified.</p>
    <p className="detail">Continuity before this segment: {segment.continuity.replaceAll('_', ' ')}{segment.continuity_provenance && ` · ${segment.continuity_provenance}`}. Segments are never joined automatically.</p>
    <form onSubmit={event => void start(event)}>
      <label htmlFor="preview-source-pts">Source PTS</label>
      <input id="preview-source-pts" value={sourcePTS} onChange={event => target(event.target.value)} inputMode="numeric" autoComplete="off" disabled={pendingCancellation !== null} />
      <p className="detail">Integer PTS in timebase {rational(segment.metadata.time_base)} seconds. Imported decoded range: {segment.metadata.first_pts} to {segment.metadata.last_pts}. A target between frames selects the first frame at or after it.</p>
      <div className="preview-controls">
        <button type="button" disabled={pendingCancellation !== null} onClick={() => target(segment.metadata.first_pts)}>First frame</button>
        <button type="button" disabled={pendingCancellation !== null} onClick={() => target(segment.metadata.last_pts)}>Last frame</button>
        <button type="submit" disabled={starting || job?.state === 'running' || pendingCancellation !== null}>Create preview</button>
      </div>
    </form>
    <div className="preview-controls">
      {(starting || job || pendingCancellation) && <button type="button" onClick={() => void cancel()}>Cancel preview</button>}
      <button type="button" onClick={close}>Close preview</button>
      <button type="button" onClick={close}>Back to segment</button>
    </div>
    <p className="preview-status" role="status">{starting ? 'Creating preview...' : job?.state === 'running' ? `Creating preview: ${job.phase}` : url ? loaded ? 'Preview ready' : 'Loading preview...' : notice || 'No preview displayed.'}</p>
    {error && <div className="error" role="alert"><strong>Preview unavailable</strong><p>{error}</p></div>}
    {url && <video ref={video} src={url} controls preload="auto" aria-label="Derived source preview" onLoadedData={() => { setLoaded(true); if (job?.state === 'ready') readyCallback.current?.(job.id); }} onSeeking={() => setDisplayed(null)} onError={() => fail('The derived preview could not be played. Close it and retry; this browser may not support the preview codec.')} />}
    {displayed && <dl className="preview-timing" aria-label="Displayed original frame">
      <dt>Displayed source PTS</dt><dd>{displayed.source_pts}</dd>
      <dt>Displayed source time (seconds)</dt><dd>{rational(displayed.source_time)}</dd>
      <dt>Displayed segment elapsed (seconds)</dt><dd>{rational(displayed.elapsed)}</dd>
    </dl>}
    {manifest && <><dl className="preview-timing">
      <dt>Requested / actual first source PTS</dt><dd>{manifest.requested_pts} / {manifest.actual_pts}</dd>
      <dt>Source timebase</dt><dd>{rational(manifest.time_base)}</dd>
      <dt>Seek delta (seconds)</dt><dd>{rational(manifest.seek_error)}</dd>
      <dt>Clip source first / last / end (seconds)</dt><dd>{rational(manifest.source_start)} / {rational(manifest.source_last)} / {rational(manifest.source_end)}</dd>
      <dt>Clip segment elapsed start / end (seconds)</dt><dd>{rational(manifest.elapsed_start)} / {rational(manifest.elapsed_end)}</dd>
      <dt>Preview duration / dimensions</dt><dd>{manifest.preview_duration_ms} ms · {manifest.width} × {manifest.height}</dd>
    </dl><p className="detail">Displayed-frame mapping uses measured preview timestamps with at most 0.5 ms timestamp quantisation. No frame-number/FPS clock conversion is used.</p>
      {manifest.warnings.length > 0 && <ul className="source-warning" aria-label="Preview fidelity warnings">{manifest.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
    </>}
    {clockAnchor?.segment_id === segment.id ? <p className="detail">Saved original-clock anchor: {clockAnchor.utc} at source PTS {clockAnchor.source_pts}, timebase {rational(clockAnchor.time_base)}. Evidence: {clockAnchor.provenance}. This is separate from the preview timer.</p> : <p className="detail">No original-clock anchor for this segment. Real-world survey time is unknown; an anchor on another segment is not propagated.</p>}
  </section>;
}
