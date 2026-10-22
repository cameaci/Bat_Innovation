import type { ReactNode } from 'react';

/** Page title band, as on every Camera_Trap page. */
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return <header className="border-b bg-white/80 backdrop-blur-sm">
    <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-8 py-4">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  </header>;
}

export function PageBody({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-7xl space-y-6 px-8 py-6">{children}</div>;
}
