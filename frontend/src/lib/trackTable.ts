import type { Candidate, Crossing, MediaSegment, TrackLabels } from '../../../electron/src/contracts';

/** Fixed categories (labels inform the reviewer; they never change a count layer). */
export const CATEGORY_NAMES: Record<string, string> = {
  exit: 'exit', entry: 'entry', fly_by: 'fly-by', foraging: 'foraging', not_a_bat: 'not a bat', uncertain: 'uncertain',
};
export const categoryName = (category: string) => CATEGORY_NAMES[category] ?? category;

/** Suggestions only: the resident UK species and the usual genus-level entries. Species is always typed or picked by a person. */
export const UK_SPECIES = [
  'Pipistrellus pipistrellus', 'Pipistrellus pygmaeus', 'Pipistrellus nathusii', 'Pipistrellus sp.',
  'Myotis daubentonii', 'Myotis nattereri', 'Myotis mystacinus', 'Myotis brandtii', 'Myotis alcathoe', 'Myotis bechsteinii', 'Myotis sp.',
  'Nyctalus noctula', 'Nyctalus leisleri', 'Nyctalus sp.', 'Eptesicus serotinus', 'Plecotus auritus', 'Plecotus austriacus', 'Plecotus sp.',
  'Barbastella barbastellus', 'Rhinolophus ferrumequinum', 'Rhinolophus hipposideros',
];

export interface TrackRow {
  id: string; segmentID: string; video: number; index: number; first: number; last: number;
  /** Seconds from the start of its video, and the track's duration in seconds. */
  start: number; seconds: number; points: number;
  quality: Candidate['quality']; decision: string | null; crossings: string[]; category: string | null; species: string; comment: string;
}

export interface TrackFilter { quality: 'all' | Candidate['quality']; label: 'all' | 'unlabelled' | string; crossed: boolean; video: string | null }
export type TrackSort = 'time' | 'duration' | 'points';

/** One row per track of the run, in survey order, with its crossings of the chosen gate (in or out) and its current label. */
export function trackRows(candidates: Candidate[], labels: TrackLabels | null, crossings: Crossing[], entry: string | null, segments: MediaSegment[]): TrackRow[] {
  const position = new Map(segments.map((segment, index) => [segment.id, index]));
  const rate = new Map(segments.map(segment => [segment.id, Number(segment.metadata.time_base.num) / Number(segment.metadata.time_base.den)]));
  const origin = new Map(segments.map(segment => [segment.id, Number(segment.metadata.first_pts)]));
  const crossed = new Map<string, string[]>();
  for (const crossing of crossings) crossed.set(crossing.track_id, [...crossed.get(crossing.track_id) ?? [], crossing.direction === entry ? 'in' : 'out']);
  return candidates.filter(item => position.has(item.segment_id)).map(item => {
    const label = labels?.tracks[item.track_id];
    const first = Number(item.first_pts), last = Number(item.last_pts);
    return { id: item.track_id, segmentID: item.segment_id, video: position.get(item.segment_id)! + 1, index: item.track_index, first, last,
      start: (first - origin.get(item.segment_id)!) * rate.get(item.segment_id)!, seconds: (last - first) * rate.get(item.segment_id)!, points: item.point_count, quality: item.quality, decision: item.decision?.decision ?? null,
      crossings: crossed.get(item.track_id) ?? [], category: label?.category ?? null, species: label?.species ?? '', comment: label?.comment ?? '' };
  }).sort((a, b) => a.video - b.video || a.first - b.first || a.index - b.index);
}

export function filterRows(rows: TrackRow[], filter: TrackFilter, sort: TrackSort): TrackRow[] {
  const kept = rows.filter(row => (filter.quality === 'all' || row.quality === filter.quality) &&
    (filter.label === 'all' || (filter.label === 'unlabelled' ? row.category === null : row.category === filter.label)) &&
    (!filter.crossed || row.crossings.length > 0) && (filter.video === null || row.segmentID === filter.video));
  if (sort === 'duration') return [...kept].sort((a, b) => b.seconds - a.seconds);
  if (sort === 'points') return [...kept].sort((a, b) => b.points - a.points);
  return kept;
}

/** Even-odd point-in-polygon test in source pixels. */
export function inside(point: [number, number], polygon: [number, number][]): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i]!, [xj, yj] = polygon[j]!;
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) result = !result;
  }
  return result;
}

/** IDs of the tracks with at least one point inside the drawn area. */
export function tracksInArea(tracks: { id: string; x: ArrayLike<number>; y: ArrayLike<number> }[], polygon: [number, number][]): string[] {
  return tracks.filter(track => Array.from({ length: track.x.length }, (_, i) => i).some(i => inside([track.x[i]!, track.y[i]!], polygon))).map(track => track.id);
}
