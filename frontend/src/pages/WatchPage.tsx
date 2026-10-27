import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, ScanSearch, SkipBack, SkipForward } from 'lucide-react';
import type { Candidate, SampleCheck, GateCounts, InvalidSpan, SceneEvent, MediaSegment, PlaybackFrames, TrackingSettings, TrackingTest } from '../../../electron/src/contracts';
import { getAPI } from '../api';
import { activeRun, activeTracking, useSurvey } from '../survey';
import { clock } from '../lib/time';
import { cn } from '../lib/utils';
import { Messages } from '../components/layout/Messages';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Progress } from '../components/ui/progress';
import { SourcePreview } from '../components/SourcePreview';
import { Player, type DisplayedFrame, type PlayerHandle, type PlayerView } from '../components/watch/Player';
import { drawFlightMap, gridAt, indexFlightMap, type FlightIndex } from '../components/watch/FlightMap';
import { drawBats, type MarkerStyle, type View } from '../components/watch/BatsLayer';
import { drawClock, frameClock } from '../components/watch/Hud';
import { CHUNK_MS, useTracks } from '../components/watch/useTracks';
import { drawDetections, drawSetup } from '../components/watch/SetupLayer';
import { SetupPanel, type DrawKind } from '../components/watch/SetupPanel';
import { floorIndex, toTrackData } from '../components/watch/tracks';
import { settingsOf } from '../lib/trackingSettings';
import { savedReviewer } from '../lib/reviewer';
import { drawCounts, soFar, type BoardMode } from '../components/watch/CountLayer';
import { CountsPanel } from '../components/watch/CountsPanel';
import { SampleCheckPanel, type ActiveSample } from '../components/watch/SampleCheckPanel';
import { SurveyTimeline } from '../components/watch/SurveyTimeline';
import { useCoverage, WATCH_MAX_RATE } from '../components/watch/useCoverage';
import { WatchReviewPanel, windowStates } from '../components/watch/WatchReviewPanel';
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
  const [panel, setPanel] = useState<'tracks' | 'setup' | 'counts' | 'review'>('tracks');
  const coverage = useCoverage();
  const [smart, setSmart] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [reel, setReel] = useState<number | null>(null);
  const [marking, setMarking] = useState(false);
  const playingRef = useRef(false);
  const rateRef = useRef(1);
  const [layout, setLayout] = useState<'split' | 'single'>('split');
  const [viewKey, setViewKey] = useState<'bats' | 'flight' | 'count'>('bats');
  const [actor, setActor] = useState(savedReviewer);
  const [gateID, setGateID] = useState<string | null>(null);
  const [counts, setCounts] = useState<GateCounts | null>(null);
  const [gateDraft, setGateDraft] = useState<GateDraft | null>(null);
  const [redraw, setRedraw] = useState<InvalidSpan | null>(null);
  const [startAt, setStartAt] = useState<number | null>(null);
  const [markerStyle, setMarkerStyle] = useState<MarkerStyle>('boxes');
  const [showNoise, setShowNoise] = useState(false);
  const [board, setBoard] = useState<BoardMode>('band');
  const [sample, setSample] = useState<ActiveSample | null>(null);
  const [sampleChecks, setSampleChecks] = useState<SampleCheck[]>([]);
  const [sampleBusy, setSampleBusy] = useState(false);
  const lastFrame = useRef<DisplayedFrame | null>(null);
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
  const loadSampleChecks = useCallback(async () => {
    if (!trackingRun || !chosenGate) { setSampleChecks([]); return; }
    const result = await getAPI()?.listSampleChecks(trackingRun, chosenGate.id);
    if (result?.ok) setSampleChecks(result.value);
  }, [trackingRun, chosenGate?.id]);
  useEffect(() => { void loadSampleChecks(); }, [loadSampleChecks]);
  const chunk = displayed ? Math.floor(displayed.ms / CHUNK_MS) : 0;
  const { tracks, error: trackError, shown: tracksShown, total: tracksTotal, noiseHidden } = useTracks(trackingRun, frames, chunk, showNoise);
  const rate = segment ? ticksPerSecond(segment) : 1;

  const testTracks = useMemo(() => test?.result?.tracks.map(toTrackData) ?? null, [test]);
  const [events, setEvents] = useState<SceneEvent[]>([]);
  useEffect(() => {
    setEvents([]);
    if (!trackingRun) return;
    void getAPI()?.trackingEvents(trackingRun).then(result => { if (result.ok) setEvents(result.value); });
  }, [trackingRun]);
  const [flight, setFlight] = useState<FlightIndex | null>(null);
  const [flightMode, setFlightMode] = useState<'building' | 'whole'>('building');
  useEffect(() => {
    setFlight(null);
    if (!trackingRun || !segment) return;
    let active = true;
    void getAPI()?.getFlightMap(trackingRun, segment.id).then(result => {
      if (active && result.ok) setFlight(indexFlightMap(result.value, ticksPerSecond(segment)));
      else if (active && !result.ok) setFrameError(result.error.message);
    });
    return () => { active = false; };
  }, [trackingRun, segment?.id]);

  // The reel: undecided uncertain crossings of the chosen gate, then undecided uncertain tracks, in survey order.
  type ReelItem = { kind: 'crossing' | 'track'; id: string; segmentID: string; start: number; end: number; trackID: string; label: string; revision: number };
  const reelItems = useMemo<ReelItem[]>(() => {
    const items: ReelItem[] = [];
    for (const crossing of counts?.crossings ?? []) {
      if (crossing.quality !== 'uncertain' || crossing.review) continue;
      items.push({ kind: 'crossing', id: crossing.key, segmentID: crossing.segment_id, start: Number(crossing.pts), end: Number(crossing.pts), trackID: crossing.track_id,
        label: `track #${crossing.track_index + 1} crossing the gate`, revision: 0 });
    }
    const crossed = new Set(items.map(item => item.trackID));
    for (const candidate of candidates) {
      if (candidate.quality !== 'uncertain' || candidate.decision || crossed.has(candidate.track_id)) continue;
      items.push({ kind: 'track', id: candidate.track_id, segmentID: candidate.segment_id, start: Number(candidate.first_pts), end: Number(candidate.last_pts),
        trackID: candidate.track_id, label: `uncertain track #${candidate.track_index + 1}`, revision: candidate.revision });
    }
    return items.sort((a, b) => (order.get(a.segmentID)! - order.get(b.segmentID)!) || a.start - b.start);
  }, [counts, candidates, order]);
  const reelItem = reel !== null ? reelItems[Math.min(reel, reelItems.length - 1)] ?? null : null;
  // Overlays that belong to whichever view takes clicks: setup shapes, the size reference and a gate being drawn.
  const extras = useCallback((context: CanvasRenderingContext2D, view: View) => {
    if (panel === 'setup' && segment) {
      drawSetup(context, view, { area: settings.detection_area, exclusions: settings.exclusions, draft, draftKind: drawing,
        reference: reference ?? [segment.metadata.width / 2, segment.metadata.height / 2], targetPx: settings.target_px });
    }
    if (gateDraft && gateDraft.points.length > 0) {
      context.strokeStyle = '#fde047';
      context.lineWidth = 2 * view.dpr;
      context.setLineDash([6 * view.dpr, 4 * view.dpr]);
      context.beginPath();
      gateDraft.points.forEach(([x, y], index) => { const px = view.dx + x * view.scale, py = view.dy + y * view.scale; if (index === 0) context.moveTo(px, py); else context.lineTo(px, py); });
      context.stroke();
      context.setLineDash([]);
    }
  }, [panel, segment, settings, draft, drawing, reference, gateDraft]);

  const views = useMemo<PlayerView[]>(() => [
    { key: 'bats', label: 'Bats', draw: (context, view, frame) => {
      extras(context, view);
      if (testTracks && test?.result) {
        drawDetections(context, view, test.result, frame.pts);
        setLive(drawBats(context, view, testTracks, frame.pts, rate));
      } else {
        setLive(drawBats(context, view, tracks, frame.pts, rate, { highlight: reelItem?.trackID ?? null, style: markerStyle, showRejected: showNoise }));
        if (counts && segment && board !== 'off') drawCounts(context, view, counts, order, segment.id, frame.pts, rate, tracks, board);
      }
      if (segment) drawClock(context, view, frameClock(segment, survey.media?.clock_anchor ?? null, frame.pts), frame.index + 1);
    } },
    { key: 'flight', label: 'Flight map', draw: (context, view, frame) => {
      if (flight) drawFlightMap(context, view, flight, flightMode === 'whole' ? flight.total : gridAt(flight, tracks, frame.pts));
      extras(context, view);
    } },
    { key: 'count', label: 'Count', draw: (context, view, frame) => {
      drawBats(context, view, tracks, frame.pts, rate, { style: markerStyle, showRejected: showNoise });
      if (counts && segment) drawCounts(context, view, counts, order, segment.id, frame.pts, rate, tracks, board === 'off' ? 'corner' : board);
      extras(context, view);
      if (segment) drawClock(context, view, frameClock(segment, survey.media?.clock_anchor ?? null, frame.pts), frame.index + 1);
    } },
  ], [extras, testTracks, test, tracks, rate, flight, flightMode, counts, segment, order, reelItem, markerStyle, showNoise, board, survey.media?.clock_anchor]);
  useEffect(() => { player.current?.redraw(); }, [views, layout, viewKey]);

  const loadCandidates = useCallback(async () => {
    if (!trackingRun) { setCandidates([]); return; }
    const result = await getAPI()?.listCandidates(trackingRun);
    if (result?.ok) setCandidates(result.value);
  }, [trackingRun]);
  useEffect(() => { void loadCandidates(); }, [loadCandidates]);

  const frameState = useRef({ segment, copy, tracks, counts, smart, speed, reelItem });
  frameState.current = { segment, copy, tracks, counts, smart, speed, reelItem };
  const onFrame = useCallback((frame: DisplayedFrame | null) => {
    // The page re-renders ten times a second at most; the canvas redraws on every displayed frame.
    lastFrame.current = frame;
    const bucket = frame === null ? -1 : Math.floor(frame.ms / 100);
    if (bucket !== tenths.current) { tenths.current = bucket; setDisplayed(frame); }
    const state = frameState.current;
    if (state.segment && state.copy) coverage.record(state.segment.id, state.copy.id, frame, playingRef.current, rateRef.current);
    if (!frame || !state.segment) return;
    // A tested range loops so the overlay can be judged on the same footage.
    const range = testRangeRef.current;
    if (range && frame.ms >= range.endMs) player.current?.seekMs(range.startMs);
    const second = ticksPerSecond(state.segment);
    // The reel loops its event from one second before to one and a half seconds after.
    const item = state.reelItem;
    if (item && item.segmentID === state.segment.id && frame.pts > item.end + 1.5 * second) player.current?.seekPTS(Math.max(0, item.start - second));
    // Smart speed: normal speed near any tracked target or crossing, the chosen speed elsewhere.
    if (state.smart && !item) {
      const near = state.tracks.some(track => track.quality !== 'noise' && frame.pts >= track.first - second && frame.pts <= track.last + second) ||
        (state.counts?.crossings ?? []).some(crossing => crossing.segment_id === state.segment!.id && Math.abs(Number(crossing.pts) - frame.pts) <= second);
      const wanted = near ? 1 : SPEEDS[state.speed]!;
      if (wanted !== rateRef.current) { rateRef.current = wanted; player.current?.setRate(wanted); }
    }
  }, [coverage.record]);
  const testRangeRef = useRef(testRange);
  testRangeRef.current = testRange;

  function playReel(index: number) {
    if (!reelItems[index]) { setReel(null); return; }
    setSpeed(2);
    rateRef.current = 1;
    player.current?.setRate(1);
    setReel(index);
  }

  async function decideReel(decision: 'bat' | 'not_bat' | 'opposite') {
    const item = reelItem;
    const api = getAPI();
    if (!item || !api || !trackingRun) return;
    if (!actor.trim()) { setFrameError('Enter your name or initials in the Counts tab first.'); return; }
    if (item.kind === 'crossing') {
      if (!counts) return;
      const result = await api.saveCountReview(trackingRun, counts.gate.id, { actor: actor.trim(), expected_revision: counts.revision,
        action: decision === 'not_bat' ? 'reject' : 'confirm', key: item.id, flipped: decision === 'opposite', count: 1, direction: null,
        segment_id: null, pts: null, rationale: '' });
      if (!result.ok) { setFrameError(result.error.message); return; }
      setCounts(result.value);
    } else {
      if (decision === 'opposite') return;
      const watched = coverage.spans(item.segmentID);
      const intervals = (watched?.spans ?? []).filter(span => span.start <= item.end && span.end >= item.start)
        .map(span => [String(Math.round(span.start)), String(Math.round(span.end))] as [string, string]);
      if (!watched || intervals.length === 0) { setFrameError('Let the event play before deciding.'); return; }
      const result = await api.decideCandidate(trackingRun, item.trackID, { actor: actor.trim(), expected_revision: item.revision, decision, note: '',
        preview_id: null, playback: { proxy_id: watched.proxyID, intervals, max_rate: Math.max(...watched.spans.map(span => span.maxRate)) } });
      if (!result.ok) { setFrameError(result.error.message); return; }
      await loadCandidates();
    }
    // The decided item leaves the queue, so the same index now points at the next one (see the effect below).
    setFrameError('');
  }

  useEffect(() => {
    // Start or continue playback of the reel item under the index after each decision.
    if (reel === null) return;
    if (reelItems.length === 0) { setReel(null); player.current?.pause(); return; }
    const item = reelItems[Math.min(reel, reelItems.length - 1)]!;
    goTo(item.segmentID, String(item.start), true);
  }, [reel, reelItems.length]);

  const windowList = useMemo(() => windowStates(survey.run?.windows ?? [], survey.tracking?.window_counts ?? {}, coverage.covers),
    [survey.run, survey.tracking, coverage.covers, coverage.version]);
  async function markWatched() {
    const api = getAPI();
    if (!api || !actor.trim()) return;
    const items = windowList.filter(item => !item.reviewed && item.tracks === 0 && item.watched).flatMap(item => {
      const watched = coverage.spans(item.window.segment_id);
      const first = Number(item.window.stats.first_pts), last = Number(item.window.stats.last_pts);
      const span = watched?.spans.find(value => value.start <= first && value.end >= last);
      return watched && span ? [{ window_id: item.window.id, proxy_id: watched.proxyID, max_rate: span.maxRate,
        intervals: [[String(Math.round(span.start)), String(Math.round(span.end))] as [string, string]] }] : [];
    });
    if (items.length === 0) return;
    setMarking(true);
    const result = await api.markWatched({ actor: actor.trim(), items });
    setMarking(false);
    if (!result.ok) { setFrameError(result.error.message); return; }
    survey.reloadRun();
  }

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
  function goTo(segmentID: string, pts: string, play = false) {
    const index = segments.findIndex(item => item.id === segmentID);
    if (index < 0) return;
    const target = Math.max(Number(segments[index]!.metadata.first_pts), Number(pts) - ticksPerSecond(segments[index]!));
    if (index === position) {
      player.current?.pause();
      player.current?.seekPTS(target);
      if (play) player.current?.play();
    } else { setAutoPlay(play); setStartAt(target); setPosition(index); }
  }

  function clearTest() { setTest(null); setTestRange(null); }

  function startSample() {
    const frame = lastFrame.current;
    if (!segment || !frame) return;
    // A manual count needs normal speed or slower; smart speed would change the rate under the counter.
    setSmart(false);
    if (SPEEDS[speed]! > 1) setSpeed(SPEEDS.indexOf(1));
    setSample({ segmentID: segment.id, start: frame.pts, presses: [] });
  }

  async function finishSample() {
    const api = getAPI();
    const frame = lastFrame.current;
    if (!sample || !api || !trackingRun || !chosenGate || !frame) return;
    player.current?.pause();
    const watched = coverage.spans(sample.segmentID);
    const span = watched?.spans.find(item => item.start <= sample.start && item.end >= frame.pts && item.maxRate <= 1);
    if (sample.segmentID !== segment?.id || frame.pts <= sample.start) { setFrameError('Play forward in the same video before finishing the check.'); return; }
    if (!watched || !span) { setFrameError('The span was not played through at 1x or slower without seeking. Start the check again.'); setSample(null); return; }
    setSampleBusy(true);
    const result = await api.saveSampleCheck(trackingRun, chosenGate.id, { actor: actor.trim(), segment_id: sample.segmentID,
      start_pts: String(Math.round(sample.start)), end_pts: String(Math.round(frame.pts)),
      presses: sample.presses.map(press => ({ pts: String(Math.round(press.pts)), kind: press.kind })),
      proxy_id: watched.proxyID, intervals: [[String(Math.round(sample.start)), String(Math.round(frame.pts))]], max_rate: span.maxRate });
    setSampleBusy(false);
    if (!result.ok) { setFrameError(result.error.message); return; }
    setSample(null); setFrameError('');
    await loadSampleChecks();
  }

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
    if (reel !== null) return;
    if (position + 1 < segments.length) { setAutoPlay(true); setPosition(position + 1); }
  }, [position, segments.length, reel]);

  useEffect(() => { rateRef.current = SPEEDS[speed]!; player.current?.setRate(SPEEDS[speed]!); }, [speed, frames]);

  useEffect(() => {
    function key(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (verify || (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (drawing && event.key === 'Enter') { event.preventDefault(); finishShape(); return; }
      if (drawing && event.key === 'Escape') { event.preventDefault(); setDraft([]); setDrawing(null); return; }
      if (reel !== null) {
        const reelKeys: Record<string, () => void> = { b: () => void decideReel('bat'), n: () => void decideReel('not_bat'), d: () => void decideReel('opposite'),
          u: () => setReel(current => current === null ? null : current + 1 < reelItems.length ? current + 1 : null), Escape: () => { setReel(null); player.current?.pause(); } };
        const reelAction = reelKeys[event.key];
        if (reelAction) { event.preventDefault(); reelAction(); return; }
      }
      if (sample && (event.key === '[' || event.key === ']')) {
        event.preventDefault();
        const frame = lastFrame.current;
        if (frame) setSample(current => current ? { ...current, presses: [...current.presses, { pts: frame.pts, kind: event.key === '[' ? 'entry' : 'exit' }] } : current);
        return;
      }
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
      actions.v = () => setLayout(current => current === 'split' ? 'single' : 'split');
      actions.m = () => void markWatched();
      actions.c = () => setBoard(current => current === 'band' ? 'corner' : current === 'corner' ? 'off' : 'band');
      const action = actions[event.key];
      if (action) { event.preventDefault(); action(); }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [displayed, verify, drawing, draft, reel, reelItems, actor, counts, windowList, sample]);

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
      {segment && frames && <div className={cn('grid gap-4', layout === 'single' && 'md:grid-cols-[1fr_17rem]')}>
        <section aria-label="Player" className="space-y-2">
          <div className="w-full">
            <Player key={frames.id} ref={player} frames={frames} sourceWidth={segment.metadata.width} sourceHeight={segment.metadata.height}
              views={views} layout={layout} active={viewKey} onFrame={onFrame} onPlaying={value => { playingRef.current = value; setPlaying(value); if (!value) coverage.flush(); }} onEnded={next} autoPlay={autoPlay}
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
            <div className="flex items-center gap-1" role="group" aria-label="Views">
              <button type="button" aria-pressed={layout === 'split'} onClick={() => setLayout(layout === 'split' ? 'single' : 'split')}
                className={cn('rounded px-2 py-0.5 text-xs', layout === 'split' ? 'bg-red-600 text-white' : 'text-slate-300 hover:bg-slate-800')}>Side by side (V)</button>
              {layout === 'single' && ([['bats', 'Bats'], ['flight', 'Flight map'], ['count', 'Count']] as const).map(([key, label]) =>
                <button key={key} type="button" aria-pressed={viewKey === key} onClick={() => setViewKey(key)}
                  className={cn('rounded px-2 py-0.5 text-xs', viewKey === key ? 'bg-slate-100 text-slate-900' : 'text-slate-300 hover:bg-slate-800')}>{label}</button>)}
              <button type="button" aria-pressed={smart} title={`Normal speed near tracks and crossings, the chosen speed elsewhere. Only ${WATCH_MAX_RATE}x or slower counts as watched.`}
                onClick={() => { setSmart(!smart); rateRef.current = SPEEDS[speed]!; player.current?.setRate(SPEEDS[speed]!); }}
                className={cn('rounded px-2 py-0.5 text-xs', smart ? 'bg-amber-500 text-slate-950' : 'text-slate-300 hover:bg-slate-800')}>Smart speed</button>
              <div className="flex items-center gap-1" role="group" aria-label="Markers">
                {(['boxes', 'dots', 'rings'] as const).map(value => <button key={value} type="button" aria-pressed={markerStyle === value} onClick={() => setMarkerStyle(value)}
                  className={cn('rounded px-2 py-0.5 text-xs', markerStyle === value ? 'bg-slate-100 text-slate-900' : 'text-slate-300 hover:bg-slate-800')}>{value[0]!.toUpperCase() + value.slice(1)}</button>)}
              </div>
              <button type="button" aria-pressed={showNoise} onClick={() => setShowNoise(!showNoise)} title="Noise tracks are hidden by default; they never count."
                className={cn('rounded px-2 py-0.5 text-xs', showNoise ? 'bg-slate-100 text-slate-900' : 'text-slate-300 hover:bg-slate-800')}>Noise {showNoise ? 'shown' : 'hidden'}</button>
              <button type="button" aria-label="Count board (C)" onClick={() => setBoard(board === 'band' ? 'corner' : board === 'corner' ? 'off' : 'band')}
                className="rounded px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-800">Board: {board} (C)</button>
              <button type="button" aria-pressed={flightMode === 'whole'} title="Flight map: build up with playback or show the whole video"
                onClick={() => setFlightMode(flightMode === 'whole' ? 'building' : 'whole')}
                className="rounded px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-800">Map: {flightMode === 'whole' ? 'whole video' : 'so far'}</button>
            </div>
            <span className="ml-auto font-mono tabular-nums" aria-label="Time in video">{elapsed}</span>
            <span className="font-mono text-xs tabular-nums text-slate-400" aria-label="Frame number">frame {displayed ? displayed.index + 1 : '-'}</span>
            <span className="text-xs text-slate-400">video {position + 1}/{segments.length}</span>
            <Button size="sm" variant="outline" className="border-slate-600 bg-transparent text-slate-100" disabled={!displayed}
              onClick={() => { player.current?.pause(); setVerify(displayed ? String(Math.round(displayed.pts)) : null); }}><ScanSearch />Verify original</Button>
          </div>
          {trackingRun && tracksShown < tracksTotal && <p role="status" aria-label="Display limit" className="rounded-md bg-amber-500/15 px-3 py-1 text-xs text-amber-200">
            Showing {tracksShown} of {tracksTotal} tracks in these 10 s (display limit, steadiest first); counts and exports include all.</p>}
          {trackingRun && noiseHidden > 0 && !showNoise && <p className="text-[11px] text-slate-500" aria-label="Hidden noise">{noiseHidden} noise tracks hidden here; they never count.</p>}
          <SurveyTimeline segments={segments} windows={survey.run?.windows ?? []} windowCounts={survey.tracking?.window_counts ?? {}}
            counts={counts} events={events} current={displayed ? { segmentID: segment.id, pts: displayed.pts } : null} onSeek={goTo} />
          <p className="text-[11px] text-slate-500">Timeline: red bars tracks per window, cyan in, magenta out, amber undecided, violet crossings per minute, x camera moved, green reviewed windows, hatched gaps between videos not marked contiguous.</p>
          <p className="text-xs text-slate-500">Space play/pause - , . frame step - arrows 5 s - 1-6 speed - V side by side - C count board. Playback copy: lossy VP9 for viewing; Verify opens the exact original frames.</p>
        </section>
        <aside className={cn('space-y-3', layout === 'split' && 'grid gap-3 space-y-0 md:grid-cols-2 xl:grid-cols-3')}>
          <div className={cn('flex gap-1', layout === 'split' && 'md:col-span-2 xl:col-span-3')} role="tablist" aria-label="Side panel">
            {([['tracks', 'Tracks'], ['setup', 'Setup'], ['counts', 'Counts'], ['review', 'Review']] as const).map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={panel === key}
              onClick={() => { setPanel(key); setViewKey(key === 'counts' ? 'count' : 'bats'); if (key === 'tracks') { setDrawing(null); setDraft([]); } }}
              className={cn('rounded-md px-3 py-1 text-sm', panel === key ? 'bg-slate-100 text-slate-900' : 'text-slate-300 hover:bg-slate-800')}>{label}</button>)}
          </div>
          {panel === 'setup' && <SetupPanel settings={settings} onChange={setSettings} drawing={drawing} draft={draft}
            onDraw={kind => { setDrawing(kind); setDraft([]); player.current?.pause(); }} onFinishShape={finishShape} onCancelShape={() => { setDraft([]); setDrawing(null); }}
            test={test} testing={testing} onTest={() => void runTest()} onClearTest={clearTest}
            onApply={() => { clearTest(); void survey.startTracking(settings); }}
            canTest={Boolean(displayed && frames)} canApply={Boolean(survey.run) && !activeRun(survey.run) && !activeTracking(survey.tracking) && !survey.busy}
            applyReason={activeTracking(survey.tracking) ? 'Tracking is running.' : 'Wait for motion summaries and other processing to finish.'} />}
          {panel === 'review' && <WatchReviewPanel states={windowList} segments={segments} reelSize={reelItems.length}
            reel={reelItem && reel !== null ? { position: Math.min(reel, reelItems.length - 1), total: reelItems.length, label: reelItem.label } : null}
            onStartReel={() => playReel(0)} onStopReel={() => { setReel(null); player.current?.pause(); }} onMark={() => void markWatched()} marking={marking} actor={actor} />}
          {panel === 'counts' && segment && <CountsPanel counts={counts} setCounts={setCounts} gateID={chosenGate?.id ?? null} setGateID={setGateID}
            actor={actor} setActor={setActor} segment={segment} segments={segments}
            live={counts && displayed ? soFar(counts, order, segment.id, displayed.pts) : null}
            gateDraft={gateDraft} setGateDraft={draft => { setGateDraft(draft); if (draft) player.current?.pause(); }} redraw={redraw} setRedraw={setRedraw} onGo={goTo} />}
          {panel === 'counts' && counts && <SampleCheckPanel checks={sampleChecks} active={sample} segments={segments} actor={actor} busy={sampleBusy}
            canStart={Boolean(displayed) && (survey.media?.schema_version ?? 0) >= 14} onStart={startSample} onFinish={() => void finishSample()}
            onCancel={() => setSample(null)} onGo={goTo} />}
          {activeTracking(survey.tracking) && <p role="status" className="rounded-lg border border-slate-800 bg-slate-900 p-3 text-sm">Tracking the whole survey with these settings...</p>}
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <p className="text-xs uppercase tracking-wide text-slate-400">Tracked now</p>
            <p className="text-4xl font-bold tabular-nums text-red-400" aria-label="Tracks at this frame">{trackingRun ? live : '-'}</p>
            <p className="mt-1 text-xs text-slate-400">{trackingRun ? `${tracks.length} tracks loaded around the playhead.` : 'No completed tracking run yet. Set it up and track the survey in the Setup tab.'}</p>
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
