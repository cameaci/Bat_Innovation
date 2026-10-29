import { useState, type MouseEvent } from 'react';
import { AudioLines } from 'lucide-react';
import type { AudioSource, CallActivity, MediaSegment } from '../../../../electron/src/contracts';
import { getAPI } from '../../api';
import { callsInVideo, type Call } from '../../lib/calls';
import { Button } from '../ui/button';

const WIDTH = 1000, HEIGHT = 36;

/**
 * One lane per recording synchronised to the displayed video: band level above the noise floor and call marks from
 * the call-activity analysis, on the video's time axis. Clicking a mark goes there and lists the tracks alive during
 * it. Calls are activity marks, not species and not proof of which tracked target called.
 */
export function AudioLanes({ sources, segment, tracks, onCalls, onSeek }: {
  sources: AudioSource[];
  segment: MediaSegment;
  tracks: { id: string; index: number; first: number; last: number }[];
  onCalls: (audioID: string, calls: Call[]) => void;
  onSeek: (pts: number) => void;
}) {
  const [activity, setActivity] = useState<Record<string, CallActivity>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState<Call | null>(null);
  const synced = sources.filter(source => source.anchor?.segment_id === segment.id);
  if (synced.length === 0) return null;
  const ticks = Number(segment.metadata.time_base.den) / Number(segment.metadata.time_base.num);
  const first = Number(segment.metadata.first_pts), last = Number(segment.metadata.last_pts);
  const x = (pts: number) => Math.max(0, Math.min(WIDTH, (pts - first) / Math.max(1, last - first) * WIDTH));

  async function find(source: AudioSource) {
    setBusy(source.id); setError('');
    const result = await getAPI()?.callActivity(source.id);
    setBusy(null);
    if (!result?.ok) { setError(result?.error.message ?? 'The local backend is unavailable.'); return; }
    setActivity(previous => ({ ...previous, [source.id]: result.value }));
    onCalls(source.id, callsInVideo(result.value, source, segment));
  }

  function click(event: MouseEvent<SVGSVGElement>, calls: Call[]) {
    const box = event.currentTarget.getBoundingClientRect();
    const pts = first + (event.clientX - box.left) / box.width * (last - first);
    const nearest = calls.reduce<Call | null>((best, call) => !best || Math.abs((call.start + call.end) / 2 - pts) < Math.abs((best.start + best.end) / 2 - pts) ? call : best, null);
    const close = nearest && Math.abs((nearest.start + nearest.end) / 2 - pts) < (last - first) / 100 ? nearest : null;
    setChosen(close);
    onSeek(close ? close.start : pts);
  }

  const alive = chosen ? tracks.filter(track => track.first <= chosen.end && track.last >= chosen.start) : [];
  return <section aria-label="Audio lanes" className="space-y-1 rounded-lg border border-slate-800 bg-slate-900 p-3 text-slate-100">
    {synced.map(source => {
      const data = activity[source.id];
      const calls = data ? callsInVideo(data, source, segment) : [];
      const at = (sample: number) => Number(source.anchor!.video_pts) + (sample - source.anchor!.audio_sample) / source.metadata.sample_rate * ticks;
      const peak = Math.max(12, ...(data?.envelope ?? []));
      return <div key={source.id} className="space-y-1">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <AudioLines className="h-4 w-4 text-sky-300" />
          <span className="font-semibold">{source.label || source.metadata.filename}</span>
          {data ? <span aria-label={`Calls in ${source.label || source.metadata.filename}`} className="text-slate-400">{calls.length} call marks in this video</span>
            : source.retunable ? <Button size="sm" variant="ghost" className="h-6 text-slate-200" disabled={busy !== null} onClick={() => void find(source)}>{busy === source.id ? 'Finding calls...' : 'Find calls'}</Button>
              : <span className="text-slate-500">not full-spectrum: no call marks</span>}
        </div>
        {data && <svg role="img" aria-label={`Audio lane ${source.label || source.metadata.filename}`} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none"
          className="h-9 w-full cursor-pointer rounded bg-slate-950" onClick={event => click(event, calls)}>
          {data.envelope.map((value, index) => {
            const left = x(at(index * data.envelope_samples)), right = x(at((index + 1) * data.envelope_samples));
            return value > 0 && right > left ? <rect key={index} x={left} width={Math.max(0.5, right - left)} y={HEIGHT - Math.min(1, value / peak) * HEIGHT} height={Math.min(1, value / peak) * HEIGHT} fill="#0ea5e9" fillOpacity={0.35} /> : null;
          })}
          {calls.map((call, index) => <rect key={index} x={x(call.start)} width={Math.max(1.5, x(call.end) - x(call.start))} y={0} height={HEIGHT} fill={chosen === call ? '#fde047' : '#38bdf8'} />)}
        </svg>}
      </div>;
    })}
    {chosen && <p role="status" aria-label="Tracks during call" className="text-xs text-slate-300">
      Call at {((chosen.start - first) / ticks).toFixed(2)} s: {alive.length ? `tracks ${alive.map(track => `#${track.index + 1}`).join(', ')} were on screen` : 'no tracked target on screen'}. Which target called is not known.</p>}
    <p className="text-[11px] text-slate-500">Call marks: ultrasonic band energy above a rolling noise floor (call-activity-v1). Placed with the confirmed sync anchor; clock drift is not corrected. No species is inferred.</p>
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
  </section>;
}
