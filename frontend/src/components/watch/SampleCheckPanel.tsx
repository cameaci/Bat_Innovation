import { ClipboardCheck, Square, X } from 'lucide-react';
import type { MediaSegment, SampleCheck } from '../../../../electron/src/contracts';
import { ptsSeconds, clock } from '../../lib/time';
import { Button } from '../ui/button';

export interface ActiveSample { segmentID: string; start: number; presses: { pts: number; kind: 'entry' | 'exit' }[] }

/**
 * Sample check: count crossings of a short span by hand at normal speed or slower and compare with the gate's
 * proposal (the practice of validating automated counts against manual counts of segments). It never changes a count.
 */
export function SampleCheckPanel({ checks, active, segments, canStart, actor, busy, onStart, onFinish, onCancel, onGo }: {
  checks: SampleCheck[];
  active: ActiveSample | null;
  segments: MediaSegment[];
  canStart: boolean;
  actor: string;
  busy: boolean;
  onStart: () => void;
  onFinish: () => void;
  onCancel: () => void;
  onGo: (segmentID: string, pts: string) => void;
}) {
  const at = (check: { segment_id: string }, pts: string) => {
    const segment = segments.find(item => item.id === check.segment_id);
    return segment ? clock(ptsSeconds(pts, segment.metadata.first_pts, segment.metadata.time_base)) : pts;
  };
  return <section aria-label="Sample check" className="space-y-2 rounded-lg border border-slate-800 bg-slate-900 p-4 text-slate-100">
    <p className="text-sm font-semibold">Sample check</p>
    {active
      ? <div role="status" aria-label="Sample check running" className="space-y-1 rounded border border-sky-500/40 bg-sky-500/10 p-2 text-xs">
        <p>Counting by hand: press <kbd>[</kbd> when a bat enters and <kbd>]</kbd> when one exits through the gate. Play at 1x or slower without seeking.</p>
        <p className="tabular-nums" aria-label="Presses so far">{active.presses.filter(item => item.kind === 'entry').length} entries, {active.presses.filter(item => item.kind === 'exit').length} exits</p>
        <div className="flex gap-1">
          <Button size="sm" className="h-7" disabled={busy} onClick={onFinish}><Square />Finish and compare</Button>
          <Button size="sm" variant="ghost" className="h-7 text-slate-200" onClick={onCancel}><X />Cancel</Button>
        </div>
      </div>
      : <>
        <Button size="sm" variant="outline" className="border-slate-600 bg-transparent text-slate-100" disabled={!canStart || !actor.trim()} onClick={onStart}>
          <ClipboardCheck />Check a sample from here</Button>
        <p className="text-[11px] text-slate-400">{!actor.trim() ? 'Enter your name first. ' : ''}Count a minute or two yourself; the app lists matched, missed and extra crossings. Counts are not changed.</p>
      </>}
    {checks.length > 0 && <ul aria-label="Sample checks" className="max-h-72 space-y-2 overflow-y-auto text-xs">
      {checks.map(check => <li key={check.id} className="rounded bg-slate-800/50 p-2">
        <p className="font-medium">{at(check, check.start_pts)} to {at(check, check.end_pts)} by {check.actor}</p>
        <p className="tabular-nums">You: {check.result.manual.entry} in, {check.result.manual.exit} out - algorithm: {check.result.algorithm.entry} in, {check.result.algorithm.exit} out - {check.result.matched.length} matched</p>
        {check.result.missed_by_algorithm.length > 0 && <p className="text-amber-200">Missed by the algorithm: {check.result.missed_by_algorithm.map((item, index) =>
          <button key={index} type="button" className="mr-1 underline" onClick={() => onGo(check.segment_id, item.pts)}>{at(check, item.pts)} {item.kind}</button>)}</p>}
        {check.result.extra_in_algorithm.length > 0 && <p className="text-fuchsia-200">Extra in the algorithm: {check.result.extra_in_algorithm.map(item =>
          <button key={item.key} type="button" className="mr-1 underline" onClick={() => onGo(check.segment_id, item.pts)}>#{item.track_index + 1} {item.kind}</button>)}</p>}
        {check.result.uncertain_in_span > 0 && <p className="text-slate-400">{check.result.uncertain_in_span} undecided crossings in this span are not part of the proposal.</p>}
      </li>)}
    </ul>}
  </section>;
}
