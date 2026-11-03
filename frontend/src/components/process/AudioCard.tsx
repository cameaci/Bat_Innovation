import { useState } from 'react';
import { AudioLines } from 'lucide-react';
import type { AnchorProposal, AudioSource, AudioSourceMode } from '../../../../electron/src/contracts';
import { getAPI } from '../../api';
import { useSurvey } from '../../survey';
import { clock } from '../../lib/time';
import { savedReviewer } from '../../lib/reviewer';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input, Label, Select } from '../ui/input';

export const AUDIO_MODES: Record<AudioSourceMode, string> = {
  full_spectrum: 'Full spectrum (retunable)', heterodyne: 'Heterodyne recording', frequency_division: 'Frequency division',
  time_expansion: 'Time expansion', unknown: 'Unknown',
};

/** Adds original WAV recordings by native selection (feature expansion E7). The originals are never changed. */
export function AudioCard({ disabled }: { disabled: boolean }) {
  const survey = useSurvey();
  const [mode, setMode] = useState<AudioSourceMode>('full_spectrum');
  const [channel, setChannel] = useState('0');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  async function add() {
    setAdding(true); setError('');
    const result = await getAPI()?.chooseAudio(survey.session.id, mode, Number(channel));
    setAdding(false);
    if (!result?.ok) { setError(result?.error.message ?? 'The local backend is unavailable.'); return; }
    await survey.reloadAudio();
  }
  return <Card aria-labelledby="audio-heading">
    <CardHeader>
      <CardTitle id="audio-heading">Audio</CardTitle>
      <CardDescription>Optional bat-detector WAV recordings, shown under the video as a spectrogram. Set one sync anchor per video in a window. Clock drift is not corrected.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1"><Label htmlFor="audio-mode" className="text-xs">Recording type</Label>
          <Select id="audio-mode" className="w-56" value={mode} onChange={event => setMode(event.target.value as AudioSourceMode)}>
            {Object.entries(AUDIO_MODES).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </Select></div>
        <div className="space-y-1"><Label htmlFor="audio-channel" className="text-xs">Channel</Label><Input id="audio-channel" className="w-20" inputMode="numeric" value={channel} onChange={event => setChannel(event.target.value)} /></div>
        <Button disabled={disabled || adding || survey.busy || !/^[0-7]$/.test(channel)} onClick={() => void add()}><AudioLines />{adding ? 'Checking audio...' : 'Add audio (WAV)'}</Button>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {survey.audio.length > 0 && <ul aria-label="Audio recordings" className="divide-y rounded-lg border text-sm">{survey.audio.map(item => <AudioItem key={item.id} item={item} />)}</ul>}
    </CardContent>
  </Card>;
}

/** One recording: its label, the start time its file claims, and a sync anchor proposed from the file clocks for one confirmation. */
function AudioItem({ item }: { item: AudioSource }) {
  const survey = useSurvey();
  const [label, setLabel] = useState(item.label ?? '');
  const [offset, setOffset] = useState('');
  const [actor, setActor] = useState(savedReviewer);
  const [proposal, setProposal] = useState<AnchorProposal | null>(null);
  const [error, setError] = useState('');
  const labels = (survey.media?.schema_version ?? 0) >= 20;
  const video = (id: string) => (survey.media?.segments.findIndex(segment => segment.id === id) ?? -1) + 1;
  async function propose() {
    setError('');
    const result = await getAPI()?.proposeAnchor(item.id, proposal?.needs_offset && offset ? offset : null);
    if (!result?.ok) { setError(result?.error.message ?? 'The local backend is unavailable.'); return; }
    setProposal(result.value);
  }
  async function confirm() {
    const value = proposal?.proposal;
    if (!value) return;
    setError('');
    const result = await getAPI()?.setAudioAnchor(item.id, { actor: actor.trim(), expected_revision: item.anchor?.revision ?? 0, segment_id: value.segment_id,
      video_pts: value.video_pts, audio_sample: value.audio_sample, note: `Confirmed proposal from file clocks (${value.basis} ${value.timestamp}${value.stated_offset ? `, stated offset ${value.stated_offset}` : ''})` });
    if (!result?.ok) { setError(result?.error.message ?? 'The local backend is unavailable.'); return; }
    setProposal(null);
    await survey.reloadAudio();
  }
  async function saveLabel() {
    const result = await getAPI()?.setAudioLabel(item.id, label);
    if (!result?.ok) setError(result?.error.message ?? 'The local backend is unavailable.'); else await survey.reloadAudio();
  }
  return <li className="space-y-1 p-3" aria-label={`Recording ${item.metadata.filename}`}>
    <p className="font-medium">{item.label ? `${item.label} - ` : ''}{item.metadata.filename}</p>
    <p className="text-xs text-muted-foreground">{AUDIO_MODES[item.source_mode]} · {item.metadata.sample_rate / 1000} kHz · {clock(item.metadata.frames / item.metadata.sample_rate)} · channel {item.channel + 1} of {item.metadata.channels}
      {item.metadata.file_clock ? ` · file says it started ${item.metadata.file_clock.timestamp} (${item.metadata.file_clock.source === 'guano' ? 'GUANO' : 'file name'}, unverified)` : ''}</p>
    {item.anchor ? <Badge variant="success">Synchronised to a video frame by {item.anchor.actor}</Badge> : <Badge variant="warning">Not synchronised: set an anchor in a window or confirm a proposal</Badge>}
    {labels && <div className="flex flex-wrap items-center gap-1">
      <Input aria-label={`Label for ${item.metadata.filename}`} className="h-7 w-56" maxLength={60} placeholder="e.g. detector at the roost" value={label} onChange={event => setLabel(event.target.value)} />
      <Button size="sm" variant="outline" className="h-7" disabled={label === (item.label ?? '')} onClick={() => void saveLabel()}>Save label</Button>
      <Button size="sm" variant="outline" className="h-7" onClick={() => void propose()}>Propose sync from file clocks</Button>
    </div>}
    {proposal?.needs_offset && <div className="flex flex-wrap items-center gap-1 text-xs">
      <span>{proposal.reason}</span>
      <Input aria-label="Audio UTC offset" className="h-7 w-24" maxLength={6} placeholder="+01:00" value={offset} onChange={event => setOffset(event.target.value)} />
      <Button size="sm" variant="outline" className="h-7" disabled={!/^[+-](0\d|1[0-4]):[0-5]\d$/.test(offset)} onClick={() => void propose()}>Propose</Button>
    </div>}
    {proposal && !proposal.proposal && !proposal.needs_offset && <p role="status" className="text-xs text-amber-800">{proposal.reason}</p>}
    {proposal?.proposal && <div role="status" aria-label="Proposed anchor" className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs">
      <p>Proposed from file clocks (unverified): audio sample {proposal.proposal.audio_sample} meets video {video(proposal.proposal.segment_id)} at {clock(Math.max(0, proposal.proposal.offset_seconds))}
        ({proposal.proposal.basis === 'guano' ? 'GUANO' : 'file name'} {proposal.proposal.timestamp}{proposal.proposal.stated_offset ? `, offset ${proposal.proposal.stated_offset} as you stated` : ''}). Check it against a clap or a call you can see before confirming.</p>
      <div className="flex flex-wrap items-center gap-1">
        <Input aria-label="Your name for the anchor" className="h-7 w-40" maxLength={120} placeholder="Your name" value={actor} onChange={event => setActor(event.target.value)} />
        <Button size="sm" className="h-7" disabled={!actor.trim()} onClick={() => void confirm()}>Confirm proposed anchor</Button>
      </div>
    </div>}
    {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
  </li>;
}
