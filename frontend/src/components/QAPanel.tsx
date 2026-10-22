import { useEffect, useRef, useState } from 'react';
import type { QAChange, QAHistory, QASuggestion, SummaryWindow, WindowQA } from '../../../electron/src/contracts';
import { getAPI } from '../api';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Checkbox, Input, Label, Select, Textarea } from './ui/input';

const unavailable = 'The local backend is unavailable. Your QA draft is kept; retry after checking the backend.';
const label = (value: string) => value.replaceAll('_', ' ');

export function QAPanel({ window: selected, previewID, disabled, onDirtyChange, onSaved }: {
  window: SummaryWindow; previewID: string | null; disabled: boolean;
  onDirtyChange: (dirty: boolean) => void; onSaved: () => void;
}) {
  const [qa, setQA] = useState<WindowQA | null>(null);
  const [actor, setActor] = useState('');
  const [decision, setDecision] = useState<NonNullable<QAChange['decision']>>('agree');
  const [note, setNote] = useState('');
  const [observationID, setObservationID] = useState('');
  const [suggestionNote, setSuggestionNote] = useState('');
  const [category, setCategory] = useState<QASuggestion['category']>(null);
  const [count, setCount] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [history, setHistory] = useState<QAHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const draft = useRef(false), generation = useRef(0);
  const header = JSON.stringify([selected.id, selected.review?.revision, selected.review?.effective_decision,
    selected.qa, selected.source_state, selected.status]);

  function edit() { draft.current = true; setDirty(true); setConfirmed(false); setNotice(''); }
  useEffect(() => { onDirtyChange(dirty || saving); return () => onDirtyChange(false); }, [dirty, saving, onDirtyChange]);
  useEffect(() => () => { generation.current += 1; }, []);

  function replace(value: WindowQA) {
    setQA(value); setActor(value.actor ?? ''); setNote(value.note);
    setDecision(value.decision === 'pending' ? 'agree' : value.decision);
    setObservationID(value.suggestion?.observation_id ?? ''); setSuggestionNote(value.suggestion?.note ?? '');
    setCategory(value.suggestion?.category ?? null); setCount(value.suggestion?.count?.toString() ?? '');
    setConfirmed(false); setHistory(null);
  }

  async function load() {
    if (draft.current) return;
    const ticket = ++generation.current;
    setLoading(true); setError('');
    try {
      const result = await getAPI()?.getWindowQA(selected.id);
      if (ticket !== generation.current || draft.current) return;
      if (!result?.ok) setError(result?.error.message ?? unavailable);
      else replace(result.value);
    } catch { if (ticket === generation.current) setError(unavailable); }
    finally { if (ticket === generation.current) setLoading(false); }
  }
  useEffect(() => {
    if (draft.current) setError('QA, first review or evidence changed while editing. Your draft is retained; a stale save will conflict. Discard and reload to replace it.');
    else void load();
  }, [header]);

  function discard() {
    draft.current = false; setDirty(false); setConfirmed(false);
    if (qa) replace(qa);
    setError(''); setNotice('QA draft discarded.'); void load();
  }

  async function save(action: QAChange['action']) {
    if (!qa || disabled || saving || loading || !confirmed) return;
    const reference = qa.first_review.observations.find(item => item.id === observationID);
    if (count.trim() && !/^\d{1,6}$/.test(count.trim())) { setError('Suggested count must be an integer from 0 to 100000 or blank for unknown.'); return; }
    if (count.trim() && Number(count) > 100000) { setError('Suggested count exceeds 100000.'); return; }
    if (action === 'set_decision' && observationID && !reference) { setError('Reload the current observation revision before suggesting a change.'); return; }
    const input: QAChange = {
      actor: actor.trim(), expected_revision: qa.revision, expected_first_review_revision: qa.first_review.revision,
      expected_evidence_revision: qa.current_evidence_revision, action, decision: action === 'retract' ? null : decision,
      note, preview_id: action !== 'retract' && (decision === 'agree' || decision === 'disagree') ? previewID : null,
      suggestion: action !== 'retract' && reference ? { observation_id: reference.id, observation_revision: reference.revision,
        note: suggestionNote, category, count: count.trim() ? Number(count) : null } : null,
      confirmed,
    };
    setSaving(true); setError(''); setNotice('');
    try {
      const result = await getAPI()?.saveQA(selected.id, input);
      if (!result?.ok) { setError(result?.error.message ?? unavailable); return; }
      generation.current += 1; draft.current = false; setDirty(false); replace(result.value);
      setNotice('QA decision saved with an audit record.'); onSaved();
    } catch { setError(unavailable); }
    finally { setSaving(false); }
  }

  async function loadHistory(more = false) {
    setHistoryLoading(true);
    try {
      const result = await getAPI()?.qaHistory(selected.id, more ? history?.next_after_revision ?? 0 : 0);
      if (!result?.ok) setError(result?.error.message ?? unavailable);
      else setHistory(previous => more && previous ? { ...result.value, events: [...previous.events, ...result.value.events] } : result.value);
    } catch { setError(unavailable); }
    finally { setHistoryLoading(false); }
  }

  const lock = disabled || saving || loading;
  const current = selected.qa && qa && selected.qa.revision >= qa.revision ? selected.qa : qa;
  const eligible = !!current?.can_decide && selected.source_state !== 'missing_source' && selected.source_state !== 'changed_source';
  const requiresPreview = decision === 'agree' || decision === 'disagree';
  const referenceEnabled = decision === 'disagree' || decision === 'needs_clarification';
  const canSave = !lock && dirty && confirmed && !!actor.trim() && (decision === 'agree' || !!note.trim())
    && (decision === 'unassessable' || eligible) && (!requiresPreview || previewID !== null)
    && (!observationID || referenceEnabled && !!suggestionNote.trim());

  return <section aria-label="Independent second review" aria-busy={saving || loading} className="space-y-3">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">Second review (QA)</h3>
      {qa && <Badge variant={current?.status === 'agree' ? 'success' : current?.status === 'pending' ? 'outline' : 'warning'}>{label(current?.status ?? 'pending')}</Badge>}
    </div>
    <p className="text-xs text-muted-foreground">An independent check of the first review by another person. It never edits the first review.</p>
    {loading && <p role="status" className="text-xs text-muted-foreground">Loading saved QA...</p>}
    {error && <p role="alert" className="rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-800">{error}</p>}
    {notice && <p role="status" className="text-xs text-emerald-700">{notice}</p>}
    {qa && <>
      <p className="text-xs text-muted-foreground">First review by {qa.first_review.actor ?? 'nobody yet'}: {label(qa.first_review.effective_decision)}.</p>
      {current?.needs_reverification && <p role="alert" className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900">This QA decision is out of date ({label(qa.decision)}). {current.warning}</p>}
      {!eligible && <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900">QA cannot agree or disagree yet. {current?.warning}</p>}
      {current?.has_disagreement && <p className="text-xs text-amber-800">A disagreement is kept in the QA history.</p>}
      {qa.note && <p className="text-xs">Saved rationale: {qa.note}</p>}
      <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (canSave) void save('set_decision'); }}>
        <fieldset disabled={lock} className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1"><Label htmlFor="qa-actor" className="text-xs">QA reviewer</Label><Input id="qa-actor" className="h-9" value={actor} maxLength={120} onChange={event => { setActor(event.target.value); edit(); }} /></div>
            <div className="space-y-1"><Label htmlFor="qa-decision" className="text-xs">QA decision</Label>
              <Select id="qa-decision" className="h-9" value={decision} onChange={event => { setDecision(event.target.value as typeof decision); setObservationID(''); edit(); }}>
                <option value="agree">Agree</option><option value="disagree">Disagree</option><option value="needs_clarification">Needs clarification</option><option value="unassessable">Unassessable</option>
              </Select></div>
          </div>
          <div className="space-y-1"><Label htmlFor="qa-note" className="text-xs">QA rationale{decision === 'agree' ? ' (optional)' : ''}</Label><Textarea id="qa-note" className="min-h-[56px]" value={note} maxLength={2000} onChange={event => { setNote(event.target.value); edit(); }} /></div>
          {referenceEnabled && qa.first_review.observations.length > 0 && <div className="space-y-2 rounded-md border bg-white p-2">
            <div className="space-y-1"><Label htmlFor="qa-observation" className="text-xs">About one observation (optional)</Label>
              <Select id="qa-observation" className="h-9" value={observationID} onChange={event => { setObservationID(event.target.value); edit(); }}>
                <option value="">The whole window</option>{qa.first_review.observations.map((item, index) => <option key={item.id} value={item.id}>Observation {index + 1}: {item.category}{item.count === null ? '' : `, count ${item.count}`}</option>)}
              </Select></div>
            {observationID && <>
              <div className="space-y-1"><Label htmlFor="qa-suggestion-note" className="text-xs">Suggestion</Label><Textarea id="qa-suggestion-note" className="min-h-[48px]" value={suggestionNote} maxLength={2000} onChange={event => { setSuggestionNote(event.target.value); edit(); }} /></div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1"><Label htmlFor="qa-category" className="text-xs">Suggested category</Label><Select id="qa-category" className="h-9" value={category ?? ''} onChange={event => { setCategory(event.target.value as QASuggestion['category'] || null); edit(); }}><option value="">No change</option>{['uncertain', 'bat', 'insect', 'bird', 'other'].map(value => <option key={value}>{value}</option>)}</Select></div>
                <div className="space-y-1"><Label htmlFor="qa-count" className="text-xs">Suggested count</Label><Input id="qa-count" className="h-9" value={count} inputMode="numeric" maxLength={6} onChange={event => { setCount(event.target.value); edit(); }} /></div>
              </div>
            </>}
          </div>}
          <label className="flex items-start gap-2 text-xs"><Checkbox className="mt-0.5" checked={confirmed} onChange={event => { draft.current = true; setDirty(true); setConfirmed(event.target.checked); }} />I confirm this is my explicit second-review action</label>
          {requiresPreview && !previewID && <p className="text-xs text-muted-foreground">Agree or disagree needs a preview of this window's original video.</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={!canSave}>Save QA decision</Button>
            <Button size="sm" variant="outline" disabled={lock || qa.revision === 0 || !confirmed || !actor.trim() || !note.trim()} onClick={() => void save('retract')}>Retract QA decision</Button>
            {dirty && <Button size="sm" variant="ghost" disabled={saving} onClick={discard}>Discard QA draft</Button>}
          </div>
        </fieldset>
      </form>
      <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={historyLoading} onClick={() => void loadHistory()}>Show QA history</Button>
      {history && <div className="space-y-1 rounded-md border bg-white p-2 text-xs"><p className="font-medium">QA history ({history.events.length} shown)</p>
        <ol className="space-y-1">{history.events.map(event => <li key={event.revision}>#{event.revision} · {new Date(event.utc).toLocaleString()} · {event.actor} · {event.action.replaceAll('_', ' ')}</li>)}</ol>
        {history.next_after_revision !== null && <Button size="sm" variant="ghost" className="h-7" disabled={historyLoading} onClick={() => void loadHistory(true)}>Load more</Button>}
      </div>}
    </>}
  </section>;
}
