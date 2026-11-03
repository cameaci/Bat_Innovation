import { CheckCheck, Clapperboard, Eye, Square } from 'lucide-react';
import type { MediaSegment, SummaryWindow } from '../../../../electron/src/contracts';
import { span } from '../../lib/time';
import { isUnreviewed } from '../../lib/windows';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';

export interface WindowState { window: SummaryWindow; reviewed: boolean; tracks: number; watched: boolean }

export function windowStates(windows: SummaryWindow[], counts: Record<string, number>, covers: (segmentID: string, first: number, last: number) => boolean): WindowState[] {
  return windows.map(window => {
    const first = window.stats.first_pts, last = window.stats.last_pts;
    return { window, reviewed: !isUnreviewed(window), tracks: counts[window.id] ?? 0,
      watched: first != null && last != null && covers(window.segment_id, Number(first), Number(last)) };
  });
}

/**
 * Review beside the video: the event reel for undecided items, and marking watched quiet windows together.
 * A window with tracks always needs its own decision; a window is "watched" only when every frame was played
 * continuously at 4x or slower.
 */
export function WatchReviewPanel({ states, segments, reelSize, reel, onStartReel, onStopReel, onMark, marking, actor }: {
  states: WindowState[];
  segments: MediaSegment[];
  reelSize: number;
  reel: { position: number; total: number; label: string } | null;
  onStartReel: () => void;
  onStopReel: () => void;
  onMark: () => void;
  marking: boolean;
  actor: string;
}) {
  const eligible = states.filter(item => !item.reviewed && item.tracks === 0 && item.watched).length;
  const reviewed = states.filter(item => item.reviewed).length;
  const name = (id: string) => `video ${segments.findIndex(item => item.id === id) + 1}`;
  return <section aria-label="Review" className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4 text-slate-100">
    <div className="space-y-2">
      <p className="text-sm font-semibold">Event reel</p>
      {reel
        ? <div role="status" aria-label="Reel item" className="space-y-1 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          <p className="font-medium">Event {reel.position + 1} of {reel.total}: {reel.label}</p>
          <p className="text-slate-300">B bat - N not a bat - D opposite way (crossings) - U skip - Esc stop. It loops until you decide.</p>
          <Button size="sm" variant="ghost" className="h-7 text-slate-200" onClick={onStopReel}><Square />Stop reel</Button>
        </div>
        : <>
          <Button size="sm" className="bg-amber-600 hover:bg-amber-500" disabled={reelSize === 0 || !actor.trim()} onClick={onStartReel}>
            <Clapperboard />Review {reelSize} uncertain event{reelSize === 1 ? '' : 's'}</Button>
          <p className="text-[11px] text-slate-400">{!actor.trim() ? 'Enter your name in the Counts tab first. ' : ''}Only uncertain tracks and crossings are queued; stable tracks are counted as proposed.</p>
        </>}
    </div>
    <div className="space-y-2 border-t border-slate-800 pt-3">
      <p className="text-sm font-semibold">Windows</p>
      <p className="text-xs text-slate-300" aria-label="Window progress">{reviewed} of {states.length} reviewed - {eligible} watched and quiet, ready to mark</p>
      <Button size="sm" className="w-full" disabled={eligible === 0 || marking || !actor.trim()} onClick={onMark}>
        <CheckCheck />Mark {eligible} watched window{eligible === 1 ? '' : 's'}: no activity seen (M)</Button>
      <p className="text-[11px] text-slate-400">Play quiet windows through at 4x or slower; windows with tracks need a decision in the reel or in Review.</p>
      <ul aria-label="Windows" className="max-h-64 space-y-1 overflow-y-auto text-xs">
        {states.map(item => <li key={item.window.id} className={cn('flex items-center gap-2 rounded px-2 py-1', item.reviewed ? 'bg-emerald-500/10 text-emerald-200' : item.watched ? 'bg-sky-500/10' : 'bg-slate-800/40')}>
          <span className="w-16 shrink-0">{name(item.window.segment_id)}</span>
          <span className="flex-1 tabular-nums">{span(item.window.interval.elapsed_start, item.window.interval.elapsed_end)}</span>
          {item.tracks > 0 && <span className="text-red-300">{item.tracks} track{item.tracks === 1 ? '' : 's'}</span>}
          {item.reviewed ? <span>reviewed</span> : item.watched ? <span className="flex items-center gap-1 text-sky-300"><Eye className="h-3 w-3" />watched</span> : <span className="text-slate-500">not watched</span>}
        </li>)}
      </ul>
    </div>
  </section>;
}
