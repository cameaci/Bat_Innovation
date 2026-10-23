import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Eye, RefreshCw, X } from 'lucide-react';
import type { Crossing, Gate, GateCounts, GateDirection } from '../../../electron/src/contracts';
import { getAPI } from '../api';
import { useSurvey } from '../survey';
import { clock, ptsSeconds } from '../lib/time';
import { PageBody, PageHeader } from '../components/layout/PageHeader';
import { Messages } from '../components/layout/Messages';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Checkbox, Input, Label, Select, Textarea } from '../components/ui/input';
import { WindowDialog } from '../components/WindowDialog';

const REVIEWER_KEY = 'bat:reviewer';
const savedReviewer = () => { try { return localStorage.getItem(REVIEWER_KEY) ?? ''; } catch { return ''; } };

export function directionText(gate: Gate, direction: GateDirection): string {
  const label = direction === 'A_to_B' ? `${gate.label_a} to ${gate.label_b}` : direction === 'B_to_A' ? `${gate.label_b} to ${gate.label_a}`
    : direction === 'out_to_in' ? 'outside to inside' : 'inside to outside';
  return `${label} (${direction === gate.entry_direction ? 'entering' : 'exiting'})`;
}

/** Three separate count layers per gate: algorithm, reviewer-adjusted and QA-approved (feature expansion E3). */
export function CountsPage() {
  const survey = useSurvey();
  const gates = survey.gates.filter(gate => gate.state === 'active');
  const [gateID, setGateID] = useState('');
  const [counts, setCounts] = useState<GateCounts | null>(null);
  const [error, setError] = useState('');
  const [actor, setActor] = useState(savedReviewer);
  const [open, setOpen] = useState<string | null>(null);
  const tracking = survey.tracking?.state === 'complete' ? survey.tracking : null;
  const gate = gates.find(item => item.id === gateID) ?? gates[0];

  async function load() {
    setError('');
    if (!tracking || !gate) { setCounts(null); return; }
    const result = await getAPI()?.getCounts(tracking.id, gate.id);
    if (result?.ok) setCounts(result.value); else setError(result?.error.message ?? 'The local backend is unavailable.');
  }
  useEffect(() => { void load(); }, [tracking?.id, gate?.id, gate?.revision]);

  async function review(crossing: Crossing | null, action: 'confirm' | 'reject' | 'clear' | 'add_missed', extra: Partial<{ flipped: boolean; count: number; rationale: string; direction: GateDirection; segment_id: string; pts: string }> = {}) {
    if (!tracking || !gate || !counts) return;
    if (!actor.trim()) { setError('Enter your name or initials first.'); return; }
    const result = await getAPI()?.saveCountReview(tracking.id, gate.id, { actor: actor.trim(), expected_revision: counts.revision, action,
      key: crossing?.key ?? null, flipped: extra.flipped ?? false, count: extra.count ?? 1, direction: extra.direction ?? null,
      segment_id: extra.segment_id ?? null, pts: extra.pts ?? null, rationale: extra.rationale ?? '' });
    if (result?.ok) { setCounts(result.value); setError(''); } else setError(result?.error.message ?? 'The local backend is unavailable.');
  }

  const windows = new Map((survey.run?.windows ?? []).map(window => [window.id, window]));
  const names = new Map((survey.media?.segments ?? []).map(segment => [segment.id, segment.metadata.filename]));
  const at = (crossing: { window_id?: string | null; pts?: string | null; segment_id?: string | null }) => {
    const window = crossing.window_id ? windows.get(crossing.window_id) : undefined;
    if (!window || !crossing.pts) return `source PTS ${crossing.pts}`;
    return `${clock(ptsSeconds(crossing.pts, (BigInt(window.interval.start_pts.num) / BigInt(window.interval.start_pts.den)).toString(), window.time_base))} into window ${window.index + 1}`;
  };

  return <>
    <PageHeader title="Counts" subtitle="Directional crossings of each counting gate. The algorithm, reviewer and QA counts are kept separate; only people decide what was a bat."
      actions={<Button variant="outline" onClick={() => void load()}><RefreshCw />Refresh</Button>} />
    <PageBody>
      <Messages error={error || survey.error} notice={survey.notice} />
      {!tracking ? <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Find tracks on the <Link className="text-primary hover:underline" to={`/surveys/${survey.session.id}/process`}>Process page</Link> first.</CardContent></Card>
        : gates.length === 0 ? <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Draw a counting gate over the original video in any window on the <Link className="text-primary hover:underline" to={`/surveys/${survey.session.id}/review`}>Review page</Link>.</CardContent></Card>
        : <>
          <Card><CardContent className="flex flex-wrap items-end gap-4 pt-6">
            <div className="space-y-1"><Label htmlFor="count-gate" className="text-xs">Gate</Label>
              <Select id="count-gate" className="w-64" value={gate?.id} onChange={event => setGateID(event.target.value)}>
                {gates.map(item => <option key={item.id} value={item.id}>{item.name} (revision {item.revision})</option>)}
              </Select></div>
            <div className="space-y-1"><Label htmlFor="count-actor" className="text-xs">Reviewer</Label>
              <Input id="count-actor" className="w-56" value={actor} maxLength={120} placeholder="Your name or initials" onChange={event => { setActor(event.target.value); try { localStorage.setItem(REVIEWER_KEY, event.target.value.trim()); } catch { /* convenience */ } }} /></div>
          </CardContent></Card>
          {counts && gate && <>
            <div className="grid gap-4 md:grid-cols-3">
              <Layer title="Algorithm (unverified)" totals={counts.layers.algorithm} note={`${counts.crossings.length} crossings detected; ${counts.layers.algorithm.excluded_scene_changed} excluded after a frame-wide scene change.`} />
              <Layer title="Reviewer-adjusted" totals={counts.layers.reviewer} note={`${counts.layers.reviewer.reviewed} of ${counts.layers.reviewer.crossings} crossings reviewed; ${counts.layers.reviewer.added} added by hand. Unreviewed crossings are not counted here.`} />
              <QALayer counts={counts} runID={tracking.id} onSaved={setCounts} onError={setError} />
            </div>
            {counts.skipped_segments.length > 0 && <p role="alert" className="text-sm text-amber-800">{counts.skipped_segments.length} video(s) have a different frame size from this gate and were not evaluated.</p>}
            <Card aria-label="Crossings">
              <CardHeader><CardTitle>Crossings</CardTitle><CardDescription>Open each crossing, watch the original and confirm, correct or reject it. A count above 1 or a flipped direction needs a reason.</CardDescription></CardHeader>
              <CardContent>
                {counts.crossings.length === 0 ? <p className="text-sm text-muted-foreground">No track crosses this gate. This does not mean no bats crossed: check the windows.</p>
                  : <ol aria-label="Gate crossings" className="divide-y rounded-lg border">{counts.crossings.map(crossing => <CrossingRow key={crossing.key} gate={gate} crossing={crossing}
                    where={`${names.get(crossing.segment_id) ?? 'video'} · ${at(crossing)}`} onOpen={() => crossing.window_id && setOpen(crossing.window_id)} onReview={review} />)}</ol>}
                <MissedForm gate={gate} segments={survey.media?.segments.map(segment => ({ id: segment.id, name: segment.metadata.filename })) ?? []}
                  onAdd={(direction, segment, pts, count, rationale) => void review(null, 'add_missed', { direction, segment_id: segment, pts, count, rationale })} />
                {counts.missed.length > 0 && <ul aria-label="Added crossings" className="mt-2 space-y-1 text-sm">{counts.missed.map(item => <li key={item.key}>Added by {item.actor}: {directionText(gate, item.direction!)} · count {item.count} · {item.rationale}</li>)}</ul>}
              </CardContent>
            </Card>
          </>}
        </>}
    </PageBody>
    {open && survey.run && <WindowDialog windows={survey.run.windows} initialID={open} onClose={() => setOpen(null)} />}
  </>;
}

function Layer({ title, totals, note }: { title: string; totals: { entered: number; exited: number; net: number }; note: string }) {
  return <Card role="region" aria-label={title}><CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
    <CardContent className="space-y-2">
      <p className="text-2xl font-semibold" role="status">Entered {totals.entered} · Exited {totals.exited} · Net {totals.net}</p>
      <p className="text-xs text-muted-foreground">{note}</p>
    </CardContent></Card>;
}

function QALayer({ counts, runID, onSaved, onError }: { counts: GateCounts; runID: string; onSaved: (value: GateCounts) => void; onError: (message: string) => void }) {
  const [actor, setActor] = useState('');
  const [note, setNote] = useState('');
  const qa = counts.layers.qa;
  async function save(decision: 'approve' | 'reject') {
    const result = await getAPI()?.saveCountQA(runID, counts.gate.id, { actor: actor.trim(), expected_revision: counts.revision, review_revision: counts.review_revision, decision, note });
    if (result?.ok) { onSaved(result.value); onError(''); setNote(''); } else onError(result?.error.message ?? 'The local backend is unavailable.');
  }
  return <Card role="region" aria-label="QA-approved"><CardHeader><CardTitle className="text-base">QA-approved</CardTitle></CardHeader>
    <CardContent className="space-y-2 text-sm">
      {qa?.counts ? <p className="text-2xl font-semibold" role="status">Entered {qa.counts.entered} · Exited {qa.counts.exited} · Net {qa.counts.net}</p>
        : <p role="status" className="text-muted-foreground">{qa ? (qa.stale ? `Out of date: the reviewed counts or gate changed after ${qa.actor}'s ${qa.decision}.` : `Rejected by ${qa.actor}: ${qa.note}`) : 'Not yet checked by a second person.'}</p>}
      {qa?.counts && <p className="text-xs text-muted-foreground">Approved by {qa.actor}.</p>}
      <div className="space-y-1"><Label htmlFor="count-qa-actor" className="text-xs">QA reviewer</Label><Input id="count-qa-actor" className="h-8" maxLength={120} value={actor} onChange={event => setActor(event.target.value)} /></div>
      <div className="space-y-1"><Label htmlFor="count-qa-note" className="text-xs">QA note</Label><Textarea id="count-qa-note" className="min-h-[48px]" maxLength={2000} value={note} onChange={event => setNote(event.target.value)} /></div>
      <div className="flex gap-2"><Button size="sm" disabled={!actor.trim()} onClick={() => void save('approve')}>Approve reviewed counts</Button>
        <Button size="sm" variant="outline" disabled={!actor.trim() || !note.trim()} onClick={() => void save('reject')}>Reject</Button></div>
    </CardContent></Card>;
}

function CrossingRow({ gate, crossing, where, onOpen, onReview }: {
  gate: Gate; crossing: Crossing; where: string; onOpen: () => void;
  onReview: (crossing: Crossing, action: 'confirm' | 'reject' | 'clear', extra?: { flipped?: boolean; count?: number; rationale?: string }) => Promise<void>;
}) {
  const [flipped, setFlipped] = useState(crossing.review?.flipped ?? false);
  const [count, setCount] = useState(String(crossing.review?.count ?? 1));
  const [rationale, setRationale] = useState('');
  const review = crossing.review;
  const status = !review ? 'Not reviewed' : review.action === 'reject' ? 'Rejected' : `Confirmed${review.flipped ? ', direction flipped' : ''} · count ${review.count}`;
  return <li className="space-y-2 p-3 text-sm" aria-label={`Crossing ${directionText(gate, crossing.direction)} at ${where}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><p className="font-medium">{directionText(gate, crossing.direction)}</p><p className="text-xs text-muted-foreground">{where}</p></div>
      <div className="flex flex-wrap items-center gap-1">
        {crossing.scene_changed && <Badge variant="warning" title="A frame-wide change happened at or before this crossing: the camera may have moved since the gate was drawn.">Scene changed: not counted by the algorithm</Badge>}
        <Badge variant={!review ? 'outline' : review.action === 'reject' ? 'danger' : 'success'}>{status}</Badge>
        <Button size="sm" variant="outline" className="h-8" disabled={!crossing.window_id} onClick={onOpen}><Eye />Open</Button>
      </div>
    </div>
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex items-center gap-1 text-xs"><Checkbox checked={flipped} onChange={event => setFlipped(event.target.checked)} />Opposite direction</label>
      <div className="space-y-1"><Label className="text-xs" htmlFor={`count-${crossing.key}`}>Count</Label><Input id={`count-${crossing.key}`} className="h-8 w-20" inputMode="numeric" value={count} onChange={event => setCount(event.target.value)} /></div>
      <div className="min-w-[12rem] flex-1 space-y-1"><Label className="text-xs" htmlFor={`reason-${crossing.key}`}>Reason</Label><Input id={`reason-${crossing.key}`} className="h-8" maxLength={2000} value={rationale} onChange={event => setRationale(event.target.value)} /></div>
      <Button size="sm" className="h-8" disabled={!/^\d+$/.test(count)} onClick={() => void onReview(crossing, 'confirm', { flipped, count: Number(count), rationale })}><Check />Confirm</Button>
      <Button size="sm" variant="outline" className="h-8" disabled={!rationale.trim()} onClick={() => void onReview(crossing, 'reject', { rationale })}><X />Reject</Button>
      {review && <Button size="sm" variant="ghost" className="h-8" onClick={() => void onReview(crossing, 'clear')}>Clear review</Button>}
    </div>
  </li>;
}

function MissedForm({ gate, segments, onAdd }: { gate: Gate; segments: { id: string; name: string }[]; onAdd: (direction: GateDirection, segment: string, pts: string, count: number, rationale: string) => void }) {
  const directions: GateDirection[] = gate.kind === 'line' ? ['A_to_B', 'B_to_A'] : ['out_to_in', 'in_to_out'];
  const [direction, setDirection] = useState<GateDirection>(gate.entry_direction);
  const [segment, setSegment] = useState(segments[0]?.id ?? '');
  const [pts, setPTS] = useState('');
  const [count, setCount] = useState('1');
  const [rationale, setRationale] = useState('');
  return <details className="mt-3 rounded-lg border p-3 text-sm"><summary className="cursor-pointer font-medium">Add a crossing the tracks missed</summary>
    <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
      <div className="space-y-1"><Label htmlFor="missed-direction" className="text-xs">Direction</Label><Select id="missed-direction" value={direction} onChange={event => setDirection(event.target.value as GateDirection)}>{directions.map(item => <option key={item} value={item}>{directionText(gate, item)}</option>)}</Select></div>
      <div className="space-y-1"><Label htmlFor="missed-video" className="text-xs">Video</Label><Select id="missed-video" value={segment} onChange={event => setSegment(event.target.value)}>{segments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></div>
      <div className="space-y-1"><Label htmlFor="missed-pts" className="text-xs">Source PTS (from the window's technical details)</Label><Input id="missed-pts" inputMode="numeric" value={pts} onChange={event => setPTS(event.target.value)} /></div>
      <div className="space-y-1"><Label htmlFor="missed-count" className="text-xs">Count</Label><Input id="missed-count" inputMode="numeric" value={count} onChange={event => setCount(event.target.value)} /></div>
      <div className="space-y-1"><Label htmlFor="missed-reason" className="text-xs">Reason</Label><Input id="missed-reason" maxLength={2000} value={rationale} onChange={event => setRationale(event.target.value)} /></div>
    </div>
    <Button size="sm" className="mt-2" disabled={!segment || !/^-?\d+$/.test(pts) || !/^\d+$/.test(count) || !rationale.trim()} onClick={() => onAdd(direction, segment, pts, Number(count), rationale)}>Add crossing</Button>
  </details>;
}
