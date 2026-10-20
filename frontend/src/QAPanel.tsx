import { useEffect, useRef, useState } from 'react';
import type { QAChange, QAHistory, QASuggestion, SummaryWindow, WindowQA } from '../../electron/src/contracts';
import { getAPI } from './api';

const unavailable = 'The local backend is unavailable. Your QA draft is retained; retry after checking the backend.';
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
    setError(''); setNotice('Unsaved QA draft discarded.'); void load();
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
      setNotice('Explicit QA action saved in SQLite with append-only history.'); onSaved();
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

  return <section className="review-panel qa-panel" aria-labelledby="qa-heading" aria-busy={saving || loading}>
    <h3 id="qa-heading">Independent second review</h3>
    <p className="detail">QA records a separate provisional human assessment, never edits first-review observations and never finalises ecological conclusions. Distinct local labels do not prove distinct humans. A two-second preview is only a navigation aid, not evidence of full-window assessment.</p>
    {loading && <p role="status">Loading saved QA...</p>}
    {error && <p role="alert" className="source-warning">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {qa && <>
      <p role="status">Second-review QA: <strong>{label(current?.status ?? 'pending')}</strong> · Saved QA revision {qa.revision} · First-review baseline {qa.first_review_revision}.</p>
      <p className="detail">Current first reviewer: {qa.first_review.actor ?? 'No saved reviewer'} · Revision {qa.first_review.revision} · {label(qa.first_review.effective_decision)}.</p>
      {current?.needs_reverification && <p role="alert" className="source-warning">Stale QA requires re-verification. Historical decision: {label(qa.decision)}. {current.warning}</p>}
      {!eligible && <p className="source-warning">QA cannot affirm this window. {current?.warning} All planned windows remain in the denominator. An unassessable note does not clear evidence.</p>}
      {current?.has_disagreement && <p className="source-warning">Disagreement is retained in QA history, including when a later decision changes.</p>}
      {qa.note && <p>Saved QA rationale: {qa.note}</p>}
      {qa.suggestion && <details><summary>Saved provisional suggestion (not adjudicated)</summary><pre>{JSON.stringify(qa.suggestion, null, 2)}</pre></details>}
      <form onSubmit={event => { event.preventDefault(); if (canSave) void save('set_decision'); }}>
        <fieldset disabled={lock}>
          <legend>Explicit QA action</legend>
          <label htmlFor="qa-actor">QA reviewer label</label><input id="qa-actor" value={actor} maxLength={120} onChange={event => { setActor(event.target.value); edit(); }} required />
          <label htmlFor="qa-decision">QA decision</label><select id="qa-decision" value={decision} onChange={event => { setDecision(event.target.value as typeof decision); setObservationID(''); edit(); }}>
            <option value="agree">Agree</option><option value="disagree">Disagree</option><option value="needs_clarification">Needs clarification</option><option value="unassessable">Unassessable (unresolved)</option>
          </select>
          <label htmlFor="qa-note">QA rationale</label><textarea id="qa-note" value={note} maxLength={2000} required={decision !== 'agree'} onChange={event => { setNote(event.target.value); edit(); }} />
          {referenceEnabled && <>
            <label htmlFor="qa-observation">Optional observation disagreement reference</label><select id="qa-observation" value={observationID} onChange={event => { setObservationID(event.target.value); edit(); }}>
              <option value="">Window-level QA only</option>{qa.first_review.observations.map(item => <option key={item.id} value={item.id}>{item.id} · revision {item.revision} · source PTS [{item.start_pts}, {item.end_pts})</option>)}
            </select>
            {observationID && <>
              <label htmlFor="qa-suggestion-note">Provisional suggestion note</label><textarea id="qa-suggestion-note" value={suggestionNote} maxLength={2000} required onChange={event => { setSuggestionNote(event.target.value); edit(); }} />
              <label htmlFor="qa-category">Suggested visual category (provisional)</label><select id="qa-category" value={category ?? ''} onChange={event => { setCategory(event.target.value as QASuggestion['category'] || null); edit(); }}><option value="">No category suggestion</option>{['uncertain','bat','insect','bird','other'].map(value => <option key={value}>{value}</option>)}</select>
              <label htmlFor="qa-count">Suggested count (blank means unknown)</label><input id="qa-count" value={count} inputMode="numeric" maxLength={6} onChange={event => { setCount(event.target.value); edit(); }} />
            </>}
          </>}
          <label><input type="checkbox" checked={confirmed} onChange={event => { draft.current = true; setDirty(true); setConfirmed(event.target.checked); }} />I confirm this is my explicit second-review action</label>
          {requiresPreview && <p className="detail">Agree/disagree requires a current source-preview receipt for this window and a current valid first review.</p>}
          <button type="submit" disabled={!canSave}>Save QA decision</button>
          <button type="button" disabled={lock || qa.revision === 0 || !confirmed || !actor.trim() || !note.trim()} onClick={() => void save('retract')}>Retract QA decision</button>
        </fieldset>
      </form>
      {dirty && <p role="status" className="source-warning">Unsaved QA draft. Save or explicitly discard before navigating or editing first review.</p>}
      <div className="media-actions"><button type="button" disabled={saving || !dirty} onClick={discard}>Discard QA draft</button><button type="button" disabled={lock || dirty} onClick={() => void load()}>Reload saved QA</button><button type="button" disabled={historyLoading} onClick={() => void loadHistory()}>Show QA audit history</button></div>
      {history && <details open className="review-history"><summary>Append-only QA history ({history.events.length} shown)</summary><ol>{history.events.map(event => <li key={event.revision}><p>QA revision {event.revision} · {event.utc} · {event.actor} · {event.action} · First-review baseline {event.first_review_revision}</p><pre>{JSON.stringify(event, null, 2)}</pre></li>)}</ol>{history.next_after_revision !== null && <button type="button" disabled={historyLoading} onClick={() => void loadHistory(true)}>Load more QA events</button>}</details>}
    </>}
  </section>;
}
