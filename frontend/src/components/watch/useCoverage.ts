import { useCallback, useRef, useState } from 'react';
import type { DisplayedFrame } from './Player';

/** Owner decision 2026-10-24: continuous viewing at this speed or slower counts as review of the playback copy. */
export const WATCH_MAX_RATE = 4;

export interface Watched { start: number; end: number; maxRate: number }

/**
 * Continuous viewing per video, from presented frames: an interval grows while frames follow each other during
 * playback (allowing the frames a fast rate skips) and closes on a seek, a pause or a jump.
 */
export function useCoverage() {
  const store = useRef(new Map<string, { proxyID: string; spans: Watched[] }>());
  const open = useRef<{ segmentID: string; index: number; pts: number; inSpan: boolean } | null>(null);
  const [version, setVersion] = useState(0);
  const bumped = useRef(0);

  const record = useCallback((segmentID: string, proxyID: string, frame: DisplayedFrame | null, playing: boolean, rate: number) => {
    // A seek (no frame) ends the interval. A paused frame is remembered so playback that starts from it covers it too.
    if (!frame) { open.current = null; return; }
    const previous = open.current && open.current.segmentID === segmentID ? open.current : null;
    const step = previous ? frame.index - previous.index : -1;
    const follows = previous !== null && step > 0 && step <= Math.ceil(rate) * 3 + 2;
    let entry = store.current.get(segmentID);
    if (!entry || entry.proxyID !== proxyID) { entry = { proxyID, spans: [] }; store.current.set(segmentID, entry); }
    const last = entry.spans[entry.spans.length - 1];
    if (follows && previous.inSpan && last) {
      // Also a frame presented just after playback stopped, such as the last frame at the end of a video.
      last.end = frame.pts;
      if (playing) last.maxRate = Math.max(last.maxRate, rate);
    } else if (playing && step !== 0) {
      entry.spans.push({ start: follows ? previous.pts : frame.pts, end: frame.pts, maxRate: rate });
    } else if (!playing) {
      if (step !== 0) open.current = { segmentID, index: frame.index, pts: frame.pts, inSpan: false };
      return;
    }
    open.current = { segmentID, index: frame.index, pts: frame.pts, inSpan: true };
    const now = Date.now();
    if (now - bumped.current > 400) { bumped.current = now; setVersion(current => current + 1); }
  }, []);

  /** Spans watched at 4x or slower, merged, for one video. */
  const spans = useCallback((segmentID: string): { proxyID: string; spans: Watched[] } | null => {
    const entry = store.current.get(segmentID);
    if (!entry) return null;
    const slow = entry.spans.filter(span => span.maxRate <= WATCH_MAX_RATE).sort((a, b) => a.start - b.start);
    const merged: Watched[] = [];
    for (const span of slow) {
      const previous = merged[merged.length - 1];
      if (previous && span.start <= previous.end) { previous.end = Math.max(previous.end, span.end); previous.maxRate = Math.max(previous.maxRate, span.maxRate); }
      else merged.push({ ...span });
    }
    return { proxyID: entry.proxyID, spans: merged };
  }, [version]);

  /** Whether every frame from first to last of a window was watched continuously at 4x or slower. */
  const covers = useCallback((segmentID: string, first: number, last: number) => {
    const entry = spans(segmentID);
    return !!entry && entry.spans.some(span => span.start <= first && span.end >= last);
  }, [spans]);

  /** Publish the latest extent now (on pause or end), since updates while playing are throttled. */
  const flush = useCallback(() => setVersion(current => current + 1), []);

  return { record, spans, covers, version, flush };
}
