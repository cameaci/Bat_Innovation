import { Loader2, Route, Square } from 'lucide-react';
import { activeRun, activeTracking, useSurvey } from '../../survey';
import { localDate } from '../../lib/time';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';

const failure: Record<string, string> = {
  tracking_limit: 'Tracking exceeded a time, memory, frame or track limit. No partial segment was saved.',
  changed_source: 'An original changed since it was summarised. Tracks are never computed on different bytes.',
  missing_source: 'An original video is missing.',
  cancelled: 'Tracking was cancelled. Segments finished before cancelling were kept.',
  interrupted: 'Tracking was interrupted. Start it again.',
};

/** Starts and shows the derived tracking run of the selected summary run (feature expansion E2). */
export function TracksCard({ disabled }: { disabled: boolean }) {
  const survey = useSurvey();
  const { run, tracking } = survey;
  const running = activeTracking(tracking);
  const total = tracking ? Object.values(tracking.track_counts).reduce((sum, count) => sum + count, 0) : 0;
  const frames = tracking ? Object.values(tracking.stats).reduce((sum, item) => sum + item.framewide_frames, 0) : 0;
  return <Card aria-labelledby="tracks-heading">
    <CardHeader className="flex-row items-start justify-between space-y-0">
      <div className="space-y-1.5">
        <CardTitle id="tracks-heading">Tracks</CardTitle>
        <CardDescription>Follows moving objects through the original frames. Tracks are candidates for review: a track is not an animal, and a window without tracks still needs review.</CardDescription>
      </div>
    </CardHeader>
    <CardContent className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled || !run || activeRun(run) || running || survey.busy || survey.dirty} onClick={() => void survey.startTracking()}>
          {running ? <Loader2 className="animate-spin" /> : <Route />}Find tracks
        </Button>
        {running && <Button variant="outline" onClick={() => void survey.cancelTracking()}><Square />Cancel tracking</Button>}
      </div>
      {!run && <p className="text-sm text-muted-foreground">Generate motion summaries first; tracks are computed for the selected summary run.</p>}
      {tracking && <div className="space-y-1 rounded-lg border bg-muted/40 p-3 text-sm">
        <p role="status" className="font-medium">{running ? 'Tracking: following moving objects...' : `Tracking ${tracking.state}: ${total} track${total === 1 ? '' : 's'} (unverified)`}</p>
        {tracking.error && !running && <p role="alert" className="text-red-700">{failure[tracking.error] ?? 'Tracking failed. The summary evidence is unchanged.'}</p>}
        {frames > 0 && <p className="flex items-center gap-1 text-xs text-amber-800"><Badge variant="warning">{frames}</Badge>frames with a frame-wide change were skipped for tracking; check those windows by eye.</p>}
        <p className="text-xs text-muted-foreground">{tracking.algorithm_version} · started {localDate(tracking.started_at_utc)} · parameters SHA256 {tracking.parameter_hash.slice(0, 12)}...</p>
      </div>}
    </CardContent>
  </Card>;
}
