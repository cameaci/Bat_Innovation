import { useEffect, useState } from 'react';
import type React from 'react';
import { Outlet, useLocation, useParams } from 'react-router-dom';
import { DatabaseZap } from 'lucide-react';
import type { RecordingSession } from '../../../../electron/src/contracts';
import { getAPI } from '../../api';
import { cn } from '../../lib/utils';
import { CURRENT_SCHEMA, SurveyProvider, useSurvey } from '../../survey';
import { Button } from '../ui/button';
import { Sidebar } from './Sidebar';
import { Messages } from './Messages';

const COLLAPSE_KEY = 'bat:sidebar-collapsed';
function stored(): boolean { try { return localStorage.getItem(COLLAPSE_KEY) === 'true'; } catch { return false; } }

export function AppLayout() {
  const { surveyID = '' } = useParams();
  const [session, setSession] = useState<RecordingSession | null>(null);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(stored);

  useEffect(() => {
    let current = true;
    setSession(null); setError('');
    void (async () => {
      try {
        const result = await getAPI()?.listSessions();
        if (!current) return;
        if (!result?.ok) { setError(result?.error.message ?? 'The local backend is unavailable.'); return; }
        const found = result.value.find(item => item.id === surveyID);
        if (found) setSession(found); else setError('This survey does not exist. Go back to the survey list.');
      } catch { if (current) setError('The local backend is unavailable.'); }
    })();
    return () => { current = false; };
  }, [surveyID]);

  function toggle() {
    setCollapsed(previous => { try { localStorage.setItem(COLLAPSE_KEY, String(!previous)); } catch { /* preference only */ } return !previous; });
  }

  const sidebar = (locked: boolean) => <Sidebar surveyID={surveyID} surveyName={session?.display_name ?? 'Loading...'} collapsed={collapsed} locked={locked} onToggle={toggle} />;
  return <div className="flex min-h-screen">
    {!session && sidebar(false)}
    <main className={cn('min-w-0 flex-1 bg-gradient-to-br from-slate-50 to-slate-100 transition-[margin] duration-200', collapsed ? 'ml-[72px]' : 'ml-64')}>
      {error && <div className="p-8"><Messages error={error} /></div>}
      {session && <SurveyProvider key={session.id} session={session}><SurveySidebar render={sidebar} /><NoticeReset /><StorageGate /><Outlet /></SurveyProvider>}
    </main>
  </div>;
}

function SurveySidebar({ render }: { render: (locked: boolean) => React.ReactNode }) {
  return <>{render(useSurvey().dirty)}</>;
}

/** A notice reports the last action on its own page; it does not follow the reviewer to another page. */
function NoticeReset() {
  const { pathname } = useLocation();
  const { clearNotice } = useSurvey();
  useEffect(() => clearNotice(), [pathname, clearNotice]);
  return null;
}

/** Databases created by older versions need one explicit upgrade before every page works. */
function StorageGate() {
  const survey = useSurvey();
  const [working, setWorking] = useState(false);
  if (!survey.media || survey.media.schema_version >= CURRENT_SCHEMA) return null;
  return <div className="mx-auto max-w-7xl px-8 pt-6">
    <div role="region" aria-label="Storage upgrade" className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
      <div className="flex items-start gap-3">
        <DatabaseZap className="mt-0.5 h-5 w-5 text-amber-700" aria-hidden />
        <div>
          <p className="font-medium text-amber-900">This survey database was created by an older version</p>
          <p className="text-sm text-amber-800">Upgrade it once to use import, summaries, review and export. Existing surveys, videos and reviews are kept.</p>
        </div>
      </div>
      <Button disabled={working || survey.busy || survey.dirty} onClick={async () => { setWorking(true); await survey.upgradeStorage(); setWorking(false); }}>
        {working ? 'Upgrading...' : 'Upgrade storage'}
      </Button>
    </div>
  </div>;
}
