import { useEffect, useRef, useState } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import type { SummaryWindow } from '../../../electron/src/contracts';
import { getAPI } from '../api';
import { readMediaBytes } from '../binary';
import { cn } from '../lib/utils';

const MAX_BYTES = 4 * 1024 * 1024;

/**
 * A window's summary PNG. Thumbnails load lazily at low priority; the inspection image loads at once with higher
 * priority. Reads share the main process's single binary-transfer reservation through readMediaBytes.
 */
export function SummaryImage({ window, alt, enabled, priority = 0, lazy = true, className }: {
  window: SummaryWindow; alt: string; enabled: boolean; priority?: number; lazy?: boolean; className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(!lazy);
  const [url, setURL] = useState<string | null>(null);
  const [error, setError] = useState('');
  const available = enabled && window.status === 'complete' && !!window.image && (!window.source_state || window.source_state === 'ready');

  useEffect(() => {
    if (!lazy) return;
    const element = container.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '200px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [lazy]);

  useEffect(() => {
    setURL(null); setError('');
    if (!visible || !available) return;
    const controller = new AbortController();
    let current = true;
    let created: string | undefined;
    void (async () => {
      try {
        const result = await readMediaBytes(() => getAPI()?.summaryImage(window.id), { signal: controller.signal, priority });
        if (!current) return;
        if (!result.ok) { if (result.error.code !== 'cancelled') setError(result.error.message); return; }
        const bytes = new Uint8Array(result.value.bytes);
        if (bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES) { setError('The summary image is empty or larger than 4 MiB.'); return; }
        created = URL.createObjectURL(new Blob([bytes.buffer], { type: 'image/png' }));
        setURL(created);
      } catch { if (current) setError('The summary image could not be read.'); }
    })();
    return () => { current = false; controller.abort(); if (created) URL.revokeObjectURL(created); };
  }, [visible, available, window.id, window.image?.sha256, priority]);

  const placeholder = window.status === 'planned' ? 'Waiting' : window.status === 'running' ? 'Processing' : window.status === 'failed' ? 'Failed: no image'
    : window.status === 'incomplete' ? 'Incomplete: no image' : window.source_state && window.source_state !== 'ready' ? 'Original unavailable' : error || 'Loading';
  return <div ref={container} className={cn('flex aspect-[1280/484] items-center justify-center overflow-hidden rounded-md bg-slate-900', className)}>
    {url ? <img src={url} alt={alt} className="h-full w-full object-contain" onError={() => { URL.revokeObjectURL(url); setURL(null); setError('The summary image could not be displayed.'); }} />
      : <span className="flex items-center gap-1.5 px-2 text-center text-xs text-slate-300">
        {window.status === 'running' || (available && !error) ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ImageOff className="h-3.5 w-3.5" aria-hidden />}{placeholder}
      </span>}
  </div>;
}
