import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { Sunset as SunsetIcon } from 'lucide-react';
import type { ClockAnchor, GateCounts, MediaSegment } from '../../../../electron/src/contracts';
import { getAPI } from '../../api';
import { seconds } from '../../lib/time';
import { profileColumns, SUNSET_PATTERN, sunsetMinute } from '../../lib/profile';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { IN_COLOUR, OUT_COLOUR } from './CountLayer';

const WIDTH = 1000, HEIGHT = 120, MIDDLE = 70;
type LayerName = 'algorithm' | 'reviewer' | 'qa';

/**
 * The emergence profile of the chosen gate: exits per minute up, entries down, the cumulative net as a line, first
 * exit, peak minute and last exit, and the typed sunset in the video with the declared clock. Click to go there.
 */
export function EmergenceProfile({ counts, colour, segments, anchor, sessionID, actor, onSeek, onChanged }: {
  counts: GateCounts;
  colour: string;
  segments: MediaSegment[];
  anchor: ClockAnchor | null;
  sessionID: string;
  actor: string;
  onSeek: (segmentID: string, pts: string) => void;
  onChanged: () => void;
}) {
  const [layer, setLayer] = useState<LayerName>('reviewer');
  const [typed, setTyped] = useState('');
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const profile = counts.profile;
  const data = profile.layers[layer] ?? profile.layers.reviewer;
  const videos = useMemo(() => segments.map(segment => ({ id: segment.id,
    minutes: Math.max(1, Math.ceil((seconds(segment.metadata.elapsed_end) ?? seconds(segment.metadata.elapsed_last_time) ?? 0) / 60)) })), [segments]);
  const columns = useMemo(() => profileColumns(data, videos), [data, videos]);
  useEffect(() => { setTyped(profile.sunset?.sunset ?? ''); setSource(profile.sunset?.source ?? ''); }, [profile.sunset?.revision]);
  const step = WIDTH / Math.max(1, columns.length);
  const bar = Math.min(step * 0.8, 24);
  const peak = Math.max(1, ...columns.map(column => Math.max(column.exited, column.entered)));
  const netRange = Math.max(1, ...columns.map(column => Math.abs(column.net)));
  const at = (segmentID: string, minute: number) => columns.findIndex(column => column.segmentID === segmentID && column.minute === minute);
  const marker = (point: { segment_id: string; seconds: number } | null) => point ? at(point.segment_id, Math.floor(point.seconds / 60)) : -1;
  const sunsetX = (() => {
    if (!profile.sunset || !anchor || profile.clock_segment_id !== anchor.segment_id) return null;
    const minute = sunsetMinute(anchor.utc, profile.sunset.sunset);
    const first = columns.findIndex(column => column.segmentID === anchor.segment_id);
    const length = columns.filter(column => column.segmentID === anchor.segment_id).length;
    return minute === null || first < 0 || minute < 0 || minute > length ? null : (first + minute) * step;
  })();
  const after = profile.minutes_after_sunset?.[layer];

  function click(event: MouseEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const column = columns[Math.min(columns.length - 1, Math.floor((event.clientX - box.left) / box.width * columns.length))];
    const segment = segments.find(item => item.id === column?.segmentID);
    if (!column || !segment) return;
    const ticks = Number(segment.metadata.time_base.den) / Number(segment.metadata.time_base.num);
    onSeek(segment.id, String(Number(segment.metadata.first_pts) + Math.round(column.minute * 60 * ticks)));
  }

  async function saveSunset(value: string) {
    setError('');
    const result = await getAPI()?.saveSunset(sessionID, { actor: actor.trim(), sunset: value, source: value ? source.trim() : '' });
    if (result && !result.ok) setError(result.error.message);
    // The profile carries the sunset, so the counts are reloaded.
    if (result?.ok) onChanged();
  }

  const video = (segmentID: string) => segments.findIndex(item => item.id === segmentID) + 1;
  const when = (point: { segment_id: string; seconds: number } | null) => point ? `video ${video(point.segment_id)} at ${Math.floor(point.seconds / 60)}:${String(Math.floor(point.seconds % 60)).padStart(2, '0')}` : 'none';
  return <section aria-label="Emergence profile" className="space-y-2 rounded-lg border border-slate-800 bg-slate-900 p-3 text-slate-100">
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-sm font-semibold"><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full" style={{ background: colour }} />Emergence profile: {counts.gate.name}</p>
      <div className="flex rounded-md border border-slate-700" role="group" aria-label="Count layer">
        {(['algorithm', 'reviewer', 'qa'] as const).map(name => <button key={name} type="button" aria-pressed={layer === name} disabled={name === 'qa' && !profile.layers.qa}
          onClick={() => setLayer(name)} className={cn('px-2 py-0.5 text-xs disabled:opacity-40', layer === name ? 'bg-slate-100 text-slate-900' : 'text-slate-300')}>{name === 'qa' ? 'QA' : name}</button>)}
      </div>
    </div>
    <svg role="img" aria-label="Exits and entries per minute" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-28 w-full cursor-pointer" preserveAspectRatio="none" onClick={click}>
      <line x1={0} x2={WIDTH} y1={MIDDLE} y2={MIDDLE} stroke="#334155" />
      {columns.map((column, index) => <g key={`${column.segmentID}:${column.minute}`}>
        {index > 0 && column.video !== columns[index - 1]!.video && <line x1={index * step} x2={index * step} y1={0} y2={HEIGHT} stroke="#475569" strokeDasharray="3 3" />}
        {column.exited > 0 && <rect x={index * step + (step - bar) / 2} width={bar} y={MIDDLE - column.exited / peak * (MIDDLE - 6)} height={column.exited / peak * (MIDDLE - 6)} fill={OUT_COLOUR} />}
        {column.entered > 0 && <rect x={index * step + (step - bar) / 2} width={bar} y={MIDDLE} height={column.entered / peak * (HEIGHT - MIDDLE - 4)} fill={IN_COLOUR} />}
      </g>)}
      <polyline fill="none" stroke="#f8fafc" strokeWidth={1.5} points={columns.map((column, index) => `${(index + 1) * step},${MIDDLE - column.net / netRange * (MIDDLE - 10)}`).join(' ')} />
      {[['first exit', marker(data.first_exit), '#fde68a'], ['peak minute', data.peak_minute ? at(data.peak_minute.segment_id, data.peak_minute.minute) : -1, '#fca5a5'],
        ['last exit', marker(data.last_exit), '#fde68a']].map(([name, index, tone]) => Number(index) >= 0 &&
        <path key={String(name)} d={`M ${(Number(index) + 0.5) * step} 2 l -5 -0 l 5 8 l 5 -8 z`} fill={String(tone)}><title>{String(name)}</title></path>)}
      {sunsetX !== null && <line x1={sunsetX} x2={sunsetX} y1={0} y2={HEIGHT} stroke="#fb923c" strokeWidth={2}><title>sunset</title></line>}
    </svg>
    <p className="text-[11px] text-slate-400">Magenta bars exits per minute (up), cyan entries (down), white line cumulative net, yellow marks first and last exit, red the peak minute{sunsetX !== null ? ', orange the sunset' : ''}. Dashed lines separate videos. Provisional.</p>
    <p aria-label="Flow metrics" className="text-xs text-slate-300">
      {data.peak_minute ? `Peak ${data.peak_minute.exited} exits in a minute (video ${video(data.peak_minute.segment_id)}, minute ${data.peak_minute.minute + 1}); busiest second ${data.peak_exits_per_second}. ` : 'No exits in this layer. '}
      First exit {when(data.first_exit)}, last exit {when(data.last_exit)}.
      {after?.first_exit != null ? ` First exit ${after.first_exit} min after sunset${after.peak_minute != null ? `, peak minute starts ${after.peak_minute} min after sunset` : ''}.` : ''}
    </p>
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <SunsetIcon className="h-4 w-4 text-orange-300" />
      <input aria-label="Sunset time" placeholder="21:04+01:00" maxLength={11} value={typed} onChange={event => setTyped(event.target.value)} className="w-28 rounded bg-slate-800 px-2 py-0.5" />
      <input aria-label="Sunset source" placeholder="Source, e.g. almanac for the site" maxLength={200} value={source} onChange={event => setSource(event.target.value)} className="min-w-0 flex-1 rounded bg-slate-800 px-2 py-0.5" />
      <Button size="sm" variant="ghost" className="h-6 text-slate-200" disabled={!actor.trim() || !SUNSET_PATTERN.test(typed) || !source.trim()} onClick={() => void saveSunset(typed)}>Save sunset</Button>
      {profile.sunset && <Button size="sm" variant="ghost" className="h-6 text-slate-400" disabled={!actor.trim()} onClick={() => void saveSunset('')}>Clear</Button>}
    </div>
    <p className="text-[11px] text-slate-500">{profile.sunset ? `Sunset ${profile.sunset.sunset} (${profile.sunset.source}), entered by ${profile.sunset.actor}. ` : 'Type the local sunset for the survey date with its UTC offset (21:04+01:00 in summer time); it is not computed. '}
      {anchor ? 'Times after sunset use the declared recording clock of its video only.' : 'Declare the recording clock on the Process page to relate exits to sunset.'}</p>
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
  </section>;
}
