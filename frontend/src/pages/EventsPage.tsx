import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronLeft, ChevronRight, HelpCircle, X } from 'lucide-react';
import type { Candidate, TrackRecord } from '../../../electron/src/contracts';
import { getAPI } from '../api';
import { useSurvey } from '../survey';
import { clock, ptsAfter, ptsSeconds } from '../lib/time';
import { PageBody, PageHeader } from '../components/layout/PageHeader';
import { Messages } from '../components/layout/Messages';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card, CardContent } from '../components/ui/card';
import { Input, Label } from '../components/ui/input';
import { SourcePreview } from '../components/SourcePreview';
import type { SourcePreviewHandle } from '../components/SourcePreview';
import { SceneOverlay } from '../components/SceneOverlay';

const REVIEWER_KEY = 'bat:reviewer';
const savedReviewer = () => { try { return localStorage.getItem(REVIEWER_KEY) ?? ''; } catch { return ''; } };
const DECISION = { bat: 'Bat', not_bat: 'Not a bat', uncertain: 'Uncertain' } as const;

/** Block review of candidate tracks in recording order (feature expansion E5). Never changes window decisions. */
export function EventsPage() {
  const survey = useSurvey();
  const tracking = survey.tracking?.state === 'complete' ? survey.tracking : null;
  const [items, setItems] = useState<Candidate[]>([]);
  const [index, setIndex] = useState(0);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [track, setTrack] = useState<TrackRecord | null>(null);
  const [actor, setActor] = useState(savedReviewer);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [onlyOpen, setOnlyOpen] = useState(true);
  const player = useRef<SourcePreviewHandle>(null);
  const shown = onlyOpen ? items.filter(item => item.decision === null) : items;
  const current = shown[Math.min(index, Math.max(0, shown.length - 1))];
  const segment = survey.media?.segments.find(item => item.id === current?.segment_id);
  const decided = items.filter(item => item.decision !== null).length;

  useEffect(() => {
    if (!tracking) { setItems([]); return; }
    void getAPI()?.listCandidates(tracking.id).then(result => { if (result.ok) setItems(result.value); else setError(result.error.message); });
  }, [tracking?.id]);
  useEffect(() => {
    setReceipt(null); setTrack(null); setNote('');
    if (!tracking || !current) return;
    let live = true;
    void getAPI()?.getTracks(tracking.id, current.segment_id, current.first_pts, (BigInt(current.last_pts) + 1n).toString()).then(result => {
      if (live && result.ok) setTrack(result.value.find(item => item.id === current.track_id) ?? null);
    });
    return () => { live = false; };
  }, [tracking?.id, current?.track_id]);

  async function decide(decision: 'bat' | 'not_bat' | 'uncertain') {
    if (!tracking || !current) return;
    if (!actor.trim()) { setError('Enter your name or initials first.'); return; }
    if (!receipt) { setError('Wait for the original clip of this candidate before deciding.'); return; }
    const result = await getAPI()?.decideCandidate(tracking.id, current.track_id, { actor: actor.trim(), expected_revision: current.revision, decision, note, preview_id: receipt });
    if (!result?.ok) { setError(result?.error.message ?? 'The local backend is unavailable.'); return; }
    setError('');
    setItems(previous => previous.map(item => item.track_id === result.value.track_id ? result.value : item));
    if (!onlyOpen) setIndex(value => Math.min(value + 1, shown.length - 1));
  }
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target;
    if (event.ctrlKey || event.metaKey || event.altKey || (target instanceof Element && target.closest('input, textarea, select, video'))) return;
    const key = event.key.toLowerCase();
    if (key === 'n') void decide('not_bat');
    else if (key === 'b') void decide('bat');
    else if (event.key === ' ') player.current?.togglePlay();
    else if (event.key === ',') player.current?.step(-1);
    else if (event.key === '.') player.current?.step(1);
    else if (key === 'l') player.current?.toggleLoop();
    else if (/^[1-5]$/.test(event.key)) player.current?.setSpeed(Number(event.key) - 1);
    else if (event.key === 'ArrowRight') setIndex(value => Math.min(value + 1, shown.length - 1));
    else if (event.key === 'ArrowLeft') setIndex(value => Math.max(0, value - 1));
    else return;
    event.preventDefault();
  }

  const start = current && segment ? (() => {
    const before = ptsAfter(current.first_pts, -1000, segment.metadata.time_base);
    return BigInt(before) < BigInt(segment.metadata.first_pts) ? segment.metadata.first_pts : before;
  })() : null;
  return <>
    <PageHeader title="Events" subtitle="Review each candidate track in a short clip of the original. These decisions never mark a window as reviewed; every window still needs its own decision." />
    <PageBody>
      <Messages error={error || survey.error} notice={survey.notice} />
      {!tracking ? <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Find tracks on the <Link className="text-primary hover:underline" to={`/surveys/${survey.session.id}/process`}>Process page</Link> first.</CardContent></Card>
        : <div className="space-y-4" onKeyDown={keys} tabIndex={-1}>
          <Card><CardContent className="flex flex-wrap items-end gap-4 pt-6">
            <p role="status" className="text-sm font-medium">{decided} of {items.length} candidates decided</p>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyOpen} onChange={event => { setOnlyOpen(event.target.checked); setIndex(0); }} />Only undecided</label>
            <div className="space-y-1"><Label htmlFor="event-actor" className="text-xs">Reviewer</Label>
              <Input id="event-actor" className="w-56" value={actor} maxLength={120} onChange={event => { setActor(event.target.value); try { localStorage.setItem(REVIEWER_KEY, event.target.value.trim()); } catch { /* convenience */ } }} /></div>
          </CardContent></Card>
          {!current || !segment || start === null ? <p className="text-sm text-muted-foreground">{items.length === 0 ? 'This tracking run found no candidates. Windows still need review on the Review page.' : 'All candidates are decided.'}</p>
            : <div className="grid gap-4 xl:grid-cols-[1fr,22rem]">
              <div className="rounded-lg bg-slate-950 p-3">
                <SourcePreview ref={player} key={current.track_id} segment={segment} initialPTS={start} minPTS={segment.metadata.first_pts} maxPTS={null} initialSeconds={6}
                  enabled={!survey.busy} disabledReason="Wait for processing to finish." onReady={setReceipt}
                  overlay={pts => <SceneOverlay tracks={track ? [track] : []} gates={survey.gates} drawing={null} displayedPTS={pts} width={segment.metadata.width} height={segment.metadata.height} timeBase={segment.metadata.time_base} />} />
              </div>
              <Card aria-label="Candidate decision" role="region"><CardContent className="space-y-3 pt-6 text-sm">
                <p className="font-semibold">Candidate {shown.indexOf(current) + 1} of {shown.length}: track T{current.track_index + 1}</p>
                <p className="text-xs text-muted-foreground">{segment.metadata.filename} · {clock(ptsSeconds(current.first_pts, segment.metadata.first_pts, segment.metadata.time_base))} to {clock(ptsSeconds(current.last_pts, segment.metadata.first_pts, segment.metadata.time_base))} into the video · {current.point_count} points</p>
                {current.decision && <Badge variant="info">{DECISION[current.decision.decision]} by {current.decision.actor}</Badge>}
                <div className="space-y-1"><Label htmlFor="event-note" className="text-xs">Note (optional)</Label><Input id="event-note" value={note} maxLength={2000} onChange={event => setNote(event.target.value)} /></div>
                <div className="grid gap-2">
                  <Button disabled={!receipt} onClick={() => void decide('not_bat')}><X />Not a bat + next<kbd className="ml-auto rounded border border-white/40 px-1 text-[10px]">N</kbd></Button>
                  <Button variant="outline" disabled={!receipt} onClick={() => void decide('bat')}><Check />Bat<kbd className="ml-auto rounded border px-1 text-[10px]">B</kbd></Button>
                  <Button variant="outline" disabled={!receipt} onClick={() => void decide('uncertain')}><HelpCircle />Uncertain</Button>
                </div>
                <div className="flex justify-between">
                  <Button size="sm" variant="ghost" disabled={shown.indexOf(current) <= 0} onClick={() => setIndex(value => Math.max(0, value - 1))}><ChevronLeft />Previous</Button>
                  <Button size="sm" variant="ghost" disabled={shown.indexOf(current) >= shown.length - 1} onClick={() => setIndex(value => value + 1)}>Next<ChevronRight /></Button>
                </div>
                <p className="text-[11px] text-muted-foreground">Keys: N not a bat + next, B bat, Space play/pause, comma/full stop frame step, L loop, 1-5 speed, Left/Right previous/next.</p>
              </CardContent></Card>
            </div>}
        </div>}
    </PageBody>
  </>;
}
