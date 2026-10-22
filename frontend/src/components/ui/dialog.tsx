import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * Modal on the native <dialog> element: the platform supplies focus trapping, Escape and the
 * accessible dialog role. `onClose` decides whether closing is allowed (for example, unsaved drafts).
 */
export function Dialog({ open, onClose, title, description, children, className, hideTitle = false }: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  hideTitle?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} aria-label={title}
    onCancel={event => { event.preventDefault(); onClose(); }}
    className={cn('max-h-[95vh] max-w-[95vw] rounded-lg border bg-background p-0 text-foreground shadow-lg', className)}>
    {open && <div className="relative flex h-full flex-col">
      {!hideTitle && <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold leading-none tracking-tight">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"><X className="h-4 w-4" /></button>
      </div>}
      {children}
    </div>}
  </dialog>;
}
