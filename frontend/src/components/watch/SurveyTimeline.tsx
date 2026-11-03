import type { MouseEvent } from 'react';
import type { GateCounts, MediaSegment, SceneEvent, SummaryWindow } from '../../../../electron/src/contracts';
import { seconds } from '../../lib/time';
import { isUnreviewed } from '../../lib/windows';
import { counted, effectiveDirection, IN_COLOUR, OUT_COLOUR } from './CountLayer';

const WIDTH = 1000, GAP = 8;

/**
 * The whole survey end to end, each video in proportion to its duration: tracks per window, crossings (out up,
 * in down, uncertain in amber), crossings per minute, camera moves, reviewed windows and the playhead. Click to go.
 */
export function SurveyTimeline({ segments, windows, windowCounts, counts, events, current, onSeek }: {
  segments: MediaSegment[];
  windows: SummaryWindow[];
  windowCounts: Record<string, number>;
  counts: GateCounts | null;
  events: SceneEvent[];
  current: { segmentID: string; pts: number } | null;
  onSeek: (segmentID: string, pts: string) => void;
}) {
  const durations = segments.map(segment => Math.max(0.001, seconds(segment.metadata.elapsed_end) ?? seconds(segment.metadata.elapsed_last_time) ?? 0.001));
  const total = durations.reduce((sum, value) => sum + value, 0);
  const usable = WIDTH - GAP * Math.max(0, segments.length - 1);
  const starts: number[] = [];
  durations.reduce((x, duration, index) => { starts[index] = x; return x + duration / total * usable + GAP; }, 0);
  const tick = (segment: MediaSegment) => Number(segment.metadata.time_base.num) / Number(segment.metadata.time_base.den);
  const x = (segmentID: string, pts: number) => {
    const index = segments.findIndex(item => item.id === segmentID);
    if (index < 0) return null;
    const segment = segments[index]!;
    const t = (pts - Number(segment.metadata.first_pts)) * tick(segment);
    return starts[index]! + Math.min(1, Math.max(0, t / durations[index]!)) * durations[index]! / total * usable;
  };
  const maxTracks = Math.max(1, ...Object.values(windowCounts));
  const perMinute = new Map<string, number>();
  for (const crossing of counts?.crossings ?? []) {
    if (!counted(crossing) || (crossing.quality === 'uncertain' && !crossing.review)) continue;
    const segment = segments.find(item => item.id === crossing.segment_id);
    if (!segment) continue;
    const minute = Math.floor((Number(crossing.pts) - Number(segment.metadata.first_pts)) * tick(segment) / 60);
    const key = `${segment.id}:${minute}`;
    perMinute.set(key, (perMinute.get(key) ?? 0) + (crossing.review?.count ?? 1));
  }
  const maxRate = Math.max(1, ...perMinute.values());

  function click(event: MouseEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const position = (event.clientX - box.left) / box.width * WIDTH;
    const index = starts.findIndex((start, at) => position >= start && position <= start + durations[at]! / total * usable);
    if (index < 0) return;
    const segment = segments[index]!;
    const t = (position - starts[index]!) / (durations[index]! / total * usable) * durations[index]!;
    onSeek(segment.id, String(Math.round(Number(segment.metadata.first_pts) + t / tick(segment))));
  }

  const playhead = current ? x(current.segmentID, current.pts) : null;
  return <svg role="img" aria-label="Survey timeline" viewBox={`0 0 ${WIDTH} 76`} preserveAspectRatio="none" className="h-20 w-full cursor-pointer rounded bg-slate-900" onClick={click}>
    {segments.map((segment, index) => <g key={segment.id}>
      <rect x={starts[index]} y={0} width={durations[index]! / total * usable} height={76} fill="#0f172a" />
      {index > 0 && segment.continuity !== 'known_contiguous' && <rect x={starts[index]! - GAP} y={0} width={GAP} height={76} fill="url(#gap)" />}
    </g>)}
    <defs><pattern id="gap" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="4" fill="#475569" /></pattern></defs>
    {windows.map(window => {
      const start = x(window.segment_id, Number(window.interval.start_pts.num) / Number(window.interval.start_pts.den));
      const segment = segments.find(item => item.id === window.segment_id);
      const end = window.interval.end_pts ? x(window.segment_id, Number(window.interval.end_pts.num) / Number(window.interval.end_pts.den))
        : segment ? x(segment.id, Number(segment.metadata.last_pts)) : null;
      if (start === null || end === null) return null;
      const height = (windowCounts[window.id] ?? 0) / maxTracks * 26;
      return <g key={window.id}>
        <rect x={start} y={28 - height} width={Math.max(1, end - start - 0.5)} height={height} fill="#ef4444" opacity={0.8} />
        <rect x={start} y={52} width={Math.max(1, end - start - 0.5)} height={4} fill={isUnreviewed(window) ? '#334155' : '#22c55e'} />
      </g>;
    })}
    {(counts?.crossings ?? []).map(crossing => {
      const at = x(crossing.segment_id, Number(crossing.pts));
      if (at === null) return null;
      if (crossing.quality === 'uncertain' && !crossing.review) return <circle key={crossing.key} cx={at} cy={40} r={2.5} fill="#f59e0b" />;
      if (!counted(crossing)) return null;
      const entering = effectiveDirection(crossing) === counts!.gate.entry_direction;
      return <line key={crossing.key} x1={at} x2={at} y1={entering ? 40 : 32} y2={entering ? 48 : 40} stroke={entering ? IN_COLOUR : OUT_COLOUR} strokeWidth={1.5} />;
    })}
    {[...perMinute].map(([key, value]) => {
      const [segmentID, minute] = key.split(':');
      const segment = segments.find(item => item.id === segmentID);
      if (!segment) return null;
      const start = x(segment.id, Number(segment.metadata.first_pts) + Number(minute) * 60 / tick(segment));
      const end = x(segment.id, Number(segment.metadata.first_pts) + (Number(minute) + 1) * 60 / tick(segment));
      if (start === null || end === null) return null;
      const height = value / maxRate * 14;
      return <rect key={key} x={start} y={76 - height} width={Math.max(1, end - start - 0.5)} height={height} fill="#a78bfa" opacity={0.8} />;
    })}
    {events.filter(event => event.kind === 'camera_moved').map((event, index) => {
      const at = event.segment_id ? x(event.segment_id, Number(event.start_pts)) : null;
      return at === null ? null : <text key={index} x={at} y={46} fill="#f87171" fontSize={12} textAnchor="middle">x</text>;
    })}
    {playhead !== null && <line x1={playhead} x2={playhead} y1={0} y2={76} stroke="#f8fafc" strokeWidth={1.5} />}
  </svg>;
}
