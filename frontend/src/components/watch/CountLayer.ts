import type { Crossing, Gate, GateCounts } from '../../../../electron/src/contracts';
import type { View } from './BatsLayer';

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

/**
 * Gates at the displayed frame (paused spans in grey with a notice), the counts so far and a short flash for each
 * crossing just passed. Counts are provisional candidate evidence.
 */
export function drawCounts(context: CanvasRenderingContext2D, view: View, counts: GateCounts, order: Map<string, number>,
  segmentID: string, now: number, ticksPerSecond: number) {
  const gate = counts.gate;
  const intervals = counts.valid_spans[segmentID] ?? [];
  const valid = intervals.find(item => (item.from_pts === null || now >= item.from_pts) && (item.to_pts === null || now < item.to_pts));
  const points = valid?.points ?? gate.points;
  context.lineWidth = 3 * view.dpr;
  context.setLineDash(valid ? [] : [8 * view.dpr, 6 * view.dpr]);
  context.strokeStyle = valid ? '#f43f5e' : '#64748b';
  shape(context, view, gate, points);
  if (gate.kind !== 'line') { context.fillStyle = valid ? 'rgba(244, 63, 94, 0.12)' : 'rgba(100, 116, 139, 0.15)'; context.fill(); }
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
    context.fillStyle = '#fecdd3';
    context.fillText('A', mx + lx * 18 * view.dpr, my + ly * 18 * view.dpr);
    context.fillText('B', mx - lx * 18 * view.dpr, my - ly * 18 * view.dpr);
  }
  if (!valid) {
    context.fillStyle = 'rgba(15, 23, 42, 0.85)';
    context.fillRect(view.dx + ax * view.scale, view.dy + ay * view.scale, 190 * view.dpr, 20 * view.dpr);
    context.fillStyle = '#e2e8f0';
    context.fillText('Gate paused: reconfirm it', view.dx + ax * view.scale + 6 * view.dpr, view.dy + ay * view.scale + 14 * view.dpr);
  }
  // Counter board.
  const total = soFar(counts, order, segmentID, now);
  context.fillStyle = 'rgba(2, 6, 23, 0.75)';
  context.fillRect(8 * view.dpr, 8 * view.dpr, 230 * view.dpr, 34 * view.dpr);
  context.font = `700 ${18 * view.dpr}px ui-sans-serif, system-ui`;
  context.fillStyle = IN_COLOUR;
  context.fillText(`IN ${total.entered}`, 16 * view.dpr, 32 * view.dpr);
  context.fillStyle = OUT_COLOUR;
  context.fillText(`OUT ${total.exited}`, 86 * view.dpr, 32 * view.dpr);
  context.fillStyle = '#f8fafc';
  context.fillText(`NET ${total.net >= 0 ? '+' : ''}${total.net}`, 166 * view.dpr, 32 * view.dpr);
  // Flash for crossings passed in the last 0.8 s of this video.
  for (const crossing of counts.crossings) {
    const age = now - Number(crossing.pts);
    if (crossing.segment_id !== segmentID || age < 0 || age > 0.8 * ticksPerSecond) continue;
    const entering = effectiveDirection(crossing) === gate.entry_direction;
    const label = crossing.quality === 'uncertain' && !crossing.review ? `? #${crossing.track_index + 1}` : `+1 ${entering ? 'IN' : 'OUT'} #${crossing.track_index + 1}`;
    context.globalAlpha = 1 - age / (0.8 * ticksPerSecond);
    context.fillStyle = crossing.quality === 'uncertain' && !crossing.review ? '#f59e0b' : entering ? IN_COLOUR : OUT_COLOUR;
    context.font = `700 ${20 * view.dpr}px ui-sans-serif, system-ui`;
    context.fillText(label, view.dx + ax * view.scale + 12 * view.dpr, view.dy + ay * view.scale + 48 * view.dpr);
    context.globalAlpha = 1;
  }
}
