import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiResult, BatAPI, Modality, ImportJob, MediaSession, RecordingSession, SaveMedia, SummaryDetail, SummaryRun, TrackingRun, Gate, GateChange, AudioSource, PlaybackStatus, TrackingSettings } from '../../electron/src/contracts';
import { getAPI } from './api';
import { settingsOf } from './lib/trackingSettings';

const unavailable = 'The local backend is unavailable. Retry, or close and reopen the app.';
export const activeRun = (run: SummaryRun | null | undefined) => run?.state === 'queued' || run?.state === 'running';
export const CURRENT_SCHEMA = 20;
export const activeTracking = (run: TrackingRun | null | undefined) => run?.state === 'queued' || run?.state === 'running';
export const THERMAL_LABEL = 'Rendered thermal - no radiometric temperature analysis';

export interface Survey {
  session: RecordingSession;
  media: MediaSession | null;
  error: string;
  notice: string;
  clearMessages: () => void;
  refreshMedia: () => Promise<void>;
  upgradeStorage: () => Promise<void>;
  importJob: ImportJob | null;
  chooseVideos: (modality: Modality) => Promise<void>;
  cancelImport: () => Promise<void>;
  saveTimeline: (input: SaveMedia) => Promise<boolean>;
  runs: SummaryRun[];
  runID: string;
  selectRun: (id: string) => void;
  run: SummaryDetail | null;
  /** The run manifest was re-read and its sources revalidated by the backend on the last poll. */
  verified: boolean;
  startRun: (windowSeconds: number) => Promise<void>;
  cancelRun: () => Promise<void>;
  cancelling: boolean;
  reloadRun: () => void;
  /** Unsaved review, QA or timeline drafts, keyed by owner. Blocks export and window close in main. */
  setDraft: (key: string, dirty: boolean) => void;
  dirty: boolean;
  /** Any backend processing reservation (import, summary run, export) is held. */
  busy: boolean;
  setExportBusy: (busy: boolean) => void;
  /** Latest tracking run of the selected summary run, with per-window track counts. */
  tracking: TrackingRun | null;
  /** Track the selected summary run with these settings (default: those of the latest run). */
  startTracking: (settings?: TrackingSettings) => Promise<void>;
  cancelTracking: () => Promise<void>;
  /** Counting gates drawn on this survey's scene (all revisions' current state, including retired). */
  gates: Gate[];
  saveGate: (gateID: string | null, change: GateChange) => Promise<Gate | undefined>;
  /** Gates created elsewhere (a site template) join the list. */
  addGates: (gates: Gate[]) => void;
  /** Full-spectrum or other WAV recordings of this survey, with their sync anchors. */
  audio: AudioSource[];
  reloadAudio: () => Promise<void>;
  /** Playback copies per segment (Phase 2); prepared automatically once a summary run completes. */
  playback: PlaybackStatus | null;
  startPlayback: () => Promise<void>;
  startEnhanced: (segmentID: string) => Promise<void>;
}

const SurveyContext = createContext<Survey | null>(null);

export function useSurvey(): Survey {
  const value = useContext(SurveyContext);
  if (!value) throw new Error('useSurvey must be used inside a survey');
  return value;
}

export function SurveyProvider({ session, children }: { session: RecordingSession; children: ReactNode }) {
  const [media, setMedia] = useState<MediaSession | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [importJob, setImportJob] = useState<ImportJob | null>(null);
  const [runs, setRuns] = useState<SummaryRun[]>([]);
  const [runID, setRunID] = useState('');
  const [run, setRun] = useState<SummaryDetail | null>(null);
  const [verified, setVerified] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, boolean>>({});
  const [exportBusy, setExportBusy] = useState(false);
  const dirty = Object.values(drafts).some(Boolean);
  const [tracking, setTracking] = useState<TrackingRun | null>(null);
  const [trackingRefresh, setTrackingRefresh] = useState(0);
  const [gates, setGates] = useState<Gate[]>([]);
  const [audio, setAudio] = useState<AudioSource[]>([]);
  const [playback, setPlayback] = useState<PlaybackStatus | null>(null);
  const [playbackRefresh, setPlaybackRefresh] = useState(0);
  const autoPlayback = useRef(false);
  const busy = importJob?.state === 'running' || activeRun(run) || exportBusy || activeTracking(tracking);

  const request = useCallback(async <T,>(action: (api: BatAPI) => Promise<ApiResult<T>>): Promise<T | undefined> => {
    try {
      const api = getAPI();
      if (!api) { setError('The desktop bridge is unavailable. Open this window through the Bat Innovation app.'); return; }
      const result = await action(api);
      if (result.ok) return result.value;
      setError(result.error.message);
    } catch { setError(unavailable); }
  }, []);

  const setDraft = useCallback((key: string, value: boolean) => {
    setDrafts(previous => previous[key] === value ? previous : { ...previous, [key]: value });
  }, []);

  // Main blocks export saving and asks before closing while any draft is unsaved.
  useLayoutEffect(() => {
    void getAPI()?.setDraftDirty(dirty).catch(() => undefined);
    function preventUnload(event: BeforeUnloadEvent) { if (dirty) { event.preventDefault(); event.returnValue = ''; } }
    window.addEventListener('beforeunload', preventUnload);
    return () => { window.removeEventListener('beforeunload', preventUnload); void getAPI()?.setDraftDirty(false).catch(() => undefined); };
  }, [dirty]);

  const refreshMedia = useCallback(async () => {
    const value = await request(api => api.getMedia(session.id));
    if (value) { setMedia(value); if (value.active_import?.state === 'running') setImportJob(value.active_import); }
  }, [request, session.id]);

  const loadRuns = useCallback(async () => {
    const value = await request(api => api.listSummaryRuns(session.id));
    if (value) {
      setRuns(value);
      setRunID(current => value.find(activeRun)?.id ?? (value.some(item => item.id === current) ? current : value[0]?.id ?? ''));
      setRefresh(current => current + 1);
    }
  }, [request, session.id]);

  useEffect(() => { void refreshMedia(); void loadRuns(); }, [refreshMedia, loadRuns]);

  async function upgradeStorage() {
    setError(''); setNotice('');
    // Each step is a separate transactional upgrade; a failure leaves the database at a supported earlier version.
    const steps: [number, (api: BatAPI) => Promise<ApiResult<unknown>>][] = [
      [1, api => api.upgradeMedia()], [2, api => api.upgradeSummaries()], [3, api => api.upgradeReviews()], [4, api => api.upgradeQA()], [5, api => api.upgradeStorage()],
    ];
    let version = media?.schema_version ?? CURRENT_SCHEMA;
    for (const [from, step] of steps) {
      // Storage of any feature-expansion version is brought to the current one by the single storage step.
      if (version !== from && !(from === 5 && version > 5 && version < CURRENT_SCHEMA)) continue;
      if (await request(step) === undefined) break;
      version = from === 5 ? CURRENT_SCHEMA : from + 1;
    }
    await refreshMedia();
    if (version === CURRENT_SCHEMA) setNotice('Storage upgraded. Existing sessions, videos and reviews were kept.');
    setRefresh(current => current + 1);
  }

  async function finishImport(job: ImportJob) {
    await refreshMedia();
    setImportJob(job);
    if (job.state === 'failed') setError(job.error?.message ?? 'Import failed. Check the original recordings and retry.');
    else setNotice(job.state === 'complete' ? `${job.files_total} video${job.files_total === 1 ? '' : 's'} added. The original files were not changed.` : 'Import cancelled. No files from this batch were added.');
  }

  useEffect(() => {
    if (importJob?.state !== 'running') return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const value = await request(api => api.importStatus(importJob.id));
      if (!active) return;
      if (value && value.state !== 'running') { await finishImport(value); return; }
      if (value) setImportJob(value);
      timer = setTimeout(() => void poll(), 500);
    };
    timer = setTimeout(() => void poll(), 500);
    return () => { active = false; clearTimeout(timer); };
  }, [importJob?.id, importJob?.state]);

  async function chooseVideos(modality: Modality) {
    setError(''); setNotice('');
    const value = await request(api => api.chooseMedia(session.id, modality));
    if (value === undefined) return;
    if (value === null) { setNotice('No files were selected.'); return; }
    if (value.state === 'running') setImportJob(value); else await finishImport(value);
  }

  async function cancelImport() {
    if (!importJob) return;
    const value = await request(api => api.cancelImport(importJob.id));
    if (value) { if (value.state === 'running') setImportJob(value); else await finishImport(value); }
  }

  async function saveTimeline(input: SaveMedia) {
    setError(''); setNotice('');
    const value = await request(api => api.saveMedia(session.id, input));
    if (value) { setMedia(value); setNotice('Video order and timeline evidence saved.'); return true; }
    return false;
  }

  // Active runs poll every second so finished windows appear live; finished runs are revalidated every 30 s.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!runID) { setRun(null); setVerified(false); return; }
    if (runRef.current?.id !== runID) { setRun(null); setVerified(false); }
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    let running = runRef.current?.id === runID && activeRun(runRef.current);
    async function poll() {
      if (!current) return;
      if (!running && document.hidden) { timer = setTimeout(() => void poll(), 30000); return; }
      try {
        const result = await getAPI()?.summaryRun(runID);
        if (!current) return;
        if (!result?.ok) { setError(result?.error.message ?? unavailable); setVerified(false); }
        else if (result.value.session_id !== session.id || result.value.id !== runID) { setError('The summary run does not match this survey.'); setVerified(false); }
        else {
          const value = result.value;
          running = activeRun(value);
          setRun(value); setVerified(true);
          setRuns(previous => previous.map(item => item.id === value.id ? value : item));
          if (!running) setCancelling(false);
        }
      } catch { if (current) { setError(unavailable); setVerified(false); } }
      if (current) timer = setTimeout(() => void poll(), running ? 1000 : 30000);
    }
    function visible() { if (!document.hidden && !running) { clearTimeout(timer); void poll(); } }
    void poll();
    document.addEventListener('visibilitychange', visible);
    return () => { current = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [runID, session.id, refresh]);

  // The latest tracking run of the selected summary run; polled each second while it runs.
  useEffect(() => {
    if (!runID || (media?.schema_version ?? 0) < 7) { setTracking(null); return; }
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll(id?: string) {
      try {
        const api = getAPI();
        let result: ApiResult<TrackingRun> | undefined;
        if (!id) {
          const listed = await api?.listTracking(runID);
          if (!current) return;
          if (!listed?.ok) { setError(listed?.error.message ?? unavailable); return; }
          if (listed.value.length === 0) { setTracking(null); return; }
          id = listed.value[0]!.id;
        }
        result = await api?.trackingRun(id);
        if (!current) return;
        if (!result?.ok) { setError(result?.error.message ?? unavailable); return; }
        setTracking(result.value);
        if (activeTracking(result.value)) timer = setTimeout(() => void poll(id), 1000);
      } catch { if (current) setError(unavailable); }
    }
    void poll();
    return () => { current = false; clearTimeout(timer); };
  }, [runID, trackingRefresh, media?.schema_version]);

  useEffect(() => {
    if ((media?.schema_version ?? 0) < 8) { setGates([]); return; }
    void request(api => api.listGates(session.id)).then(value => { if (value) setGates(value); });
  }, [request, session.id, media?.schema_version]);

  const reloadAudio = useCallback(async () => {
    if ((media?.schema_version ?? 0) < 10) { setAudio([]); return; }
    const value = await request(api => api.listAudio(session.id));
    if (value) setAudio(value);
  }, [request, session.id, media?.schema_version]);
  useEffect(() => { void reloadAudio(); }, [reloadAudio]);

  // Playback copies: polled each second while a copy is being made.
  useEffect(() => {
    if ((media?.schema_version ?? 0) < 11) { setPlayback(null); return; }
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const value = await request(api => api.playbackStatus(session.id));
      if (!current || !value) return;
      setPlayback(value);
      if (value.active) timer = setTimeout(() => void poll(), 1000);
    }
    void poll();
    return () => { current = false; clearTimeout(timer); };
  }, [request, session.id, media?.schema_version, playbackRefresh]);

  const startPlayback = useCallback(async () => {
    const value = await request(api => api.startPlayback(session.id));
    if (value) { setPlayback(value); setPlaybackRefresh(current => current + 1); }
  }, [request, session.id]);

  const startEnhanced = useCallback(async (segmentID: string) => {
    const value = await request(api => api.startEnhanced(session.id, segmentID));
    if (value) { setPlayback(value); setPlaybackRefresh(current => current + 1); }
  }, [request, session.id]);

  // Once per opened survey: after a summary run completes, copy any video that has no playback copy yet.
  useEffect(() => {
    if (autoPlayback.current || !playback || playback.active || run?.state !== 'complete' || !media) return;
    const copied = new Set(playback.proxies.map(item => item.segment_id));
    if (media.segments.every(segment => copied.has(segment.id))) return;
    autoPlayback.current = true;
    void startPlayback();
  }, [playback, run?.state, media, startPlayback]);

  function addGates(added: Gate[]) {
    setGates(previous => [...previous.filter(item => !added.some(gate => gate.id === item.id)), ...added]);
  }

  async function saveGate(gateID: string | null, change: GateChange) {
    setError(''); setNotice('');
    const value = await request(api => api.saveGate(session.id, gateID, change));
    if (value) {
      setGates(previous => [...previous.filter(item => item.id !== value.id), value]);
      setNotice(value.state === 'retired' ? `Gate "${value.name}" retired. Its history is kept.` : `Gate "${value.name}" saved (revision ${value.revision}).`);
    }
    return value;
  }

  async function startTracking(settings?: TrackingSettings) {
    if (!runID) return;
    setError(''); setNotice('');
    const chosen = settings ?? settingsOf(tracking);
    const value = await request(api => api.startTracking(runID, chosen));
    if (value) { setTracking(value); setTrackingRefresh(current => current + 1); }
  }

  async function cancelTracking() {
    if (!tracking || !activeTracking(tracking)) return;
    const value = await request(api => api.cancelTracking(tracking.id));
    if (value) setTrackingRefresh(current => current + 1);
  }

  async function startRun(windowSeconds: number) {
    setError(''); setNotice('');
    const value = await request(api => api.startSummaries({ session_id: session.id, window_seconds: windowSeconds }));
    if (value) { setRuns(previous => [value, ...previous.filter(item => item.id !== value.id)]); setRun(value); setRunID(value.id); setRefresh(current => current + 1); }
  }

  async function cancelRun() {
    if (!run || !activeRun(run)) return;
    setCancelling(true);
    const value = await request(api => api.cancelSummaries(run.id));
    if (value) { setRun(value); if (!activeRun(value)) setCancelling(false); } else setCancelling(false);
  }

  const value: Survey = {
    session, media, error, notice, clearMessages: () => { setError(''); setNotice(''); },
    refreshMedia, upgradeStorage, importJob, chooseVideos, cancelImport, saveTimeline,
    runs, runID, selectRun: id => { setRunID(id); setRefresh(current => current + 1); }, run, verified,
    startRun, cancelRun, cancelling, reloadRun: () => setRefresh(current => current + 1),
    setDraft, dirty, busy, setExportBusy, tracking, startTracking, cancelTracking, gates, saveGate, addGates, audio, reloadAudio,
    playback, startPlayback, startEnhanced,
  };
  return <SurveyContext.Provider value={value}>{children}</SurveyContext.Provider>;
}
