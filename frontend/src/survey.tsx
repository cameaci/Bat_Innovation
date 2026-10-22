import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiResult, BatAPI, ImportJob, MediaSession, RecordingSession, SaveMedia, SummaryDetail, SummaryRun } from '../../electron/src/contracts';
import { getAPI } from './api';

const unavailable = 'The local backend is unavailable. Retry, or close and reopen the app.';
export const activeRun = (run: SummaryRun | null | undefined) => run?.state === 'queued' || run?.state === 'running';
export const CURRENT_SCHEMA = 5;

export interface Survey {
  session: RecordingSession;
  media: MediaSession | null;
  error: string;
  notice: string;
  clearMessages: () => void;
  refreshMedia: () => Promise<void>;
  upgradeStorage: () => Promise<void>;
  importJob: ImportJob | null;
  chooseVideos: () => Promise<void>;
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
  const busy = importJob?.state === 'running' || activeRun(run) || exportBusy;

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
      [1, api => api.upgradeMedia()], [2, api => api.upgradeSummaries()], [3, api => api.upgradeReviews()], [4, api => api.upgradeQA()],
    ];
    let version = media?.schema_version ?? CURRENT_SCHEMA;
    for (const [from, step] of steps) {
      if (version !== from) continue;
      if (await request(step) === undefined) break;
      version = from + 1;
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

  async function chooseVideos() {
    setError(''); setNotice('');
    const value = await request(api => api.chooseMedia(session.id));
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
    setDraft, dirty, busy, setExportBusy,
  };
  return <SurveyContext.Provider value={value}>{children}</SurveyContext.Provider>;
}
