import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Anchor, Headphones, Waves } from 'lucide-react';
import type { AudioDerived, MediaSegment } from '../../../electron/src/contracts';
import { getAPI } from '../api';
import { readMediaBytes } from '../binary';
import { useSurvey } from '../survey';
import { ptsSeconds } from '../lib/time';
import type { SourcePreviewHandle } from './SourcePreview';
import { Button } from './ui/button';
import { Input, Label, Select } from './ui/input';

/**
 * Spectrogram and digital heterodyne of the synchronised WAV for the loaded clip (feature expansion E7).
 * The playhead follows the displayed original frame. One anchor sets the offset; drift is not corrected.
 */
export function AudioStrip({ segment, actor, clip, displayedPTS, player }: {
  segment: MediaSegment; actor: string; clip: { startPTS: string; durationMs: number } | null; displayedPTS: string | null;
  player: RefObject<SourcePreviewHandle | null>;
}) {
  const survey = useSurvey();
  const [audioID, setAudioID] = useState(survey.audio[0]?.id ?? '');
  const [spectrogram, setSpectrogram] = useState<{ meta: AudioDerived; url: string } | null>(null);
  const [tune, setTune] = useState('45');
  const [anchorSeconds, setAnchorSeconds] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sound = useRef<HTMLAudioElement>(null);
  const source = survey.audio.find(item => item.id === audioID) ?? survey.audio[0];
  const synced = source?.anchor?.segment_id === segment.id;
  const seconds = clip ? Math.max(1, Math.min(12, Math.ceil(clip.durationMs / 1000))) : 0;
  useEffect(() => () => { if (spectrogram) URL.revokeObjectURL(spectrogram.url); }, [spectrogram]);
  useEffect(() => { setSpectrogram(null); }, [clip?.startPTS, audioID]);

  async function derive(kind: 'spectrogram' | 'heterodyne') {
    if (!source || !clip) return null;
    setBusy(true); setError('');
    try {
      const api = getAPI();
      const meta = await api?.deriveAudio(source.id, { segment_id: segment.id, start_pts: clip.startPTS, seconds, kind, tune_hz: kind === 'heterodyne' ? Number(tune) * 1000 : null });
      if (!meta?.ok) { setError(meta?.error.message ?? 'The local backend is unavailable.'); return null; }
      const content = await readMediaBytes(() => api!.audioContent(meta.value.id, kind), { priority: 2 });
      if (!content?.ok) { setError(content?.error.message ?? 'The audio could not be read.'); return null; }
      return { meta: meta.value, url: URL.createObjectURL(new Blob([new Uint8Array(content.value.bytes).buffer], { type: kind === 'spectrogram' ? 'image/png' : 'audio/wav' })) };
    } catch { setError('The local backend is unavailable.'); return null; } finally { setBusy(false); }
  }
  async function listen() {
    const result = await derive('heterodyne');
    const element = sound.current;
    if (!result || !element) return;
    element.src = result.url;
    const at = player.current?.playAtNormalSpeed() ?? 0;
    element.currentTime = Math.max(0, at - result.meta.start_offset_seconds);
    void element.play().catch(() => setError('The heterodyne clip could not be played.'));
  }
  async function setAnchor() {
    if (!source || displayedPTS === null || !/^\d+(\.\d+)?$/.test(anchorSeconds)) return;
    const result = await getAPI()?.setAudioAnchor(source.id, { actor: actor.trim(), expected_revision: source.anchor?.revision ?? 0, segment_id: segment.id,
      video_pts: displayedPTS, audio_sample: Math.round(Number(anchorSeconds) * source.metadata.sample_rate), note: '' });
    if (!result?.ok) { setError(result?.error.message ?? 'The local backend is unavailable.'); return; }
    setError(''); await survey.reloadAudio();
  }

  if (!source) return null;
  const playhead = spectrogram && clip && displayedPTS !== null
    ? (ptsSeconds(displayedPTS, clip.startPTS, segment.metadata.time_base) - spectrogram.meta.start_offset_seconds) / spectrogram.meta.covered_seconds : null;
  return <section aria-label="Audio" className="space-y-2 rounded-md border border-slate-700 p-2 text-xs text-slate-200">
    <div className="flex flex-wrap items-end gap-2">
      <p className="font-semibold">Audio</p>
      {survey.audio.length > 1 && <Select aria-label="Audio recording" className="h-7 w-48 text-xs" value={source.id} onChange={event => setAudioID(event.target.value)}>
        {survey.audio.map(item => <option key={item.id} value={item.id}>{item.metadata.filename}</option>)}</Select>}
      <span className="text-slate-400">{source.metadata.filename} · {source.metadata.sample_rate / 1000} kHz{synced ? ' · synchronised by one anchor; drift not corrected' : ' · not synchronised to this video'}</span>
    </div>
    {synced && <div className="flex flex-wrap items-end gap-2">
      <Button size="sm" variant="secondary" className="h-7" disabled={!clip || busy} onClick={async () => { const result = await derive('spectrogram'); if (result) setSpectrogram(result); }}><Waves />Show spectrogram</Button>
      {source.retunable ? <>
        <div className="space-y-1"><Label htmlFor="tune-khz" className="text-xs">Tune (kHz)</Label><Input id="tune-khz" className="h-7 w-20" inputMode="decimal" value={tune} onChange={event => setTune(event.target.value)} /></div>
        <Button size="sm" variant="secondary" className="h-7" disabled={!clip || busy || !(Number(tune) >= 15 && Number(tune) <= 120)} onClick={() => void listen()}><Headphones />Listen (heterodyne)</Button>
      </> : <span className="text-amber-300">Recorded as {source.source_mode.replace('_', ' ')}: cannot be retuned.</span>}
      <audio ref={sound} aria-label="Heterodyne audio" className="hidden" />
    </div>}
    {spectrogram && <div className="relative" aria-label="Spectrogram">
      <img src={spectrogram.url} alt={`Spectrogram, 0 to ${(spectrogram.meta.frequency_max_hz ?? 0) / 1000} kHz, ${spectrogram.meta.covered_seconds.toFixed(1)} s`} className="h-24 w-full" />
      {playhead !== null && playhead >= 0 && playhead <= 1 && <div aria-hidden className="absolute inset-y-0 w-px bg-yellow-300" style={{ left: `${playhead * 100}%` }} />}
      <p className="text-[11px] text-slate-400">0 to {(spectrogram.meta.frequency_max_hz ?? 0) / 1000} kHz (top). {spectrogram.meta.start_offset_seconds > 0 ? 'The audio starts after the clip begins.' : ''}{spectrogram.meta.covered_seconds * 1000 < (clip?.durationMs ?? 0) - 1 ? ' The audio ends before the clip ends.' : ''}</p>
    </div>}
    <details><summary className="cursor-pointer text-slate-400">Set the sync anchor at the displayed frame</summary>
      <div className="mt-1 flex flex-wrap items-end gap-2">
        <div className="space-y-1"><Label htmlFor="anchor-seconds" className="text-xs">The same moment in the audio (seconds)</Label><Input id="anchor-seconds" className="h-7 w-32" inputMode="decimal" value={anchorSeconds} onChange={event => setAnchorSeconds(event.target.value)} /></div>
        <Button size="sm" variant="secondary" className="h-7" disabled={!actor.trim() || displayedPTS === null || !/^\d+(\.\d+)?$/.test(anchorSeconds)} onClick={() => void setAnchor()}><Anchor />Save anchor</Button>
      </div>
      <p className="mt-1 text-slate-400">Pause on a frame with a sound you can also find in the audio (for example a clap), enter its audio time and save. Your name under First review is recorded.</p>
    </details>
    {error && <p role="alert" className="text-red-300">{error}</p>}
  </section>;
}
