import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Eye } from 'lucide-react';
import type { SummaryWindow } from '../../../electron/src/contracts';
import { activeRun, useSurvey } from '../survey';
import { localDate, span } from '../lib/time';
import { isUnreviewed, warningFlags } from '../lib/windows';
import { cn } from '../lib/utils';
import { PageBody, PageHeader } from '../components/layout/PageHeader';
import { Messages } from '../components/layout/Messages';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Label, Select } from '../components/ui/input';
import { Progress } from '../components/ui/progress';
import { SummaryImage } from '../components/SummaryImage';
import { WindowDialog } from '../components/WindowDialog';
import { decisionText } from '../components/ReviewPanel';

const PAGE = 24;
const filters: { key: string; label: string; test: (window: SummaryWindow) => boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'unreviewed', label: 'Not reviewed', test: isUnreviewed },
  { key: 'activity', label: 'With observations', test: window => (window.review?.observation_count ?? 0) > 0 },
  { key: 'quiet', label: 'No activity', test: window => window.review?.effective_decision === 'reviewed_no_discernible_event' },
  { key: 'flagged', label: 'Flagged', test: window => warningFlags(window).length > 0 },
  { key: 'problem', label: 'Failed or incomplete', test: window => window.status === 'failed' || window.status === 'incomplete' },
  { key: 'recheck', label: 'Needs re-check', test: window => window.review?.needs_reverification === true || window.qa?.needs_reverification === true },
  { key: 'qa', label: 'QA pending', test: window => window.qa?.status !== 'agree' },
];

export function ReviewPage() {
  const survey = useSurvey();
  const { run } = survey;
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const windows = run?.windows ?? [];
  const names = useMemo(() => new Map((survey.media?.segments ?? []).map(segment => [segment.id, segment.metadata.filename])), [survey.media]);
  const active = filters.find(item => item.key === filter) ?? filters[0];
  const matching = windows.filter(active.test);
  const pages = Math.max(1, Math.ceil(matching.length / PAGE));
  const current = Math.min(page, pages - 1);
  const shown = matching.slice(current * PAGE, current * PAGE + PAGE);
  const progress = run?.review_progress;
  const qa = run?.qa_progress;

  return <>
    <PageHeader title="Review" subtitle="Open each window, watch the original video and record what you saw. Every window needs a decision, including quiet ones." />
    <PageBody>
      <Messages error={survey.error} notice={survey.notice} />
      {!run && <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No motion summaries yet. <Link to={`/surveys/${survey.session.id}/process`} className="font-medium text-primary hover:underline">Generate them on the Process page.</Link></CardContent></Card>}
      {run && <>
        <Card><CardContent className="space-y-3 pt-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-[16rem] flex-1 space-y-1.5">
              <div className="flex justify-between text-sm"><span className="font-medium">Reviewed</span><span role="status">{progress ? `${progress.reviewed} of ${progress.total} windows` : 'Loading...'}</span></div>
              <Progress value={progress ? 100 * progress.reviewed / Math.max(1, progress.total) : 0} label="Review progress" />
              {qa && <p className="text-xs text-muted-foreground">Second review: {qa.agree} agreed, {qa.disagree} disagreed, {qa.needs_clarification} need clarification, {qa.pending} pending.</p>}
            </div>
            {survey.runs.length > 1 && <div className="space-y-1"><Label htmlFor="review-run" className="text-xs">Processing run</Label>
              <Select id="review-run" className="w-72" value={survey.runID} disabled={survey.dirty} onChange={event => { survey.selectRun(event.target.value); setPage(0); }}>
                {survey.runs.map(item => <option key={item.id} value={item.id}>{localDate(item.started_at_utc)} · {item.state} · {item.counts.planned} windows</option>)}
              </Select></div>}
            <Button disabled={!windows.some(isUnreviewed)} onClick={() => setOpen(windows.find(isUnreviewed)?.id ?? null)}><Eye />Start reviewing</Button>
          </div>
          {activeRun(run) && <p className="text-xs text-muted-foreground">Processing is still running. Windows can be opened, and review unlocks when it finishes.</p>}
          <div role="toolbar" aria-label="Window filter" className="flex flex-wrap gap-1.5">
            {filters.map(item => {
              const count = windows.filter(item.test).length;
              return <button key={item.key} type="button" aria-pressed={filter === item.key} onClick={() => { setFilter(item.key); setPage(0); }}
                className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors', filter === item.key ? 'border-primary bg-primary text-primary-foreground' : 'bg-white text-muted-foreground hover:bg-accent')}>
                {item.label} <span className="opacity-70">{count}</span>
              </button>;
            })}
          </div>
        </CardContent></Card>
        {matching.length === 0 ? <p className="text-sm text-muted-foreground">No windows match this filter.</p>
          : <ul aria-label={filter === 'all' ? 'All planned windows' : 'Filtered planned windows'} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {shown.map(window => <li key={window.id}><WindowCard window={window} name={names.get(window.segment_id) ?? 'video'} verified={survey.verified} onOpen={() => setOpen(window.id)} /></li>)}
          </ul>}
        {pages > 1 && <nav aria-label="Gallery pages" className="flex items-center justify-center gap-2 text-sm">
          <Button variant="outline" size="sm" disabled={current === 0} onClick={() => setPage(current - 1)}><ChevronLeft />Previous page</Button>
          <span>Page {current + 1} of {pages}</span>
          <Button variant="outline" size="sm" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next page<ChevronRight /></Button>
        </nav>}
      </>}
    </PageBody>
    {open && run && <WindowDialog windows={run.windows} initialID={open} onClose={() => setOpen(null)} />}
  </>;
}

function WindowCard({ window, name, verified, onOpen }: { window: SummaryWindow; name: string; verified: boolean; onOpen: () => void }) {
  const decision = window.review?.effective_decision ?? 'unreviewed';
  const flags = warningFlags(window);
  const label = `Window ${span(window.interval.elapsed_start, window.interval.elapsed_end)} of ${name}`;
  return <article aria-label={label}>
    <button type="button" onClick={onOpen} className="w-full space-y-2 rounded-lg border bg-white p-2 text-left shadow-sm transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <SummaryImage window={window} enabled={verified} alt={`Motion summary, ${label}`} />
      <div className="flex items-start justify-between gap-2 px-1">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{span(window.interval.elapsed_start, window.interval.elapsed_end)}</p>
          <p className="truncate text-xs text-muted-foreground" title={name}>{name}</p>
        </div>
        {decision !== 'unreviewed' && <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" aria-hidden />}
      </div>
      <div className="flex flex-wrap gap-1 px-1 pb-1">
        <Badge variant={decision === 'unreviewed' ? 'outline' : decision === 'reviewed_with_observations' ? 'info' : 'success'}>{decisionText[decision]}{(window.review?.observation_count ?? 0) > 0 ? ` (${window.review?.observation_count})` : ''}</Badge>
        {window.status !== 'complete' && <Badge variant="danger">{window.status}</Badge>}
        {window.review?.needs_reverification && <Badge variant="warning">Re-check</Badge>}
        {flags.length > 0 && <Badge variant="warning" title={flags.join(', ')}><AlertTriangle className="h-3 w-3" />{flags.length} flag{flags.length === 1 ? '' : 's'}</Badge>}
        {window.qa && window.qa.status !== 'pending' && <Badge variant="outline">QA {window.qa.status.replaceAll('_', ' ')}</Badge>}
      </div>
    </button>
  </article>;
}
