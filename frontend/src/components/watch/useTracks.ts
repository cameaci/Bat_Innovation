import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlaybackFrames } from '../../../../electron/src/contracts';
import { getAPI } from '../../api';
import { floorIndex, toTrackData } from './tracks';
import type { TrackData } from './tracks';

export const CHUNK_MS = 30000;

/**
 * Tracks of one segment in 30 s chunks of playback time: the chunk under the playhead and the next one are loaded,
 * and only those two are kept. Tracks spanning a chunk boundary appear once.
 */
export function useTracks(runID: string | null, frames: PlaybackFrames | null, chunk: number): { tracks: TrackData[]; error: string } {
  const [loaded, setLoaded] = useState<Map<number, TrackData[]>>(new Map());
  const [error, setError] = useState('');
  const requested = useRef(new Set<string>());
  const generation = `${runID}:${frames?.id}`;

  useEffect(() => { setLoaded(new Map()); setError(''); requested.current = new Set(); }, [generation]);

  useEffect(() => {
    if (!runID || !frames || frames.proxy_ms.length === 0) return;
    const wanted = [chunk, chunk + 1].filter(index => index >= 0 && index * CHUNK_MS <= frames.duration_ms);
    for (const index of wanted) {
      const key = `${generation}:${index}`;
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      // Frame indices of the first frame at or after each chunk boundary (copy times are whole milliseconds).
      const startIndex = floorIndex(frames.proxy_ms, index * CHUNK_MS - 1) + 1;
      const after = floorIndex(frames.proxy_ms, (index + 1) * CHUNK_MS - 1) + 1;
      if (startIndex >= frames.source_pts.length) continue;
      const startPTS = frames.source_pts[startIndex]!;
      const endPTS = after < frames.source_pts.length ? frames.source_pts[after]! : null;
      void getAPI()?.getTracks(runID, frames.segment_id, startPTS, endPTS).then(result => {
        if (`${runID}:${frames.id}` !== generation || !requested.current.has(key)) return;
        if (!result.ok) { setError(result.error.message); return; }
        try {
          const data = result.value.map(toTrackData);
          setLoaded(previous => {
            const next = new Map([...previous].filter(([held]) => held >= index - 1 && held <= index + 1));
            next.set(index, data);
            return next;
          });
        } catch (problem) { setError(problem instanceof Error ? problem.message : 'Tracks could not be read.'); }
      }).catch(() => setError('Tracks could not be loaded.'));
    }
    // Chunks that fell out of the kept range may be requested again later.
    for (const key of [...requested.current]) {
      const index = Number(key.split(':').pop());
      if (index < chunk - 1 || index > chunk + 1) requested.current.delete(key);
    }
  }, [runID, frames, chunk, generation]);

  const tracks = useMemo(() => {
    const unique = new Map<string, TrackData>();
    for (const list of loaded.values()) for (const track of list) unique.set(track.id, track);
    return [...unique.values()];
  }, [loaded]);
  return { tracks, error };
}
