import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, ChevronsRight, X } from 'lucide-react';
import type { SummaryWindow } from '../../../electron/src/contracts';
import { activeRun, useSurvey } from '../survey';
import type { DisplayedSourceFrame, WindowSourceFrame } from '../sourceFrame';
import { rational, span } from '../lib/time';
import { flagText, isUnreviewed, motionText, warningFlags } from '../lib/windows';
import { Dialog } from './ui/dialog';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { SummaryImage } from './SummaryImage';
import { SourcePreview } from './SourcePreview';
import { ReviewPanel } from './ReviewPanel';
import type { ReviewPanelHandle } from './ReviewPanel';
import { QAPanel } from './QAPanel';

const REVIEWER_KEY = 'bat:reviewer';
function savedReviewer(): string { try { return localStorage.getItem(REVIEWER_KEY) ?? ''; } catch { return ''; } }

const interval = (start: { num: string; den: string }, end: { num: string; den: string } | null) => `[${rational(start)}, ${rational(end)})`;

function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return <div className="mx-3 mt-3 rounded-lg border bg-muted/40 p-3">{title && <h3 className="mb-2 text-sm font-semibold">{title}</h3>}{children}</div>;
}

/** One window: motion summary and original video on the left, review and QA on the right (Camera_Trap's detail shell). */
export function WindowDialog({ windows, initialID, onClose }: { windows: SummaryWindow[]; initialID: string; onClose: () => void }) {
  const survey = useSurvey();
  const [id, setID] = useState(initialID);
  const [receipt, setReceipt] = useState<{ windowID: string; previewID: string } | null>(null);
  const [frame, setFrame] = useState<WindowSourceFrame | null>(null);
  const [firstDirty, setFirstDirty] = useState(false);
  const [qaDirty, setQADirty] = useState(false);
  const [message, setMessage] = useState('');
  const [reviewer, setReviewer] = useState(savedReviewer);
  const review = useRef<ReviewPanelHandle>(null);
  const snapshot = useRef<SummaryWindow | null>(null);
  const dirty = firstDirty || qaDirty;
  const latest = windows.find(window => window.id === id);
  if (latest) snapshot.current = latest;
  const selected = latest ?? (dirty ? snapshot.current : null);
  const position = windows.findIndex(window => window.id === id);
  const segment = survey.media?.segments.find(item => item.id === selected?.segment_id);
  const processing = activeRun(survey.run);
  const sourceReady = segment?.source_state === 'ready' && (!selected?.source_state || selected.source_state === 'ready');
  const previewEnabled = !!selected && !processing && survey.verified && sourceReady && selected.preview_pts !== null && survey.importJob?.state !== 'running';

  useEffect(() => { survey.setDraft('review', dirty); return () => survey.setDraft('review', false); }, [dirty]);
  useEffect(() => { setReceipt(null); setFrame(null); setMessage(''); }, [id]);

  function go(target: SummaryWindow | undefined) {
    if (!target) return;
    if (dirty) { setMessage('Save or discard your changes before moving to another window.'); return; }
    setID(target.id);
  }
  function navigate(direction: 'prev' | 'next' | 'unreviewed') {
    if (direction === 'unreviewed') go([...windows.slice(position + 1), ...windows.slice(0, Math.max(0, position))].find(isUnreviewed));
    else go(windows[position + (direction === 'prev' ? -1 : 1)]);
  }
  function close() {
    if (dirty && !window.confirm('Discard unsaved review changes for this window?')) return;
    onClose();
  }
  function shortcut(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, video, summary, [contenteditable]')) return;
    const key = event.key.toLowerCase();
    if (event.key === 'ArrowLeft') navigate('prev');
    else if (event.key === 'ArrowRight') navigate('next');
    else if (key === 'u') navigate('unreviewed');
    else if (key === 'n') review.current?.markNoEvent();
    else if (key === 'o') review.current?.addObservation();
    else return;
    event.preventDefault();
  }
  function displayed(value: DisplayedSourceFrame | null) {
    setFrame(value && selected ? { ...value, windowID: selected.id } : null);
  }

  const name = segment?.metadata.filename ?? 'video';
  const title = selected ? `Window ${span(selected.interval.elapsed_start, selected.interval.elapsed_end)} of ${name}` : 'Window';
  return <Dialog open onClose={close} title={title} hideTitle className="h-[92vh] w-[95vw] overflow-hidden">
    {selected ? <div className="flex h-full min-h-0" onKeyDown={shortcut} tabIndex={-1}>
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto bg-slate-950 p-3">
        <section aria-label="Motion summary" className="space-y-1">
          <SummaryImage window={selected} enabled={survey.verified} lazy={false} priority={1} alt={`Reference and motion evidence for ${title}`} className="max-h-[42vh] w-full" />
          <p className="text-xs text-slate-400">Left: first frame. Right: where things moved. Cyan = early, yellow = middle, magenta = late third of the window. Colours do not identify animals.</p>
        </section>
        {segment && selected.preview_pts !== null && <SourcePreview key={selected.id} segment={segment} initialPTS={selected.preview_pts}
          minPTS={selected.stats.first_pts ?? selected.preview_pts} maxPTS={selected.interval.end_pts?.den === '1' ? selected.interval.end_pts.num : null}
          enabled={previewEnabled} disabledReason={processing ? 'The original video opens when processing finishes.' : !sourceReady ? 'The original video is missing or changed.' : 'Original video unavailable.'}
          onReady={previewID => setReceipt(previewID ? { windowID: selected.id, previewID } : null)} onDisplayedFrame={displayed} />}
      </div>
      <aside aria-label="Window review" className="flex w-96 shrink-0 flex-col border-l bg-white">
        <div className="flex items-center justify-between border-b px-3 py-1.5">
          <div className="flex items-center gap-0.5">
            <span className="mr-1 text-xs text-muted-foreground">{position + 1} of {windows.length}</span>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Previous window" title="Previous (Left arrow)" disabled={position <= 0} onClick={() => navigate('prev')}><ChevronLeft /></Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Next window" title="Next (Right arrow)" disabled={position < 0 || position >= windows.length - 1} onClick={() => navigate('next')}><ChevronRight /></Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Next unreviewed window" title="Next unreviewed (U)" disabled={!windows.some(window => window.id !== id && isUnreviewed(window))} onClick={() => navigate('unreviewed')}><ChevronsRight /></Button>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Close window" onClick={close}><X /></Button>
        </div>
        <div className="flex-1 overflow-y-auto pb-3">
          {message && <p role="alert" className="mx-3 mt-3 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900">{message}</p>}
          {!latest && <p role="alert" className="mx-3 mt-3 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-800">This window is missing from the latest run data. Your draft is kept, but it cannot be saved.</p>}
          <Card>
            <h2 className="text-base font-semibold">{span(selected.interval.elapsed_start, selected.interval.elapsed_end)}</h2>
            <p className="truncate text-xs text-muted-foreground" title={name}>{name} · window {selected.index + 1}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              <Badge variant={selected.status === 'complete' ? 'secondary' : 'danger'}>{selected.status}</Badge>
              {selected.qa && <Badge variant="outline">QA {selected.qa.status.replaceAll('_', ' ')}</Badge>}
            </div>
            <p className="mt-2 text-xs">{motionText(selected)}</p>
            {selected.error && <p className="mt-1 text-xs text-red-700">{selected.error.message}</p>}
            {warningFlags(selected).length > 0 && <ul aria-label="Window quality flags" className="mt-2 space-y-1 text-xs text-amber-800">
              {warningFlags(selected).map(flag => <li key={flag} className="flex gap-1"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{flagText[flag] ?? flag.replaceAll('_', ' ')}</li>)}
            </ul>}
          </Card>
          <Card>
            {processing ? <p className="text-xs text-muted-foreground">Review opens when processing finishes.</p>
              : <ReviewPanel ref={review} key={`review:${selected.id}`} window={selected} previewID={receipt?.windowID === selected.id ? receipt.previewID : null}
                actor={reviewer} onActorChange={value => { setReviewer(value); try { localStorage.setItem(REVIEWER_KEY, value.trim()); } catch { /* convenience only */ } }}
                displayedSourceFrame={frame} disabled={!latest || !survey.verified || qaDirty} onDirtyChange={setFirstDirty} onSaved={survey.reloadRun} />}
          </Card>
          {!processing && <Card><details>
            <summary className="cursor-pointer text-sm font-semibold">Second review (QA)</summary>
            <div className="mt-2"><QAPanel key={`qa:${selected.id}`} window={selected} previewID={receipt?.windowID === selected.id ? receipt.previewID : null}
              disabled={!latest || !survey.verified || firstDirty} onDirtyChange={setQADirty} onSaved={survey.reloadRun} /></div>
          </details></Card>}
          <Card><details className="text-xs">
            <summary className="cursor-pointer text-sm font-semibold">Technical details</summary>
            <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-2 gap-y-1 break-all">
              <dt className="text-muted-foreground">Source PTS</dt><dd>{interval(selected.interval.start_pts, selected.interval.end_pts)}</dd>
              <dt className="text-muted-foreground">Timebase</dt><dd>{rational(selected.time_base)}</dd>
              <dt className="text-muted-foreground">Source time (s)</dt><dd>{interval(selected.interval.start_time, selected.interval.end_time)}</dd>
              <dt className="text-muted-foreground">Video elapsed (s)</dt><dd>{interval(selected.interval.elapsed_start, selected.interval.elapsed_end)}</dd>
              <dt className="text-muted-foreground">Frames / comparisons</dt><dd>{selected.stats.frame_count ?? '-'} / {selected.stats.comparison_count ?? '-'}</dd>
              <dt className="text-muted-foreground">Motion pixels</dt><dd>{selected.stats.motion_pixels ?? '-'} (early, middle, late: {selected.stats.phase_pixels?.join(', ') ?? '-'})</dd>
              <dt className="text-muted-foreground">Timestamp gaps</dt><dd>{selected.stats.gap_count ?? '-'}; max spacing {rational(selected.stats.max_spacing)} s</dd>
              <dt className="text-muted-foreground">All flags</dt><dd>{selected.flags.join(', ') || 'none'}</dd>
              <dt className="text-muted-foreground">Window / run</dt><dd className="font-mono">{selected.id} / {selected.run_id}</dd>
              <dt className="text-muted-foreground">Source SHA256</dt><dd className="font-mono">{selected.source_sha256}</dd>
              <dt className="text-muted-foreground">Image SHA256</dt><dd className="font-mono">{selected.image?.sha256 ?? 'none'}</dd>
              <dt className="text-muted-foreground">Decoded PTS SHA256</dt><dd className="font-mono">{selected.stats.pts_digest ?? '-'}</dd>
            </dl>
          </details></Card>
          <p className="mx-3 mt-3 text-[11px] text-muted-foreground">Keys: Left/Right previous/next, U next unreviewed, N no activity, O add observation, Esc close.</p>
        </div>
      </aside>
    </div> : <div className="flex items-center justify-between p-6"><p>This window is no longer part of the run.</p><Button onClick={onClose}>Close</Button></div>}
  </Dialog>;
}
