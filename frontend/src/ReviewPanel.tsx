import { useEffect, useRef, useState } from 'react';
import type { ProvisionalObservation, ProvisionalObservationInput, ReviewChange, ReviewHistory, SummaryWindow, WindowReview } from '../../electron/src/contracts';
import { getAPI } from './api';

const unavailable = 'The local backend is unavailable. Your draft is retained. Retry after checking the backend.';
const decisionLabel = (value: string) => value.replaceAll('_', ' ');
type ActionInput<T = ReviewChange> = T extends ReviewChange ? Omit<T, 'actor' | 'expected_revision'> : never;

export function ReviewPanel({ window: selected, previewID, disabled, onDirtyChange, onSaved }: {
  window: SummaryWindow;
  previewID: string | null;
  disabled: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
}) {
  const [review, setReview] = useState<WindowReview | null>(null);
  const [actor, setActor] = useState('');
  const [editor, setEditor] = useState<ProvisionalObservationInput | null>(null);
  const [editingID, setEditingID] = useState<string | null>(null);
  const [countText, setCountText] = useState('');
  const [unableNote, setUnableNote] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [history, setHistory] = useState<ReviewHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [verifiedHeader, setVerifiedHeader] = useState('');
  const draft = useRef(false);
  const readGeneration = useRef(0);
  const header = JSON.stringify([selected.id, selected.review?.revision, selected.review?.needs_reverification, selected.review?.verification_warning, selected.source_state, selected.status]);

  function markDirty() { draft.current = true; setDirty(true); setNotice(''); }

  useEffect(() => {
    onDirtyChange(dirty || saving);
    return () => onDirtyChange(false);
  }, [dirty, saving, onDirtyChange]);

  async function load(verificationOnly = false) {
    if (draft.current && !verificationOnly) { setError('Save or discard the review draft before reloading.'); return; }
    const ticket = ++readGeneration.current;
    if (!verificationOnly) { setLoading(true); setError(''); }
    try {
      const result = await getAPI()?.getWindowReview(selected.id);
      if (ticket !== readGeneration.current) return;
      if (!result?.ok) setError(result?.error.message ?? unavailable);
      else {
        if (verificationOnly) setReview(previous => previous ? {
          ...previous, can_verify: result.value.can_verify, needs_reverification: result.value.needs_reverification,
          verification_warning: result.value.verification_warning, effective_decision: result.value.effective_decision,
        } : previous);
        else { setReview(result.value); setActor(previous => previous || result.value.actor || ''); }
        setVerifiedHeader(header);
      }
    } catch { if (ticket === readGeneration.current) setError(unavailable); }
    finally { if (ticket === readGeneration.current) setLoading(false); }
  }

  useEffect(() => {
    if (draft.current) {
      setError('The saved review or evidence status changed while editing. Your draft is retained. A stale save will be rejected; discard and reload to replace the draft.');
      void load(true);
    } else void load();
  }, [header]);

  function discard() {
    setEditor(null); setEditingID(null); setCountText(''); setUnableNote('');
    // The locally edited attribution is part of the draft too. Restoring
    // the last saved actor prevents a later action from being misattributed.
    setActor(review?.actor ?? '');
    draft.current = false; setDirty(false); setError(''); setNotice('Unsaved review draft discarded.');
    void load();
  }

  async function save(change: ActionInput) {
    if (!review || disabled || saving || loading) return;
    if (!actor.trim()) { setError('Enter a reviewer label for audit attribution.'); return; }
    setSaving(true); setError(''); setNotice('');
    try {
      const result = await getAPI()?.saveReview(selected.id, { ...change, actor: actor.trim(), expected_revision: review.revision } as ReviewChange);
      if (!result?.ok) { setError(result?.error.message ?? unavailable); return; }
      readGeneration.current += 1;
      setReview(result.value);
      setVerifiedHeader(header);
      setEditor(null); setEditingID(null); setCountText(''); setUnableNote('');
      draft.current = false; setDirty(false); setHistory(null);
      setNotice('Review action saved in SQLite with an append-only audit record.'); onSaved();
    } catch { setError(unavailable); }
    finally { setSaving(false); }
  }

  function edit(observation?: ProvisionalObservation) {
    if (disabled || saving || loading || editor) return;
    setEditingID(observation?.id ?? null);
    setEditor(observation ? {
      segment_id: observation.segment_id, start_pts: observation.start_pts, end_pts: observation.end_pts,
      category: observation.category, activity: observation.activity, count: observation.count,
      uncertain: observation.uncertain, notes: observation.notes,
    } : {
      segment_id: selected.segment_id, start_pts: selected.stats.first_pts ?? selected.preview_pts ?? '', end_pts: '',
      category: 'uncertain', activity: null, count: null, uncertain: true, notes: '',
    });
    setCountText(observation?.count === null || observation?.count === undefined ? '' : String(observation.count));
    markDirty(); setError('');
  }

  function field<K extends keyof ProvisionalObservationInput>(key: K, value: ProvisionalObservationInput[K]) {
    setEditor(previous => previous ? { ...previous, [key]: value } : previous); markDirty();
  }

  async function saveObservation() {
    if (!editor) return;
    if (!/^-?\d+$/.test(editor.start_pts.trim()) || !/^-?\d+$/.test(editor.end_pts.trim())) {
      setError('Enter integer original-source PTS for both half-open span endpoints.'); return;
    }
    if (countText.trim() && (!/^\d+$/.test(countText.trim()) || !Number.isSafeInteger(Number(countText)) || Number(countText) > 100000)) {
      setError('Count must be an integer from 0 to 100000, or blank for unknown.'); return;
    }
    const observation = { ...editor, start_pts: editor.start_pts.trim(), end_pts: editor.end_pts.trim(), activity: editor.activity?.trim() || null, count: countText.trim() ? Number(countText) : null };
    await save(editingID ? { action: 'update_observation', observation_id: editingID, observation } : { action: 'add_observation', observation });
  }

  async function loadHistory(more = false) {
    setHistoryLoading(true); setError('');
    try {
      const result = await getAPI()?.reviewHistory(selected.id, more ? history?.next_after_revision ?? 0 : 0);
      if (!result?.ok) setError(result?.error.message ?? unavailable);
      else setHistory(previous => more && previous ? { ...result.value, events: [...previous.events, ...result.value.events] } : result.value);
    } catch { setError(unavailable); }
    finally { setHistoryLoading(false); }
  }

  const lock = disabled || saving || loading;
  const currentWarning = selected.review?.verification_warning || review?.verification_warning;
  const needsReverification = selected.review?.needs_reverification || review?.needs_reverification;
  const sourceUnavailable = selected.source_state !== undefined && selected.source_state !== 'ready';
  const canDecide = !lock && editor === null && !unableNote.trim() && verifiedHeader === header && review?.can_verify && !sourceUnavailable && previewID !== null;
  const effectiveDecision = review && selected.review && selected.review.revision >= review.revision ? selected.review.effective_decision : review?.effective_decision;
  return <section className="review-panel" aria-labelledby="review-heading" aria-busy={saving || loading}>
    <h3 id="review-heading">Manual first review</h3>
    <p className="detail">Provisional visual observations only. A reviewer label provides local audit attribution, not identity authentication. No species, ecological conclusion or second-review approval is recorded.</p>
    <p className="source-hash">Run {selected.run_id} · Window {selected.id}</p>
    {loading && <p role="status">Loading saved review...</p>}
    {error && <p role="alert" className="source-warning">{error}</p>}
    {notice && <p role="status" className="notice">{notice}</p>}
    {review && <>
      <p role="status">First review: <strong>{decisionLabel(effectiveDecision ?? 'unreviewed')}</strong> · Saved revision {review.revision} · {review.observations.length} provisional observations.</p>
      {needsReverification && <p role="alert" className="source-warning">Re-verification required. Historical decision: {decisionLabel(review.decision)}. {currentWarning} {review.can_verify && !sourceUnavailable ? 'Current evidence is available. Create a fresh source preview and record a new explicit reviewed decision; the historical decision remains unresolved until then.' : 'Restore the original evidence before recording a new reviewed decision.'}</p>}
      {(!review.can_verify || sourceUnavailable) && <p className="source-warning">Unable to verify this source window. It remains unresolved; record an unable-to-assess annotation rather than reviewing it clear. {currentWarning}</p>}
      <label htmlFor="reviewer-label">Reviewer label</label>
      <input id="reviewer-label" value={actor} maxLength={120} disabled={lock} onChange={event => { setActor(event.target.value); markDirty(); }} />
      <p className="detail">A ready source preview from this exact window is required before an explicit reviewed decision. A two-second preview is a navigation aid; the human reviewer remains responsible for assessing the complete interval. Viewing or saving an observation never completes review.</p>
      <p className="detail">{previewID ? 'Source preview receipt available for this window.' : 'Open Preview window source and create a preview before recording a reviewed decision. Keep the preview open until the decision is saved.'}</p>
      <ol className="observation-list" aria-label="Saved provisional observations">{review.observations.map(observation => <li key={observation.id}>
        <p><strong>{observation.category}</strong> · Source PTS [{observation.start_pts}, {observation.end_pts}) · Count {observation.count === null ? 'unknown' : observation.count}{observation.uncertain ? ' · Uncertain' : ''}</p>
        <p>{observation.activity || 'Activity unknown'}{observation.notes && ` · ${observation.notes}`}</p>
        <p className="source-hash">Observation {observation.id} · Segment {observation.segment_id}</p>
        <div className="media-actions"><button type="button" disabled={lock || editor !== null || unableNote.trim() !== ''} onClick={() => edit(observation)}>Edit observation</button><button type="button" disabled={lock || editor !== null || unableNote.trim() !== ''} onClick={() => void save({ action: 'delete_observation', observation_id: observation.id })}>Delete observation</button></div>
      </li>)}</ol>
      {review.observations.length === 0 && <p>No provisional observations saved.</p>}
      {!editor && <button type="button" disabled={lock || unableNote.trim() !== '' || review.observations.length >= 100} onClick={() => edit()}>Add provisional observation</button>}
      {editor && <form className="observation-form" onSubmit={event => { event.preventDefault(); void saveObservation(); }}>
        <h4>{editingID ? 'Edit provisional observation' : 'New provisional observation'}</h4>
        <p className="detail">Use original integer PTS ticks in timebase {selected.time_base.num}/{selected.time_base.den} seconds. The span must remain inside this window and its single original segment. End is excluded. Copy authoritative PTS from the source preview; player seconds and motion colours are not timestamps.</p>
        <label htmlFor="observation-start">Observation start source PTS</label><input id="observation-start" value={editor.start_pts} disabled={lock} inputMode="numeric" maxLength={20} onChange={event => field('start_pts', event.target.value)} required />
        <label htmlFor="observation-end">Observation end source PTS (exclusive)</label><input id="observation-end" value={editor.end_pts} disabled={lock} inputMode="numeric" maxLength={20} onChange={event => field('end_pts', event.target.value)} required />
        <label htmlFor="observation-category">Provisional visual category</label><select id="observation-category" value={editor.category} disabled={lock} onChange={event => field('category', event.target.value as ProvisionalObservationInput['category'])}><option value="uncertain">Uncertain</option><option value="bat">Bat (provisional)</option><option value="insect">Insect</option><option value="bird">Bird</option><option value="other">Other</option></select>
        <label htmlFor="observation-activity">Optional activity / behaviour</label><input id="observation-activity" value={editor.activity ?? ''} disabled={lock} maxLength={120} onChange={event => field('activity', event.target.value)} />
        <label htmlFor="observation-count">Count (blank means unknown)</label><input id="observation-count" value={countText} disabled={lock} inputMode="numeric" maxLength={6} onChange={event => { setCountText(event.target.value); markDirty(); }} />
        <label className="checkbox-label"><input type="checkbox" checked={editor.uncertain} disabled={lock} onChange={event => field('uncertain', event.target.checked)} /> Uncertain observation</label>
        <label htmlFor="observation-notes">Observation notes</label><textarea id="observation-notes" value={editor.notes} disabled={lock} maxLength={2000} rows={3} onChange={event => field('notes', event.target.value)} />
        <button type="submit" disabled={lock}>{saving ? 'Saving...' : 'Save observation'}</button>
      </form>}
      <div className="review-decisions media-actions">
        <button type="button" disabled={!canDecide || review.observations.length === 0} onClick={() => void save({ action: 'set_decision', decision: 'reviewed_with_observations', preview_id: previewID })}>Mark reviewed with observations</button>
        <button type="button" disabled={!canDecide || review.observations.length !== 0} onClick={() => void save({ action: 'set_decision', decision: 'reviewed_no_discernible_event', preview_id: previewID })}>Mark reviewed: no discernible event</button>
        <button type="button" disabled={lock || editor !== null || unableNote.trim() !== ''} onClick={() => void save({ action: 'set_decision', decision: 'unreviewed', preview_id: null })}>Return to unreviewed</button>
      </div>
      <label htmlFor="unable-note">Unable-to-assess annotation</label><textarea id="unable-note" value={unableNote} rows={3} maxLength={2000} disabled={lock || editor !== null} onChange={event => { setUnableNote(event.target.value); markDirty(); }} />
      {review.unable_note && <p className="source-warning">Saved unresolved annotation: {review.unable_note}</p>}
      <button type="button" disabled={lock || editor !== null || !unableNote.trim()} onClick={() => void save({ action: 'unable_to_assess', note: unableNote.trim() })}>Save unable-to-assess annotation</button>
      {dirty && <p role="status" className="source-warning">Unsaved review draft. Save the action or discard the draft before changing windows, runs or sessions.</p>}
      <div className="media-actions"><button type="button" disabled={saving || !dirty} onClick={discard}>Discard review draft</button><button type="button" disabled={lock || dirty} onClick={() => void load()}>Reload saved review</button><button type="button" disabled={historyLoading} onClick={() => void loadHistory()}>Show review audit history</button></div>
      {history && <details open className="review-history"><summary>Append-only review history ({history.events.length} shown)</summary><ol>{history.events.map(event => <li key={event.revision}><p>Revision {event.revision} · {event.utc} · {event.actor} · {event.action}</p><pre>{JSON.stringify(event, null, 2)}</pre></li>)}</ol>{history.next_after_revision !== null && <button type="button" disabled={historyLoading} onClick={() => void loadHistory(true)}>Load more audit actions</button>}</details>}
    </>}
  </section>;
}
