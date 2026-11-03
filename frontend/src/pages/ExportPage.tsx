import { useEffect, useRef, useState } from 'react';
import { FileSpreadsheet, FolderDown, Loader2, Square } from 'lucide-react';
import type { ExportJob } from '../../../electron/src/contracts';
import { getAPI } from '../api';
import { activeRun, useSurvey } from '../survey';
import { localDate } from '../lib/time';
import { PageBody, PageHeader } from '../components/layout/PageHeader';
import { Messages } from '../components/layout/Messages';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Checkbox, Label, Select } from '../components/ui/input';
import { RenderCard } from '../components/export/RenderCard';
import { ReportCard } from '../components/export/ReportCard';

const unavailable = 'The local backend is unavailable. No bundle was saved.';

export function ExportPage() {
  const survey = useSurvey();
  const { run, runID } = survey;
  const [job, setJob] = useState<ExportJob | null>(null);
  const [action, setAction] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const working = job?.state === 'working';
  const jobRef = useRef(job); jobRef.current = job;
  const blocked = !run || activeRun(run) || survey.dirty;

  useEffect(() => { survey.setExportBusy(working || action); return () => survey.setExportBusy(false); }, [working, action]);
  useEffect(() => () => { const current = jobRef.current; if (current?.state === 'working') void getAPI()?.cancelExport(current.id); }, []);
  useEffect(() => { setJob(null); setSaved(''); setError(''); }, [runID]);
  useEffect(() => {
    if (job?.state !== 'working') return;
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
    if (blocked || working || action || !confirmed) return;
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
    if (!job || survey.dirty || working || action) return;
    setAction(true); setSaved(''); setError('');
    try {
      const result = await getAPI()?.saveExportBundle(job.id);
      if (!result?.ok) setError(result?.error.message ?? unavailable);
      else setSaved(result.value.cancelled ? 'Save cancelled. Choose a folder when ready.' : `Saved in a new folder named ${result.value.folder_name}.`);
    } catch { setError(unavailable); } finally { setAction(false); }
  }
  const manifest = job?.state === 'ready' ? job.manifest : null;

  return <>
    <PageHeader title="Export" subtitle="Save the review results of one processing run as spreadsheet files." />
    <PageBody>
      <Messages error={error} notice={saved} />
      <Card role="region" aria-label="Provisional CSV export">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FileSpreadsheet className="h-5 w-5" aria-hidden />Provisional CSV bundle</CardTitle>
          <CardDescription>Four CSV files and a manifest: your observations, an audit row for every planned window (reviewed or not), and the tracks and gate counts of the latest finished tracking run (algorithm, reviewer and QA layers kept apart). <strong>PROVISIONAL: not an ecologically finalised report.</strong> Reviewer names are local labels, not verified identities.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!run ? <p className="text-sm text-muted-foreground">Generate motion summaries first.</p> : <>
            {survey.runs.length > 1 && <div className="max-w-md space-y-1"><Label htmlFor="export-run" className="text-xs">Processing run</Label>
              <Select id="export-run" value={runID} disabled={working || action || survey.dirty} onChange={event => survey.selectRun(event.target.value)}>
                {survey.runs.map(item => <option key={item.id} value={item.id}>{localDate(item.started_at_utc)} · {item.state} · {item.counts.planned} windows</option>)}
              </Select></div>}
            {run.review_progress && <p className="text-sm">{run.review_progress.reviewed} of {run.review_progress.total} windows reviewed in this run.{run.review_progress.unreviewed > 0 ? ' Unreviewed windows are exported as unreviewed.' : ''}</p>}
            {activeRun(run) && <p role="status" className="text-sm text-muted-foreground">Wait for processing to finish before exporting.</p>}
            {survey.dirty && <p role="status" className="text-sm text-amber-800">Save or discard open review changes before exporting.</p>}
            <label className="flex items-start gap-2 text-sm"><Checkbox className="mt-0.5" checked={confirmed} disabled={working || action} onChange={event => setConfirmed(event.target.checked)} />I understand these CSVs are provisional and not final ecological reports.</label>
            <div className="flex flex-wrap gap-2">
              <Button disabled={blocked || working || action || !confirmed} onClick={() => void start()}>{working ? <Loader2 className="animate-spin" /> : <FileSpreadsheet />}Export provisional CSVs</Button>
              {working && <Button variant="outline" disabled={action} onClick={() => void cancel()}><Square />Cancel export</Button>}
              {manifest && <Button variant="outline" disabled={survey.dirty || action} onClick={() => void save()}><FolderDown />Save provisional CSV bundle...</Button>}
            </div>
            {working && <p role="status" className="text-sm text-muted-foreground">Creating a read-only snapshot of this run...</p>}
            {manifest && <div className="space-y-1 rounded-lg border bg-muted/40 p-3 text-sm">
              <p className="text-xs text-muted-foreground">{manifest.tracking ? `Tracks and counts from tracking run ${manifest.tracking.tracking_run_id.slice(0, 8)} (${manifest.tracking.tracks} tracks, ${manifest.tracking.gates} gates).` : 'No finished tracking run: the tracks and counts files contain headers only.'}</p>
              <p role="status">Ready: {manifest.counts.planned} planned windows, {manifest.counts.reviewed} reviewed, {manifest.counts.qa.pending} QA pending{manifest.counts.missing ? `, ${manifest.counts.missing} missing records` : ''}.</p>
              <p className="text-xs text-muted-foreground">Coverage: manifest {manifest.manifest_complete ? 'complete' : 'INCOMPLETE'}, processing {manifest.processing_complete ? 'complete' : 'INCOMPLETE'}. Snapshot of {localDate(manifest.as_of_utc)}.</p>
              <ul className="text-xs text-muted-foreground">{Object.values(manifest.files).map(file => <li key={file.name}>{file.name}: {file.bytes} bytes{file.rows === undefined ? '' : `, ${file.rows} rows`}</li>)}</ul>
            </div>}
          </>}
        </CardContent>
      </Card>
      <ReportCard />
      <RenderCard />
    </PageBody>
  </>;
}
