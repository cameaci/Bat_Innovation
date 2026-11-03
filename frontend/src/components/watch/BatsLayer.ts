import { floorIndex, positionAt } from './tracks';
import type { TrackData } from './tracks';

/** Source pixels to canvas pixels for a letterboxed (object-contain) video. */
export interface View { scale: number; dx: number; dy: number; dpr: number }

export function containView(canvasWidth: number, canvasHeight: number, sourceWidth: number, sourceHeight: number, dpr: number): View {
  const scale = Math.min(canvasWidth / sourceWidth, canvasHeight / sourceHeight);
  return { scale, dx: (canvasWidth - sourceWidth * scale) / 2, dy: (canvasHeight - sourceHeight * scale) / 2, dpr };
}

export const UNCERTAIN = '#f59e0b';
/** Okabe-Ito hues: distinguishable with the common colour-vision deficiencies. */
export const TRACK_COLOURS = ['#E69F00', '#56B4E9', '#009E73', '#F0E442', '#4C9BE8', '#D55E00', '#CC79A7', '#FFFFFF'];
export type MarkerStyle = 'rings' | 'boxes' | 'dots';
/** Above this many visible tracks the ID labels are left out so the bats stay visible. */
export const LABEL_LIMIT = 25;

export function trackColour(index: number): string { return TRACK_COLOURS[index % TRACK_COLOURS.length]!; }

/**
 * Individual tracks at the displayed frame, in the chosen marker style, each in its own colour: rings or boxes sized
 * to the target with a heading arrow, or ThruTracker-style dots (a diamond and a dotted trail). Coherent tracks are
 * solid and uncertain ones dashed. Markers show tracker output for review; they are not verified animals.
 */
export function drawBats(context: CanvasRenderingContext2D, view: View, tracks: TrackData[], now: number,
  ticksPerSecond: number, options: { highlight?: string | null; showRejected?: boolean; style?: MarkerStyle } = {}): number {
  const style = options.style ?? 'rings';
  const trail = ticksPerSecond * 1;
  const heading = ticksPerSecond * 0.25;
  const px = (x: number) => view.dx + x * view.scale;
  const py = (y: number) => view.dy + y * view.scale;
  const visible: { track: TrackData; at: NonNullable<ReturnType<typeof positionAt>> }[] = [];
  for (const track of tracks) {
    if (track.quality === 'noise' && !options.showRejected) continue;
    const at = positionAt(track, now);
    if (at) visible.push({ track, at });
  }
  const labels = visible.length <= LABEL_LIMIT;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const { track, at } of visible) {
    const firm = track.quality === 'coherent' || track.quality === 'unrated';
    const colour = trackColour(track.index);
    const highlighted = options.highlight === track.id;
    const dash = firm ? [] : [5 * view.dpr, 4 * view.dpr];
    const start = Math.max(0, floorIndex(track.pts, now - trail));
    if (style === 'dots') {
      // A dot at every detection of the last second, fading with age.
      for (let i = start; i <= at.index; i += 1) {
        context.globalAlpha = Math.max(0.15, 1 - (now - track.pts[i]!) / trail);
        context.fillStyle = colour;
        context.beginPath();
        context.arc(px(track.x[i]!), py(track.y[i]!), 1.8 * view.dpr, 0, Math.PI * 2);
        context.fill();
      }
    } else {
      for (let i = start; i < at.index; i += 1) {
        context.strokeStyle = colour;
        context.globalAlpha = Math.max(0.1, 1 - (now - track.pts[i + 1]!) / trail) * 0.8;
        context.lineWidth = 2 * view.dpr;
        context.beginPath();
        context.moveTo(px(track.x[i]!), py(track.y[i]!));
        context.lineTo(px(track.x[i + 1]!), py(track.y[i + 1]!));
        context.stroke();
      }
    }
    context.globalAlpha = 1;
    const x = px(at.x), y = py(at.y);
    const size = Math.sqrt(Math.max(1, at.area)) * view.scale;
    const radius = style === 'dots' ? Math.max(5 * view.dpr, size * 0.8) : Math.max(9 * view.dpr, size * 1.2);
    context.setLineDash(dash);
    context.strokeStyle = highlighted ? '#fde047' : firm ? colour : UNCERTAIN;
    context.lineWidth = (highlighted ? 4 : style === 'dots' ? 2 : 2.5) * view.dpr;
    context.beginPath();
    if (style === 'rings') context.arc(x, y, radius, 0, Math.PI * 2);
    else if (style === 'boxes') context.rect(x - radius, y - radius, radius * 2, radius * 2);
    else { context.moveTo(x, y - radius); context.lineTo(x + radius, y); context.lineTo(x, y + radius); context.lineTo(x - radius, y); context.closePath(); }
    context.stroke();
    context.setLineDash([]);
    if (style !== 'dots') {
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
    }
    if (labels || highlighted) {
      const label = `#${track.index + 1}`;
      context.font = `600 ${12 * view.dpr}px ui-sans-serif, system-ui`;
      const width = context.measureText(label).width + 8 * view.dpr;
      context.fillStyle = 'rgba(2, 6, 23, 0.8)';
      context.fillRect(x + radius * 0.7, y - radius - 16 * view.dpr, width, 16 * view.dpr);
      context.fillStyle = firm ? colour : UNCERTAIN;
      context.fillText(label, x + radius * 0.7 + 4 * view.dpr, y - radius - 4 * view.dpr);
    }
  }
  return visible.length;
}
