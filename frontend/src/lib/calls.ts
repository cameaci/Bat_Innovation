import type { AudioSource, CallActivity, MediaSegment } from '../../../electron/src/contracts';

export interface Call { audioID: string; segmentID: string; start: number; end: number; peak: number }

/**
 * Call marks of one recording placed on the video with its confirmed anchor: video PTS = anchor PTS + (audio sample -
 * anchor sample) / rate / time base. Only the anchored video gets marks (one anchor, no drift correction), and only
 * marks inside it.
 */
export function callsInVideo(activity: CallActivity, source: AudioSource, segment: MediaSegment): Call[] {
  const anchor = source.anchor;
  if (!anchor || anchor.segment_id !== segment.id) return [];
  const ticks = Number(segment.metadata.time_base.den) / Number(segment.metadata.time_base.num);
  const origin = Number(anchor.video_pts), first = Number(segment.metadata.first_pts), last = Number(segment.metadata.last_pts);
  const at = (sample: number) => origin + (sample - anchor.audio_sample) / activity.sample_rate * ticks;
  return activity.marks.map(([start, end, peak]) => ({ audioID: source.id, segmentID: segment.id, start: at(start), end: at(end), peak }))
    .filter(call => call.end >= first && call.start <= last);
}

/** Tracks alive (first to last point) at any time during a call of the same video. */
export function tracksDuringCalls(tracks: { id: string; segmentID: string; first: number; last: number }[], calls: Call[]): Set<string> {
  const found = new Set<string>();
  for (const track of tracks) {
    if (calls.some(call => call.segmentID === track.segmentID && track.first <= call.end && track.last >= call.start)) found.add(track.id);
  }
  return found;
}
