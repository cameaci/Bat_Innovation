import type { MouseEvent } from 'react';
import type { Gate, Rational, TrackRecord } from '../../../electron/src/contracts';

const TRAIL_SECONDS = 2;
const COLOURS = ['#22d3ee', '#facc15', '#f472b6', '#4ade80', '#fb923c', '#a78bfa'];

export interface Drawing { kind: Gate['kind']; points: [number, number][]; onPoint: (point: [number, number]) => void }

/** Rectangle corners from two clicked opposite corners. */
export function rectangle([a, b]: [number, number][]): [number, number][] {
  return [[a![0], a![1]], [b![0], a![1]], [b![0], b![1]], [a![0], b![1]]];
}

/**
 * Drawn over a letterboxed (object-contain) original preview in source pixel coordinates: track trails up to the
 * displayed frame, active counting gates with their A/B sides, and an in-progress gate drawing.
 */
export function SceneOverlay({ tracks, gates, drawing, displayedPTS, width, height, timeBase }: {
  tracks: TrackRecord[]; gates: Gate[]; drawing: Drawing | null; displayedPTS: string | null; width: number; height: number; timeBase: Rational;
}) {
  const stroke = Math.max(1, width / 400);
  const font = Math.max(8, width / 45);
  const now = displayedPTS === null ? null : BigInt(displayedPTS);
  const trail = BigInt(Math.round(TRAIL_SECONDS * Number(timeBase.den) / Number(timeBase.num)));
  const visible = now === null ? [] : tracks.flatMap(track => {
    const points = track.points.filter(([pts]) => BigInt(pts) <= now && BigInt(pts) >= now - trail);
    return points.length === 0 ? [] : [{ track, points, live: BigInt(track.last_pts) >= now }];
  });
  function click(event: MouseEvent<SVGSVGElement>) {
    if (!drawing) return;
    const svg = event.currentTarget;
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    if (point.x < 0 || point.y < 0 || point.x > width || point.y > height) return;
    drawing.onPoint([Math.round(point.x * 10) / 10, Math.round(point.y * 10) / 10]);
  }
  const shapes = gates.filter(gate => gate.state === 'active' && gate.frame_w === width && gate.frame_h === height);
  const draft = drawing && drawing.points.length > 0 ? (drawing.kind === 'rect' && drawing.points.length === 2 ? rectangle(drawing.points) : drawing.points) : [];
  return <svg aria-label={drawing ? 'Gate drawing area' : 'Tracks and gates'} role="img" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet"
    className={`absolute inset-0 h-full w-full ${drawing ? 'cursor-crosshair' : 'pointer-events-none'}`} onClick={click}>
    {shapes.map(gate => {
      const points = gate.points;
      const [a, b] = [points[0]!, points[points.length - 1]!];
      const middle = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      // Side A is the visual left of the first-to-last point direction (image y grows downwards).
      const left = [(b[1] - a[1]) / length, -(b[0] - a[0]) / length];
      return <g key={gate.id} data-gate={gate.name}>
        {gate.kind === 'line'
          ? <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#ef4444" strokeWidth={stroke * 2} />
          : <polygon points={points.map(point => point.join(',')).join(' ')} fill="#ef444422" stroke="#ef4444" strokeWidth={stroke * 2} />}
        {gate.kind === 'line' && <>
          <text x={middle[0]! + left[0]! * font * 1.5} y={middle[1]! + left[1]! * font * 1.5} fill="#fecaca" fontSize={font} textAnchor="middle">A</text>
          <text x={middle[0]! - left[0]! * font * 1.5} y={middle[1]! - left[1]! * font * 1.5} fill="#fecaca" fontSize={font} textAnchor="middle">B</text>
        </>}
        <text x={a[0]} y={Math.max(font, a[1] - font / 2)} fill="#fecaca" fontSize={font}>{gate.name}</text>
      </g>;
    })}
    {visible.map(({ track, points, live }) => {
      const colour = COLOURS[track.track_index % COLOURS.length];
      const [, x, y] = points[points.length - 1]!;
      return <g key={track.id} data-track={track.track_index}>
        <polyline points={points.map(([, px, py]) => `${px},${py}`).join(' ')} fill="none" stroke={colour} strokeWidth={stroke} strokeOpacity={0.85} />
        {live && <circle cx={x} cy={y} r={Math.max(3, width / 160)} fill="none" stroke={colour} strokeWidth={stroke} />}
        {live && <text x={x + width / 100} y={y - width / 100} fill={colour} fontSize={font}>T{track.track_index + 1}</text>}
      </g>;
    })}
    {draft.length > 0 && <g data-draft="gate">
      {drawing!.kind === 'line' || draft.length < 3
        ? <polyline points={draft.map(point => point.join(',')).join(' ')} fill="none" stroke="#fde047" strokeWidth={stroke * 2} strokeDasharray={`${stroke * 4} ${stroke * 2}`} />
        : <polygon points={draft.map(point => point.join(',')).join(' ')} fill="#fde04722" stroke="#fde047" strokeWidth={stroke * 2} strokeDasharray={`${stroke * 4} ${stroke * 2}`} />}
      {drawing!.points.map(([x, y], index) => <circle key={index} cx={x} cy={y} r={Math.max(2, width / 200)} fill="#fde047" />)}
    </g>}
  </svg>;
}
