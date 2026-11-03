import { AlertCircle, CheckCircle2 } from 'lucide-react';

/** One alert and one status line, shared by every page. */
export function Messages({ error, notice }: { error?: string; notice?: string }) {
  return <>
    {error && <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
    {notice && <p role="status" className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{notice}</p>}
  </>;
}
