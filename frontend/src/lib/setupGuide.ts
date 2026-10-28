import type { Gate, TrackingSettings, TrackingTestResult } from '../../../electron/src/contracts';

type Point = [number, number];

/**
 * Starting points by roost type, after published field guidance (ThruTracker roost guide, BCT practice). They set a
 * few visible settings and give a gate tip; they are starting values, never validated thresholds.
 */
export const ROOST_PRESETS: { key: string; label: string; settings: Partial<TrackingSettings>; tip: string }[] = [
  { key: 'bat_box', label: 'Bat box', settings: { polarity: 'both', activity: 'sparse', target_speed: 4 },
    tip: 'Draw the gate just below the opening, across the drop-out path, clear of the frame edge.' },
  { key: 'building', label: 'Building', settings: { polarity: 'both', activity: 'normal', target_speed: 4 },
    tip: 'Exits may be unknown: test over a busy span, look at where tracks start, then put a gate across each exit.' },
  { key: 'tree', label: 'Tree', settings: { polarity: 'both', activity: 'sparse', target_speed: 4 },
    tip: 'Exclude moving foliage away from the exit and keep the gate close below the exit, against open sky.' },
  { key: 'cave', label: 'Cave entrance', settings: { polarity: 'both', activity: 'normal', target_speed: 4 },
    tip: 'Place the gate where contrast is high and bats are spaced out, past the swirling at the mouth.' },
  { key: 'bridge', label: 'Bridge', settings: { polarity: 'both', activity: 'normal', target_speed: 5 },
    tip: 'Bats may leave in several directions: one gate per exit and note what the camera does not cover.' },
  { key: 'large', label: 'Very large emergence', settings: { polarity: 'light', activity: 'dense', target_speed: 5 },
    tip: 'Choose a section where bats do not overlap much; exclude swirling areas that do not cross the gate.' },
];

/** The largest target size the tracker accepts (a bat close to a 1080p trail camera is 100-200 px across). */
export const MAX_TARGET_PX = 240;
export interface Measured { targetPx: number; contrast: number; polarity: 'light' | 'dark' | 'both'; area: number; pieces?: number }

/** The test-run detection under (or nearest) a click on the displayed frame, as suggested settings. */
export function measureAt(result: TrackingTestResult | null | undefined, pts: number, point: Point, targetPx: number): Measured | null {
  const item = result?.detections.find(entry => Number(entry.pts) === Math.round(pts));
  if (!item) return null;
  let best: { index: number; distance: number } | null = null;
  item.accepted.forEach(([x0, y0, x1, y1], index) => {
    const distance = Math.hypot((x0 + x1) / 2 - point[0], (y0 + y1) / 2 - point[1]);
    if (distance <= Math.max(2 * targetPx, (x1 - x0) + (y1 - y0)) && (!best || distance < best.distance)) best = { index, distance };
  });
  if (!best) return null;
  const index = (best as { index: number }).index;
  const [area, contrast, sign] = item.measures[index]!;
  // With a target size much smaller than the bat, one bat is found as several pieces (wings, body, blur): the pieces
  // around the click are grouped, so a single click measures the whole bat rather than one piece.
  let union = [...item.accepted[index]!] as [number, number, number, number];
  const used = new Set([index]);
  for (let grown = true; grown;) {
    grown = false;
    const gap = Math.max(2 * targetPx, 0.5 * Math.max(union[2] - union[0], union[3] - union[1]));
    item.accepted.forEach(([x0, y0, x1, y1], other) => {
      if (used.has(other) || x0 > union[2] + gap || x1 < union[0] - gap || y0 > union[3] + gap || y1 < union[1] - gap) return;
      union = [Math.min(union[0], x0), Math.min(union[1], y0), Math.max(union[2], x1), Math.max(union[3], y1)];
      used.add(other); grown = true;
    });
  }
  const size = used.size > 1 ? Math.sqrt((union[2] - union[0]) * (union[3] - union[1])) : 2 * Math.sqrt(area / Math.PI);
  // Pieces of one bat that are partly lighter and partly darker (a blurred wing over a bright wall) keep both polarities.
  const signs = new Set([...used].map(other => item.measures[other]![2] > 0));
  return { area, contrast, polarity: signs.size > 1 ? 'both' : sign > 0 ? 'light' : 'dark', targetPx: Math.min(MAX_TARGET_PX, Math.max(3, Math.round(size))), ...(used.size > 1 ? { pieces: used.size } : {}) };
}

/** Settings from a measured target: its size, its polarity, and a threshold at half its contrast (never above 7). */
export function applyMeasured(settings: TrackingSettings, measured: Measured): TrackingSettings {
  // Half the measured contrast, in half steps, so a similar but fainter target is still found.
  return { ...settings, target_px: measured.targetPx, polarity: measured.polarity, threshold: Math.min(7, Math.max(1.5, Math.round(measured.contrast) / 2)) };
}

/**
 * Whether the set target size fits what the test found, from the median measured size of its detections (at least 30).
 * Much smaller targets are diluted by the matching filter and missed (a dense thermal swarm 3-4 px across against the
 * 12 px default); much larger ones are found in pieces (a bat close to a trail camera). A smaller size can be read off
 * the detections; a larger one cannot (only pieces were measured), so the reviewer is asked to click a bat.
 */
export function sizeAdvice(result: TrackingTestResult | null | undefined, targetPx: number): { message: string; suggestion: number | null } | null {
  const diameters = (result?.detections ?? []).flatMap(item => item.measures.map(([area]) => 2 * Math.sqrt(area / Math.PI))).sort((a, b) => a - b);
  if (diameters.length < 30) return null;
  const median = diameters[Math.floor(diameters.length / 2)]!;
  // The measured diameter is the area above half the peak, well under the visible extent of a blurred bat; dilution
  // only loses small targets, so the advice to shrink is for clearly smaller and small ones (a 3-4 px swarm at 12 px).
  if (median < 0.4 * targetPx && median < 16) {
    const suggestion = Math.max(3, Math.round(median));
    return { message: `Most targets measure about ${median.toFixed(1)} px across, much smaller than the ${targetPx} px set: small bats are diluted and missed at this size.`, suggestion };
  }
  if (median > 1.5 * targetPx) {
    return { message: `Targets measure ${median.toFixed(0)} px or more across, larger than the ${targetPx} px set, so each bat may be found in pieces. Click a bat in the test range to measure it as a whole.`, suggestion: null };
  }
  return null;
}

/** What the test run says about the footage itself, beyond the tracks. */
export function testWarnings(stats: TrackingTestResult['stats'] | undefined): string[] {
  if (!stats) return [];
  const warnings: string[] = [];
  const frames = Math.max(1, stats.frames);
  if (stats.repeated_frames > 0) warnings.push(`${Math.round(100 * stats.repeated_frames / frames)} % of frames repeat the previous one (frame-rate conversion or a camera freeze); tracks skip them.`);
  if (stats.gain_jumps > 0) warnings.push(`The camera's brightness jumped ${stats.gain_jumps} time${stats.gain_jumps === 1 ? '' : 's'} (automatic gain); these steps were compensated.`);
  if (stats.limit_frames > 0) warnings.push(`${stats.limit_frames} frame${stats.limit_frames === 1 ? '' : 's'} had more targets than the expected activity allows and were skipped: choose Dense or raise the threshold.`);
  if (stats.static_detections > 0) warnings.push('A spot stayed lit for seconds (a hot fixture or a resting bat); it cannot start tracks.');
  return warnings;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Placement problems that make a gate miss bats (ThruTracker troubleshooting): too close to the frame edge for a bat
 * to be seen on both sides, along the main flight direction instead of across it, or over an excluded zone.
 */
export function gateWarnings(gate: Pick<Gate, 'kind' | 'points' | 'frame_w' | 'frame_h'>, exclusions: Point[][], headings: Point[]): string[] {
  const warnings: string[] = [];
  const margin = 0.05 * Math.min(gate.frame_w, gate.frame_h);
  const edges = gate.points.map((point, index) => [point, gate.points[index + 1] ?? gate.points[0]!] as [Point, Point]);
  const segments = gate.kind === 'line' ? edges.slice(0, gate.points.length - 1) : edges;
  const nearEdge = gate.points.some(([x, y]) => Math.min(x, y, gate.frame_w - x, gate.frame_h - y) < margin);
  // A line that ends at the frame edge is fine; an area or line running along the edge is not.
  if (gate.kind !== 'line' && nearEdge) warnings.push('The gate runs within 5 % of the frame edge: bats leaving there are never seen on the far side.');
  if (gate.kind === 'line' && segments.every(([a, b]) => [a, b].every(([x]) => Math.min(x, gate.frame_w - x) < margin) || [a, b].every(([, y]) => Math.min(y, gate.frame_h - y) < margin)))
    warnings.push('The line lies along the frame edge: bats must be seen on both sides of it.');
  if (gate.kind === 'line' && headings.length >= 5) {
    const [[ax, ay], [bx, by]] = [gate.points[0]!, gate.points[gate.points.length - 1]!];
    const length = Math.hypot(bx - ax, by - ay) || 1;
    const along = headings.filter(([hx, hy]) => Math.abs((hx * (bx - ax) + hy * (by - ay)) / (length * (Math.hypot(hx, hy) || 1))) > 0.85).length;
    if (along / headings.length > 0.6) warnings.push('Most tracks fly along this line rather than across it: few crossings will be found. Turn the gate across the flight path.');
  }
  const centre = (shape: Point[]): Point => [shape.reduce((sum, p) => sum + p[0], 0) / shape.length, shape.reduce((sum, p) => sum + p[1], 0) / shape.length];
  if (exclusions.some(shape => segments.some(([a, b]) => distanceToSegment(centre(shape), a, b) < 0.5 * Math.max(...shape.map(p => Math.hypot(p[0] - centre(shape)[0], p[1] - centre(shape)[1]))))))
    warnings.push('The gate passes through an excluded zone: no targets are detected there, so crossings there are never counted.');
  return warnings;
}
