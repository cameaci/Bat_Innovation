import { useEffect, useState } from 'react';
import { Download, FileUp, Save, Stamp, Trash2 } from 'lucide-react';
import type { MediaSegment, SiteTemplate, TrackingSettings } from '../../../../electron/src/contracts';
import { getAPI } from '../../api';
import { useSurvey } from '../../survey';
import { Button } from '../ui/button';

/**
 * Site templates: save this view's search areas, exclusions, gates and settings by name, and set up next season's
 * survey of the same site the same way. Geometry is never rescaled to another frame size, and placed gates wait for
 * one reconfirmation that they still sit on the roost.
 */
export function SiteTemplatePanel({ settings, segment, actor, onSettings }: {
  settings: TrackingSettings;
  segment: MediaSegment;
  actor: string;
  onSettings: (settings: TrackingSettings) => void;
}) {
  const survey = useSurvey();
  const [templates, setTemplates] = useState<SiteTemplate[]>([]);
  const [chosen, setChosen] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const ready = (survey.media?.schema_version ?? 0) >= 15;

  async function load() {
    const result = await getAPI()?.listTemplates();
    if (result?.ok) setTemplates(result.value);
  }
  useEffect(() => { if (ready) void load(); }, [ready]);

  async function act<T>(action: () => Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }> | undefined, done: (value: T) => string) {
    setError(''); setMessage('');
    const result = await action();
    if (!result) return;
    if (!result.ok) { setError(result.error.message); return; }
    setMessage(done(result.value));
    await load();
  }

  const frame = { frame_w: segment.metadata.width, frame_h: segment.metadata.height };
  const gates = survey.gates.filter(gate => gate.state === 'active' && gate.frame_w === frame.frame_w && gate.frame_h === frame.frame_h)
    .map(({ id: _id, session_id: _session, revision: _revision, state: _state, template_id: _template, ...value }) => value);
  const selected = templates.find(item => item.id === chosen) ?? null;
  if (!ready) return null;
  return <section aria-label="Site template" className="space-y-2 rounded-lg border border-slate-800 bg-slate-900 p-4 text-slate-100">
    <p className="text-sm font-semibold">Site template</p>
    <p className="text-[11px] text-slate-400">Reuse a site's search areas, exclusions, gates and settings next season. Geometry and settings only, no video.</p>
    {!actor.trim() && <p className="text-[11px] text-amber-200">Enter your name in the Counts tab to save or apply templates.</p>}
    <div className="flex gap-1">
      <select aria-label="Saved templates" value={chosen} onChange={event => setChosen(event.target.value)} className="min-w-0 flex-1 rounded bg-slate-800 px-2 py-1 text-xs">
        <option value="">{templates.length ? 'Choose a template...' : 'No templates yet'}</option>
        {templates.map(item => <option key={item.id} value={item.id}>{item.name} ({item.frame_w} x {item.frame_h}, {item.gates.length} gate{item.gates.length === 1 ? '' : 's'})</option>)}
      </select>
    </div>
    {selected && <div className="flex flex-wrap gap-1">
      <Button size="sm" className="h-7" disabled={!actor.trim()} onClick={() => void act(() => getAPI()?.applyTemplate(selected.id, { actor: actor.trim(), session_id: survey.session.id, ...frame }), value => {
        onSettings(value.template.settings);
        survey.addGates(value.gates);
        return `Applied "${value.template.name}": settings loaded and ${value.gates.length} gate${value.gates.length === 1 ? '' : 's'} placed. Reconfirm each gate on the Counts tab before it counts.`;
      })}><Stamp />Apply to this survey</Button>
      <Button size="sm" variant="ghost" className="h-7 text-slate-200" onClick={() => void act(() => getAPI()?.exportTemplate(selected.id), value => value ? `Saved "${value}" as a file.` : '')}><Download />Save as file</Button>
      <Button size="sm" variant="ghost" className="h-7 text-slate-200" aria-label="Retire template" onClick={() => void act(() => getAPI()?.retireTemplate(selected.id), value => { setChosen(''); return `Retired "${value.name}".`; })}><Trash2 /></Button>
    </div>}
    <div className="flex gap-1">
      <input aria-label="Template name" value={name} maxLength={60} placeholder="Name, e.g. Church north gable" onChange={event => setName(event.target.value)}
        className="min-w-0 flex-1 rounded bg-slate-800 px-2 py-1 text-xs" />
      <Button size="sm" className="h-7" disabled={!name.trim() || !actor.trim()} onClick={() => void act(() => getAPI()?.saveTemplate({ name: name.trim(), actor: actor.trim(), ...frame, settings, gates }),
        value => { setName(''); setChosen(value.id); return `Saved "${value.name}" with ${value.gates.length} gate${value.gates.length === 1 ? '' : 's'}.`; })}><Save />Save current setup</Button>
    </div>
    <Button size="sm" variant="ghost" className="h-7 text-slate-200" disabled={!actor.trim()} onClick={() => void act(() => getAPI()?.importTemplate(actor.trim()), value => value ? `Imported "${value.name}".` : '')}><FileUp />Import a template file</Button>
    {message && <p role="status" aria-label="Template message" className="text-xs text-emerald-200">{message}</p>}
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
  </section>;
}
