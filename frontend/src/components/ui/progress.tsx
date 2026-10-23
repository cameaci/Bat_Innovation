import { cn } from '../../lib/utils';

/** Determinate progress bar; `label` names it for assistive technology. */
export function Progress({ value, label, className }: { value: number; label: string; className?: string }) {
  const bounded = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(bounded)}
    className={cn('relative h-2.5 w-full overflow-hidden rounded-full bg-secondary', className)}>
    <div className="h-full w-full bg-primary transition-transform duration-500 ease-out" style={{ transform: `translateX(-${100 - bounded}%)` }} />
  </div>;
}
