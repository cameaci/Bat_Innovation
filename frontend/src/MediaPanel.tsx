import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { ApiResult, BatAPI, Continuity, ImportJob, MediaMetadata, MediaSegment, MediaSession, Rational, RecordingSession, SaveMedia } from '../../electron/src/contracts';
import { getAPI } from './api';

const unavailable = 'The local backend is unavailable. Retry, or close and reopen the desktop app.';
const rational = (value: Rational | null) => value ? `${value.num}/${value.den}` : 'Unknown';

function Metadata({ metadata: m }: { metadata: MediaMetadata }) {
  return <details className="media-metadata">
    <summary>Source metadata</summary>
    <dl>
      <dt>Container / video codec</dt><dd>{m.container} / {m.codec}</dd>
      <dt>File size</dt><dd>{m.size_bytes} bytes</dd>
      <dt>Dimensions</dt><dd>{m.width} × {m.height}</dd>
      <dt>Reported duration (seconds)</dt><dd>{rational(m.reported_duration)}</dd>
      <dt>Decoded frames</dt><dd>{m.frame_count}</dd>
      <dt>Average / base rate</dt><dd>{rational(m.average_rate)} / {rational(m.base_rate)}</dd>
      <dt>Rotation</dt><dd>{m.rotation === null ? 'Unknown' : `${m.rotation} degrees`}</dd>
      <dt>Field order / interlacing</dt><dd>{m.field_order ?? 'Unknown'} / {m.interlaced ? 'Interlaced frames detected' : 'No interlaced frames detected'}</dd>
      <dt>Streams</dt><dd>{m.streams.map(stream => <div key={stream.index}>Stream {stream.index}: {stream.type}, {stream.codec ?? 'Unknown codec'}, timebase {rational(stream.time_base)}{stream.index === m.video_stream_index ? ' (selected video)' : ''}</div>)}</dd>
      <dt>SHA256</dt><dd className="source-hash">{m.sha256}</dd>
    </dl>
  </details>;
}

export function MediaPanel({ session, onBusyChange }: { session: RecordingSession; onBusyChange?: (busy: boolean) => void }) {
  const [media, setMedia] = useState<MediaSession | null>(null);
  const [segments, setSegments] = useState<MediaSegment[]>([]);
  const [anchorSegment, setAnchorSegment] = useState('');
  const [anchorUTC, setAnchorUTC] = useState('');
  const [anchorProvenance, setAnchorProvenance] = useState('');
  const [job, setJob] = useState<ImportJob | null>(null);
  const [busy, setBusy] = useState<string | null>('loading');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const importing = job?.state === 'running';
  const disabled = busy !== null || importing;

  useEffect(() => {
    onBusyChange?.(disabled || dirty);
    return () => onBusyChange?.(false);
  }, [disabled, dirty, onBusyChange]);

  function replace(value: MediaSession) {
    setMedia(value);
    setSegments(value.segments);
    setAnchorSegment(value.clock_anchor?.segment_id ?? '');
    setAnchorUTC(value.clock_anchor?.utc ?? '');
    setAnchorProvenance(value.clock_anchor?.provenance ?? '');
    setDirty(false);
  }

  async function request<T>(action: (api: BatAPI) => Promise<ApiResult<T>>): Promise<T | undefined> {
    try {
      const api = getAPI();
      if (!api) { setError('The desktop bridge is unavailable. Reopen this interface through Electron.'); return; }
      const result = await action(api);
      if (result.ok) return result.value;
      setError(result.error.message);
    } catch { setError(unavailable); }
  }

  async function refresh() {
    if (dirty) { setError('Save or discard timeline edits before refreshing.'); return; }
    setBusy('loading'); setError(''); setNotice('');
    const value = await request(api => api.getMedia(session.id));
    if (value) { replace(value); setJob(value.active_import?.state === 'running' ? value.active_import : null); }
    setBusy(null);
  }

  useEffect(() => { void refresh(); }, [session.id]);

  async function finish(value: ImportJob, isCurrent: () => boolean = () => true) {
    const latest = await request(api => api.getMedia(session.id));
    if (!isCurrent()) return;
    if (latest) replace(latest);
    setJob(value);
    if (value.state === 'failed') setError(value.error?.message ?? 'Import failed. Check the original recordings and retry.');
    else setNotice(value.state === 'complete' ? 'Original segments inspected and saved in SQLite.' : 'Import cancelled. No files from this batch were added.');
  }

  useEffect(() => {
    if (!job || job.state !== 'running') return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await getAPI()?.importStatus(job.id);
        if (!active) return;
        if (!result?.ok) {
          setError(`Import status could not be checked; retrying. ${result?.error.message ?? unavailable}`);
        } else {
          setError('');
          if (result.value.state !== 'running') {
            await finish(result.value, () => active);
            return;
          }
          setJob(result.value);
        }
      } catch { if (active) setError(`Import status could not be checked; retrying. ${unavailable}`); }
      if (active) timer = setTimeout(() => void poll(), 500);
    };
    timer = setTimeout(() => void poll(), 500);
    return () => { active = false; clearTimeout(timer); };
  }, [job?.id, job?.state, session.id]);

  async function upgrade() {
    setBusy('upgrade'); setError(''); setNotice('');
    if (await request(api => api.upgradeMedia())) {
      const value = await request(api => api.getMedia(session.id));
      if (value) { replace(value); setNotice('Media storage upgraded to schema 2. Existing sessions are retained.'); }
    }
    setBusy(null);
  }

  async function choose() {
    if (dirty) { setError('Save or discard timeline edits before importing.'); return; }
    setBusy('picker'); setError(''); setNotice('');
    const value = await request(api => api.chooseMedia(session.id));
    if (value !== undefined) {
      if (value === null) { setJob(null); setNotice('File selection cancelled. No import was started.'); }
      else if (value.state === 'running') setJob(value);
      else await finish(value);
    }
    setBusy(null);
  }

  async function cancel() {
    if (!job) return;
    setBusy('cancel'); setError('');
    const value = await request(api => api.cancelImport(job.id));
    if (value) {
      if (value.state === 'running') setJob(value);
      else await finish(value);
    }
    setBusy(null);
  }

  function move(index: number, offset: number) {
    const reordered = [...segments];
    [reordered[index], reordered[index + offset]] = [reordered[index + offset], reordered[index]];
    setSegments(reordered.map(segment => ({ ...segment, continuity: 'unknown', continuity_provenance: null })));
    setDirty(true); setNotice('Order changed. Continuity is reset to unknown; enter evidence for the new neighbouring segments and save.');
  }

  function continuity(id: string, status: Continuity, provenance?: string) {
    setSegments(current => current.map(segment => segment.id === id ? { ...segment, continuity: status, continuity_provenance: status === 'unknown' ? null : provenance ?? segment.continuity_provenance } : segment));
    setDirty(true);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setNotice('');
    if (segments.some(segment => segment.continuity !== 'unknown' && !segment.continuity_provenance?.trim())) {
      setError('Provide evidence for each known continuity relationship, or leave it unknown.'); return;
    }
    let clock_anchor: SaveMedia['clock_anchor'] = null;
    if (anchorSegment || anchorUTC.trim() || anchorProvenance.trim()) {
      if (!anchorSegment || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(anchorUTC.trim()) || !Number.isFinite(Date.parse(anchorUTC.trim())) || !anchorProvenance.trim()) {
        setError('Choose an anchor segment and enter a valid UTC timestamp ending in Z or +00:00, plus the source of that clock evidence. Clear the anchor to leave real-world time unknown.'); return;
      }
      clock_anchor = { segment_id: anchorSegment, utc: anchorUTC.trim(), provenance: anchorProvenance.trim() };
    }
    setBusy('saving');
    const value = await request(api => api.saveMedia(session.id, {
      segment_ids: segments.map(segment => segment.id),
      continuity: segments.map(segment => ({ segment_id: segment.id, status: segment.continuity, provenance: segment.continuity === 'unknown' ? null : segment.continuity_provenance?.trim() ?? null })),
      clock_anchor,
    }));
    if (value) { replace(value); setNotice('Segment order and provenance saved in SQLite.'); }
    setBusy(null);
  }

  return <section aria-labelledby="media-heading" aria-busy={busy !== null}>
    <h2 id="media-heading">Session media</h2>
    <p><strong>{session.display_name}</strong> · Camera: {session.camera_ref}</p>
    <p className="detail">Inspect original MP4 or MTS segments. Source timestamps and exact rational seconds are authoritative. Original-speed provenance is unverified.</p>
    <div className="media-actions">
      <button type="button" onClick={() => void refresh()} disabled={disabled || dirty}>Refresh media</button>
      {media?.schema_version === 2 && <button type="button" onClick={() => void choose()} disabled={disabled || dirty}>Choose original videos</button>}
    </div>
    {error && <div className="error" role="alert"><strong>Media operation failed</strong><p>{error}</p></div>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!media && <p>{busy === 'loading' ? 'Loading media inventory...' : 'Media inventory could not be loaded. Use Refresh media to retry.'}</p>}
    {media?.schema_version === 1 && <div>
      <p>Media import needs an explicit storage upgrade from schema 1 to schema 2. This adds media records and preserves existing sessions.</p>
      <button type="button" onClick={() => void upgrade()} disabled={disabled}>Upgrade media storage</button>
    </div>}
    {job && <div className="import-status">
      <p role="status">Import {job.state}: {job.phase}{job.filename && ` · ${job.filename}`} · {job.files_done}/{job.files_total} files{job.phase === 'hashing' ? ` · ${job.progress_value} bytes hashed` : job.phase === 'decoding' ? ` · ${job.progress_value} frames decoded` : ''}</p>
      {importing && <button type="button" onClick={() => void cancel()} disabled={busy !== null}>{busy === 'cancel' ? 'Cancelling...' : 'Cancel import'}</button>}
    </div>}
    {media?.schema_version === 2 && <form className="media-form" onSubmit={event => void save(event)}>
      <p className="detail">Continuity describes the relationship to the previous segment. Filenames and file times do not prove continuity. No global continuous timeline is inferred.</p>
      {segments.length === 0 ? <p>No source segments imported.</p> : <ol className="segment-list">{segments.map((segment, index) => <li key={segment.id}>
        <article aria-label={`Segment ${index + 1}: ${segment.metadata.filename}`}>
          <h3>{index + 1}. {segment.metadata.filename}</h3>
          <p className="detail">{segment.source_state === 'ready' ? 'Source identity unchanged since import.' : `Source state: ${segment.source_state}`}</p>
          {segment.source_state !== 'ready' && <p role="alert" className="source-warning">{segment.source_state === 'missing_source' ? 'Original source is missing. Restore it to its selected location and refresh.' : segment.source_state === 'unreadable_source' ? 'Original source exists but cannot be read. Check file permissions or storage access and refresh.' : 'Original source changed. Restore the unchanged original and refresh; stored timestamps do not verify this changed file.'}</p>}
          <div className="media-actions">
            <button type="button" disabled={disabled || index === 0} onClick={() => move(index, -1)}>Move up</button>
            <button type="button" disabled={disabled || index === segments.length - 1} onClick={() => move(index, 1)}>Move down</button>
          </div>
          <dl className="media-timing">
            <dt>First / last decoded PTS</dt><dd>{segment.metadata.first_pts} / {segment.metadata.last_pts}</dd>
            <dt>Source timebase</dt><dd>{rational(segment.metadata.time_base)}</dd>
            <dt>First / last source time (seconds)</dt><dd>{rational(segment.metadata.first_time)} / {rational(segment.metadata.last_time)}</dd>
            <dt>Elapsed to last frame / end (seconds)</dt><dd>{rational(segment.metadata.elapsed_last_time)} / {rational(segment.metadata.elapsed_end)}</dd>
            <dt>Source end (seconds)</dt><dd>{rational(segment.metadata.end_time)}</dd>
          </dl>
          {segment.metadata.warnings.length > 0 && <ul className="source-warning" aria-label={`Warnings for ${segment.metadata.filename}`}>{segment.metadata.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
          <Metadata metadata={segment.metadata} />
          <label htmlFor={`continuity-${segment.id}`}>Continuity before {segment.metadata.filename}</label>
          <select id={`continuity-${segment.id}`} value={segment.continuity} disabled={disabled || index === 0} onChange={event => continuity(segment.id, event.target.value as Continuity)}>
            <option value="unknown">Unknown{index === 0 ? ' (first segment)' : ''}</option><option value="known_contiguous">Known contiguous</option><option value="known_gap">Known gap</option>
          </select>
          {segment.continuity !== 'unknown' && <><label htmlFor={`evidence-${segment.id}`}>Continuity evidence for {segment.metadata.filename}</label><input id={`evidence-${segment.id}`} value={segment.continuity_provenance ?? ''} maxLength={500} required disabled={disabled} onChange={event => continuity(segment.id, segment.continuity, event.target.value)} /></>}
        </article>
      </li>)}</ol>}
      {segments.length > 0 && <fieldset disabled={disabled}>
        <legend>Optional original-clock anchor</legend>
        <p className="detail">Anchor the first valid decoded frame of one segment to evidenced UTC. Leave blank to keep real-world time unknown. File timestamps are never used as survey time.</p>
        {media.clock_anchor ? <p className="detail">Saved anchor: first source PTS {media.clock_anchor.source_pts}, timebase {rational(media.clock_anchor.time_base)}, source time {rational(media.clock_anchor.source_time)} seconds.</p> : <p className="detail">No original-clock anchor. Real-world survey time remains unknown.</p>}
        <label htmlFor="anchor-segment">Clock anchor segment</label>
        <select id="anchor-segment" value={anchorSegment} onChange={event => { setAnchorSegment(event.target.value); if (!event.target.value) { setAnchorUTC(''); setAnchorProvenance(''); } setDirty(true); }}>
          <option value="">No clock anchor</option>{segments.map(segment => <option key={segment.id} value={segment.id}>{segment.metadata.filename}</option>)}
        </select>
        <label htmlFor="anchor-utc">Clock anchor UTC</label>
        <input id="anchor-utc" value={anchorUTC} placeholder="YYYY-MM-DDTHH:mm:ssZ" disabled={!anchorSegment || disabled} onChange={event => { setAnchorUTC(event.target.value); setDirty(true); }} />
        <label htmlFor="anchor-provenance">Clock anchor provenance</label>
        <input id="anchor-provenance" value={anchorProvenance} maxLength={500} disabled={!anchorSegment || disabled} onChange={event => { setAnchorProvenance(event.target.value); setDirty(true); }} />
      </fieldset>}
      {segments.length > 0 && <><button type="submit" disabled={disabled || !dirty}>{busy === 'saving' ? 'Saving...' : 'Save timeline'}</button>{dirty && <button type="button" disabled={disabled} onClick={() => { if (media) replace(media); setError(''); setNotice('Unsaved timeline changes discarded.'); }}>Discard unsaved changes</button>}</>}
    </form>}
  </section>;
}
