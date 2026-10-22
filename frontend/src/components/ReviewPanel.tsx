import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Ban, Check, History, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { ProvisionalObservation, ProvisionalObservationInput, ReviewChange, ReviewHistory, SummaryWindow, WindowReview } from '../../../electron/src/contracts';
import { getAPI } from '../api';
import { displayedPTSFor } from '../sourceFrame';
import type { WindowSourceFrame } from '../sourceFrame';
import { clock, seconds } from '../lib/time';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Checkbox, Input, Label, Select, Textarea } from './ui/input';

const unavailable = 'The local backend is unavailable. Your draft is kept. Retry after checking the backend.';
type ActionInput<T = ReviewChange> = T extends ReviewChange ? Omit<T, 'actor' | 'expected_revision'> : never;
export const decisionText: Record<string, string> = {
  unreviewed: 'Not reviewed', reviewed_no_discernible_event: 'Reviewed: no activity', reviewed_with_observations: 'Reviewed: activity',
};
const categoryText: Record<ProvisionalObservationInput['category'], string> = { bat: 'Bat (provisional)', insect: 'Insect', bird: 'Bird', other: 'Other', uncertain: 'Uncertain' };

export interface ReviewPanelHandle { markNoEvent: () => void; addObservation: () => void }

export const ReviewPanel = forwardRef<ReviewPanelHandle, {
  window: SummaryWindow;
  /** Reviewer label shared across windows; sent with every saved action as audit attribution. */
  actor: string;
  onActorChange: (actor: string) => void;
  previewID: string | null;
  displayedSourceFrame: WindowSourceFrame | null;
  disabled: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
}>(function ReviewPanel({ window: selected, actor, onActorChange, previewID, displayedSourceFrame, disabled, onDirtyChange, onSaved }, handle) {
  const [review, setReview] = useState<WindowReview | null>(null);
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
  const [verifiedHeader, setVerifiedHeader] = useState('');
  const draft = useRef(false);
  const readGeneration = useRef(0);
  const header = JSON.stringify([selected.id, selected.review?.revision, selected.review?.needs_reverification, selected.review?.verification_warning, selected.source_state, selected.status]);
  const tb = selected.time_base;
  const windowStart = seconds(selected.interval.start_time) ?? 0;
  const at = (pts: string) => /^-?\d+$/.test(pts.trim()) ? clock(Number(pts) * Number(tb.num) / Number(tb.den) - windowStart) : 'not set';

  function markDirty() { draft.current = true; setDirty(true); setNotice(''); }
  useEffect(() => { onDirtyChange(dirty || saving); return () => onDirtyChange(false); }, [dirty, saving, onDirtyChange]);

  async function load(verificationOnly = false) {
    if (draft.current && !verificationOnly) { setError('Save or discard the draft before reloading.'); return; }
    const ticket = ++readGeneration.current;
    if (!verificationOnly) { setLoading(true); setError(''); }
    try {
      const result = await getAPI()?.getWindowReview(selected.id);
      if (ticket !== readGeneration.current) return;
      if (!result?.ok) setError(result?.error.message ?? unavailable);
      else {
        if (verificationOnly) setReview(previous => previous ? { ...previous, can_verify: result.value.can_verify, needs_reverification: result.value.needs_reverification,
          verification_warning: result.value.verification_warning, effective_decision: result.value.effective_decision } : previous);
        else { setReview(result.value); if (!actor && result.value.actor) onActorChange(result.value.actor); }
        setVerifiedHeader(header);
      }
    } catch { if (ticket === readGeneration.current) setError(unavailable); }
    finally { if (ticket === readGeneration.current) setLoading(false); }
  }
  useEffect(() => {
    if (draft.current) { setError('This window changed while you were editing. Your draft is kept; a stale save will be refused. Discard the draft to reload.'); void load(true); }
    else void load();
  }, [header]);

  function discard() {
    setEditor(null); setEditingID(null); setCountText(''); setUnableNote('');
    draft.current = false; setDirty(false); setError(''); setNotice('Draft discarded.');
    void load();
  }

  async function save(change: ActionInput) {
    if (!review || disabled || saving || loading) return;
    if (!actor.trim()) { setError('Enter your name or initials as reviewer first.'); return; }
    setSaving(true); setError(''); setNotice('');
    try {
      const result = await getAPI()?.saveReview(selected.id, { ...change, actor: actor.trim(), expected_revision: review.revision } as ReviewChange);
      if (!result?.ok) { setError(result?.error.message ?? unavailable); return; }
      readGeneration.current += 1;
      setReview(result.value); setVerifiedHeader(header);
      setEditor(null); setEditingID(null); setCountText(''); setUnableNote('');
      draft.current = false; setDirty(false); setHistory(null);
      setNotice('Saved with an audit record.'); onSaved();
    } catch { setError(unavailable); }
    finally { setSaving(false); }
  }

  function edit(observation?: ProvisionalObservation) {
    if (lock || editor) return;
    setEditingID(observation?.id ?? null);
    setEditor(observation ? { segment_id: observation.segment_id, start_pts: observation.start_pts, end_pts: observation.end_pts, category: observation.category,
      activity: observation.activity, count: observation.count, uncertain: observation.uncertain, notes: observation.notes }
      : { segment_id: selected.segment_id, start_pts: displayedStart ?? selected.stats.first_pts ?? selected.preview_pts ?? '', end_pts: '', category: 'bat', activity: null, count: null, uncertain: true, notes: '' });
    setCountText(observation?.count === null || observation?.count === undefined ? '' : String(observation.count));
    markDirty(); setError('');
  }
  function field<K extends keyof ProvisionalObservationInput>(key: K, value: ProvisionalObservationInput[K]) { setEditor(previous => previous ? { ...previous, [key]: value } : previous); markDirty(); }

  async function saveObservation() {
    if (!editor) return;
    if (!/^-?\d+$/.test(editor.start_pts.trim()) || !/^-?\d+$/.test(editor.end_pts.trim())) { setError('Set where the activity starts and ends: pause the video on the frame and use the buttons.'); return; }
    if (countText.trim() && (!/^\d+$/.test(countText.trim()) || Number(countText) > 100000)) { setError('Count must be a whole number from 0 to 100000, or empty when unknown.'); return; }
    const observation = { ...editor, start_pts: editor.start_pts.trim(), end_pts: editor.end_pts.trim(), activity: editor.activity?.trim() || null, count: countText.trim() ? Number(countText) : null };
    await save(editingID ? { action: 'update_observation', observation_id: editingID, observation } : { action: 'add_observation', observation });
  }

  async function loadHistory(more = false) {
    try {
      const result = await getAPI()?.reviewHistory(selected.id, more ? history?.next_after_revision ?? 0 : 0);
      if (!result?.ok) setError(result?.error.message ?? unavailable);
      else setHistory(previous => more && previous ? { ...result.value, events: [...previous.events, ...result.value.events] } : result.value);
    } catch { setError(unavailable); }
  }

  const lock = disabled || saving || loading;
  const displayedStart = displayedPTSFor(displayedSourceFrame, selected, review?.binding, previewID, 'start');
  const displayedEnd = displayedPTSFor(displayedSourceFrame, selected, review?.binding, previewID, 'end');
  const warning = selected.review?.verification_warning || review?.verification_warning;
  const needsReverification = selected.review?.needs_reverification || review?.needs_reverification;
  const sourceUnavailable = selected.source_state !== undefined && selected.source_state !== 'ready';
  const canDecide = !lock && editor === null && !unableNote.trim() && verifiedHeader === header && !!review?.can_verify && !sourceUnavailable && previewID !== null;
  const effective = review && selected.review && selected.review.revision >= review.revision ? selected.review.effective_decision : review?.effective_decision;

  useImperativeHandle(handle, () => ({
    markNoEvent: () => { if (review && canDecide && review.observations.length === 0) void save({ action: 'set_decision', decision: 'reviewed_no_discernible_event', preview_id: previewID }); },
    addObservation: () => { if (review && !unableNote.trim() && review.observations.length < 100) edit(); },
  }));

  return <section aria-labelledby="review-heading" aria-busy={saving || loading} className="space-y-3">
    <div className="flex items-center justify-between gap-2">
      <h3 id="review-heading" className="text-sm font-semibold">First review</h3>
      {review && <Badge variant={effective === 'unreviewed' ? 'outline' : effective === 'reviewed_with_observations' ? 'info' : 'success'}>{decisionText[effective ?? 'unreviewed']}</Badge>}
    </div>
    {loading && <p role="status" className="text-xs text-muted-foreground">Loading saved review...</p>}
    {error && <p role="alert" className="rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-800">{error}</p>}
    {notice && <p role="status" className="text-xs text-emerald-700">{notice}</p>}
    {review && <>
      {needsReverification && <p role="alert" className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900">Needs a new check: the earlier decision ({decisionText[review.decision]}) is no longer current. {warning}</p>}
      {(!review.can_verify || sourceUnavailable) && <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900">This window cannot be verified against its original. Record why under "Unable to assess". {warning}</p>}
      <div className="space-y-1"><Label htmlFor="reviewer-label" className="text-xs">Reviewer</Label>
        <Input id="reviewer-label" className="h-9" value={actor} maxLength={120} disabled={lock} placeholder="Your name or initials" onChange={event => onActorChange(event.target.value)} /></div>
      {!previewID && !sourceUnavailable && <p className="text-xs text-muted-foreground">Watch the original video on the left before deciding. A decision is only saved with a preview of this exact window.</p>}
      {review.observations.length === 0 && editor === null && <div className="grid gap-2">
        <Button disabled={!canDecide} onClick={() => void save({ action: 'set_decision', decision: 'reviewed_no_discernible_event', preview_id: previewID })}><Check />No activity seen<kbd className="ml-auto rounded border border-white/40 px-1 text-[10px]">N</kbd></Button>
        <Button variant="outline" disabled={lock || unableNote.trim() !== ''} onClick={() => edit()}><Plus />Add observation<kbd className="ml-auto rounded border px-1 text-[10px]">O</kbd></Button>
      </div>}
      {review.observations.length > 0 && <div className="space-y-2">
        <ol aria-label="Saved provisional observations" className="space-y-2">{review.observations.map(observation => <li key={observation.id} className="rounded-md border bg-white p-2 text-xs">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-medium">{categoryText[observation.category]} · {observation.count === null ? 'Count unknown' : `Count ${observation.count}`}{observation.uncertain ? ' · uncertain' : ''}</p>
              <p className="text-muted-foreground">{at(observation.start_pts)} to {at(observation.end_pts)}{observation.activity ? ` · ${observation.activity}` : ''}</p>
              {observation.notes && <p>{observation.notes}</p>}
            </div>
            <div className="flex shrink-0">
              <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Edit observation" disabled={lock || editor !== null || unableNote.trim() !== ''} onClick={() => edit(observation)}><Pencil /></Button>
              <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Delete observation" disabled={lock || editor !== null || unableNote.trim() !== ''} onClick={() => void save({ action: 'delete_observation', observation_id: observation.id })}><Trash2 /></Button>
            </div>
          </div>
        </li>)}</ol>
        {editor === null && <div className="grid gap-2">
          <Button disabled={!canDecide} onClick={() => void save({ action: 'set_decision', decision: 'reviewed_with_observations', preview_id: previewID })}><Check />Mark reviewed with observations</Button>
          <Button variant="outline" disabled={lock || unableNote.trim() !== '' || review.observations.length >= 100} onClick={() => edit()}><Plus />Add observation</Button>
        </div>}
      </div>}
      {editor && <form aria-label={editingID ? 'Edit observation' : 'New observation'} className="space-y-2 rounded-md border bg-white p-3" onSubmit={event => { event.preventDefault(); void saveObservation(); }}>
        <p className="text-xs font-semibold">{editingID ? 'Edit observation' : 'New observation'}</p>
        <div className="grid grid-cols-[1fr,6.5rem] gap-2">
          <div className="space-y-1"><Label htmlFor="observation-category" className="text-xs">What moved</Label>
            <Select id="observation-category" className="h-9" value={editor.category} disabled={lock} onChange={event => field('category', event.target.value as ProvisionalObservationInput['category'])}>
              {Object.entries(categoryText).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </Select></div>
          <div className="space-y-1"><Label htmlFor="observation-count" className="text-xs">Count</Label><Input id="observation-count" className="h-9" value={countText} disabled={lock} inputMode="numeric" maxLength={6} placeholder="unknown" onChange={event => { setCountText(event.target.value); markDirty(); }} /></div>
        </div>
        <div className="space-y-1 rounded-md bg-muted/50 p-2 text-xs">
          <p>Starts at <strong>{at(editor.start_pts)}</strong>, ends before <strong>{at(editor.end_pts)}</strong> (time into this window)</p>
          <p className="text-muted-foreground">Pause the original video on a frame, then:</p>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="outline" className="h-7" disabled={lock || displayedStart === null} onClick={() => { if (displayedStart !== null) field('start_pts', displayedStart); }}>Use current frame as start</Button>
            <Button size="sm" variant="outline" className="h-7" disabled={lock || displayedEnd === null} onClick={() => { if (displayedEnd !== null) field('end_pts', displayedEnd); }}>Use current frame as end</Button>
          </div>
          <details><summary className="cursor-pointer text-muted-foreground">Exact source PTS</summary>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <div className="space-y-1"><Label htmlFor="observation-start" className="text-xs">Observation start source PTS</Label><Input id="observation-start" className="h-8 font-mono text-xs" value={editor.start_pts} disabled={lock} inputMode="numeric" maxLength={20} onChange={event => field('start_pts', event.target.value)} /></div>
              <div className="space-y-1"><Label htmlFor="observation-end" className="text-xs">Observation end source PTS (exclusive)</Label><Input id="observation-end" className="h-8 font-mono text-xs" value={editor.end_pts} disabled={lock} inputMode="numeric" maxLength={20} onChange={event => field('end_pts', event.target.value)} /></div>
            </div>
            <p className="mt-1 text-muted-foreground">Timebase {tb.num}/{tb.den} s. The end frame is excluded.</p>
          </details>
        </div>
        <div className="space-y-1"><Label htmlFor="observation-activity" className="text-xs">Behaviour (optional)</Label><Input id="observation-activity" className="h-9" value={editor.activity ?? ''} disabled={lock} maxLength={120} placeholder="e.g. emerging, re-entering, commuting" onChange={event => field('activity', event.target.value)} /></div>
        <label className="flex items-center gap-2 text-xs"><Checkbox checked={editor.uncertain} disabled={lock} onChange={event => field('uncertain', event.target.checked)} />Uncertain observation</label>
        <div className="space-y-1"><Label htmlFor="observation-notes" className="text-xs">Notes</Label><Textarea id="observation-notes" className="min-h-[56px]" value={editor.notes} disabled={lock} maxLength={2000} onChange={event => field('notes', event.target.value)} /></div>
        <div className="flex gap-2"><Button type="submit" size="sm" disabled={lock}>{saving ? 'Saving...' : 'Save observation'}</Button><Button size="sm" variant="outline" disabled={saving} onClick={discard}>Cancel</Button></div>
      </form>}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">Unable to assess, undo, history</summary>
        <div className="mt-2 space-y-2">
          <div className="space-y-1"><Label htmlFor="unable-note" className="text-xs">Unable-to-assess note</Label>
            <Textarea id="unable-note" className="min-h-[56px]" value={unableNote} maxLength={2000} disabled={lock || editor !== null} placeholder="Why this window cannot be assessed" onChange={event => { setUnableNote(event.target.value); markDirty(); }} /></div>
          {review.unable_note && <p className="rounded-md bg-amber-50 px-2 py-1 text-amber-900">Saved note: {review.unable_note}</p>}
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="outline" className="h-8" disabled={lock || editor !== null || !unableNote.trim()} onClick={() => void save({ action: 'unable_to_assess', note: unableNote.trim() })}><Ban />Save unable-to-assess note</Button>
            <Button size="sm" variant="outline" className="h-8" disabled={lock || editor !== null || unableNote.trim() !== '' || effective === 'unreviewed'} onClick={() => void save({ action: 'set_decision', decision: 'unreviewed', preview_id: null })}><RotateCcw />Return to unreviewed</Button>
            <Button size="sm" variant="ghost" className="h-8" onClick={() => void loadHistory()}><History />Show review history</Button>
          </div>
          {history && <div className="space-y-1 rounded-md border bg-white p-2"><p className="font-medium">Review history ({history.events.length} shown)</p>
            <ol className="space-y-1">{history.events.map(event => <li key={event.revision}>#{event.revision} · {new Date(event.utc).toLocaleString()} · {event.actor} · {event.action.replaceAll('_', ' ')}</li>)}</ol>
            {history.next_after_revision !== null && <Button size="sm" variant="ghost" className="h-7" onClick={() => void loadHistory(true)}>Load more</Button>}
          </div>}
        </div>
      </details>
      {dirty && editor === null && <div className="flex items-center justify-between gap-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900" role="status">Unsaved changes<Button size="sm" variant="outline" className="h-7" onClick={discard}>Discard draft</Button></div>}
    </>}
  </section>;
});
