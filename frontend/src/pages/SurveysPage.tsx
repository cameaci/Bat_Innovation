import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Camera, CircleCheck, CircleX, Film, MoonStar, Plus, RefreshCw } from 'lucide-react';
import type { Health, RecordingSession, SummaryDetail, SummaryRun } from '../../../electron/src/contracts';
import { getAPI } from '../api';
import { localDate } from '../lib/time';
import { PageBody, PageHeader } from '../components/layout/PageHeader';
import { Messages } from '../components/layout/Messages';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog } from '../components/ui/dialog';
import { Input, Label } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Progress } from '../components/ui/progress';

const unavailable = 'The local backend is unavailable. Retry, or close and reopen the app.';

export function SurveysPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [sessions, setSessions] = useState<RecordingSession[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  async function refresh() {
    setLoading(true); setError(''); setHealth(null);
    try {
      const api = getAPI();
      if (!api) { setError('The desktop bridge is unavailable. Open this window through the Bat Innovation app.'); return; }
      const ready = await api.health();
      if (!ready.ok) { setError(ready.error.code === 'unavailable' ? `Backend unavailable. ${ready.error.message}` : ready.error.message); return; }
      setHealth(ready.value);
      const listed = await api.listSessions();
      if (!listed.ok) { setError(listed.error.code === 'unavailable' ? `Backend unavailable. ${listed.error.message}` : listed.error.message); setHealth(null); return; }
      setSessions(listed.value);
    } catch { setError(unavailable); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  return <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
    <PageHeader title="Surveys" subtitle="Each survey holds the original videos of one camera and their reviewed motion windows."
      actions={<>
        <span role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {loading ? <><RefreshCw className="h-4 w-4 animate-spin" />Checking backend...</>
            : health ? <><CircleCheck className="h-4 w-4 text-emerald-600" /><span>Backend ready</span><span aria-hidden>·</span><span>SQLite storage ready.</span></>
            : <><CircleX className="h-4 w-4 text-red-600" />Backend not ready</>}
        </span>
        <Button variant="outline" onClick={() => void refresh()} disabled={loading}><RefreshCw />Refresh</Button>
        <Button onClick={() => setCreating(true)} disabled={!health}><Plus />New survey</Button>
      </>} />
    <PageBody>
      <Messages error={error} />
      {sessions?.length === 0 && <Card className="mx-auto max-w-xl text-center">
        <CardHeader className="items-center">
          <MoonStar className="h-10 w-10 text-primary" aria-hidden />
          <CardTitle>No surveys yet</CardTitle>
          <CardDescription>Create a survey for one camera, add its original videos, then review every motion window.</CardDescription>
        </CardHeader>
        <CardContent><Button onClick={() => setCreating(true)} disabled={!health}><Plus />New survey</Button></CardContent>
      </Card>}
      {sessions && sessions.length > 0 && <ul aria-label="Surveys" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {sessions.map(session => <li key={session.id}><SurveyCard session={session} /></li>)}
      </ul>}
    </PageBody>
    <CreateSurveyDialog open={creating} onClose={() => setCreating(false)} onCreated={session => setSessions(current => [session, ...(current ?? [])])} />
  </div>;
}

function SurveyCard({ session }: { session: RecordingSession }) {
  const [videos, setVideos] = useState<number | null>(null);
  const [run, setRun] = useState<SummaryRun | SummaryDetail | null>(null);
  useEffect(() => {
    let current = true;
    void (async () => {
      const api = getAPI();
      if (!api) return;
      const [media, runs] = await Promise.all([api.getMedia(session.id), api.listSummaryRuns(session.id)]).catch(() => [null, null]);
      if (!current) return;
      if (media?.ok) setVideos(media.value.segments.length);
      const latest = runs?.ok ? runs.value[0] : undefined;
      if (!latest) return;
      setRun(latest);
      const detail = await api.summaryRun(latest.id).catch(() => null);
      if (current && detail?.ok) setRun(detail.value);
    })();
    return () => { current = false; };
  }, [session.id]);
  const progress = run && 'review_progress' in run ? run.review_progress : undefined;
  return <Link to={`/surveys/${session.id}/process`} aria-label={`Open survey ${session.display_name}`} className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <Card className="h-full transition-shadow hover:shadow-md">
      <CardHeader>
        <CardTitle className="truncate">{session.display_name}</CardTitle>
        <CardDescription className="flex items-center gap-1.5"><Camera className="h-3.5 w-3.5" />{session.camera_ref} · created {localDate(session.created_at_utc)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary"><Film className="h-3 w-3" />{videos === null ? '...' : `${videos} video${videos === 1 ? '' : 's'}`}</Badge>
          {run && <Badge variant={run.state === 'complete' ? 'success' : run.state === 'running' || run.state === 'queued' ? 'info' : 'warning'}>{run.counts.planned} windows · {run.state}</Badge>}
        </div>
        {progress && progress.total > 0 && <div className="space-y-1">
          <div className="flex justify-between text-xs text-muted-foreground"><span>Reviewed</span><span>{progress.reviewed} / {progress.total}</span></div>
          <Progress value={100 * progress.reviewed / progress.total} label={`${session.display_name} review progress`} />
        </div>}
      </CardContent>
    </Card>
  </Link>;
}

function CreateSurveyDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (session: RecordingSession) => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [camera, setCamera] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const display_name = name.trim(), camera_ref = camera.trim();
    if (!display_name || !camera_ref) { setError('Enter a survey name and a camera, each up to 120 characters.'); return; }
    setSaving(true); setError('');
    try {
      const created = await getAPI()?.createSession({ display_name, camera_ref });
      if (!created?.ok) { setError(created?.error.message ?? unavailable); return; }
      onCreated(created.value); setName(''); setCamera(''); onClose();
      navigate(`/surveys/${created.value.id}/process`);
    } catch { setError(unavailable); }
    finally { setSaving(false); }
  }
  return <Dialog open={open} onClose={onClose} title="New survey" description="One survey per camera. Its name and camera are local labels only." className="w-[28rem]">
    <form onSubmit={event => void submit(event)} className="space-y-4 px-6 py-5">
      <div className="space-y-2"><Label htmlFor="survey-name">Survey name</Label><Input id="survey-name" value={name} maxLength={120} required autoFocus onChange={event => setName(event.target.value)} placeholder="e.g. Barn roost, visit 2" /></div>
      <div className="space-y-2"><Label htmlFor="survey-camera">Camera</Label><Input id="survey-camera" value={camera} maxLength={120} required onChange={event => setCamera(event.target.value)} placeholder="e.g. IR camera 3, north elevation" /></div>
      <Messages error={error} />
      <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={saving}>{saving ? 'Creating...' : 'Create survey'}</Button></div>
    </form>
  </Dialog>;
}
