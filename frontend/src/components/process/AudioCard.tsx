import { useState } from 'react';
import { AudioLines } from 'lucide-react';
import type { AudioSourceMode } from '../../../../electron/src/contracts';
import { getAPI } from '../../api';
import { useSurvey } from '../../survey';
import { clock } from '../../lib/time';
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
      {survey.audio.length > 0 && <ul aria-label="Audio recordings" className="divide-y rounded-lg border text-sm">{survey.audio.map(item => <li key={item.id} className="space-y-1 p-3">
        <p className="font-medium">{item.metadata.filename}</p>
        <p className="text-xs text-muted-foreground">{AUDIO_MODES[item.source_mode]} · {item.metadata.sample_rate / 1000} kHz · {clock(item.metadata.frames / item.metadata.sample_rate)} · channel {item.channel + 1} of {item.metadata.channels}</p>
        {item.anchor ? <Badge variant="success">Synchronised to a video frame by {item.anchor.actor}</Badge> : <Badge variant="warning">Not synchronised: set an anchor in a window</Badge>}
      </li>)}</ul>}
    </CardContent>
  </Card>;
}
