import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Circle, Clock, Loader2, Square } from 'lucide-react';
import type { Phase, PhaseState } from '../../lib/processing';
import { processingPhases } from '../../lib/processing';
import { cn } from '../../lib/utils';
import { useSurvey } from '../../survey';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { Progress } from '../ui/progress';

const icon: Record<PhaseState, { Icon: typeof Circle; className: string; label: string }> = {
  not_started: { Icon: Circle, className: 'text-muted-foreground', label: 'Not started' },
  waiting: { Icon: Clock, className: 'text-muted-foreground', label: 'Waiting' },
  running: { Icon: Loader2, className: 'animate-spin text-primary', label: 'Running' },
  done: { Icon: CheckCircle2, className: 'text-emerald-600', label: 'Done' },
  attention: { Icon: AlertTriangle, className: 'text-amber-600', label: 'Needs attention' },
};

/** The survey pipeline phase by phase, after Camera_Trap's job progress modal. Unlike there it can be hidden:
 * processing runs in the backend, and the sidebar's Processing entry brings this window back. */
export function ProcessingDialog() {
  const survey = useSurvey();
  const phases = processingPhases({ segments: survey.media?.segments.length ?? 0, importJob: survey.importJob, run: survey.run, playback: survey.playback, tracking: survey.tracking });
  const base = `/surveys/${survey.session.id}`;
  const hide = () => survey.showProgress(false);
  const action = (phase: Phase) => {
    if (phase.state === 'running') {
      const cancel = phase.key === 'import' ? survey.cancelImport : phase.key === 'summaries' ? survey.cancelRun : phase.key === 'tracking' ? survey.cancelTracking : null;
      return cancel && <Button size="sm" variant="outline" disabled={phase.key === 'summaries' && survey.cancelling} onClick={() => void cancel()}>
        <Square />{phase.key === 'summaries' && survey.cancelling ? 'Cancelling...' : 'Cancel'}</Button>;
    }
    if (phase.state !== 'done') return null;
    const to = phase.key === 'summaries' ? `${base}/review` : phase.key === 'copies' || phase.key === 'tracking' ? `${base}/watch` : null;
    return to && <Link to={to} onClick={hide} className="text-sm font-medium text-primary hover:underline">{phase.key === 'summaries' ? 'Review windows' : 'Open Watch'}</Link>;
  };
  return <Dialog open={survey.progressOpen} onClose={hide} title="Processing" className="w-[34rem]"
    description="Each step runs in the background on this computer. The original videos are never changed.">
    <ol aria-label="Processing steps" className="space-y-3 px-6 py-4">
      {phases.map(phase => {
        const { Icon, className, label } = icon[phase.state];
        return <li key={phase.key} aria-label={`${phase.label}: ${label}`} className={cn('space-y-2 rounded-lg border p-3', phase.state === 'running' && 'border-primary/40 bg-primary/5')}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', className)} aria-hidden />
              <div><p className="text-sm font-semibold">{phase.label}</p><p className="text-xs text-muted-foreground">{phase.detail}</p></div>
            </div>
            {action(phase)}
          </div>
          {phase.percent !== null && <Progress value={phase.percent} label={`${phase.label} progress`} />}
        </li>;
      })}
    </ol>
    <div className="flex items-center justify-between gap-3 border-t px-6 py-3">
      <p className="text-xs text-muted-foreground">Hiding this window does not stop processing. Reopen it from Processing in the sidebar.</p>
      <Button size="sm" onClick={hide}>Hide</Button>
    </div>
  </Dialog>;
}
