import { useEffect, useRef, useState } from 'react';
import type { ExportJob } from '../../electron/src/contracts';
import { getAPI } from './api';

const unavailable = 'The local export backend is unavailable. No complete bundle was saved.';
export function ExportPanel({ runID, disabled, dirty, onBusyChange }: { runID: string; disabled: boolean; dirty: boolean; onBusyChange: (busy: boolean) => void }) {
  const [job, setJob] = useState<ExportJob | null>(null);
  const [action, setAction] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const working = job?.state === 'working';
  const busy = working || action;
  const jobRef = useRef(job); jobRef.current = job;
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => () => { const current = jobRef.current; if (current?.state === 'working') void getAPI()?.cancelExport(current.id); }, []);
  useEffect(() => {
    if (!job || job.state !== 'working') return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await getAPI()?.exportStatus(job!.id);
        if (!current) return;
        if (!result?.ok) { setError(result?.error.message ?? unavailable); setJob(null); return; }
        setJob(result.value);
        if (result.value.error) setError(result.value.error.message);
        if (result.value.state === 'working') timer = setTimeout(() => void poll(), 400);
      } catch { if (current) { setError(unavailable); setJob(null); } }
    }
    timer = setTimeout(() => void poll(), 100);
    return () => { current = false; clearTimeout(timer); };
  }, [job?.id, job?.state]);
  async function start() {
    if (disabled || dirty || busy || !confirmed) return;
    setAction(true); setError(''); setSaved(''); setJob(null);
    try {
      const result = await getAPI()?.startExport(runID);
      if (!result?.ok) setError(result?.error.message ?? unavailable);
      else { setJob(result.value); if (result.value.error) setError(result.value.error.message); }
    } catch { setError(unavailable); }
    finally { setAction(false); }
  }
  async function cancel() {
    if (!job) return;
    setAction(true);
    try { const result = await getAPI()?.cancelExport(job.id); if (result?.ok) setJob(result.value); else setError(result?.error.message ?? unavailable); }
    catch { setError(unavailable); } finally { setAction(false); }
  }
  async function save() {
    if (!job || disabled || dirty || busy) return;
    setAction(true); setSaved(''); setError('');
    try {
      const result = await getAPI()?.saveExportBundle(job.id);
      if (!result?.ok) setError(result?.error.message ?? unavailable);
      else setSaved(result.value.cancelled ? 'Save cancelled. Choose a destination when ready.' : `Saved complete provisional bundle in ${result.value.folder_name}.`);
    } catch { setError(unavailable); } finally { setAction(false); }
  }
  const manifest = job?.state === 'ready' ? job.manifest : null;
  return <section className="export-panel" aria-label="Provisional CSV export">
    <h3>Provisional CSV exports</h3>
    <p className="source-warning">PROVISIONAL — NOT ECOLOGICALLY FINALISED</p>
    <p className="detail">Export this run's saved database snapshot and every planned window, regardless of gallery filters. Observation rows are provisional visual records, not distinct animals or final ecological reports. Local reviewer labels are attribution, not verified identities.</p>
    <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} /> I understand these CSVs are provisional and not final ecological reports.</label>
    {dirty && <p role="status">Save or explicitly discard first-review, QA and timeline drafts before exporting.</p>}
    <div className="media-actions"><button type="button" disabled={disabled || dirty || busy || !confirmed} onClick={() => void start()}>Export provisional CSVs</button>
      {working && <button type="button" disabled={action} onClick={() => void cancel()}>Cancel export</button>}
      {manifest && <button type="button" disabled={disabled || dirty || busy} onClick={() => void save()}>Save provisional CSV bundle...</button>}
    </div>
    {busy && <p role="status">{working ? 'Creating a bounded read-only export snapshot...' : 'Completing provisional export operation...'}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {saved && <p role="status">{saved}</p>}
    {manifest && <div className="export-results">
      <p role="status">Export snapshot: {manifest.counts.planned} planned; {manifest.counts.actual} actual; {manifest.counts.missing} missing manifest records; {manifest.counts.reviewed} reviewed; {manifest.counts.qa.pending} QA pending; {manifest.counts.first_stale} first-review stale; {manifest.counts.qa_stale} QA stale; {manifest.counts.timestamp_gaps} observed timestamp gaps; {manifest.counts.evidence_flagged} evidence warnings.</p>
      <p>Manifest {manifest.manifest_complete ? 'complete' : 'INCOMPLETE'}; processing {manifest.processing_complete ? 'complete' : 'INCOMPLETE'}. These indicate technical coverage only.</p>
      <p>Schema: {manifest.schema_version}. Database as of UTC: {manifest.as_of_utc}. Human decisions are as of this snapshot, not live approval.</p>
      <ul>{Object.values(manifest.files).map(file => <li key={file.name}>{file.name}: {file.bytes} bytes{file.rows === undefined ? '' : `; ${file.rows} rows`}</li>)}</ul>
      <p className="detail">The manifest defines reversible spreadsheet-safe text encoding, canonical audit JSON and capped append-only history retrieval. Exact numeric PTS and rational bounds are authoritative; spreadsheet numeric display may lose precision. UTC recording time stays blank without a valid same-segment clock anchor.</p>
    </div>}
  </section>;
}
