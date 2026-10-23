import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, ChevronDown, FilePlus2, Film, Loader2, Play, RefreshCw, Square } from 'lucide-react';
import type { Continuity, MediaSegment, Modality, SaveMedia, SummaryWindow } from '../../../electron/src/contracts';
import { activeRun, CURRENT_SCHEMA, THERMAL_LABEL, useSurvey } from '../survey';
import { clock, localDate, rational, span } from '../lib/time';
import { PageBody, PageHeader } from '../components/layout/PageHeader';
import { Messages } from '../components/layout/Messages';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Input, Label, Select } from '../components/ui/input';
import { Progress } from '../components/ui/progress';
import { SummaryImage } from '../components/SummaryImage';
import { WindowDialog } from '../components/WindowDialog';
import { TracksCard } from '../components/process/TracksCard';

// Stated on every import; they belong with the source details, not among the warnings.
const ROUTINE_NOTES = new Set(['Original recording speed is unverified.', 'No original-clock anchor is inferred from media metadata.']);

const sourceBadge: Record<string, string> = { missing_source: 'Source missing', unreadable_source: 'Source unreadable', changed_source: 'Source changed' };
const sourceProblem: Record<string, string> = {
  missing_source: 'Original missing. Restore it to its original location and refresh.',
  unreadable_source: 'Original cannot be read. Check file permissions or the drive.',
  changed_source: 'Original changed since import. Restore the unchanged file.',
};

export function ProcessPage() {
  const survey = useSurvey();
  const [open, setOpen] = useState<string | null>(null);
  const ready = (survey.media?.schema_version ?? 0) >= CURRENT_SCHEMA;
  return <>
    <PageHeader title="Process" subtitle="Add the original videos, then generate a motion summary for every time window. Results appear as each window finishes." />
    <PageBody>
      <Messages error={survey.error} notice={survey.notice} />
      <div className="grid gap-6 xl:grid-cols-2">
        <VideosCard disabled={!ready} />
        <SummariesCard disabled={!ready} onOpen={setOpen} />
        <TracksCard disabled={!ready} />
      </div>
    </PageBody>
    {open && survey.run && <WindowDialog windows={survey.run.windows} initialID={open} onClose={() => setOpen(null)} />}
  </>;
}

function VideosCard({ disabled }: { disabled: boolean }) {
  const survey = useSurvey();
  const { media, importJob } = survey;
  const [segments, setSegments] = useState<MediaSegment[]>([]);
  const [anchor, setAnchor] = useState({ segment: '', utc: '', provenance: '' });
  const [dirty, setDirty] = useState(false);
  const [modality, setModality] = useState<Modality>('active_ir');
  const [error, setError] = useState('');
  const importing = importJob?.state === 'running';
  const locked = disabled || survey.busy;

  useEffect(() => {
    if (dirty || !media) return;
    setSegments(media.segments);
    setAnchor({ segment: media.clock_anchor?.segment_id ?? '', utc: media.clock_anchor?.utc ?? '', provenance: media.clock_anchor?.provenance ?? '' });
  }, [media, dirty]);
  useEffect(() => { survey.setDraft('timeline', dirty); return () => survey.setDraft('timeline', false); }, [dirty]);

  function move(index: number, offset: number) {
    const next = [...segments];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    // Reordering invalidates every stated neighbour relationship.
    setSegments(next.map(segment => ({ ...segment, continuity: 'unknown', continuity_provenance: null })));
    setDirty(true);
  }
  function continuity(id: string, status: Continuity, provenance?: string) {
    setSegments(current => current.map(segment => segment.id === id ? { ...segment, continuity: status, continuity_provenance: status === 'unknown' ? null : provenance ?? segment.continuity_provenance } : segment));
    setDirty(true);
  }
  async function save() {
    setError('');
    if (segments.some(segment => segment.continuity !== 'unknown' && !segment.continuity_provenance?.trim())) { setError('Give evidence for each known continuity relationship, or set it back to unknown.'); return; }
    let clock_anchor: SaveMedia['clock_anchor'] = null;
    if (anchor.segment || anchor.utc.trim() || anchor.provenance.trim()) {
      if (!anchor.segment || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(anchor.utc.trim()) || !Number.isFinite(Date.parse(anchor.utc.trim())) || !anchor.provenance.trim()) {
        setError('For a clock anchor, choose a video, enter its first-frame time in UTC (for example 2026-06-17T21:04:00Z) and say where that time comes from.'); return;
      }
      clock_anchor = { segment_id: anchor.segment, utc: anchor.utc.trim(), provenance: anchor.provenance.trim() };
    }
    const saved = await survey.saveTimeline({
      segment_ids: segments.map(segment => segment.id),
      continuity: segments.map(segment => ({ segment_id: segment.id, status: segment.continuity, provenance: segment.continuity === 'unknown' ? null : segment.continuity_provenance?.trim() ?? null })),
      clock_anchor,
    });
    if (saved) setDirty(false);
  }

  return <Card aria-labelledby="videos-heading">
    <CardHeader className="flex-row items-start justify-between space-y-0">
      <div className="space-y-1.5">
        <CardTitle id="videos-heading">Videos</CardTitle>
        <CardDescription>Original .MTS or .MP4 files, in recording order. They are read, never copied or changed.</CardDescription>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="outline" size="icon" aria-label="Refresh videos" title="Check the original files again" onClick={() => void survey.refreshMedia()} disabled={dirty}><RefreshCw /></Button>
        <Select aria-label="Video type" className="h-10 w-44" value={modality} disabled={locked || dirty} onChange={event => setModality(event.target.value as Modality)}>
          <option value="active_ir">Active IR</option><option value="rendered_thermal">Rendered thermal</option>
        </Select>
        <Button onClick={() => void survey.chooseVideos(modality)} disabled={locked || dirty}><FilePlus2 />Add videos</Button>
      </div>
    </CardHeader>
    <CardContent className="space-y-4">
      {importJob && importing && <div className="space-y-2 rounded-lg border bg-muted/40 p-3" role="status" aria-label="Import progress">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Checking {importJob.filename ?? 'videos'} ({importJob.files_done + 1} of {importJob.files_total}): {importJob.phase}</span>
          <Button size="sm" variant="outline" onClick={() => void survey.cancelImport()}>Cancel import</Button>
        </div>
        <Progress value={100 * importJob.files_done / Math.max(1, importJob.files_total)} label="Import progress" />
        <p className="text-xs text-muted-foreground">Each file is fully decoded once to record its exact frame timestamps. Long recordings take a while.</p>
      </div>}
      {segments.length === 0 ? <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
        <Film className="h-8 w-8" aria-hidden />No videos yet. Use Add videos to choose the original files.
      </div> : <ol aria-label="Videos" className="divide-y rounded-lg border">
        {segments.map((segment, index) => <li key={segment.id} className="space-y-2 p-3">
          <article aria-label={`Video ${index + 1}: ${segment.metadata.filename}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium" title={segment.metadata.filename}>{index + 1}. {segment.metadata.filename}</p>
                <p className="text-xs text-muted-foreground">{clock(segment.metadata.elapsed_end ?? segment.metadata.elapsed_last_time)} · {segment.metadata.width}×{segment.metadata.height} · {segment.metadata.codec} · {segment.metadata.frame_count} frames</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {segment.modality === 'rendered_thermal' && <Badge variant="info" title={THERMAL_LABEL}>Rendered thermal</Badge>}
                {segment.source_state === 'ready' ? <Badge variant="success">Ready</Badge> : <Badge variant="danger">{sourceBadge[segment.source_state]}</Badge>}
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Move ${segment.metadata.filename} up`} disabled={locked || index === 0} onClick={() => move(index, -1)}><ArrowUp /></Button>
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Move ${segment.metadata.filename} down`} disabled={locked || index === segments.length - 1} onClick={() => move(index, 1)}><ArrowDown /></Button>
              </div>
            </div>
            {segment.modality === 'rendered_thermal' && <p className="text-xs text-muted-foreground">{THERMAL_LABEL}.</p>}
            {segment.source_state !== 'ready' && <p role="alert" className="text-sm text-red-700">{sourceProblem[segment.source_state]}</p>}
            {segment.metadata.warnings.some(warning => !ROUTINE_NOTES.has(warning)) && <ul aria-label={`Warnings for ${segment.metadata.filename}`} className="space-y-0.5 text-xs text-amber-800">{segment.metadata.warnings.filter(warning => !ROUTINE_NOTES.has(warning)).map(warning => <li key={warning} className="flex gap-1"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{warning}</li>)}</ul>}
            {index > 0 && <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1"><Label htmlFor={`continuity-${segment.id}`} className="text-xs">Continuity with the previous video</Label>
                <Select id={`continuity-${segment.id}`} value={segment.continuity} disabled={locked} onChange={event => continuity(segment.id, event.target.value as Continuity)}>
                  <option value="unknown">Unknown</option><option value="known_contiguous">Continues without a gap</option><option value="known_gap">There is a gap</option>
                </Select></div>
              {segment.continuity !== 'unknown' && <div className="space-y-1"><Label htmlFor={`evidence-${segment.id}`} className="text-xs">Evidence for this</Label>
                <Input id={`evidence-${segment.id}`} value={segment.continuity_provenance ?? ''} maxLength={500} disabled={locked} onChange={event => continuity(segment.id, segment.continuity, event.target.value)} /></div>}
            </div>}
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">Source details</summary>
              <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">First / last frame PTS</dt><dd>{segment.metadata.first_pts} / {segment.metadata.last_pts} (timebase {rational(segment.metadata.time_base)})</dd>
                <dt className="text-muted-foreground">Exact end (s)</dt><dd>{rational(segment.metadata.elapsed_end)}</dd>
                <dt className="text-muted-foreground">Container</dt><dd>{segment.metadata.container}</dd>
                <dt className="text-muted-foreground">Rates (avg / base)</dt><dd>{rational(segment.metadata.average_rate)} / {rational(segment.metadata.base_rate)}</dd>
                <dt className="text-muted-foreground">Interlacing</dt><dd>{segment.metadata.interlaced ? 'Interlaced frames detected' : 'None detected'} · field order {segment.metadata.field_order ?? 'unknown'}</dd>
                <dt className="text-muted-foreground">SHA256</dt><dd className="break-all font-mono">{segment.metadata.sha256}</dd>
                <dt className="text-muted-foreground">Notes</dt><dd>{segment.metadata.warnings.filter(warning => ROUTINE_NOTES.has(warning)).join(' ') || 'none'}</dd>
              </dl>
            </details>
          </article>
        </li>)}
      </ol>}
      {segments.length > 0 && <details className="rounded-lg border p-3 text-sm">
        <summary className="flex cursor-pointer items-center gap-1 font-medium"><ChevronDown className="h-4 w-4" />Real-world clock (optional)</summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">Real survey time stays unknown unless you anchor one video's first frame to evidenced UTC time. File dates are never used.{survey.media?.clock_anchor ? ` Saved: ${survey.media.clock_anchor.utc}.` : ''}</p>
          <div className="space-y-1"><Label htmlFor="anchor-segment" className="text-xs">Anchored video</Label>
            <Select id="anchor-segment" value={anchor.segment} disabled={locked} onChange={event => { setAnchor(event.target.value ? { ...anchor, segment: event.target.value } : { segment: '', utc: '', provenance: '' }); setDirty(true); }}>
              <option value="">No clock anchor</option>{segments.map(segment => <option key={segment.id} value={segment.id}>{segment.metadata.filename}</option>)}
            </Select></div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1"><Label htmlFor="anchor-utc" className="text-xs">First frame time (UTC)</Label><Input id="anchor-utc" value={anchor.utc} placeholder="2026-06-17T21:04:00Z" disabled={locked || !anchor.segment} onChange={event => { setAnchor({ ...anchor, utc: event.target.value }); setDirty(true); }} /></div>
            <div className="space-y-1"><Label htmlFor="anchor-provenance" className="text-xs">Source of this time</Label><Input id="anchor-provenance" value={anchor.provenance} maxLength={500} disabled={locked || !anchor.segment} onChange={event => { setAnchor({ ...anchor, provenance: event.target.value }); setDirty(true); }} /></div>
          </div>
        </div>
      </details>}
      {(dirty || error) && <div className="flex flex-wrap items-center gap-2">
        {error && <p role="alert" className="w-full text-sm text-red-700">{error}</p>}
        <Button disabled={locked || !dirty} onClick={() => void save()}>Save timeline</Button>
        <Button variant="outline" disabled={!dirty} onClick={() => { setDirty(false); setError(''); }}>Discard changes</Button>
      </div>}
    </CardContent>
  </Card>;
}

function SummariesCard({ disabled, onOpen }: { disabled: boolean; onOpen: (id: string) => void }) {
  const survey = useSurvey();
  const { run, runs } = survey;
  const [windowSeconds, setWindowSeconds] = useState(30);
  const [starting, setStarting] = useState(false);
  const segments = survey.media?.segments ?? [];
  const running = activeRun(run);
  const done = run ? run.counts.complete + run.counts.failed + run.counts.incomplete : 0;
  const finished = run?.windows.filter(window => window.status !== 'planned' && window.status !== 'running') ?? [];
  // While processing, the newest results come first so they appear as they finish.
  const shown: SummaryWindow[] = (running ? [...finished].reverse() : run?.windows ?? []).slice(0, 12);
  const names = new Map(segments.map(segment => [segment.id, segment.metadata.filename]));

  return <Card aria-labelledby="summaries-heading">
    <CardHeader className="flex-row items-start justify-between space-y-0">
      <div className="space-y-1.5">
        <CardTitle id="summaries-heading">Motion summaries</CardTitle>
        <CardDescription>One image per time window shows where something moved. It is a guide for review, not a bat detection.</CardDescription>
      </div>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1"><Label htmlFor="window-length" className="text-xs">Window length</Label>
          <Select id="window-length" className="w-36" value={windowSeconds} disabled={disabled || survey.busy} onChange={event => setWindowSeconds(Number(event.target.value))}>
            {[15, 30, 60].map(value => <option key={value} value={value}>{value} seconds</option>)}
          </Select></div>
        <Button disabled={disabled || survey.busy || survey.dirty || starting || segments.length === 0} onClick={async () => { setStarting(true); await survey.startRun(windowSeconds); setStarting(false); }}>
          <Play />{starting ? 'Starting...' : 'Generate motion summaries'}</Button>
        {running && <Button variant="outline" disabled={survey.cancelling} onClick={() => void survey.cancelRun()}><Square />{survey.cancelling ? 'Cancelling...' : 'Cancel'}</Button>}
      </div>
      {segments.length === 0 && <p className="text-sm text-muted-foreground">Add videos first.</p>}
      {runs.length > 1 && <div className="space-y-1"><Label htmlFor="summary-run" className="text-xs">Processing run</Label>
        <Select id="summary-run" value={survey.runID} disabled={running || survey.dirty} onChange={event => survey.selectRun(event.target.value)}>
          {runs.map(item => <option key={item.id} value={item.id}>{localDate(item.started_at_utc)} · {item.state} · {item.counts.planned} windows</option>)}
        </Select></div>}
      {run && <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span role="status" className="flex items-center gap-2 font-medium">
            {running && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {running ? `Processing: ${done} of ${run.counts.planned} windows done` : `Run ${run.state}: ${run.counts.complete} of ${run.counts.planned} windows complete`}
          </span>
          <span className="flex flex-wrap gap-1">
            {run.counts.failed > 0 && <Badge variant="danger">{run.counts.failed} failed</Badge>}
            {run.counts.incomplete > 0 && <Badge variant="warning">{run.counts.incomplete} incomplete</Badge>}
            {survey.cancelling && <Badge variant="warning">Stopping</Badge>}
          </span>
        </div>
        <Progress value={100 * done / Math.max(1, run.counts.planned)} label="Summary progress" />
        {run.error && <p role="alert" className="text-sm text-red-700">{run.error.message}</p>}
        {run.windows.length !== run.counts.planned && <p role="alert" className="text-sm text-red-700">The window list does not match the planned count; this run cannot show complete coverage.</p>}
      </div>}
      {run && shown.length > 0 && <section aria-label={running ? 'Latest results' : 'Results'} className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">{running ? 'Latest results' : 'Results'}</h3>
          {!running && <Link to={`/surveys/${survey.session.id}/review`} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">Review all {run.windows.length} windows<ArrowRight className="h-4 w-4" /></Link>}
        </div>
        <ul className="grid grid-cols-2 gap-2 lg:grid-cols-3">
          {shown.map(window => <li key={window.id}>
            <button type="button" onClick={() => onOpen(window.id)} aria-label={`Open window ${span(window.interval.elapsed_start, window.interval.elapsed_end)} of ${names.get(window.segment_id) ?? 'video'}`}
              className="w-full space-y-1 rounded-lg border bg-white p-1.5 text-left transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <SummaryImage window={window} enabled={survey.verified} alt={`Motion summary ${span(window.interval.elapsed_start, window.interval.elapsed_end)}`} />
              <p className="truncate px-1 text-xs"><span className="font-medium">{span(window.interval.elapsed_start, window.interval.elapsed_end)}</span> <span className="text-muted-foreground">{names.get(window.segment_id)}</span></p>
            </button>
          </li>)}
        </ul>
        {running && <p className="text-xs text-muted-foreground">Open any finished window to look at it now. Review decisions and original-video previews unlock when processing finishes.</p>}
      </section>}
    </CardContent>
  </Card>;
}
