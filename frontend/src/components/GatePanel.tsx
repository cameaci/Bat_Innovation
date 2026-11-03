import { useEffect, useState } from 'react';
import { PenLine, Trash2 } from 'lucide-react';
import type { Gate, GateValue, MediaSegment } from '../../../electron/src/contracts';
import { useSurvey } from '../survey';
import { rectangle } from './SceneOverlay';
import { Button } from './ui/button';
import { Input, Label, Select } from './ui/input';

export interface GateDraft { kind: Gate['kind']; points: [number, number][] }
const needed = { line: 2, rect: 2, polygon: 3 } as const;

/** Draw, name and retire counting gates on the original frame. Gates belong to the survey, not one window. */
export function GatePanel({ segment, actor, draft, setDraft }: {
  segment: MediaSegment; actor: string; draft: GateDraft | null; setDraft: (draft: GateDraft | null) => void;
}) {
  const survey = useSurvey();
  const [name, setName] = useState('Roost entrance');
  const [labelA, setLabelA] = useState('Side A');
  const [labelB, setLabelB] = useState('Side B');
  const [entry, setEntry] = useState<GateValue['entry_direction']>('B_to_A');
  const [hysteresis, setHysteresis] = useState('4');
  const [saving, setSaving] = useState(false);
  const width = segment.metadata.width, height = segment.metadata.height;
  const gates = survey.gates.filter(gate => gate.state === 'active');
  useEffect(() => { survey.setDraft('gate', draft !== null); return () => survey.setDraft('gate', false); }, [draft !== null]);
  const ready = draft !== null && draft.points.length >= needed[draft.kind] && !!actor.trim() && /^\d+(\.\d+)?$/.test(hysteresis);

  async function save() {
    if (!draft || !ready) return;
    setSaving(true);
    const area = draft.kind !== 'line';
    const value: GateValue = { name: name.trim(), kind: draft.kind, points: draft.kind === 'rect' ? rectangle(draft.points) : draft.points,
      frame_w: width, frame_h: height, label_a: area ? 'Inside' : labelA.trim(), label_b: area ? 'Outside' : labelB.trim(),
      entry_direction: area ? 'out_to_in' : entry, hysteresis_px: Number(hysteresis) };
    const saved = await survey.saveGate(null, { actor: actor.trim(), expected_revision: 0, value });
    setSaving(false);
    if (saved) setDraft(null);
  }
  async function retire(gate: Gate) {
    if (!actor.trim() || !window.confirm(`Retire gate "${gate.name}"? Its counts stay in the audit history.`)) return;
    await survey.saveGate(gate.id, { actor: actor.trim(), expected_revision: gate.revision, value: null });
  }

  return <section aria-label="Counting gates" className="space-y-2 rounded-md border border-slate-700 p-2 text-xs text-slate-200">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="font-semibold">Counting gates</p>
      {!draft && <Button size="sm" variant="secondary" className="h-7" disabled={!actor.trim() || survey.busy} onClick={() => setDraft({ kind: 'line', points: [] })}><PenLine />Draw a gate</Button>}
    </div>
    {!actor.trim() && <p className="text-slate-400">Enter your name under First review to draw gates.</p>}
    {actor.trim() && survey.busy && !draft && <p role="status" className="text-slate-400">Gates can be drawn once tracking or processing has finished.</p>}
    {gates.length > 0 && <ul aria-label="Active gates" className="space-y-1">{gates.map(gate => <li key={gate.id} className="flex items-center justify-between gap-2">
      <span>{gate.name} · {gate.kind}{gate.kind === 'line' ? ` · A: ${gate.label_a}, B: ${gate.label_b}` : ''} · entering {gate.entry_direction.replaceAll('_', ' ')} · revision {gate.revision}</span>
      <Button size="icon" variant="ghost" className="h-6 w-6" aria-label={`Retire gate ${gate.name}`} onClick={() => void retire(gate)}><Trash2 /></Button>
    </li>)}</ul>}
    {draft && <div className="space-y-2">
      <p className="text-slate-300">Pause the video, then click on the frame: a line needs 2 to 8 points (a bent line follows a roof edge or gap; A is on the left of the drawing direction), a rectangle 2 opposite corners, a polygon 3 or more points.</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1"><Label htmlFor="gate-kind" className="text-xs">Gate type</Label>
          <Select id="gate-kind" className="h-8" value={draft.kind} onChange={event => setDraft({ kind: event.target.value as Gate['kind'], points: [] })}>
            <option value="line">Line</option><option value="rect">Rectangle</option><option value="polygon">Polygon</option>
          </Select></div>
        <div className="space-y-1"><Label htmlFor="gate-name" className="text-xs">Gate name</Label><Input id="gate-name" className="h-8" maxLength={60} value={name} onChange={event => setName(event.target.value)} /></div>
        {draft.kind === 'line' && <>
          <div className="space-y-1"><Label htmlFor="gate-a" className="text-xs">Side A means</Label><Input id="gate-a" className="h-8" maxLength={60} value={labelA} onChange={event => setLabelA(event.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="gate-b" className="text-xs">Side B means</Label><Input id="gate-b" className="h-8" maxLength={60} value={labelB} onChange={event => setLabelB(event.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="gate-entry" className="text-xs">Entering is</Label>
            <Select id="gate-entry" className="h-8" value={entry} onChange={event => setEntry(event.target.value as GateValue['entry_direction'])}>
              <option value="B_to_A">B to A</option><option value="A_to_B">A to B</option>
            </Select></div>
        </>}
        <div className="space-y-1"><Label htmlFor="gate-band" className="text-xs">Hysteresis (pixels)</Label><Input id="gate-band" className="h-8" inputMode="decimal" value={hysteresis} onChange={event => setHysteresis(event.target.value)} /></div>
      </div>
      {draft.kind !== 'line' && <p className="text-slate-400">Areas count outside to inside as entering.</p>}
      <p role="status">{draft.points.length} point{draft.points.length === 1 ? '' : 's'} placed.</p>
      <div className="flex gap-2">
        <Button size="sm" className="h-7" disabled={!ready || saving} onClick={() => void save()}>Save gate</Button>
        <Button size="sm" variant="secondary" className="h-7" disabled={draft.points.length === 0} onClick={() => setDraft({ ...draft, points: [] })}>Clear points</Button>
        <Button size="sm" variant="ghost" className="h-7 text-slate-200" onClick={() => setDraft(null)}>Cancel</Button>
      </div>
    </div>}
  </section>;
}

/** Add one clicked point, respecting the point count of the chosen gate type. */
export function addPoint(draft: GateDraft, point: [number, number]): GateDraft {
  const limit = draft.kind === 'polygon' ? 32 : draft.kind === 'line' ? 8 : 2;
  return draft.points.length >= limit ? draft : { ...draft, points: [...draft.points, point] };
}
