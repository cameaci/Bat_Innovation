import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlaybackFrames } from '../../../../electron/src/contracts';
import { getAPI } from '../../api';
import { floorIndex, toTrackData } from './tracks';
import type { TrackData } from './tracks';

export const CHUNK_MS = 10000;

export interface TrackLoad { tracks: TrackData[]; error: string; shown: number; total: number; noiseHidden: number }

/**
 * Tracks of one segment in 10 s chunks of playback time: the chunk under the playhead and its neighbours are kept.
 * Tracks spanning a chunk boundary appear once. Noise tracks are left out unless asked for, and a chunk cut by the
 * backend's display budget is reported (shown < total), never hidden.
 */
export function useTracks(runID: string | null, frames: PlaybackFrames | null, chunk: number, includeNoise = false): TrackLoad {
  const [loaded, setLoaded] = useState<Map<number, { tracks: TrackData[]; shown: number; total: number; noise: number }>>(new Map());
  const [error, setError] = useState('');
  const requested = useRef(new Set<string>());
  const generation = `${runID}:${frames?.id}:${includeNoise}`;

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
      void getAPI()?.getTracks(runID, frames.segment_id, startPTS, endPTS, includeNoise).then(result => {
        if (`${runID}:${frames.id}:${includeNoise}` !== generation || !requested.current.has(key)) return;
        if (!result.ok) { setError(result.error.message); return; }
        try {
          const page = result.value;
          const data = { tracks: page.tracks.map(toTrackData), shown: page.shown, total: page.total, noise: page.noise_hidden };
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
  }, [runID, frames, chunk, generation, includeNoise]);

  return useMemo(() => {
    const unique = new Map<string, TrackData>();
    for (const page of loaded.values()) for (const track of page.tracks) unique.set(track.id, track);
    // The chunk under the playhead decides what the limit banner says.
    const here = loaded.get(chunk);
    return { tracks: [...unique.values()], error, shown: here?.shown ?? 0, total: here?.total ?? 0, noiseHidden: here?.noise ?? 0 };
  }, [loaded, error, chunk]);
}
