import type React from 'react';
import { NavLink } from 'react-router-dom';
import { ArrowLeft, Download, ListChecks, MoonStar, PanelLeftClose, PanelLeftOpen, Sparkles, Sigma, Clapperboard } from 'lucide-react';
import { cn } from '../../lib/utils';

// Layout and classes follow Camera_Trap's Sidebar (see ../ui/NOTICE): a 256 px column that collapses to a 72 px rail.
const rowClass = (active: boolean, collapsed: boolean) => cn(
  'flex h-9 w-full items-center gap-3 rounded-lg text-sm font-medium transition-colors',
  collapsed ? 'justify-center px-0' : 'px-3',
  active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
);

export function Sidebar({ surveyID, surveyName, collapsed, locked, onToggle }: { surveyID: string; surveyName: string; collapsed: boolean; locked: boolean; onToggle: () => void }) {
  // Leaving a page would drop its unsaved draft, so navigation waits until it is saved or discarded.
  const guard = (event: React.MouseEvent) => { if (locked) event.preventDefault(); };
  const lockedTitle = locked ? 'Save or discard your changes first' : undefined;
  const items = [
    { to: `/surveys/${surveyID}/process`, icon: Sparkles, label: 'Process' },
    { to: `/surveys/${surveyID}/review`, icon: ListChecks, label: 'Review' },
    { to: `/surveys/${surveyID}/events`, icon: Clapperboard, label: 'Events' },
    { to: `/surveys/${surveyID}/counts`, icon: Sigma, label: 'Counts' },
    { to: `/surveys/${surveyID}/export`, icon: Download, label: 'Export' },
  ];
  return <aside aria-label="Survey navigation" className={cn('fixed left-0 top-0 flex h-screen flex-col border-r bg-white transition-[width] duration-200', collapsed ? 'w-[72px]' : 'w-64')}>
    <div className={cn('flex h-[73px] items-center gap-2 border-b', collapsed ? 'justify-center' : 'px-5')}>
      <MoonStar className="h-6 w-6 text-primary" aria-hidden />
      {!collapsed && <span className="text-lg font-bold tracking-tight">Bat Innovation</span>}
    </div>
    <div className={cn('flex h-[72px] shrink-0 flex-col justify-center border-b', collapsed ? 'items-center px-0' : 'px-4')}>
      {collapsed
        ? <NavLink to="/" aria-label="Back to surveys" title={lockedTitle ?? 'Back to surveys'} aria-disabled={locked || undefined} onClick={guard} className={rowClass(false, true)}><ArrowLeft className="h-4 w-4" /></NavLink>
        : <div className="border-l-[3px] border-primary pl-3">
          <p className="truncate text-base font-bold leading-tight text-primary" title={surveyName}>{surveyName}</p>
          <NavLink to="/" title={lockedTitle} aria-disabled={locked || undefined} onClick={guard} className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground aria-disabled:opacity-50"><ArrowLeft className="h-3 w-3" />Back to surveys</NavLink>
        </div>}
    </div>
    <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-4">
      {items.map(item => <NavLink key={item.to} to={item.to} title={lockedTitle ?? (collapsed ? item.label : undefined)} aria-disabled={locked || undefined} onClick={guard} className={({ isActive }) => cn(rowClass(isActive, collapsed), locked && !isActive && 'opacity-50')}>
        <item.icon className="h-4 w-4 shrink-0" aria-hidden />{collapsed ? <span className="sr-only">{item.label}</span> : item.label}
      </NavLink>)}
    </nav>
    <div className="shrink-0 border-t p-4">
      <button type="button" onClick={onToggle} className={rowClass(false, collapsed)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
        {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <><PanelLeftClose className="h-4 w-4" />Collapse</>}
      </button>
    </div>
  </aside>;
}
