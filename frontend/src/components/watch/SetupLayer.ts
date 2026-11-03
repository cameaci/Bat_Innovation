import type { TrackingTestResult } from '../../../../electron/src/contracts';
import type { View } from './BatsLayer';

type Point = [number, number];

function polygon(context: CanvasRenderingContext2D, view: View, points: Point[], close: boolean) {
  context.beginPath();
  points.forEach(([x, y], index) => {
    const px = view.dx + x * view.scale, py = view.dy + y * view.scale;
    if (index === 0) context.moveTo(px, py); else context.lineTo(px, py);
  });
  if (close) context.closePath();
}

/** Detection area (green outline), exclusion zones (hatched grey), the polygon being drawn and the size reference. */
export function drawSetup(context: CanvasRenderingContext2D, view: View, setup: {
  area: Point[][]; exclusions: Point[][]; draft: Point[]; draftKind: 'area' | 'exclusion' | null; reference: Point; targetPx: number;
  suggestions?: Point[][];
}) {
  context.lineWidth = 2 * view.dpr;
  for (const shape of setup.area) {
    polygon(context, view, shape, true);
    context.strokeStyle = '#22c55e';
    context.setLineDash([]);
    context.stroke();
  }
  for (const shape of setup.suggestions ?? []) {
    // Proposed exclusions from a test run, not yet accepted.
    polygon(context, view, shape, true);
    context.strokeStyle = '#f59e0b';
    context.setLineDash([3 * view.dpr, 3 * view.dpr]);
    context.stroke();
  }
  for (const shape of setup.exclusions) {
    polygon(context, view, shape, true);
    context.fillStyle = 'rgba(15, 23, 42, 0.55)';
    context.fill();
    context.strokeStyle = '#94a3b8';
    context.setLineDash([6 * view.dpr, 4 * view.dpr]);
    context.stroke();
  }
  if (setup.draft.length > 0) {
    polygon(context, view, setup.draft, false);
    context.strokeStyle = setup.draftKind === 'exclusion' ? '#cbd5e1' : '#4ade80';
    context.setLineDash([4 * view.dpr, 3 * view.dpr]);
    context.stroke();
    for (const [x, y] of setup.draft) {
      context.beginPath();
      context.arc(view.dx + x * view.scale, view.dy + y * view.scale, 3 * view.dpr, 0, Math.PI * 2);
      context.fillStyle = '#fde047';
      context.fill();
    }
  }
  context.setLineDash([]);
  const [rx, ry] = setup.reference;
  context.beginPath();
  context.arc(view.dx + rx * view.scale, view.dy + ry * view.scale, Math.max(2, setup.targetPx / 2 * view.scale), 0, Math.PI * 2);
  context.strokeStyle = '#ef4444';
  context.lineWidth = 2 * view.dpr;
  context.stroke();
  context.font = `${11 * view.dpr}px ui-sans-serif, system-ui`;
  context.fillStyle = '#fecaca';
  context.fillText(`target ${setup.targetPx} px`, view.dx + rx * view.scale + setup.targetPx / 2 * view.scale + 4 * view.dpr, view.dy + ry * view.scale);
}

/** Test-run detections at the displayed frame: accepted in green, rejected by size in grey. */
export function drawDetections(context: CanvasRenderingContext2D, view: View, result: TrackingTestResult, pts: number) {
  const entry = result.detections.find(item => Number(item.pts) === pts);
  if (!entry) return;
  context.lineWidth = 1.5 * view.dpr;
  const box = ([x0, y0, x1, y1]: number[], colour: string) => {
    context.strokeStyle = colour;
    context.strokeRect(view.dx + x0! * view.scale, view.dy + y0! * view.scale, (x1! - x0!) * view.scale, (y1! - y0!) * view.scale);
  };
  entry.accepted.forEach(item => box(item, '#22c55e'));
  entry.rejected.forEach(item => box(item.slice(0, 4) as number[], '#64748b'));
}
