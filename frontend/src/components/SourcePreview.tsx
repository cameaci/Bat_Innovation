import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, RotateCcw } from 'lucide-react';
import type { MediaSegment, PreviewFrame, PreviewJob } from '../../../electron/src/contracts';
import { getAPI } from '../api';
import { readMediaBytes } from '../binary';
import type { DisplayedSourceFrame } from '../sourceFrame';
import { clock, ptsAfter, ptsSeconds, rational } from '../lib/time';
import { Button } from './ui/button';

const unavailable = 'The local backend is unavailable. Close the window and retry after checking the backend.';
const STEP_MS = 2000;
const BUSY_RETRIES = 20, BUSY_WAIT_MS = 250;

/**
 * Two-second derived WebM preview of the original, started at `initialPTS` when `enabled`. Displayed frames are
 * mapped to exact original PTS through the preview manifest (requestVideoFrameCallback), never a browser timer.
 */
export function SourcePreview({ segment, initialPTS, minPTS, maxPTS, enabled, disabledReason, onReady, onDisplayedFrame }: {
  segment: MediaSegment;
  initialPTS: string;
  /** Stepping stays inside this window: [minPTS, maxPTS). */
  minPTS: string;
  maxPTS: string | null;
  enabled: boolean;
  disabledReason: string;
  onReady?: (previewID: string | null) => void;
  onDisplayedFrame?: (frame: DisplayedSourceFrame | null) => void;
}) {
  const [sourcePTS, setSourcePTS] = useState(initialPTS);
  const [job, setJob] = useState<PreviewJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [pendingCancellation, setPendingCancellation] = useState<string | null>(null);
  const [url, setURL] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [displayed, setDisplayed] = useState<PreviewFrame | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const generation = useRef(0);
  const activeJob = useRef<string | null>(null);
  const clipURL = useRef<string | null>(null);
  const readyCallback = useRef(onReady);
  readyCallback.current = onReady;
  const frameCallback = useRef(onDisplayedFrame);
  frameCallback.current = onDisplayedFrame;
  const contentRead = useRef<AbortController | null>(null);

  function clearDisplayed() {
    setDisplayed(null);
    frameCallback.current?.(null);
  }

  function clearClip() {
    readyCallback.current?.(null);
    contentRead.current?.abort();
    if (video.current) {
      video.current.pause();
      video.current.removeAttribute('src');
      video.current.load();
    }
    if (clipURL.current) URL.revokeObjectURL(clipURL.current);
    clipURL.current = null;
    setURL(null);
    setLoaded(false);
    clearDisplayed();
  }

  function releaseJob() {
    const id = activeJob.current;
    activeJob.current = null;
    if (id) void getAPI()?.cancelPreview(id).catch(() => undefined);
  }

  function invalidate() {
    generation.current += 1;
    clearClip();
    releaseJob();
    setJob(null);
    setStarting(false);
    setPendingCancellation(null);
  }

  function fail(message: string) {
    invalidate();
    setError(message);
    setNotice('');
  }

  useEffect(() => {
    return () => {
      readyCallback.current?.(null);
      frameCallback.current?.(null);
      contentRead.current?.abort();
      generation.current += 1;
      releaseJob();
      if (clipURL.current) URL.revokeObjectURL(clipURL.current);
      clipURL.current = null;
    };
  }, []);

  async function start(requested: string) {
    invalidate();
    setError(''); setNotice('');
    setSourcePTS(requested);
    const ticket = generation.current;
    setStarting(true);
    try {
      const api = getAPI();
      if (!api) { fail(unavailable); return; }
      let result = await api.startPreview({ segment_id: segment.id, source_pts: requested });
      // Moving to another window cancels the previous preview, whose worker may still be stopping.
      // Wait a bounded time for that release instead of failing the new window's preview.
      for (let attempt = 0; !result.ok && result.error.code === 'preview_busy' && attempt < BUSY_RETRIES; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, BUSY_WAIT_MS));
        if (ticket !== generation.current) return;
        result = await api.startPreview({ segment_id: segment.id, source_pts: requested });
      }
      if (ticket !== generation.current) {
        if (result.ok) void api.cancelPreview(result.value.id).catch(() => undefined);
        return;
      }
      if (!result.ok) { fail(result.error.message); return; }
      if (result.value.segment_id !== segment.id) { fail('The preview response does not match the selected source.'); return; }
      activeJob.current = result.value.id;
      setJob(result.value);
      setStarting(false);
    } catch { if (ticket === generation.current) fail(unavailable); }
  }

  useEffect(() => { if (enabled) void start(initialPTS); }, [enabled]);

  // Status revalidates source identity even after bytes have been loaded into the player.
  useEffect(() => {
    if (!job) return;
    const id = job.id;
    const ticket = generation.current;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    contentRead.current = controller;
    const current = () => active && ticket === generation.current;
    async function poll() {
      try {
        const api = getAPI();
        if (!api) { if (current()) fail(unavailable); return; }
        const result = await api.previewStatus(id);
        if (!current()) return;
        if (!result.ok) { fail(result.error.message); return; }
        const value = result.value;
        if (value.segment_id !== segment.id) { fail('The preview no longer matches the selected source.'); return; }
        if (value.state === 'failed' || value.state === 'cancelled') {
          fail(value.error?.message ?? (value.state === 'cancelled' ? 'Preview cancelled or expired. Create a new preview to continue.' : 'Preview generation failed. Check the selected source.'));
          return;
        }
        setJob(value);
        if (value.state === 'ready' && !clipURL.current) {
          if (!value.manifest || value.manifest.segment_id !== segment.id || value.manifest.source_sha256 !== segment.metadata.sha256) {
            fail('The preview identity does not match the imported original. Refresh the session media.'); return;
          }
          const content = await readMediaBytes(() => api.previewContent(id), { signal: controller.signal, priority: 2 });
          if (!current()) return;
          if (!content?.ok) { fail(content?.error.message ?? unavailable); return; }
          const bytes = new Uint8Array(content.value.bytes);
          if (bytes.byteLength < 1 || bytes.byteLength > 8 * 1024 * 1024) { fail('The preview content is empty or exceeds its 8 MiB limit.'); return; }
          clipURL.current = URL.createObjectURL(new Blob([bytes.buffer], { type: 'video/webm' }));
          setURL(clipURL.current);
        }
        if (current()) timer = setTimeout(() => void poll(), value.state === 'ready' ? 1000 : 500);
      } catch { if (current()) fail(unavailable); }
    }
    void poll();
    return () => {
      active = false; clearTimeout(timer); controller.abort();
      if (contentRead.current === controller) contentRead.current = null;
    };
  }, [job?.id]);

  useEffect(() => {
    if (!pendingCancellation) return;
    const ticket = generation.current;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      try {
        const result = await getAPI()?.previewStatus(pendingCancellation!);
        if (!active || ticket !== generation.current) return;
        if (!result?.ok) setError(result?.error.message ?? unavailable);
        else if (result.value.state === 'cancelled' || result.value.state === 'failed') {
          activeJob.current = null;
          setPendingCancellation(null);
          setError('');
          setNotice('Preview stopped. No preview is displayed.');
          return;
        }
      } catch { if (active && ticket === generation.current) setError(unavailable); }
      if (active && ticket === generation.current) timer = setTimeout(() => void check(), 1000);
    }
    timer = setTimeout(() => void check(), 500);
    return () => { active = false; clearTimeout(timer); };
  }, [pendingCancellation]);

  const manifest = job?.manifest;
  useLayoutEffect(() => {
    const player = video.current;
    if (!url || !player || !manifest) return;
    if (typeof player.requestVideoFrameCallback !== 'function') {
      fail('This browser cannot identify displayed preview frames reliably. Source-time playback is unavailable.');
      return;
    }
    let active = true;
    let callback: number;
    let pending: PreviewFrame | null = null;
    const clipGeneration = generation.current;
    const previewID = job!.id;
    const current = () => active && generation.current === clipGeneration && activeJob.current === previewID;
    function publish(mapped: PreviewFrame) {
      setDisplayed(mapped);
      frameCallback.current?.({ previewID, segmentID: manifest!.segment_id,
        sourceSHA256: manifest!.source_sha256, timeBase: manifest!.time_base, sourcePTS: mapped.source_pts });
    }
    function matchesPosition(mapped: PreviewFrame) {
      const index = manifest!.frames.indexOf(mapped);
      const end = manifest!.frames[index + 1]?.preview_ms ?? manifest!.preview_duration_ms;
      const position = player!.currentTime * 1000;
      // Preview position only rejects stale callbacks; only rVFC supplies a source-PTS candidate.
      return index >= 0 && mapped.preview_ms <= position && position < end;
    }
    function seeking() {
      clearDisplayed();
      // A presented-frame callback may precede the seeking event for this same target.
      if (pending && !matchesPosition(pending)) pending = null;
    }
    function seeked() {
      if (current() && !player!.seeking && pending && matchesPosition(pending)) publish(pending);
      pending = null;
    }
    function frame(_now: number, metadata: VideoFrameCallbackMetadata) {
      if (!current() || !player) return;
      const milliseconds = metadata.mediaTime * 1000;
      const mapped = manifest!.frames.find(value => Math.abs(value.preview_ms - milliseconds) <= 0.5001);
      if (!mapped) { fail('The displayed frame could not be matched to an original source PTS. Create a new preview.'); return; }
      if (player.seeking) {
        clearDisplayed();
        pending = mapped;
      } else {
        pending = null;
        publish(mapped);
      }
      callback = player.requestVideoFrameCallback(frame);
    }
    player.addEventListener('seeking', seeking);
    player.addEventListener('seeked', seeked);
    callback = player.requestVideoFrameCallback(frame);
    return () => {
      active = false; pending = null; player.cancelVideoFrameCallback(callback);
      player.removeEventListener('seeking', seeking); player.removeEventListener('seeked', seeked);
    };
    // A ready clip's ledger is immutable; status polling must not drop an in-progress seek candidate.
  }, [url, job?.id]);

  async function cancel() {
    const id = activeJob.current;
    if (!pendingCancellation) generation.current += 1;
    clearClip(); setJob(null); setStarting(false);
    setPendingCancellation(id);
    const ticket = generation.current;
    setError(''); setNotice('Cancellation requested. No preview is displayed.');
    if (id) {
      try {
        const result = await getAPI()?.cancelPreview(id);
        if (ticket === generation.current) {
          if (!result?.ok) setError(result?.error.message ?? unavailable);
          else if (result.value.state === 'running') setNotice('Cancellation is in progress. No preview is displayed.');
          else {
            activeJob.current = null; setPendingCancellation(null);
            setNotice('Preview cancelled. No preview is displayed.');
          }
        }
      } catch { if (ticket === generation.current) setError(unavailable); }
    }
  }

  const timeBase = segment.metadata.time_base;
  const clipStart = manifest?.actual_pts ?? sourcePTS;
  const previous = ptsAfter(clipStart, -STEP_MS, timeBase);
  const next = ptsAfter(clipStart, STEP_MS, timeBase);
  const canPrevious = BigInt(clipStart) > BigInt(minPTS);
  const canNext = maxPTS === null ? BigInt(next) <= BigInt(segment.metadata.last_pts) : BigInt(next) < BigInt(maxPTS);
  const busy = starting || job?.state === 'running' || pendingCancellation !== null;
  const offset = (pts: string) => clock(ptsSeconds(pts, minPTS, timeBase));

  return <section aria-label="Original video" className="flex min-h-0 flex-col gap-2">
    <div className="relative flex min-h-[180px] flex-1 items-center justify-center overflow-hidden rounded-md bg-black">
      {url ? <video ref={video} src={url} controls preload="auto" aria-label="Derived source preview" className="max-h-full max-w-full"
        onLoadedData={() => { setLoaded(true); if (job?.state === 'ready') readyCallback.current?.(job.id); }} onSeeking={clearDisplayed}
        onError={() => fail('The preview could not be played. Close the window and retry.')} />
        : <p className="flex items-center gap-2 px-4 text-center text-sm text-slate-300" role="status">
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {!enabled ? disabledReason : starting ? 'Creating preview...' : job?.state === 'running' ? `Creating preview: ${job.phase}` : error ? 'Preview unavailable.' : notice || 'Preview not loaded.'}
        </p>}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
      <div className="flex items-center gap-1">
        <Button size="sm" variant="secondary" className="h-8" disabled={!enabled || busy || !canPrevious} onClick={() => void start(BigInt(previous) < BigInt(minPTS) ? minPTS : previous)}><ChevronLeft />2 s back</Button>
        <Button size="sm" variant="secondary" className="h-8" disabled={!enabled || busy || !canNext} onClick={() => void start(next)}>2 s on<ChevronRight /></Button>
        <Button size="sm" variant="secondary" className="h-8" disabled={!enabled || busy} onClick={() => void start(initialPTS)}><RotateCcw />Window start</Button>
        {(starting || job?.state === 'running') && <Button size="sm" variant="ghost" className="h-8 text-slate-200" onClick={() => void cancel()}>Cancel preview</Button>}
      </div>
      <span role="status">{url ? (loaded ? 'Preview ready' : 'Loading preview...') : ''}{manifest ? ` · clip ${offset(manifest.actual_pts)} to ${clock(ptsSeconds(manifest.actual_pts, minPTS, timeBase) + manifest.preview_duration_ms / 1000)} of this window` : ''}</span>
    </div>
    {displayed && <p aria-label="Displayed original frame" className="text-xs text-slate-200">Displayed frame: {offset(displayed.source_pts)} into the window · <span className="font-mono">Displayed source PTS {displayed.source_pts}</span> · source time {rational(displayed.source_time)} s</p>}
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    {manifest && manifest.warnings.length > 0 && <details className="text-xs text-slate-400"><summary className="cursor-pointer">About this preview ({manifest.warnings.length} notes)</summary>
      <ul aria-label="Preview fidelity warnings" className="mt-1 list-disc pl-4">{manifest.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details>}
  </section>;
}
