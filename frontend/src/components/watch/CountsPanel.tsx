import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Crosshair, PenLine, RefreshCw } from 'lucide-react';
import type { ApiResult, Crossing, GateCounts, InvalidSpan, MediaSegment } from '../../../../electron/src/contracts';
import { getAPI } from '../../api';
import { useSurvey } from '../../survey';
import { clock } from '../../lib/time';
import { cn } from '../../lib/utils';
import { saveReviewer } from '../../lib/reviewer';
import { GatePanel, type GateDraft } from '../GatePanel';
import { rectangle } from '../SceneOverlay';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { IN_COLOUR, OUT_COLOUR } from './CountLayer';

export type Decision = 'bat' | 'not_bat' | 'opposite';

/**
 * Counts per gate beside the video: the live tally, what still needs a person (uncertain crossings and paused
 * spans after a camera move) and the one-action acceptance of the proposal, then an independent QA decision.
 */
export function CountsPanel({ counts, setCounts, gateID, setGateID, actor, setActor, segment, segments, live, gateDraft, setGateDraft, redraw, setRedraw, onGo }: {
  counts: GateCounts | null;
  setCounts: (counts: GateCounts) => void;
  gateID: string | null;
  setGateID: (id: string) => void;
  actor: string;
  setActor: (actor: string) => void;
  segment: MediaSegment;
  segments: MediaSegment[];
  live: { entered: number; exited: number; net: number; pending: number } | null;
  gateDraft: GateDraft | null;
  setGateDraft: (draft: GateDraft | null) => void;
  redraw: InvalidSpan | null;
  setRedraw: (span: InvalidSpan | null) => void;
  onGo: (segmentID: string, pts: string) => void;
}) {
  const survey = useSurvey();
  const [error, setError] = useState('');
  const [qaNote, setQANote] = useState('');
  const active = survey.gates.filter(gate => gate.state === 'active');
  const runID = survey.tracking?.state === 'complete' ? survey.tracking.id : null;
  const name = (id: string) => { const index = segments.findIndex(item => item.id === id); return index < 0 ? 'unknown video' : `video ${index + 1}`; };
  const seconds = (id: string, pts: string | null) => {
    const item = segments.find(value => value.id === id);
    if (!item || pts === null) return 'start';
    return clock(Number(BigInt(pts) - BigInt(item.metadata.first_pts)) * Number(item.metadata.time_base.num) / Number(item.metadata.time_base.den));
  };

  async function act(call: (api: NonNullable<ReturnType<typeof getAPI>>) => Promise<ApiResult<GateCounts>>) {
    setError('');
    if (!actor.trim()) { setError('Enter your name or initials first.'); return; }
    const api = getAPI();
    if (!api) return;
    const result = await call(api);
    if (result.ok) setCounts(result.value); else setError(result.error.message);
  }

  const decide = (crossing: Crossing, decision: Decision) => counts && runID && act(api => api.saveCountReview(runID, counts.gate.id, {
    actor: actor.trim(), expected_revision: counts.revision, action: decision === 'not_bat' ? 'reject' : 'confirm', key: crossing.key,
    flipped: decision === 'opposite', count: 1, direction: null, segment_id: null, pts: null, rationale: '',
  }));
  const accept = () => counts && runID && act(api => api.saveCountReview(runID, counts.gate.id, {
    actor: actor.trim(), expected_revision: counts.revision, action: 'accept', key: null, flipped: false, count: 1,
    direction: null, segment_id: null, pts: null, rationale: '',
  }));
  const reconfirm = (span: InvalidSpan, points: [number, number][] | null) => counts && runID && act(api => api.reconfirmGate(runID, counts.gate.id, {
    actor: actor.trim(), anchor_kind: span.anchor_kind, anchor_id: span.anchor_id, points, note: points ? 'Gate redrawn on the moved scene' : 'Gate still on the same place',
  }));
  const qa = (decision: 'approve' | 'reject') => counts && runID && act(api => api.saveCountQA(runID, counts.gate.id, {
    actor: actor.trim(), expected_revision: counts.revision, review_revision: counts.review_revision, decision, note: qaNote,
  }));

  const uncertain = counts?.crossings.filter(item => item.quality === 'uncertain') ?? [];
  const reviewer = counts?.layers.reviewer;
  return <section aria-label="Counts" className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4 text-slate-100">
    <div className="space-y-1">
      <label htmlFor="watch-actor" className="text-xs font-medium">Your name or initials</label>
      <Input id="watch-actor" className="h-8 border-slate-700 bg-slate-800 text-slate-100" maxLength={120} value={actor}
        onChange={event => { setActor(event.target.value); saveReviewer(event.target.value); }} />
    </div>
    {active.length === 0 || (gateDraft && !redraw)
      ? <GatePanel segment={segment} actor={actor} draft={gateDraft} setDraft={setGateDraft} />
      : <div className="flex flex-wrap items-center gap-2">
        {active.length > 1 && <select aria-label="Gate" className="rounded bg-slate-800 px-2 py-1 text-sm" value={gateID ?? ''} onChange={event => setGateID(event.target.value)}>
          {active.map(gate => <option key={gate.id} value={gate.id}>{gate.name}</option>)}</select>}
        {active.length === 1 && <p className="text-sm font-semibold">{active[0]!.name}</p>}
        <Button size="sm" variant="ghost" className="ml-auto h-7 text-slate-300" onClick={() => setGateDraft({ kind: 'line', points: [] })}><PenLine />New gate</Button>
      </div>}
    {!runID && <p className="text-xs text-slate-400">Track the survey first (Setup tab); counts use the latest complete tracking run.</p>}
    {counts && live && <div role="group" aria-label="Count so far" className="grid grid-cols-3 gap-2 text-center">
      <div><p className="text-[11px] uppercase text-slate-400">In</p><p className="text-3xl font-bold tabular-nums" style={{ color: IN_COLOUR }} aria-label="Entered so far">{live.entered}</p></div>
      <div><p className="text-[11px] uppercase text-slate-400">Out</p><p className="text-3xl font-bold tabular-nums" style={{ color: OUT_COLOUR }} aria-label="Exited so far">{live.exited}</p></div>
      <div><p className="text-[11px] uppercase text-slate-400">Net out</p><p className="text-3xl font-bold tabular-nums" aria-label="Net so far">{live.net >= 0 ? '+' : ''}{live.net}</p></div>
      <p className="col-span-3 text-[11px] text-slate-400">So far at the playhead{live.pending ? `, ${live.pending} uncertain not counted yet` : ''}. Provisional, not a final count.</p>
    </div>}
    {counts && reviewer && <>
      <p className="text-xs" aria-label="Count quality">
        <span className="text-green-400">{counts.layers.algorithm.coherent} coherent</span> - <span className="text-amber-400">{counts.layers.algorithm.uncertain} uncertain</span> - <span className="text-slate-300">{counts.invalid_spans.length} paused span{counts.invalid_spans.length === 1 ? '' : 's'}</span>
      </p>
      <p className="text-xs text-slate-300">Whole survey - algorithm: in {counts.layers.algorithm.entered}, out {counts.layers.algorithm.exited}; reviewer: in {reviewer.entered}, out {reviewer.exited}, net {reviewer.net} ({reviewer.state}).</p>
      {counts.invalid_spans.length > 0 && <ul aria-label="Paused gate spans" className="space-y-2">
        {counts.invalid_spans.map(span => <li key={span.anchor_id} className="space-y-1 rounded border border-slate-700 p-2 text-xs">
          <p className="flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
            {span.reason === 'camera_moved' ? `Camera moved at ${seconds(span.segment_id, span.from_pts)} in ${name(span.segment_id)}` : `${name(span.segment_id)} is not marked contiguous with the one before`}. Counting is paused.</p>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="ghost" className="h-7 text-slate-200" onClick={() => onGo(span.segment_id, span.resume_pts ?? segments.find(item => item.id === span.segment_id)?.metadata.first_pts ?? '0')}><Crosshair />Show</Button>
            <Button size="sm" className="h-7" onClick={() => void reconfirm(span, null)}>Reconfirm gate</Button>
            <Button size="sm" variant="outline" className="h-7 border-slate-600 bg-transparent text-slate-100"
              onClick={() => { setRedraw(span); setGateDraft({ kind: counts.gate.kind, points: [] }); onGo(span.segment_id, span.resume_pts ?? '0'); }}>Redraw</Button>
          </div>
          {redraw?.anchor_id === span.anchor_id && gateDraft && <div className="flex gap-1">
            <Button size="sm" className="h-7" disabled={gateDraft.points.length < (counts.gate.kind === 'polygon' ? 3 : 2)}
              onClick={() => { const points = counts.gate.kind === 'rect' ? rectangle(gateDraft.points) : gateDraft.points; setGateDraft(null); setRedraw(null); void reconfirm(span, points); }}>Use redrawn gate</Button>
            <Button size="sm" variant="ghost" className="h-7 text-slate-300" onClick={() => { setGateDraft(null); setRedraw(null); }}>Cancel</Button>
          </div>}
        </li>)}
      </ul>}
      {uncertain.length > 0 && <div className="space-y-1">
        <p className="text-xs font-medium">Uncertain crossings ({uncertain.filter(item => !item.review).length} undecided)</p>
        <ul aria-label="Uncertain crossings" className="max-h-56 space-y-1 overflow-y-auto">
          {uncertain.map(crossing => <li key={crossing.key} className={cn('flex flex-wrap items-center gap-1 rounded px-2 py-1 text-xs', crossing.review ? 'bg-slate-800/40 text-slate-400' : 'bg-amber-500/10')}>
            <button type="button" className="underline" onClick={() => onGo(crossing.segment_id, crossing.pts)}>#{crossing.track_index + 1} at {seconds(crossing.segment_id, crossing.pts)}</button>
            <span>{crossing.review ? (crossing.review.action === 'reject' ? 'not a bat' : crossing.review.flipped ? 'bat, opposite way' : 'bat') : ''}</span>
            <span className="ml-auto flex gap-1">
              <Button size="sm" variant="ghost" className="h-6 px-2 text-slate-100" onClick={() => void decide(crossing, 'bat')}>Bat</Button>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-slate-100" onClick={() => void decide(crossing, 'not_bat')}>Not a bat</Button>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-slate-100" onClick={() => void decide(crossing, 'opposite')}>Opposite</Button>
            </span>
          </li>)}
        </ul>
      </div>}
      <Button size="sm" className="w-full bg-emerald-600 hover:bg-emerald-500" disabled={reviewer.state !== 'ready'} onClick={() => void accept()}>
        <CheckCircle2 />{reviewer.state === 'accepted' ? `Accepted by ${reviewer.accepted?.actor}` : 'Accept count'}</Button>
      {reviewer.state === 'unresolved' && <p className="text-[11px] text-slate-400">Decide the uncertain crossings and reconfirm paused spans to accept.</p>}
      {reviewer.state === 'accepted' && <div className="space-y-1 border-t border-slate-800 pt-2 text-xs">
        <p className="font-medium">Second check (QA, a different person)</p>
        {counts.layers.qa && <p className={counts.layers.qa.stale ? 'text-amber-300' : 'text-slate-300'}>QA {counts.layers.qa.decision} by {counts.layers.qa.actor}{counts.layers.qa.stale ? ' (out of date)' : ''}</p>}
        <Input aria-label="QA note" className="h-8 border-slate-700 bg-slate-800 text-slate-100" placeholder="Note (needed to reject)" value={qaNote} onChange={event => setQANote(event.target.value)} />
        <div className="flex gap-2">
          <Button size="sm" className="h-7" onClick={() => void qa('approve')}>Approve counts</Button>
          <Button size="sm" variant="outline" className="h-7 border-slate-600 bg-transparent text-slate-100" onClick={() => void qa('reject')}>Reject</Button>
        </div>
      </div>}
      <Button size="sm" variant="ghost" className="h-7 text-slate-400" onClick={() => runID && counts && void act(api => api.getCounts(runID, counts.gate.id))}><RefreshCw />Reload counts</Button>
    </>}
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
  </section>;
}
