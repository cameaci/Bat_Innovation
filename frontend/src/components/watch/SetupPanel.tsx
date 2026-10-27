import { useState } from 'react';
import { FlaskConical, Loader2, Play, Ruler, Trash2, X } from 'lucide-react';
import type { TrackingSettings, TrackingTest } from '../../../../electron/src/contracts';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { ROOST_PRESETS, testWarnings, type Measured } from '../../lib/setupGuide';

type Point = [number, number];
export type DrawKind = 'area' | 'exclusion' | null;

const segmented = (active: boolean) => cn('rounded px-2 py-1 text-xs', active ? 'bg-slate-100 text-slate-900' : 'bg-slate-800 text-slate-300 hover:bg-slate-700');

function Slider({ id, label, value, min, max, step = 1, onChange, hint }: { id: string; label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void; hint: string }) {
  return <div className="space-y-1">
    <div className="flex justify-between text-xs"><label htmlFor={id} className="font-medium">{label}</label><span className="tabular-nums text-slate-300">{value}</span></div>
    <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} className="w-full accent-red-500" />
    <p className="text-[11px] text-slate-400">{hint}</p>
  </div>;
}

/** Tracking setup: what to look for and where, a 10 s test on the displayed footage, then the whole survey. */
export function SetupPanel({ settings, onChange, drawing, draft, onDraw, onFinishShape, onCancelShape, test, testing, onTest, onClearTest, onApply, canTest, canApply, applyReason, measured, onUseMeasured, suggestions, onExclude, onIgnore }: {
  settings: TrackingSettings;
  onChange: (settings: TrackingSettings) => void;
  drawing: DrawKind;
  draft: Point[];
  onDraw: (kind: Exclude<DrawKind, null>) => void;
  onFinishShape: () => void;
  onCancelShape: () => void;
  test: TrackingTest | null;
  testing: boolean;
  onTest: () => void;
  onClearTest: () => void;
  onApply: () => void;
  canTest: boolean;
  canApply: boolean;
  applyReason: string;
  measured: Measured | null;
  onUseMeasured: () => void;
  suggestions: { points: [number, number][]; detections: number }[];
  onExclude: (points: [number, number][]) => void;
  onIgnore: (index: number) => void;
}) {
  const [preset, setPreset] = useState('');
  const tip = ROOST_PRESETS.find(item => item.key === preset)?.tip;
  const set = <K extends keyof TrackingSettings>(key: K, value: TrackingSettings[K]) => onChange({ ...settings, [key]: value });
  const stats = test?.result?.stats;
  return <section aria-label="Tracking setup" className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-4 text-slate-100">
    <div>
      <h2 className="text-sm font-semibold">Tracking setup</h2>
      <p className="text-[11px] text-slate-400">Starting values, not validated thresholds. Test on representative footage before tracking the survey.</p>
    </div>
    <label className="block space-y-1 text-xs"><span className="font-medium">Roost type</span>
      <select aria-label="Roost type" value={preset} className="w-full rounded bg-slate-800 px-2 py-1"
        onChange={event => { setPreset(event.target.value); const chosen = ROOST_PRESETS.find(item => item.key === event.target.value); if (chosen) onChange({ ...settings, ...chosen.settings }); }}>
        <option value="">Choose to load starting values...</option>
        {ROOST_PRESETS.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
      </select>
      {tip && <span className="block text-[11px] text-amber-200" aria-label="Gate tip">{tip}</span>}
    </label>
    {measured && <div role="status" aria-label="Measured target" className="space-y-1 rounded border border-sky-500/40 bg-sky-500/10 p-2 text-xs">
      <p><Ruler className="mr-1 inline h-3 w-3" />Clicked target: about {measured.targetPx} px across, {measured.contrast} x local noise, {measured.polarity === 'light' ? 'lighter' : 'darker'} than the scene.</p>
      <Button size="sm" className="h-7" onClick={onUseMeasured}>Use for size, polarity and threshold</Button>
    </div>}
    <Slider id="target-size" label="Target size (px)" value={settings.target_px} min={3} max={80} onChange={value => set('target_px', value)}
      hint="Click a bat on the paused video to place the red reference circle; after a test, the click also measures it." />
    <Slider id="threshold" label="Contrast threshold (x local noise)" value={settings.threshold} min={1.5} max={12} step={0.5} onChange={value => set('threshold', value)}
      hint="How far a target must stand out from the flicker at its place. Lower finds fainter targets and more noise." />
    <Slider id="target-speed" label="Target speed (sizes per frame)" value={settings.target_speed} min={1} max={12} step={0.5} onChange={value => set('target_speed', value)}
      hint="How far a target may move between frames. Raise it if fast bats split into pieces; lower it if tracks jump between neighbours." />
    <div className="space-y-1">
      <p className="text-xs font-medium">Target appears</p>
      <div className="flex gap-1" role="group" aria-label="Target polarity">
        {(['both', 'light', 'dark'] as const).map(value => <button key={value} type="button" aria-pressed={settings.polarity === value} className={segmented(settings.polarity === value)} onClick={() => set('polarity', value)}>
          {value === 'both' ? 'Light or dark' : value === 'light' ? 'Lighter' : 'Darker'}</button>)}
      </div>
    </div>
    <div className="space-y-1">
      <p className="text-xs font-medium">Expected activity</p>
      <div className="flex gap-1" role="group" aria-label="Expected activity">
        {(['sparse', 'normal', 'dense'] as const).map(value => <button key={value} type="button" aria-pressed={settings.activity === value} className={segmented(settings.activity === value)} onClick={() => set('activity', value)}>
          {value[0]!.toUpperCase() + value.slice(1)}</button>)}
      </div>
    </div>
    <div className="space-y-2">
      <p className="text-xs font-medium">Where to look</p>
      {drawing
        ? <div className="space-y-2 rounded border border-yellow-500/40 bg-yellow-500/10 p-2 text-xs" role="status">
          Click points on the video to outline the {drawing === 'area' ? 'search area' : 'excluded zone'} ({draft.length} so far).
          <div className="flex gap-2">
            <Button size="sm" disabled={draft.length < 3} onClick={onFinishShape}>Finish shape</Button>
            <Button size="sm" variant="ghost" className="text-slate-100" onClick={onCancelShape}><X />Cancel</Button>
          </div>
        </div>
        : <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="border-slate-600 bg-transparent text-slate-100" disabled={settings.detection_area.length >= 4} onClick={() => onDraw('area')}>Draw search area</Button>
          <Button size="sm" variant="outline" className="border-slate-600 bg-transparent text-slate-100" disabled={settings.exclusions.length >= 8} onClick={() => onDraw('exclusion')}>Exclude a zone</Button>
        </div>}
      <ul className="space-y-1 text-xs" aria-label="Search areas and excluded zones">
        {settings.detection_area.length === 0 && <li className="text-slate-400">Searching the whole frame.</li>}
        {settings.detection_area.map((shape, index) => <li key={`a${index}`} className="flex items-center justify-between"><span className="text-green-400">Search area {index + 1} ({shape.length} points)</span>
          <button type="button" aria-label={`Remove search area ${index + 1}`} onClick={() => set('detection_area', settings.detection_area.filter((_, at) => at !== index))}><Trash2 className="h-3.5 w-3.5" /></button></li>)}
        {settings.exclusions.map((shape, index) => <li key={`e${index}`} className="flex items-center justify-between"><span className="text-slate-300">Excluded zone {index + 1} ({shape.length} points)</span>
          <button type="button" aria-label={`Remove excluded zone ${index + 1}`} onClick={() => set('exclusions', settings.exclusions.filter((_, at) => at !== index))}><Trash2 className="h-3.5 w-3.5" /></button></li>)}
      </ul>
    </div>
    <details className="text-xs">
      <summary className="cursor-pointer font-medium">Advanced</summary>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {([['max_gap_s', 'Keep a lost target (s)', 0.04, 2, 0.04], ['join_gap_s', 'Join tracks across (s)', 0, 5, 0.1],
          ['min_track_s', 'Shortest track (s)', 0, 5, 0.05], ['min_displacement_targets', 'Shortest path (targets)', 0, 20, 0.5]] as const).map(([key, label, min, max, step]) =>
          <label key={key} className="space-y-1"><span className="block text-slate-300">{label}</span>
            <input type="number" min={min} max={max} step={step} value={settings[key]} className="w-full rounded bg-slate-800 px-2 py-1"
              onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= min && value <= max) set(key, value); }} /></label>)}
      </div>
    </details>
    <div className="space-y-2 border-t border-slate-800 pt-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" className="bg-red-600 hover:bg-red-500" disabled={!canTest || testing || drawing !== null} onClick={onTest}>
          {testing ? <Loader2 className="animate-spin" /> : <FlaskConical />}Test 10 s from here</Button>
        {test && !testing && <Button size="sm" variant="ghost" className="text-slate-100" onClick={onClearTest}>Back to tracked survey</Button>}
      </div>
      {test?.state === 'failed' && <p role="alert" className="text-xs text-red-300">Test failed ({test.error}).</p>}
      {stats && <p role="status" aria-label="Test result" className="text-xs text-slate-200">
        Test: {stats.coherent} stable track{stats.coherent === 1 ? '' : 's'}, {stats.uncertain} uncertain, {stats.noise} rejected as noise, {stats.rejected_size} detections rejected by size, {stats.joins} joined.
        {test?.result?.events.length ? ` Scene events: ${test.result.events.map(event => event.kind.replace('_', ' ')).join(', ')}.` : ''}
      </p>}
      {testWarnings(stats).length > 0 && <ul aria-label="Footage warnings" className="list-disc space-y-1 pl-4 text-[11px] text-amber-200">
        {testWarnings(stats).map(text => <li key={text}>{text}</li>)}</ul>}
      {suggestions.length > 0 && <div className="space-y-1" aria-label="Suggested exclusions">
        <p className="text-xs font-medium">Detections kept appearing here without a track (amber on the video):</p>
        {suggestions.map((item, index) => <div key={index} className="flex items-center gap-2 text-xs">
          <span className="flex-1">Area {index + 1}: {item.detections} detections</span>
          <Button size="sm" className="h-6" onClick={() => onExclude(item.points)}>Exclude</Button>
          <Button size="sm" variant="ghost" className="h-6 text-slate-300" onClick={() => onIgnore(index)}>Ignore</Button>
        </div>)}
      </div>}
      {test?.result && <p className="text-[11px] text-slate-400">Looping the tested range: green boxes are accepted detections, grey ones were rejected by size. Click a bat to measure it. Not saved.</p>}
      <Button size="sm" variant="outline" className="w-full border-red-500/60 bg-transparent text-red-100" disabled={!canApply} title={canApply ? undefined : applyReason} onClick={onApply}>
        <Play />Looks good - track whole survey</Button>
      {!canApply && <p className="text-[11px] text-slate-400">{applyReason}</p>}
    </div>
  </section>;
}
