import { useEffect, useRef, useState } from 'react';
import type { MediaSegment, SummaryWindow } from '../../electron/src/contracts';
import { getAPI } from './api';
import { readMediaBytes } from './binary';

const pageSize = 12;
const filters = ['All windows', 'Unreviewed', 'Reviewed', 'Contains observations', 'Quality flagged', 'Failed/incomplete', 'Requires re-verification'] as const;
type Filter = typeof filters[number];
const rational = (value: SummaryWindow['interval']['elapsed_end']) => value ? `${value.num}/${value.den}` : 'Unknown';

function matches(window: SummaryWindow, filter: Filter): boolean {
  switch (filter) {
    case 'Unreviewed': return !window.review || window.review.effective_decision === 'unreviewed';
    case 'Reviewed': return !!window.review && window.review.effective_decision !== 'unreviewed';
    case 'Contains observations': return (window.review?.observation_count ?? 0) > 0;
    case 'Quality flagged': return window.flags.length > 0;
    case 'Failed/incomplete': return window.status === 'failed' || window.status === 'incomplete';
    case 'Requires re-verification': return window.review?.needs_reverification === true;
    default: return true;
  }
}

function Thumbnail({ window, enabled, onFailure }: { window: SummaryWindow; enabled: boolean; onFailure: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setURL] = useState<string | null>(null);
  const [error, setError] = useState('');
  const failed = useRef(onFailure);
  failed.current = onFailure;

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '100px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setURL(null); setError('');
    if (!visible || !enabled || window.status !== 'complete' || !window.image || (window.source_state && window.source_state !== 'ready')) return;
    const controller = new AbortController();
    let current = true;
    let created: string | undefined;
    async function load() {
      try {
        const result = await readMediaBytes(() => getAPI()?.summaryImage(window.id), { signal: controller.signal, priority: 0 });
        if (!current) return;
        if (!result.ok) { setError(result.error.message); failed.current(); return; }
        const bytes = new Uint8Array(result.value.bytes);
        if (bytes.byteLength < 1 || bytes.byteLength > 4 * 1024 * 1024) {
          setError('The summary image is empty or exceeds its 4 MiB limit.'); failed.current(); return;
        }
        created = URL.createObjectURL(new Blob([bytes.buffer], { type: 'image/png' }));
        setURL(created);
      } catch {
        if (current) { setError('The summary thumbnail could not be read. Refresh summary runs to retry.'); failed.current(); }
      }
    }
    void load();
    return () => { current = false; controller.abort(); if (created) URL.revokeObjectURL(created); };
  }, [visible, enabled, window.id, window.status, window.image?.sha256, window.source_state]);

  return <div className="summary-thumbnail" ref={container}>
    {url ? <img src={url} alt={`Summary thumbnail for window ${window.index + 1}`} onError={() => {
      URL.revokeObjectURL(url); setURL(null); setError('The generated thumbnail could not be displayed.'); failed.current();
    }} /> : <p>{error || (window.status !== 'complete' || !window.image ? 'No complete summary image.' : window.source_state && window.source_state !== 'ready' ? 'Original unavailable; thumbnail unresolved.' : !enabled ? 'Thumbnail validation paused.' : 'Thumbnail loads when visible.')}</p>}
  </div>;
}

export function SummaryGallery({ windows, segments, selectedID, disabled, previewDisabled, verified, reviewEnabled, onInspect, onPreview, onImageFailure }: {
  windows: SummaryWindow[];
  segments: MediaSegment[];
  selectedID: string;
  disabled: boolean;
  previewDisabled: boolean;
  verified: boolean;
  reviewEnabled: boolean;
  onInspect: (id: string) => void;
  onPreview: (window: SummaryWindow) => void;
  onImageFailure: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('All windows');
  const [page, setPage] = useState(0);
  const matching = windows.filter(window => matches(window, filter));
  const pages = Math.max(1, Math.ceil(matching.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const start = currentPage * pageSize;
  const shown = matching.slice(start, start + pageSize);
  const bySegment = new Map(segments.map(segment => [segment.id, segment]));
  const sourcePositions = new Map([...new Set(windows.map(window => window.segment_id))].map((id, index) => [id, index + 1]));
  const selectedPosition = windows.findIndex(window => window.id === selectedID);

  return <div className="summary-gallery">
    <h3 id="window-gallery" tabIndex={-1}>Chronological window gallery</h3>
    {selectedPosition >= 0 && <p className="detail">Selected run window {selectedPosition + 1}{shown.some(window => window.id === selectedID) ? '' : ' (outside this page or filter; its inspection remains open below)'}.</p>}
    <label htmlFor="window-filter">Window filter</label>
    <select id="window-filter" value={filter} disabled={disabled} onChange={event => {
      if (!disabled) { setFilter(event.target.value as Filter); setPage(0); }
    }}>{filters.map(value => <option key={value}>{value}</option>)}</select>
    <p className="detail">Filters affect this gallery only. Review progress always includes every planned window. Previous, next and next-unreviewed navigation follow all windows, across filters; segments remain separate.</p>
    <p role="status" className="gallery-count">Showing {matching.length ? start + 1 : 0}-{Math.min(start + pageSize, matching.length)} of {matching.length} matching windows; {windows.length} manifest windows in this run. Page {currentPage + 1} of {pages}.</p>
    <nav className="media-actions" aria-label="Gallery pages">
      <button type="button" disabled={disabled || currentPage === 0} onClick={() => { if (!disabled) setPage(currentPage - 1); }}>Previous gallery page</button>
      <button type="button" disabled={disabled || currentPage === pages - 1} onClick={() => { if (!disabled) setPage(currentPage + 1); }}>Next gallery page</button>
    </nav>
    {matching.length === 0 && <p>No windows match this filter. Choose All windows to reach every planned interval.</p>}
    <ol className="summary-list summary-grid" aria-label={filter === 'All windows' ? 'All planned windows' : 'Filtered planned windows'} start={start + 1}>{shown.map(window => {
      const segment = bySegment.get(window.segment_id);
      const sourceReady = segment?.source_state === 'ready' && (!window.source_state || window.source_state === 'ready');
      return <li key={window.id}><article aria-label={`Window ${window.index + 1}: ${segment?.metadata.filename ?? window.segment_id}`} aria-current={selectedID === window.id ? 'true' : undefined} className={selectedID === window.id ? 'selected-window' : undefined}>
        <h3>Run window {windows.indexOf(window) + 1} · Segment window {window.index + 1} · {segment?.metadata.filename ?? window.segment_id}</h3>
        <p className="detail">Run source segment {sourcePositions.get(window.segment_id)} · {window.segment_id}</p>
        {selectedID === window.id && <p className="selected-label">Selected window</p>}
        <Thumbnail window={window} enabled={verified && sourceReady} onFailure={onImageFailure} />
        <p>Processing: <strong>{window.status}</strong> · Segment elapsed seconds: [{rational(window.interval.elapsed_start)}, {rational(window.interval.elapsed_end)})</p>
        <p>{window.status !== 'complete' ? 'Motion evidence unavailable or incomplete.' : (window.stats.comparison_count ?? 0) === 0 ? 'No frame comparison available; motion cannot be assessed.' : window.stats.motion_pixels === 0 ? 'No motion evidence above threshold.' : 'Motion evidence above threshold.'}</p>
        {reviewEnabled && <p>First review: <strong>{(window.review?.effective_decision ?? 'unreviewed').replaceAll('_', ' ')}</strong> · {window.review?.observation_count ?? 0} provisional observations{window.review?.needs_reverification ? ' · Re-verification required' : ''}</p>}
        {window.flags.length > 0 && <ul className="source-warning" aria-label="Window quality flags">{window.flags.map(flag => <li key={flag}>{flag.replaceAll('_', ' ')}</li>)}</ul>}
        {window.error && <p className="source-warning">{window.error.code}: {window.error.message}</p>}
        {(!sourceReady || window.source_state && window.source_state !== 'ready') && <p className="source-warning">Original source state: {window.source_state ?? segment?.source_state ?? 'unavailable'}. Derived image and source preview are unavailable.</p>}
        <div className="media-actions"><button type="button" disabled={disabled} aria-pressed={selectedID === window.id} onClick={() => onInspect(window.id)}>Inspect summary</button><button type="button" disabled={previewDisabled || (disabled && selectedID !== window.id) || !verified || !sourceReady || window.preview_pts === null} onClick={() => onPreview(window)}>Preview window source</button></div>
      </article></li>;
    })}</ol>
  </div>;
}
