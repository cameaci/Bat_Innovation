import { useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import type { ApiResult } from '../../../../electron/src/contracts';
import { getAPI } from '../../api';
import { useSurvey } from '../../survey';
import { reportHTML, type ReportData } from '../../lib/report';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';

/** The provisional evidence report as a PDF: survey, gates, three count layers, profile, checks, coverage, figures, limitations. */
export function ReportCard() {
  const survey = useSurvey();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const tracking = survey.tracking?.state === 'complete' ? survey.tracking : null;

  async function make() {
    const api = getAPI();
    if (!api || !tracking || !survey.media || !survey.run) return;
    setBusy(true); setError(''); setSaved('');
    try {
      const value = <T,>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };
      const gates = survey.gates.filter(gate => gate.state === 'active');
      const counts = await Promise.all(gates.map(async gate => value(await api.getCounts(tracking.id, gate.id))));
      const checks = Object.fromEntries(await Promise.all(gates.map(async gate => [gate.id, value(await api.listSampleChecks(tracking.id, gate.id))] as const)));
      const labels = survey.media.schema_version >= 17 ? value(await api.listLabels(tracking.id)) : null;
      const tracks = await Promise.all(survey.media.segments.map(async segment => {
        const page = value(await api.getTracks(tracking.id, segment.id, segment.metadata.first_pts, null, false));
        return { segmentID: segment.id, shown: page.shown, total: page.total,
          paths: page.tracks.map(track => ({ index: track.track_index, uncertain: track.quality === 'uncertain', points: track.points.map(([, x, y]) => [x, y] as [number, number]) })) };
      }));
      const data: ReportData = { generatedUTC: new Date().toISOString(), session: survey.session, segments: survey.media.segments, anchor: survey.media.clock_anchor,
        review: survey.run.review_progress ?? null, windows: survey.run.windows.length, tracking, counts, sampleChecks: checks, labels, tracks };
      const result = await api.saveReport(reportHTML(data));
      if (!result.ok) setError(result.error.message);
      else if (result.value) setSaved(`Saved ${result.value}`);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'The report could not be prepared.');
    } finally {
      setBusy(false);
    }
  }

  return <Card role="region" aria-label="Evidence report">
    <CardHeader>
      <CardTitle className="flex items-center gap-2"><FileText className="h-5 w-5" aria-hidden />Evidence report (PDF)</CardTitle>
      <CardDescription>One PROVISIONAL report of this survey: videos and hashes, gates, the algorithm, reviewer and QA counts per gate, emergence profiles, sample checks, review coverage of every window, track figures, settings and versions, and the limitations. It reflects the review state when it is made.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-2">
      {!tracking || !survey.run ? <p className="text-sm text-muted-foreground">Generate summaries and track the survey first.</p>
        : <Button disabled={busy || survey.dirty} onClick={() => void make()}>{busy ? <Loader2 className="animate-spin" /> : <FileText />}Save PDF report...</Button>}
      {survey.dirty && <p role="status" className="text-sm text-amber-800">Save or discard open review changes first.</p>}
      {saved && <p role="status" className="text-sm text-emerald-700">{saved}</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </CardContent>
  </Card>;
}
