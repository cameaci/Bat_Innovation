import type { Crossing, Gate, GateCounts } from '../../../../electron/src/contracts';
import { trackColour, type View } from './BatsLayer';
import { floorIndex, positionAt, type TrackData } from './tracks';

export const IN_COLOUR = '#22d3ee';
export const OUT_COLOUR = '#e879f9';

/** Whether a crossing counts in the reviewer layer as it stands: proposed and not rejected, or decided as a bat. */
export function counted(crossing: Crossing): boolean {
  const review = crossing.review;
  if (!review) return crossing.quality === 'coherent';
  return review.action !== 'reject';
}

export function effectiveDirection(crossing: Crossing): Crossing['direction'] {
  const flip = { A_to_B: 'B_to_A', B_to_A: 'A_to_B', out_to_in: 'in_to_out', in_to_out: 'out_to_in' } as const;
  return crossing.review?.flipped ? flip[crossing.direction] : crossing.direction;
}

/** Crossings at or before the playhead: earlier videos entirely, the current one up to the displayed PTS. */
export function soFar(counts: GateCounts, order: Map<string, number>, segmentID: string, now: number) {
  const current = order.get(segmentID) ?? -1;
  let entered = 0, exited = 0, pending = 0;
  for (const crossing of counts.crossings) {
    const at = order.get(crossing.segment_id) ?? -1;
    if (at > current || (at === current && Number(crossing.pts) > now)) continue;
    if (crossing.quality === 'uncertain' && !crossing.review) { pending += 1; continue; }
    if (!counted(crossing)) continue;
    const amount = crossing.review?.count ?? 1;
    if (effectiveDirection(crossing) === counts.gate.entry_direction) entered += amount; else exited += amount;
  }
  return { entered, exited, net: exited - entered, pending };
}

function shape(context: CanvasRenderingContext2D, view: View, gate: Gate, points: [number, number][]) {
  context.beginPath();
  points.forEach(([x, y], index) => {
    const px = view.dx + x * view.scale, py = view.dy + y * view.scale;
    if (index === 0) context.moveTo(px, py); else context.lineTo(px, py);
  });
  if (gate.kind !== 'line') context.closePath();
}

type Point = [number, number];

function intersection(p1: Point, p2: Point, q1: Point, q2: Point): Point | null {
  const r = [p2[0] - p1[0], p2[1] - p1[1]], q = [q2[0] - q1[0], q2[1] - q1[1]];
  const denominator = r[0]! * q[1]! - r[1]! * q[0]!;
  if (denominator === 0) return null;
  const t = ((q1[0] - p1[0]) * q[1]! - (q1[1] - p1[1]) * q[0]!) / denominator;
  const u = ((q1[0] - p1[0]) * r[1]! - (q1[1] - p1[1]) * r[0]!) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [p1[0] + t * r[0]!, p1[1] + t * r[1]!] : null;
}

/**
 * Where a track met the gate for a crossing at `pts`: the intersection of its last step before that point with a gate
 * edge, or the first point on the new side when the step does not touch an edge (it passed beyond a band point).
 */
export function crossingPoint(track: TrackData, pts: number, kind: Gate['kind'], points: Point[]): Point | null {
  const index = floorIndex(track.pts, pts);
  if (index < 0) return null;
  const here: Point = [track.x[index]!, track.y[index]!];
  if (index === 0) return here;
  const before: Point = [track.x[index - 1]!, track.y[index - 1]!];
  const edges = points.map((point, i) => [point, points[i + 1] ?? points[0]!] as [Point, Point]);
  for (const [a, b] of kind === 'line' ? edges.slice(0, points.length - 1) : edges) {
    const hit = intersection(before, here, a, b);
    if (hit) return hit;
  }
  return here;
}

export function inside(point: Point, polygon: Point[]): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!, [xj, yj] = polygon[j]!;
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) result = !result;
  }
  return result;
}

/** Tracks inside an area gate at `now` (a display value: tracks, not bats), split by quality. */
export function insideNow(tracks: TrackData[], now: number, kind: Gate['kind'], points: Point[]): { coherent: number; uncertain: number } | null {
  if (kind === 'line') return null;
  let coherent = 0, uncertain = 0;
  for (const track of tracks) {
    if (track.quality === 'noise') continue;
    const at = positionAt(track, now);
    if (!at || !inside([at.x, at.y], points)) continue;
    if (track.quality === 'uncertain') uncertain += 1; else coherent += 1;
  }
  return { coherent, uncertain };
}

export type BoardMode = 'band' | 'corner' | 'off';
const CIRCLE_SECONDS = 1.5;

/**
 * Gates at the displayed frame (paused spans in grey with a notice), a circle where each recent crossing met the gate
 * (filled in the track's colour, hollow amber while undecided) and the count board: a band along the bottom of the
 * video like the reference tools, or a compact corner box. Counts are provisional candidate evidence.
 */
export function drawCounts(context: CanvasRenderingContext2D, view: View, counts: GateCounts, order: Map<string, number>,
  segmentID: string, now: number, ticksPerSecond: number, tracks: TrackData[] = [], board: BoardMode = 'corner') {
  const gate = counts.gate;
  const intervals = counts.valid_spans[segmentID] ?? [];
  const valid = intervals.find(item => (item.from_pts === null || now >= item.from_pts) && (item.to_pts === null || now < item.to_pts));
  const points = valid?.points ?? gate.points;
  context.lineWidth = 3 * view.dpr;
  context.setLineDash(valid ? [] : [8 * view.dpr, 6 * view.dpr]);
  context.strokeStyle = valid ? '#facc15' : '#64748b';
  shape(context, view, gate, points);
  if (gate.kind !== 'line') { context.fillStyle = valid ? 'rgba(250, 204, 21, 0.08)' : 'rgba(100, 116, 139, 0.15)'; context.fill(); }
  context.stroke();
  context.setLineDash([]);
  const font = 13 * view.dpr;
  context.font = `600 ${font}px ui-sans-serif, system-ui`;
  const [ax, ay] = points[0]!;
  if (gate.kind === 'line') {
    const [bx, by] = points[points.length - 1]!;
    const length = Math.hypot(bx - ax, by - ay) || 1;
    const lx = (by - ay) / length, ly = -(bx - ax) / length;
    const mx = view.dx + (ax + bx) / 2 * view.scale, my = view.dy + (ay + by) / 2 * view.scale;
    context.fillStyle = '#fef08a';
    context.fillText('A', mx + lx * 18 * view.dpr, my + ly * 18 * view.dpr);
    context.fillText('B', mx - lx * 18 * view.dpr, my - ly * 18 * view.dpr);
  }
  if (!valid) {
    // Centred on the gate, clear of the counter board.
    const cx = view.dx + points.reduce((sum, point) => sum + point[0], 0) / points.length * view.scale;
    const cy = view.dy + points.reduce((sum, point) => sum + point[1], 0) / points.length * view.scale;
    context.fillStyle = 'rgba(15, 23, 42, 0.85)';
    context.fillRect(cx - 95 * view.dpr, cy - 10 * view.dpr, 190 * view.dpr, 20 * view.dpr);
    context.fillStyle = '#e2e8f0';
    context.fillText('Gate paused: reconfirm it', cx - 89 * view.dpr, cy + 4 * view.dpr);
  }
  // A circle where each crossing of the last 1.5 s met the gate.
  const byID = new Map(tracks.map(track => [track.id, track]));
  for (const crossing of counts.crossings) {
    const age = now - Number(crossing.pts);
    if (crossing.segment_id !== segmentID || age < 0 || age > CIRCLE_SECONDS * ticksPerSecond) continue;
    const track = byID.get(crossing.track_id);
    const at = track ? crossingPoint(track, Number(crossing.pts), gate.kind, points) : null;
    if (!at) continue;
    const undecided = crossing.quality === 'uncertain' && !crossing.review;
    const entering = effectiveDirection(crossing) === gate.entry_direction;
    const x = view.dx + at[0] * view.scale, y = view.dy + at[1] * view.scale, r = 9 * view.dpr;
    context.globalAlpha = 1 - age / (CIRCLE_SECONDS * ticksPerSecond) * 0.8;
    context.beginPath();
    context.arc(x, y, r, 0, Math.PI * 2);
    if (undecided) { context.strokeStyle = '#f59e0b'; context.lineWidth = 2.5 * view.dpr; context.stroke(); }
    else if (counted(crossing)) {
      context.fillStyle = trackColour(crossing.track_index);
      context.fill();
      context.strokeStyle = entering ? IN_COLOUR : OUT_COLOUR;
      context.lineWidth = 2.5 * view.dpr;
      context.stroke();
    }
    context.fillStyle = '#0f172a';
    context.font = `800 ${11 * view.dpr}px ui-sans-serif, system-ui`;
    context.fillText(undecided ? '?' : entering ? 'IN' : 'OUT', x - (undecided ? 3 : entering ? 6 : 10) * view.dpr, y + 4 * view.dpr);
    context.globalAlpha = 1;
  }
  if (board === 'off') return;
  const total = soFar(counts, order, segmentID, now);
  const occupancy = insideNow(tracks, now, gate.kind, points);
  const parts: [string, string][] = [['#e2e8f0', gate.name], [IN_COLOUR, `Entered ${total.entered}`], [OUT_COLOUR, `Exited ${total.exited}`],
    ['#f8fafc', `Net ${total.net >= 0 ? '+' : ''}${total.net}`]];
  if (occupancy) parts.push(['#a5f3fc', `Inside ${occupancy.coherent}${occupancy.uncertain ? ` (+${occupancy.uncertain}?)` : ''} tracks now`]);
  if (total.pending) parts.push(['#f59e0b', `${total.pending} undecided`]);
  parts.push(['#94a3b8', 'PROVISIONAL']);
  if (board === 'band') {
    const left = view.dx, right = context.canvas.width - view.dx, bottom = context.canvas.height - view.dy;
    const size = Math.max(14, Math.min(26, (right - left) / view.dpr / 48)) * view.dpr;
    const height = size * 1.8;
    context.fillStyle = 'rgba(2, 6, 23, 0.78)';
    context.fillRect(left, bottom - height, right - left, height);
    context.font = `700 ${size}px ui-sans-serif, system-ui`;
    let x = left + size * 0.6;
    for (const [colour, text] of parts) {
      context.fillStyle = colour;
      context.fillText(text, x, bottom - height * 0.3);
      x += context.measureText(text).width + size * 1.2;
    }
    return;
  }
  context.fillStyle = 'rgba(2, 6, 23, 0.75)';
  context.fillRect(8 * view.dpr, 8 * view.dpr, 230 * view.dpr, 34 * view.dpr);
  context.font = `700 ${18 * view.dpr}px ui-sans-serif, system-ui`;
  context.fillStyle = IN_COLOUR;
  context.fillText(`IN ${total.entered}`, 16 * view.dpr, 32 * view.dpr);
  context.fillStyle = OUT_COLOUR;
  context.fillText(`OUT ${total.exited}`, 86 * view.dpr, 32 * view.dpr);
  context.fillStyle = '#f8fafc';
  context.fillText(`NET ${total.net >= 0 ? '+' : ''}${total.net}`, 166 * view.dpr, 32 * view.dpr);
}
