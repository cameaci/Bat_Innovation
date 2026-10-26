import type { TrackQuality, TrackRecord } from '../../../../electron/src/contracts';

/** One track in numeric arrays for per-frame drawing. PTS values must be safe integers (checked on load). */
export interface TrackData {
  id: string;
  index: number;
  quality: TrackQuality;
  first: number;
  last: number;
  pts: Float64Array;
  x: Float32Array;
  y: Float32Array;
  area: Float32Array;
}

export function toTrackData(record: TrackRecord): TrackData {
  const count = record.points.length;
  const data: TrackData = {
    id: record.id, index: record.track_index, quality: record.quality ?? 'unrated',
    first: Number(record.first_pts), last: Number(record.last_pts),
    pts: new Float64Array(count), x: new Float32Array(count), y: new Float32Array(count), area: new Float32Array(count),
  };
  record.points.forEach(([pts, x, y, area], index) => {
    const value = Number(pts);
    if (!Number.isSafeInteger(value)) throw new Error('Track timestamps exceed the safe display range.');
    data.pts[index] = value; data.x[index] = x; data.y[index] = y; data.area[index] = area;
  });
  return data;
}

/** Index of the last element <= value, or -1. */
export function floorIndex(values: ArrayLike<number>, value: number): number {
  let low = 0, high = values.length - 1, found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (values[middle]! <= value) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found;
}

/** Position at `now`, interpolated between the bracketing points; null outside the track's span. */
export function positionAt(track: TrackData, now: number): { x: number; y: number; area: number; index: number } | null {
  if (now < track.first || now > track.last) return null;
  const index = floorIndex(track.pts, now);
  if (index < 0) return null;
  const next = index + 1 < track.pts.length ? index + 1 : index;
  const span = track.pts[next]! - track.pts[index]!;
  const t = span > 0 ? (now - track.pts[index]!) / span : 0;
  return { x: track.x[index]! + t * (track.x[next]! - track.x[index]!), y: track.y[index]! + t * (track.y[next]! - track.y[index]!),
    area: track.area[index]!, index };
}
