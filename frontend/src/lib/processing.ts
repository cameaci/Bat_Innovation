import type { ImportJob, PlaybackStatus, SummaryDetail, TrackingRun } from '../../../electron/src/contracts';

/** One step of the survey pipeline as the processing window shows it: add videos, summaries, playback copies, tracks. */
export type PhaseState = 'not_started' | 'waiting' | 'running' | 'done' | 'attention';
export interface Phase {
  key: 'import' | 'summaries' | 'copies' | 'tracking';
  label: string;
  state: PhaseState;
  detail: string;
  /** 0-100 while running, otherwise null. */
  percent: number | null;
}

const plural = (count: number, word: string) => `${count.toLocaleString('en-GB')} ${word}${count === 1 ? '' : 's'}`;
const percent = (done: number, total: number) => Math.round(100 * done / Math.max(1, total));

export function processingPhases({ segments, importJob, run, playback, tracking }: {
  segments: number;
  importJob: ImportJob | null;
  run: SummaryDetail | null;
  playback: PlaybackStatus | null;
  tracking: TrackingRun | null;
}): Phase[] {
  const imported: Phase = importJob?.state === 'running'
    ? { key: 'import', label: 'Add videos', state: 'running', percent: percent(importJob.files_done, importJob.files_total),
      detail: `Checking ${importJob.files_done + 1} of ${importJob.files_total}: ${importJob.phase}` }
    : importJob?.state === 'failed'
      ? { key: 'import', label: 'Add videos', state: 'attention', percent: null, detail: importJob.error?.message ?? 'The last import failed. No files from that batch were added.' }
      : segments > 0
        ? { key: 'import', label: 'Add videos', state: 'done', percent: null, detail: `${plural(segments, 'video')} added; originals unchanged` }
        : { key: 'import', label: 'Add videos', state: 'not_started', percent: null, detail: 'Add the original videos on the Process page.' };

  const done = run ? run.counts.complete + run.counts.failed + run.counts.incomplete : 0;
  const summaries: Phase = !run
    ? { key: 'summaries', label: 'Motion summaries', state: segments > 0 ? 'not_started' : 'waiting', percent: null,
      detail: segments > 0 ? 'Generate motion summaries on the Process page.' : 'Starts once videos are added.' }
    : run.state === 'queued' || run.state === 'running'
      ? { key: 'summaries', label: 'Motion summaries', state: 'running', percent: percent(done, run.counts.planned), detail: `${done} of ${plural(run.counts.planned, 'window')} done` }
      : { key: 'summaries', label: 'Motion summaries', state: run.state === 'complete' ? 'done' : 'attention', percent: null,
        detail: `Run ${run.state}: ${run.counts.complete} of ${plural(run.counts.planned, 'window')} complete` };

  const ready = new Set(playback?.proxies.filter(item => item.state === 'ready').map(item => item.segment_id) ?? []).size;
  const broken = new Set(playback?.proxies.filter(item => ['failed', 'cancelled', 'interrupted'].includes(item.state) && !playback.proxies.some(other => other.segment_id === item.segment_id && other.state === 'ready')).map(item => item.segment_id) ?? []).size;
  const copies: Phase = playback?.active
    ? { key: 'copies', label: 'Playback copies', state: 'running', percent: percent(ready, segments), detail: `${ready} of ${plural(segments, 'video')} ready` }
    : segments > 0 && ready >= segments
      ? { key: 'copies', label: 'Playback copies', state: 'done', percent: null, detail: `${ready} of ${plural(segments, 'video')} ready for Watch` }
      : broken > 0
        ? { key: 'copies', label: 'Playback copies', state: 'attention', percent: null, detail: `${broken} ${broken === 1 ? 'copy' : 'copies'} did not finish; prepare again on the Watch page.` }
        : { key: 'copies', label: 'Playback copies', state: 'waiting', percent: null, detail: 'Prepared automatically once the summaries finish.' };

  const tracks = tracking ? Object.values(tracking.track_counts).reduce((sum, count) => sum + count, 0) : 0;
  const progress = tracking?.progress;
  const tracked: Phase = !tracking
    ? { key: 'tracking', label: 'Tracks', state: run?.state === 'complete' ? 'not_started' : 'waiting', percent: null,
      detail: run?.state === 'complete' ? 'Set up and test on the Watch page, or press Find tracks.' : 'Needs a finished summary run.' }
    : tracking.state === 'queued' || tracking.state === 'running'
      ? { key: 'tracking', label: 'Tracks', state: 'running', percent: progress ? percent(progress[0], progress[1]) : 0,
        detail: progress ? `${progress[0].toLocaleString('en-GB')} of ${plural(progress[1], 'frame')}` : 'Starting' }
      : { key: 'tracking', label: 'Tracks', state: tracking.state === 'complete' ? 'done' : 'attention', percent: null,
        detail: tracking.state === 'complete' ? `${plural(tracks, 'track')} found (candidates, unverified)` : `Tracking ${tracking.state}` };

  return [imported, summaries, copies, tracked];
}
