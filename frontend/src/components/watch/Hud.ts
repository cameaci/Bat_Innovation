import type { ClockAnchor, MediaSegment } from '../../../../electron/src/contracts';
import { anchoredClock, clock } from '../../lib/time';
import type { View } from './BatsLayer';

/**
 * The time of the displayed frame: the declared recording clock for the anchored video (same arithmetic as the
 * export), otherwise elapsed time in the video. Never an invented wall-clock time.
 */
export function frameClock(segment: MediaSegment, anchor: ClockAnchor | null, pts: number): string {
  const base = segment.metadata.time_base;
  if (anchor && anchor.segment_id === segment.id && anchor.provenance.trim() && anchor.source_pts === segment.metadata.first_pts) {
    const offset = Number(BigInt(Math.round(pts)) - BigInt(anchor.source_pts)) * Number(base.num) / Number(base.den);
    const text = anchoredClock(anchor.utc, offset);
    if (text) return `${text} (declared clock)`;
  }
  const elapsed = Number(BigInt(Math.round(pts)) - BigInt(segment.metadata.first_pts)) * Number(base.num) / Number(base.den);
  return `elapsed ${clock(Math.floor(elapsed * 100) / 100)}`;
}

/** Clock and frame number in the top right corner of the video, like a camera's burnt-in time. */
export function drawClock(context: CanvasRenderingContext2D, view: View, text: string, frameNumber: number) {
  const label = `${text}  frame ${frameNumber}`;
  context.font = `600 ${13 * view.dpr}px ui-monospace, monospace`;
  const width = context.measureText(label).width + 12 * view.dpr;
  const right = context.canvas.width - view.dx - 6 * view.dpr;
  context.fillStyle = 'rgba(2, 6, 23, 0.75)';
  context.fillRect(right - width, view.dy + 30 * view.dpr, width, 20 * view.dpr);
  context.fillStyle = '#fde047';
  context.fillText(label, right - width + 6 * view.dpr, view.dy + 45 * view.dpr);
}
