import type { MediaSegment, SummaryWindow } from '../../../electron/src/contracts';
import { clock, seconds } from '../lib/time';

/**
 * One lane per original video in recording order. Each planned window is a bin: its height shows candidate
 * tracks, a dot marks reviewed observations. Gaps between videos stay visible; nothing is compressed away.
 */
export function ActivityTimeline({ segments, windows, trackCounts, onOpen }: {
  segments: MediaSegment[]; windows: SummaryWindow[]; trackCounts: Record<string, number> | undefined; onOpen: (windowID: string) => void;
}) {
  const most = Math.max(1, ...windows.map(window => trackCounts?.[window.id] ?? 0));
  return <section aria-label="Activity timeline" className="space-y-2">
    {segments.map((segment, order) => {
      const lane = windows.filter(window => window.segment_id === segment.id);
      const total = seconds(segment.metadata.elapsed_end ?? segment.metadata.elapsed_last_time) ?? 1;
      return <div key={segment.id} className="space-y-1">
        {order > 0 && <p className="text-[11px] text-amber-800">{segment.continuity === 'known_contiguous' ? 'Continues directly from the previous video.' : segment.continuity === 'known_gap' ? 'Recording gap before this video.' : 'Continuity with the previous video is unknown.'}</p>}
        <p className="text-xs font-medium">{segment.metadata.filename} · {clock(total)}</p>
        <svg role="list" aria-label={`Timeline of ${segment.metadata.filename}`} viewBox="0 0 1000 40" preserveAspectRatio="none" className="h-10 w-full rounded bg-slate-100">
          {lane.map(window => {
            const start = (seconds(window.interval.elapsed_start) ?? 0) / total * 1000;
            const end = (seconds(window.interval.elapsed_end) ?? total) / total * 1000;
            const tracks = trackCounts?.[window.id] ?? 0;
            const observed = (window.review?.observation_count ?? 0) > 0;
            const label = `${clock(seconds(window.interval.elapsed_start))}: ${tracks} track${tracks === 1 ? '' : 's'}${observed ? ', observations recorded' : ''}${window.status !== 'complete' ? `, ${window.status}` : ''}`;
            return <g key={window.id} role="listitem" aria-label={label} className="cursor-pointer" onClick={() => onOpen(window.id)}>
              <title>{label}</title>
              <rect x={start} y={0} width={Math.max(1, end - start - 1)} height={40} fill={window.status === 'complete' ? 'transparent' : '#fecaca'} />
              {tracks > 0 && <rect x={start} y={40 - 34 * tracks / most} width={Math.max(1, end - start - 1)} height={34 * tracks / most} fill="#ef4444" fillOpacity={0.7} />}
              {observed && <circle cx={(start + end) / 2} cy={6} r={4} fill="#2563eb" />}
            </g>;
          })}
        </svg>
      </div>;
    })}
    <p className="text-[11px] text-muted-foreground">Red bars: candidate tracks per window (not bats). Blue dots: windows with recorded observations. Click a window to open it.</p>
  </section>;
}
