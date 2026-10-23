import type { Rational, TrackRecord } from '../../../electron/src/contracts';

const TRAIL_SECONDS = 2;
const COLOURS = ['#22d3ee', '#facc15', '#f472b6', '#4ade80', '#fb923c', '#a78bfa'];

/**
 * Trails of candidate tracks up to the displayed original frame, drawn in source pixel coordinates over a
 * letterboxed (object-contain) video. Points after the displayed frame are never drawn.
 */
export function TrackOverlay({ tracks, displayedPTS, width, height, timeBase }: {
  tracks: TrackRecord[]; displayedPTS: string | null; width: number; height: number; timeBase: Rational;
}) {
  if (displayedPTS === null || tracks.length === 0) return null;
  const now = BigInt(displayedPTS);
  const trail = BigInt(Math.round(TRAIL_SECONDS * Number(timeBase.den) / Number(timeBase.num)));
  const visible = tracks.flatMap(track => {
    const points = track.points.filter(([pts]) => BigInt(pts) <= now && BigInt(pts) >= now - trail);
    return points.length === 0 ? [] : [{ track, points, live: BigInt(track.last_pts) >= now }];
  });
  return <svg aria-label="Track trails" role="img" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet"
    className="pointer-events-none absolute inset-0 h-full w-full">
    {visible.map(({ track, points, live }) => {
      const colour = COLOURS[track.track_index % COLOURS.length];
      const [, x, y] = points[points.length - 1]!;
      return <g key={track.id} data-track={track.track_index}>
        <polyline points={points.map(([, px, py]) => `${px},${py}`).join(' ')} fill="none" stroke={colour} strokeWidth={Math.max(1, width / 400)} strokeOpacity={0.85} />
        {live && <circle cx={x} cy={y} r={Math.max(3, width / 160)} fill="none" stroke={colour} strokeWidth={Math.max(1, width / 400)} />}
        {live && <text x={x + width / 100} y={y - width / 100} fill={colour} fontSize={Math.max(8, width / 50)}>T{track.track_index + 1}</text>}
      </g>;
    })}
  </svg>;
}
