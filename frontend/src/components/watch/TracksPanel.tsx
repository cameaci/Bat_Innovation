import { useMemo, useRef, useState } from 'react';
import { Lasso, Tag, Undo2 } from 'lucide-react';
import type { TrackLabels } from '../../../../electron/src/contracts';
import { categoryName, filterRows, UK_SPECIES, type TrackFilter, type TrackRow, type TrackSort } from '../../lib/trackTable';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';

const QUALITY_TEXT: Record<string, string> = { coherent: 'text-emerald-300', uncertain: 'text-amber-300', noise: 'text-slate-500', unrated: 'text-slate-300' };

/**
 * Every track of the survey as a table: filter, sort, click a row to go to its first frame, select tracks by
 * ticking, by filter or by an area drawn on the video, and label the selection in one audited action. Labels and
 * species are reviewer entries; they never change a count.
 */
export function TracksPanel({ rows, labels, segmentID, selected, setSelected, focused, onFocus, actor, onLabel, onUndo, onSelectArea, selectingArea }: {
  rows: TrackRow[];
  labels: TrackLabels | null;
  segmentID: string | null;
  selected: Set<string>;
  setSelected: (ids: Set<string>) => void;
  focused: string | null;
  onFocus: (row: TrackRow) => void;
  actor: string;
  onLabel: (input: { track_ids: string[]; category: string; species: string; comment: string }) => Promise<string | null>;
  onUndo: (eventID: string) => Promise<string | null>;
  onSelectArea: () => void;
  selectingArea: boolean;
}) {
  const [filter, setFilter] = useState<TrackFilter>({ quality: 'all', label: 'all', crossed: false, video: null });
  const [sort, setSort] = useState<TrackSort>('time');
  const [category, setCategory] = useState('exit');
  const [custom, setCustom] = useState('');
  const [species, setSpecies] = useState('');
  const [comment, setComment] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const table = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => filterRows(rows, filter, sort), [rows, filter, sort]);
  const categories = [...(labels?.categories ?? []), ...(labels?.custom ?? [])];
  const chosen = category === '__new' ? custom.trim() : category;
  const undone = new Set((labels?.events ?? []).map(event => event.undoes).filter(Boolean));
  const history = (labels?.events ?? []).filter(event => !event.undoes).slice(-5).reverse();

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

  async function apply() {
    setBusy(true); setError(''); setMessage('');
    const failure = await onLabel({ track_ids: [...selected], category: chosen, species: species.trim(), comment: comment.trim() });
    setBusy(false);
    if (failure) { setError(failure); return; }
    setMessage(`Labelled ${selected.size} track${selected.size === 1 ? '' : 's'} as ${categoryName(chosen)}.`);
    setSelected(new Set()); setComment(''); setCustom(''); if (category === '__new') setCategory(chosen);
  }

  function keys(event: React.KeyboardEvent) {
    // Up and down move through the shown rows and go to each track; x ticks the focused row.
    const index = shown.findIndex(row => row.id === focused);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation();
      const next = shown[Math.max(0, Math.min(shown.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (next) { onFocus(next); table.current?.querySelector(`[data-track="${next.id}"]`)?.scrollIntoView({ block: 'nearest' }); }
    } else if (event.key === 'x' && focused) { event.preventDefault(); event.stopPropagation(); toggle(focused); }
  }

  const select = 'rounded bg-slate-800 px-1 py-0.5 text-xs';
  return <section aria-label="Track table" className="space-y-2 rounded-lg border border-slate-800 bg-slate-900 p-4 text-slate-100">
    <div className="flex items-baseline justify-between gap-2">
      <p className="text-sm font-semibold">Tracks</p>
      <p className="text-[11px] text-slate-400" aria-label="Track table summary">{shown.length} of {rows.length} shown, {selected.size} selected</p>
    </div>
    <div className="flex flex-wrap gap-1">
      <select aria-label="Quality filter" className={select} value={filter.quality} onChange={event => setFilter({ ...filter, quality: event.target.value as TrackFilter['quality'] })}>
        <option value="all">All qualities</option><option value="coherent">Coherent</option><option value="uncertain">Uncertain</option><option value="noise">Noise</option>
      </select>
      <select aria-label="Label filter" className={select} value={filter.label} onChange={event => setFilter({ ...filter, label: event.target.value })}>
        <option value="all">Any label</option><option value="unlabelled">Unlabelled</option>
        {categories.map(item => <option key={item} value={item}>{categoryName(item)}</option>)}
      </select>
      <select aria-label="Sort tracks" className={select} value={sort} onChange={event => setSort(event.target.value as TrackSort)}>
        <option value="time">By time</option><option value="duration">Longest first</option><option value="points">Most points first</option>
      </select>
      <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={filter.crossed} onChange={event => setFilter({ ...filter, crossed: event.target.checked })} />Crossed gate</label>
      <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={filter.video !== null} onChange={event => setFilter({ ...filter, video: event.target.checked ? segmentID : null })} />This video</label>
    </div>
    <div ref={table} tabIndex={0} onKeyDown={keys} className="max-h-72 overflow-auto rounded border border-slate-800 focus:outline focus:outline-1 focus:outline-sky-500">
      <table className="w-full text-left text-[11px] tabular-nums">
        <thead className="sticky top-0 bg-slate-900 text-slate-400"><tr>
          <th className="px-1"><input type="checkbox" aria-label="Select all shown" checked={shown.length > 0 && shown.every(row => selected.has(row.id))}
            onChange={event => { const next = new Set(selected); shown.forEach(row => event.target.checked ? next.add(row.id) : next.delete(row.id)); setSelected(next); }} /></th>
          <th className="px-1">#</th><th className="px-1">Video</th><th className="px-1">Start s</th><th className="px-1">Dur s</th><th className="px-1">Pts</th>
          <th className="px-1">Quality</th><th className="px-1">Gate</th><th className="px-1">Label</th><th className="px-1">Species</th>
        </tr></thead>
        <tbody>
          {shown.map(row => <tr key={row.id} data-track={row.id} aria-selected={row.id === focused} onClick={() => onFocus(row)}
            className={cn('cursor-pointer border-t border-slate-800 hover:bg-slate-800', row.id === focused && 'bg-sky-900/60')}>
            <td className="px-1" onClick={event => event.stopPropagation()}><input type="checkbox" aria-label={`Select track ${row.index + 1} of video ${row.video}`} checked={selected.has(row.id)} onChange={() => toggle(row.id)} /></td>
            <td className="px-1">{row.index + 1}</td><td className="px-1">{row.video}</td><td className="px-1">{row.start.toFixed(1)}</td>
            <td className="px-1">{row.seconds.toFixed(1)}</td><td className="px-1">{row.points}</td>
            <td className={cn('px-1', QUALITY_TEXT[row.quality])}>{row.quality}{row.decision ? ` (${row.decision.replace('_', ' ')})` : ''}</td>
            <td className="px-1">{row.crossings.join(', ')}</td>
            <td className="px-1" title={row.comment}>{row.category ? categoryName(row.category) : ''}</td>
            <td className="max-w-24 truncate px-1 italic" title={row.species}>{row.species}</td>
          </tr>)}
        </tbody>
      </table>
      {shown.length === 0 && <p className="p-2 text-xs text-slate-400">{rows.length ? 'No track matches these filters.' : 'No tracks in this run.'}</p>}
    </div>
    <p className="text-[11px] text-slate-500">Click a row to go to the track's first frame. Up/down move, x ticks the focused row.</p>
    <div className="flex flex-wrap items-center gap-1">
      <Button size="sm" variant="ghost" className={cn('h-7 text-slate-200', selectingArea && 'bg-slate-700')} onClick={onSelectArea}><Lasso />{selectingArea ? 'Click points, Enter to finish' : 'Select by area'}</Button>
      {selected.size > 0 && <Button size="sm" variant="ghost" className="h-7 text-slate-200" onClick={() => setSelected(new Set())}>Clear selection</Button>}
    </div>
    <div className="space-y-1 rounded border border-slate-800 p-2">
      <p className="text-xs font-semibold">Label the selection</p>
      <div className="flex flex-wrap gap-1">
        <select aria-label="Label category" className={select} value={category} onChange={event => setCategory(event.target.value)}>
          {categories.map(item => <option key={item} value={item}>{categoryName(item)}</option>)}
          {(labels?.custom.length ?? 0) < 6 && <option value="__new">New label...</option>}
        </select>
        {category === '__new' && <input aria-label="New label" maxLength={30} value={custom} onChange={event => setCustom(event.target.value)} placeholder="e.g. light-sampling" className="w-32 rounded bg-slate-800 px-2 py-0.5 text-xs" />}
        <input aria-label="Species" list="uk-bat-species" maxLength={80} value={species} onChange={event => setSpecies(event.target.value)} placeholder="Species (optional)" className="min-w-0 flex-1 rounded bg-slate-800 px-2 py-0.5 text-xs italic" />
        <datalist id="uk-bat-species">{UK_SPECIES.map(item => <option key={item} value={item} />)}</datalist>
      </div>
      <input aria-label="Label comment" maxLength={2000} value={comment} onChange={event => setComment(event.target.value)} placeholder="Comment (optional)" className="w-full rounded bg-slate-800 px-2 py-0.5 text-xs" />
      <Button size="sm" className="h-7" disabled={busy || selected.size === 0 || !chosen || !actor.trim()} onClick={() => void apply()}>
        <Tag />Label {selected.size} track{selected.size === 1 ? '' : 's'}</Button>
      {!actor.trim() && <p className="text-[11px] text-amber-200">Enter your name in the Counts tab to label tracks.</p>}
      <p className="text-[11px] text-slate-500">Species is entered by you, never inferred. Labels never change a count.</p>
      {message && <p role="status" aria-label="Label message" className="text-xs text-emerald-200">{message}</p>}
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    </div>
    {history.length > 0 && <div className="space-y-1">
      <p className="text-xs font-semibold">Recent label actions</p>
      {history.map(event => <div key={event.id} className={cn('flex items-center gap-2 text-[11px]', undone.has(event.id) && 'text-slate-500 line-through')}>
        <span className="flex-1">{event.actor}: {categoryName(event.category ?? '')} on {event.track_ids.length} track{event.track_ids.length === 1 ? '' : 's'}{event.species ? `, ${event.species}` : ''}</span>
        {!undone.has(event.id) && <Button size="sm" variant="ghost" className="h-6 px-1 text-slate-300" aria-label={`Undo label ${categoryName(event.category ?? '')}`}
          disabled={!actor.trim()} onClick={() => { setError(''); void onUndo(event.id).then(failure => { if (failure) setError(failure); }); }}><Undo2 />Undo</Button>}
      </div>)}
    </div>}
  </section>;
}
