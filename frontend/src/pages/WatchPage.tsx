import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, ScanSearch, SkipBack, SkipForward } from 'lucide-react';
import type { GateCounts, InvalidSpan, MediaSegment, PlaybackFrames, TrackingSettings, TrackingTest } from '../../../electron/src/contracts';
import { getAPI } from '../api';
import { activeRun, activeTracking, useSurvey } from '../survey';
import { clock } from '../lib/time';
import { cn } from '../lib/utils';
import { Messages } from '../components/layout/Messages';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Progress } from '../components/ui/progress';
import { SourcePreview } from '../components/SourcePreview';
import { Player, type DisplayedFrame, type Draw, type PlayerHandle } from '../components/watch/Player';
import { drawBats } from '../components/watch/BatsLayer';
import { CHUNK_MS, useTracks } from '../components/watch/useTracks';
import { drawDetections, drawSetup } from '../components/watch/SetupLayer';
import { SetupPanel, type DrawKind } from '../components/watch/SetupPanel';
import { floorIndex, toTrackData } from '../components/watch/tracks';
import { settingsOf } from '../lib/trackingSettings';
import { savedReviewer } from '../lib/reviewer';
import { drawCounts, soFar } from '../components/watch/CountLayer';
import { CountsPanel } from '../components/watch/CountsPanel';
import { addPoint, type GateDraft } from '../components/GatePanel';

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

const ticksPerSecond = (segment: MediaSegment) => Number(segment.metadata.time_base.den) / Number(segment.metadata.time_base.num);

/** Continuous review of the whole survey: one playback copy per video, with tracked bats drawn on every frame. */
export function WatchPage() {
  const survey = useSurvey();
  const segments = survey.media?.segments ?? [];
  const copies = survey.playback?.proxies ?? [];
  const [position, setPosition] = useState(0);
  const segment = segments[Math.min(position, Math.max(0, segments.length - 1))];
  const copy = copies.find(item => item.segment_id === segment?.id && item.state === 'ready') ?? null;
  const [frames, setFrames] = useState<PlaybackFrames | null>(null);
  const [frameError, setFrameError] = useState('');
  const [displayed, setDisplayed] = useState<DisplayedFrame | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [autoPlay, setAutoPlay] = useState(false);
  const [verify, setVerify] = useState<string | null>(null);
  const [live, setLive] = useState(0);
  const player = useRef<PlayerHandle>(null);
  const tenths = useRef(-1);
  const [panel, setPanel] = useState<'tracks' | 'setup' | 'counts'>('tracks');
  const [actor, setActor] = useState(savedReviewer);
  const [gateID, setGateID] = useState<string | null>(null);
  const [counts, setCounts] = useState<GateCounts | null>(null);
  const [gateDraft, setGateDraft] = useState<GateDraft | null>(null);
  const [redraw, setRedraw] = useState<InvalidSpan | null>(null);
  const [startAt, setStartAt] = useState<number | null>(null);
  const order = useMemo(() => new Map(segments.map((item, index) => [item.id, index])), [segments]);
  const activeGates = survey.gates.filter(gate => gate.state === 'active');
  const chosenGate = activeGates.find(gate => gate.id === gateID) ?? activeGates[0] ?? null;
  const [settings, setSettings] = useState<TrackingSettings>(() => settingsOf(survey.tracking));
  const [drawing, setDrawing] = useState<DrawKind>(null);
  const [draft, setDraft] = useState<[number, number][]>([]);
  const [reference, setReference] = useState<[number, number] | null>(null);
  const [test, setTest] = useState<TrackingTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [testRange, setTestRange] = useState<{ startMs: number; endMs: number } | null>(null);
  const settingsRun = useRef<string | null>(null);
  useEffect(() => {
    // Adopt the latest run's settings once per run, never over the user's unsaved changes to another run's values.
    if (survey.tracking && settingsRun.current !== survey.tracking.id) { settingsRun.current = survey.tracking.id; setSettings(settingsOf(survey.tracking)); }
  }, [survey.tracking]);

  useEffect(() => {
    setFrames(null); setFrameError(''); setDisplayed(null); tenths.current = -1;
    if (!copy) return;
    let active = true;
    void getAPI()?.playbackFrames(copy.id).then(result => {
      if (!active) return;
      if (result.ok) setFrames(result.value); else setFrameError(result.error.message);
    }).catch(() => { if (active) setFrameError('The playback copy could not be opened.'); });
    return () => { active = false; };
  }, [copy?.id]);

  const trackingRun = survey.tracking?.state === 'complete' ? survey.tracking.id : null;
  useEffect(() => {
    setCounts(null);
    if (!trackingRun || !chosenGate) return;
    let active = true;
    void getAPI()?.getCounts(trackingRun, chosenGate.id).then(result => {
      if (!active) return;
      if (result.ok) setCounts(result.value); else setFrameError(result.error.message);
    });
    return () => { active = false; };
  }, [trackingRun, chosenGate?.id, chosenGate?.revision]);
  const chunk = displayed ? Math.floor(displayed.ms / CHUNK_MS) : 0;
  const { tracks, error: trackError } = useTracks(trackingRun, frames, chunk);
  const rate = segment ? ticksPerSecond(segment) : 1;

  const testTracks = useMemo(() => test?.result?.tracks.map(toTrackData) ?? null, [test]);
  const draw = useCallback<Draw>((context, view, frame) => {
    if (panel === 'setup' && segment) {
      drawSetup(context, view, { area: settings.detection_area, exclusions: settings.exclusions, draft, draftKind: drawing,
        reference: reference ?? [segment.metadata.width / 2, segment.metadata.height / 2], targetPx: settings.target_px });
    }
    if (counts && segment && (panel === 'counts' || panel === 'tracks')) drawCounts(context, view, counts, order, segment.id, frame.pts, rate);
    if (gateDraft && gateDraft.points.length > 0) {
      context.strokeStyle = '#fde047';
      context.lineWidth = 2 * view.dpr;
      context.setLineDash([6 * view.dpr, 4 * view.dpr]);
      context.beginPath();
      gateDraft.points.forEach(([x, y], index) => { const px = view.dx + x * view.scale, py = view.dy + y * view.scale; if (index === 0) context.moveTo(px, py); else context.lineTo(px, py); });
      context.stroke();
      context.setLineDash([]);
    }
    if (testTracks && test?.result) {
      drawDetections(context, view, test.result, frame.pts);
      setLive(drawBats(context, view, testTracks, frame.pts, rate));
    } else setLive(drawBats(context, view, tracks, frame.pts, rate));
  }, [tracks, rate, panel, settings, draft, drawing, reference, testTracks, test, segment, counts, order, gateDraft]);
  useEffect(() => { player.current?.redraw(); }, [draw]);

  const onFrame = useCallback((frame: DisplayedFrame | null) => {
    // The page re-renders ten times a second at most; the canvas redraws on every displayed frame.
    const bucket = frame === null ? -1 : Math.floor(frame.ms / 100);
    if (bucket !== tenths.current) { tenths.current = bucket; setDisplayed(frame); }
    // A tested range loops so the overlay can be judged on the same footage.
    const range = testRangeRef.current;
    if (frame && range && frame.ms >= range.endMs) player.current?.seekMs(range.startMs);
  }, []);
  const testRangeRef = useRef(testRange);
  testRangeRef.current = testRange;

  async function runTest() {
    if (!segment || !frames || !displayed) return;
    const end = Math.min(frames.proxy_ms.length - 1, Math.max(displayed.index + 1, floorIndex(frames.proxy_ms, displayed.ms + 10000)));
    setTesting(true); setTest(null); setTestRange(null);
    player.current?.pause();
    try {
      const api = getAPI();
      let result = await api?.startTrackingTest({ segment_id: segment.id, start_pts: frames.source_pts[displayed.index]!, end_pts: frames.source_pts[end]!, settings });
      while (result?.ok && result.value.state === 'running') {
        await new Promise(resolve => setTimeout(resolve, 400));
        result = await api?.trackingTest(result.value.id);
      }
      if (!result?.ok) { setFrameError(result?.error.message ?? 'The test run could not be started.'); return; }
      setTest(result.value);
      if (result.value.state === 'complete') {
        setTestRange({ startMs: displayed.ms, endMs: frames.proxy_ms[end]! });
        player.current?.seekMs(displayed.ms);
        player.current?.play();
      }
    } catch { setFrameError('The test run could not be completed.'); }
    finally { setTesting(false); }
  }

  /** Show a moment of the survey from one second before it, opening another video when needed. */
  function goTo(segmentID: string, pts: string) {
    const index = segments.findIndex(item => item.id === segmentID);
    if (index < 0) return;
    const target = Math.max(Number(segments[index]!.metadata.first_pts), Number(pts) - ticksPerSecond(segments[index]!));
    if (index === position) { player.current?.pause(); player.current?.seekPTS(target); }
    else { setAutoPlay(false); setStartAt(target); setPosition(index); }
  }

  function clearTest() { setTest(null); setTestRange(null); }

  function pick(point: [number, number]) {
    if (gateDraft) setGateDraft(addPoint(gateDraft, point));
    else if (drawing) setDraft(previous => previous.length < 32 ? [...previous, point] : previous);
    else setReference(point);
  }

  function finishShape() {
    if (draft.length < 3 || !drawing) return;
    const key = drawing === 'area' ? 'detection_area' : 'exclusions';
    setSettings(previous => ({ ...previous, [key]: [...previous[key], draft] }));
    setDraft([]); setDrawing(null);
  }

  const next = useCallback(() => {
    if (position + 1 < segments.length) { setAutoPlay(true); setPosition(position + 1); }
  }, [position, segments.length]);

  useEffect(() => { player.current?.setRate(SPEEDS[speed]!); }, [speed, frames]);

  useEffect(() => {
    function key(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (verify || (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (drawing && event.key === 'Enter') { event.preventDefault(); finishShape(); return; }
      if (drawing && event.key === 'Escape') { event.preventDefault(); setDraft([]); setDrawing(null); return; }
      const handle = player.current;
      if (!handle) return;
      const actions: Record<string, () => void> = {
        ' ': () => handle.togglePlay(),
        ',': () => handle.step(-1),
        '.': () => handle.step(1),
        ArrowLeft: () => handle.seekMs(Math.max(0, (displayed?.ms ?? 0) - 5000)),
        ArrowRight: () => handle.seekMs((displayed?.ms ?? 0) + 5000),
      };
      SPEEDS.forEach((_, index) => { actions[String(index + 1)] = () => setSpeed(index); });
      const action = actions[event.key];
      if (action) { event.preventDefault(); action(); }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [displayed, verify, drawing, draft]);

  const elapsed = segment && displayed ? clock(Number(BigInt(Math.round(displayed.pts)) - BigInt(segment.metadata.first_pts)) / rate) : '--';
  const status = useMemo(() => {
    if (!survey.media) return 'Loading...';
    if ((survey.media.schema_version ?? 0) < 11) return 'Upgrade storage on the Process page to enable continuous playback.';
    if (segments.length === 0) return 'Add videos on the Process page to start.';
    if (!survey.run) return 'Generate motion summaries on the Process page; playback copies are prepared after them.';
    return '';
  }, [survey.media, survey.run, segments.length]);
  const segmentCopy = copies.find(item => item.segment_id === segment?.id);
  const preparing = survey.playback?.active === true;
  const ready = copies.filter(item => item.state === 'ready').length;

  return <div className="min-h-screen bg-slate-950 text-slate-100">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-6 py-3">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Watch</h1>
        <p className="text-xs text-slate-400">Continuous playback with tracked targets. Rings mark tracker output for review, not verified bats.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Videos">
        {segments.map((item, index) => {
          const state = copies.find(value => value.segment_id === item.id)?.state;
          return <button key={item.id} type="button" role="tab" aria-selected={index === position} onClick={() => { setAutoPlay(false); setPosition(index); }}
            title={item.metadata.filename}
            className={cn('rounded-full border px-3 py-1 text-xs', index === position ? 'border-red-500 bg-red-500/20 text-red-100' : 'border-slate-700 text-slate-300 hover:bg-slate-800')}>
            {index + 1}. {item.metadata.filename}{state && state !== 'ready' ? ` (${state})` : ''}
          </button>;
        })}
      </div>
    </header>
    <div className="space-y-3 px-6 py-4">
      <Messages error={survey.error || frameError || trackError} notice={survey.notice} />
      {status && <p className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-center text-sm text-slate-300">{status} <Link className="text-red-300 underline" to={`/surveys/${survey.session.id}/process`}>Open Process</Link></p>}
      {!status && preparing && <div className="space-y-1 rounded-lg border border-slate-800 bg-slate-900 p-3">
        <p className="text-sm">Preparing playback copies: {ready} of {segments.length} ready.</p>
        <Progress value={100 * ready / Math.max(1, segments.length)} label="Playback copies" />
      </div>}
      {!status && segment && !copy && !preparing && <div className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-center text-sm text-slate-300">
        {segmentCopy?.state === 'failed' || segmentCopy?.state === 'cancelled' || segmentCopy?.state === 'interrupted'
          ? <>The playback copy of this video {segmentCopy.state === 'failed' ? `failed (${segmentCopy.error ?? 'unknown'})` : `was ${segmentCopy.state}`}. The original stays available through Verify on the Review page.</>
          : 'This video has no playback copy yet.'}
        <div className="mt-3"><Button onClick={() => void survey.startPlayback()} disabled={survey.busy}><RotateCcw />Prepare playback copies</Button></div>
      </div>}
      {segment && frames && <div className="grid gap-4 md:grid-cols-[1fr_17rem]">
        <section aria-label="Bats view" className="space-y-2">
          <div className="aspect-video max-h-[70vh] w-full">
            <Player key={frames.id} ref={player} frames={frames} sourceWidth={segment.metadata.width} sourceHeight={segment.metadata.height}
              draw={draw} onFrame={onFrame} onPlaying={setPlaying} onEnded={next} autoPlay={autoPlay}
              startPTS={startAt} onPick={panel === 'setup' || gateDraft ? pick : undefined} />
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm">
            <Button size="sm" variant="ghost" className="text-slate-100" aria-label="Previous video" disabled={position === 0} onClick={() => { setAutoPlay(false); setPosition(position - 1); }}><SkipBack /></Button>
            <Button size="sm" variant="ghost" className="text-slate-100" aria-label="Previous frame (,)" onClick={() => player.current?.step(-1)}><ChevronLeft /></Button>
            <Button size="sm" className="bg-red-600 hover:bg-red-500" aria-label={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={() => player.current?.togglePlay()}>{playing ? <Pause /> : <Play />}</Button>
            <Button size="sm" variant="ghost" className="text-slate-100" aria-label="Next frame (.)" onClick={() => player.current?.step(1)}><ChevronRight /></Button>
            <Button size="sm" variant="ghost" className="text-slate-100" aria-label="Next video" disabled={position + 1 >= segments.length} onClick={() => { setAutoPlay(false); setPosition(position + 1); }}><SkipForward /></Button>
            <div className="flex items-center gap-1" role="group" aria-label="Playback speed">
              {SPEEDS.map((value, index) => <button key={value} type="button" aria-pressed={index === speed} onClick={() => setSpeed(index)}
                className={cn('rounded px-2 py-0.5 text-xs tabular-nums', index === speed ? 'bg-slate-100 text-slate-900' : 'text-slate-300 hover:bg-slate-800')}>{value}x</button>)}
            </div>
            <span className="ml-auto font-mono tabular-nums" aria-label="Time in video">{elapsed}</span>
            <span className="font-mono text-xs tabular-nums text-slate-400" aria-label="Frame number">frame {displayed ? displayed.index + 1 : '-'}</span>
            <span className="text-xs text-slate-400">video {position + 1}/{segments.length}</span>
            <Button size="sm" variant="outline" className="border-slate-600 bg-transparent text-slate-100" disabled={!displayed}
              onClick={() => { player.current?.pause(); setVerify(displayed ? String(Math.round(displayed.pts)) : null); }}><ScanSearch />Verify original</Button>
          </div>
          <p className="text-xs text-slate-500">Space play/pause - , . frame step - arrows 5 s - 1-6 speed. Playback copy: lossy VP9 for viewing; Verify opens the exact original frames.</p>
        </section>
        <aside className="space-y-3">
          <div className="flex gap-1" role="tablist" aria-label="Side panel">
            {([['tracks', 'Tracks'], ['setup', 'Setup'], ['counts', 'Counts']] as const).map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={panel === key}
              onClick={() => { setPanel(key); if (key === 'tracks') { setDrawing(null); setDraft([]); } }}
              className={cn('rounded-md px-3 py-1 text-sm', panel === key ? 'bg-slate-100 text-slate-900' : 'text-slate-300 hover:bg-slate-800')}>{label}</button>)}
          </div>
          {panel === 'setup' && <SetupPanel settings={settings} onChange={setSettings} drawing={drawing} draft={draft}
            onDraw={kind => { setDrawing(kind); setDraft([]); player.current?.pause(); }} onFinishShape={finishShape} onCancelShape={() => { setDraft([]); setDrawing(null); }}
            test={test} testing={testing} onTest={() => void runTest()} onClearTest={clearTest}
            onApply={() => { clearTest(); void survey.startTracking(settings); }}
            canTest={Boolean(displayed && frames)} canApply={Boolean(survey.run) && !activeRun(survey.run) && !activeTracking(survey.tracking) && !survey.busy}
            applyReason={activeTracking(survey.tracking) ? 'Tracking is running.' : 'Wait for motion summaries and other processing to finish.'} />}
          {panel === 'counts' && segment && <CountsPanel counts={counts} setCounts={setCounts} gateID={chosenGate?.id ?? null} setGateID={setGateID}
            actor={actor} setActor={setActor} segment={segment} segments={segments}
            live={counts && displayed ? soFar(counts, order, segment.id, displayed.pts) : null}
            gateDraft={gateDraft} setGateDraft={draft => { setGateDraft(draft); if (draft) player.current?.pause(); }} redraw={redraw} setRedraw={setRedraw} onGo={goTo} />}
          {activeTracking(survey.tracking) && <p role="status" className="rounded-lg border border-slate-800 bg-slate-900 p-3 text-sm">Tracking the whole survey with these settings...</p>}
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <p className="text-xs uppercase tracking-wide text-slate-400">Tracked now</p>
            <p className="text-4xl font-bold tabular-nums text-red-400" aria-label="Tracks at this frame">{trackingRun ? live : '-'}</p>
            <p className="mt-1 text-xs text-slate-400">{trackingRun ? `${tracks.length} tracks loaded around the playhead.` : 'No completed tracking run yet. Run tracking on the Process page.'}</p>
          </div>
        </aside>
      </div>}
    </div>
    {verify !== null && segment && <Dialog open onClose={() => setVerify(null)} title="Verify original frames" className="w-[min(70rem,95vw)]"
      description="Exact source frames decoded from the unchanged original at the paused time.">
      <div className="p-4">
        <SourcePreview segment={segment} initialPTS={verify} minPTS={segment.metadata.first_pts} maxPTS={null} enabled
          disabledReason="Original video unavailable." />
      </div>
    </Dialog>}
  </div>;
}
