import { useEffect, useRef, useState } from 'react';
import type { Gate, Heatmap, HeatmapMode, MediaSegment } from '../../../electron/src/contracts';
import { getAPI } from '../api';
import { Label, Select } from './ui/input';

const MODES: Record<HeatmapMode, string> = { first: 'First point of each track', all: 'All track points', confirmed: 'Tracks a reviewer marked as bat' };

/** Where candidate tracks were in the frame. Counts track points, never individuals. */
export function HeatmapPanel({ runID, segments, gates }: { runID: string; segments: MediaSegment[]; gates: Gate[] }) {
  const [segmentID, setSegmentID] = useState(segments[0]?.id ?? '');
  const [mode, setMode] = useState<HeatmapMode>('first');
  const [map, setMap] = useState<Heatmap | null>(null);
  const [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!segmentID) return;
    let live = true;
    void getAPI()?.getHeatmap(runID, segmentID, mode).then(result => {
      if (!live) return;
      if (result.ok) { setMap(result.value); setError(''); } else setError(result.error.message);
    });
    return () => { live = false; };
  }, [runID, segmentID, mode]);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context || !map) return;
    const most = Math.max(1, ...map.cells);
    context.fillStyle = '#0f172a';
    context.fillRect(0, 0, map.columns, map.rows);
    map.cells.forEach((value, index) => {
      if (!value) return;
      context.fillStyle = `rgba(239, 68, 68, ${0.2 + 0.8 * value / most})`;
      context.fillRect(index % map.columns, Math.floor(index / map.columns), 1, 1);
    });
  }, [map]);
  const shown = map ? gates.filter(gate => gate.state === 'active' && gate.frame_w === map.width && gate.frame_h === map.height) : [];
  return <section aria-label="Heatmap" className="space-y-2">
    <div className="flex flex-wrap gap-3">
      <div className="space-y-1"><Label htmlFor="heatmap-video" className="text-xs">Video</Label>
        <Select id="heatmap-video" className="h-8" value={segmentID} onChange={event => setSegmentID(event.target.value)}>{segments.map(segment => <option key={segment.id} value={segment.id}>{segment.metadata.filename}</option>)}</Select></div>
      <div className="space-y-1"><Label htmlFor="heatmap-mode" className="text-xs">Show</Label>
        <Select id="heatmap-mode" className="h-8" value={mode} onChange={event => setMode(event.target.value as HeatmapMode)}>{Object.entries(MODES).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</Select></div>
    </div>
    {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    {map && <div className="relative w-full max-w-xl" style={{ aspectRatio: `${map.width} / ${map.height}` }}>
      <canvas ref={canvas} width={map.columns} height={map.rows} aria-label="Track point density" className="absolute inset-0 h-full w-full [image-rendering:pixelated]" />
      <svg viewBox={`0 0 ${map.width} ${map.height}`} className="pointer-events-none absolute inset-0 h-full w-full">
        {shown.map(gate => gate.kind === 'line'
          ? <line key={gate.id} x1={gate.points[0]![0]} y1={gate.points[0]![1]} x2={gate.points[1]![0]} y2={gate.points[1]![1]} stroke="#fde047" strokeWidth={Math.max(1, map.width / 300)} />
          : <polygon key={gate.id} points={gate.points.map(point => point.join(',')).join(' ')} fill="none" stroke="#fde047" strokeWidth={Math.max(1, map.width / 300)} />)}
      </svg>
    </div>}
    {map && <p role="status" className="text-xs text-muted-foreground">{map.points} track points from {map.tracks} tracks. Track points, not individuals; an empty area is not proof that no bat was there.</p>}
  </section>;
}
