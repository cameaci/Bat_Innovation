import { useCallback, useEffect, useState } from 'react';
import { Clapperboard, Download, Loader2, Square } from 'lucide-react';
import type { RenderJob } from '../../../../electron/src/contracts';
import { getAPI } from '../../api';
import { useSurvey } from '../../survey';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Label, Select } from '../ui/input';

const KIND = { overlay: 'Overlay video (every frame)', highlights: 'Highlights (spans with tracks only)' } as const;

/**
 * Review videos with the overlay burnt in: one video at a time, the whole video or only the spans with tracks. Each
 * skipped span is a card stating its length; the file is checked against its hash when saved.
 */
export function RenderCard() {
  const survey = useSurvey();
  const segments = survey.media?.segments ?? [];
  const [segmentID, setSegmentID] = useState('');
  const [kind, setKind] = useState<RenderJob['kind']>('highlights');
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const run = survey.tracking?.state === 'complete' ? survey.tracking : null;
  const ready = (survey.media?.schema_version ?? 0) >= 19;
  const active = jobs.some(job => job.state === 'queued' || job.state === 'running');
  const chosen = segmentID || segments[0]?.id || '';

  const load = useCallback(async () => {
    if (!ready) return;
    const result = await getAPI()?.listRenders(survey.session.id);
    if (result?.ok) setJobs(result.value);
  }, [ready, survey.session.id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [active, load]);

  async function act<T>(call: Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }> | undefined, done?: (value: T) => void) {
    setError(''); setSaved('');
    const result = await call;
    if (!result) return;
    if (!result.ok) { setError(result.error.message); return; }
    done?.(result.value);
    await load();
  }

  const name = (id: string) => { const index = segments.findIndex(item => item.id === id); return index < 0 ? 'removed video' : `${index + 1}. ${segments[index]!.metadata.filename}`; };
  if (!ready) return null;
  return <Card role="region" aria-label="Review videos">
    <CardHeader>
      <CardTitle className="flex items-center gap-2"><Clapperboard className="h-5 w-5" aria-hidden />Review videos</CardTitle>
      <CardDescription>A video with the tracks, gates, count board, clock and a PROVISIONAL watermark burnt in, made from the original frames. Highlights keep only the spans with tracks (plus a second either side); every skipped span becomes a card with its exact length, because no tracker output is not verified absence.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      {!run ? <p className="text-sm text-muted-foreground">Track the survey on the Watch page first.</p> : <>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1"><Label htmlFor="render-video" className="text-xs">Video</Label>
            <Select id="render-video" value={chosen} onChange={event => setSegmentID(event.target.value)}>
              {segments.map(item => <option key={item.id} value={item.id}>{name(item.id)}</option>)}</Select></div>
          <div className="space-y-1"><Label htmlFor="render-kind" className="text-xs">Kind</Label>
            <Select id="render-kind" value={kind} onChange={event => setKind(event.target.value as RenderJob['kind'])}>
              {(Object.keys(KIND) as RenderJob['kind'][]).map(item => <option key={item} value={item}>{KIND[item]}</option>)}</Select></div>
          <Button disabled={active || !chosen} onClick={() => void act(getAPI()?.startRender({ session_id: survey.session.id, segment_id: chosen, tracking_run_id: run.id, kind }))}>
            {active ? <Loader2 className="animate-spin" /> : <Clapperboard />}Render video</Button>
        </div>
        {jobs.length > 0 && <ul aria-label="Rendered videos" className="space-y-2 text-sm">{jobs.map(job => <li key={job.id} className="rounded-md border p-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{job.kind === 'overlay' ? 'Overlay' : 'Highlights'} - {name(job.segment_id)}</span>
            <span className="text-xs text-muted-foreground">{job.state === 'running' && job.progress ? `rendering ${Math.round(job.progress[0] / Math.max(1, job.progress[1]) * 100)}%` : job.state}</span>
            {(job.state === 'queued' || job.state === 'running') && <Button size="sm" variant="outline" onClick={() => void act(getAPI()?.cancelRender(job.id))}><Square />Cancel</Button>}
            {job.state === 'ready' && <Button size="sm" variant="outline" onClick={() => void act(getAPI()?.saveRender(job.id), value => { if (value) setSaved(`Saved ${value}`); })}><Download />Save video...</Button>}
          </div>
          {job.state === 'ready' && <p className="text-xs text-muted-foreground">{job.result.drawn_source_frames} of {job.result.source_frames} source frames drawn, {((job.result.duration_ms ?? 0) / 1000).toFixed(1)} s, {Math.round((job.result.bytes ?? 0) / 1024)} KB.
            {job.result.skipped?.length ? ` Skipped spans (cards): ${job.result.skipped.map(item => `${item.seconds.toFixed(3)} s`).join(', ')}.` : ''}</p>}
          {job.error && job.state !== 'ready' && <p className="text-xs text-red-700">{job.error.replaceAll('_', ' ')}</p>}
        </li>)}</ul>}
      </>}
      {saved && <p role="status" className="text-sm text-emerald-700">{saved}</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </CardContent>
  </Card>;
}
