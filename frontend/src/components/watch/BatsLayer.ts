import { floorIndex, positionAt } from './tracks';
import type { TrackData } from './tracks';

/** Source pixels to canvas pixels for a letterboxed (object-contain) video. */
export interface View { scale: number; dx: number; dy: number; dpr: number }

export function containView(canvasWidth: number, canvasHeight: number, sourceWidth: number, sourceHeight: number, dpr: number): View {
  const scale = Math.min(canvasWidth / sourceWidth, canvasHeight / sourceHeight);
  return { scale, dx: (canvasWidth - sourceWidth * scale) / 2, dy: (canvasHeight - sourceHeight * scale) / 2, dpr };
}

export const BAT_RED = '#ef4444';
export const UNCERTAIN = '#f59e0b';

/**
 * Individual tracks at the displayed frame: a ring sized to the target, an ID label, a heading arrow and a fading
 * trail. Rings mark tracker output for review; they are not verified animals.
 */
export function drawBats(context: CanvasRenderingContext2D, view: View, tracks: TrackData[], now: number,
  ticksPerSecond: number, options: { highlight?: string | null; showRejected?: boolean } = {}): number {
  const trail = ticksPerSecond * 1;
  const heading = ticksPerSecond * 0.25;
  const px = (x: number) => view.dx + x * view.scale;
  const py = (y: number) => view.dy + y * view.scale;
  let live = 0;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const track of tracks) {
    if (track.quality === 'noise' && !options.showRejected) continue;
    const at = positionAt(track, now);
    if (!at) continue;
    live += 1;
    const colour = track.quality === 'uncertain' || track.quality === 'noise' ? UNCERTAIN : BAT_RED;
    const highlighted = options.highlight === track.id;
    // Fading trail over the last second.
    const start = Math.max(0, floorIndex(track.pts, now - trail));
    for (let i = start; i < at.index; i += 1) {
      const age = (now - track.pts[i + 1]!) / trail;
      context.strokeStyle = colour;
      context.globalAlpha = Math.max(0.1, 1 - age) * 0.8;
      context.lineWidth = 2 * view.dpr;
      context.beginPath();
      context.moveTo(px(track.x[i]!), py(track.y[i]!));
      context.lineTo(px(track.x[i + 1]!), py(track.y[i + 1]!));
      context.stroke();
    }
    context.globalAlpha = 1;
    const x = px(at.x), y = py(at.y);
    const radius = Math.max(9 * view.dpr, Math.sqrt(Math.max(1, at.area)) * view.scale * 1.2);
    context.setLineDash(colour === UNCERTAIN ? [5 * view.dpr, 4 * view.dpr] : []);
    context.strokeStyle = highlighted ? '#fde047' : colour;
    context.lineWidth = (highlighted ? 4 : 2.5) * view.dpr;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.stroke();
    context.setLineDash([]);
    // Heading arrow from the movement over the last quarter second.
    const from = Math.max(0, floorIndex(track.pts, now - heading));
    const vx = at.x - track.x[from]!, vy = at.y - track.y[from]!;
    const length = Math.hypot(vx, vy);
    if (length * view.scale > 1.5) {
      const ux = vx / length, uy = vy / length;
      const tipX = x + ux * radius * 2.2, tipY = y + uy * radius * 2.2;
      context.beginPath();
      context.moveTo(x + ux * radius, y + uy * radius);
      context.lineTo(tipX, tipY);
      context.moveTo(tipX, tipY);
      context.lineTo(tipX - ux * 7 * view.dpr - uy * 5 * view.dpr, tipY - uy * 7 * view.dpr + ux * 5 * view.dpr);
      context.moveTo(tipX, tipY);
      context.lineTo(tipX - ux * 7 * view.dpr + uy * 5 * view.dpr, tipY - uy * 7 * view.dpr - ux * 5 * view.dpr);
      context.stroke();
    }
    const label = `#${track.index + 1}`;
    context.font = `600 ${12 * view.dpr}px ui-sans-serif, system-ui`;
    const width = context.measureText(label).width + 8 * view.dpr;
    context.fillStyle = colour;
    context.fillRect(x + radius * 0.7, y - radius - 16 * view.dpr, width, 16 * view.dpr);
    context.fillStyle = '#ffffff';
    context.fillText(label, x + radius * 0.7 + 4 * view.dpr, y - radius - 4 * view.dpr);
  }
  return live;
}
