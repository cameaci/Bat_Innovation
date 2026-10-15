import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { ApiResult, Health, RecordingSession } from '../../electron/src/contracts';
import { getAPI } from './api';

type Failure = Extract<ApiResult<never>, { ok: false }>['error'];

const unavailable: Failure = {
  code: 'unavailable',
  message: 'The local backend is unavailable. Retry, or close and reopen the desktop app.',
};

function errorTitle(error: Failure): string {
  if (error.code === 'unauthorized') return 'Backend token rejected';
  if (error.code === 'unavailable') return 'Backend unavailable';
  if (error.code === 'invalid') return 'Invalid session input';
  return 'Backend request failed';
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [sessions, setSessions] = useState<RecordingSession[] | null>(null);
  const [busy, setBusy] = useState<'loading' | 'saving' | null>('loading');
  const [error, setError] = useState<Failure | null>(null);
  const [notice, setNotice] = useState('');
  const [displayName, setDisplayName] = useState('Synthetic survey');
  const [cameraRef, setCameraRef] = useState('Test camera');

  async function refresh() {
    setBusy('loading');
    setError(null);
    setNotice('');
    setHealth(null);
    setSessions(null);
    try {
      const api = getAPI();
      if (!api) {
        setError({ ...unavailable, message: 'The desktop bridge is unavailable. Launch this interface through Electron.' });
        return;
      }
      const readiness = await api.health();
      if (!readiness.ok) {
        setError(readiness.error);
        return;
      }
      setHealth(readiness.value);
      const listed = await api.listSessions();
      if (!listed.ok) {
        setError(listed.error);
        setHealth(null);
        return;
      }
      setSessions(listed.value);
    } catch {
      setHealth(null);
      setError(unavailable);
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function createSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const display_name = displayName.trim();
    const camera_ref = cameraRef.trim();
    setNotice('');
    if (!display_name || !camera_ref || display_name.length > 120 || camera_ref.length > 120) {
      setError({ code: 'invalid', message: 'Enter a display name and camera reference, each between 1 and 120 characters after trimming spaces.' });
      return;
    }
    setBusy('saving');
    setError(null);
    try {
      const api = getAPI();
      if (!api) {
        setError(unavailable);
        setHealth(null);
        return;
      }
      const created = await api.createSession({ display_name, camera_ref });
      if (!created.ok) {
        setError(created.error);
        if (created.error.code !== 'invalid') setHealth(null);
        return;
      }
      setSessions(current => [created.value, ...(current ?? [])]);
      setDisplayName(display_name);
      setCameraRef(camera_ref);
      setNotice('Session created and saved in SQLite.');
    } catch {
      setHealth(null);
      setError(unavailable);
    } finally {
      setBusy(null);
    }
  }

  return (
    <main>
      <header>
        <p className="eyebrow">Local development foundation</p>
        <h1>Bat Innovation</h1>
        <p>Create synthetic recording sessions and confirm local persistence. Video import and review are not implemented yet.</p>
      </header>

      <section aria-labelledby="backend-heading" className="status-panel">
        <div>
          <h2 id="backend-heading">Local backend</h2>
          <p role="status">{busy === 'loading' ? 'Checking backend readiness...' : health ? 'Backend ready' : 'Backend not ready'}</p>
          {health && <p className="detail">SQLite storage ready. FFmpeg and ffprobe available.</p>}
        </div>
        <button type="button" onClick={() => void refresh()} disabled={busy !== null}>
          {busy === 'loading' ? 'Checking...' : 'Refresh / retry'}
        </button>
      </section>

      {error && <div className="error" role="alert"><strong>{errorTitle(error)}</strong><p>{error.message}</p></div>}
      {notice && <p role="status" className="notice">{notice}</p>}

      <section aria-labelledby="create-heading">
        <h2 id="create-heading">Create a synthetic session</h2>
        <p className="detail">Use synthetic metadata only for this foundation check.</p>
        <form onSubmit={event => void createSession(event)}>
          <label htmlFor="display-name">Display name</label>
          <input id="display-name" name="display_name" value={displayName} onChange={event => setDisplayName(event.target.value)} required maxLength={120} disabled={busy !== null} />
          <label htmlFor="camera-ref">Camera reference</label>
          <input id="camera-ref" name="camera_ref" value={cameraRef} onChange={event => setCameraRef(event.target.value)} required maxLength={120} disabled={busy !== null} />
          <button type="submit" disabled={busy !== null || !health || sessions === null}>
            {busy === 'saving' ? 'Saving...' : 'Create session'}
          </button>
        </form>
      </section>

      <section aria-labelledby="sessions-heading" aria-busy={busy === 'loading'}>
        <h2 id="sessions-heading">Saved sessions{sessions && ` (${sessions.length})`}</h2>
        <p className="detail">Sessions are read from SQLite when this window opens or refreshes.</p>
        {sessions === null ? <p>Saved sessions have not been loaded.</p> : sessions.length === 0 ? <p>No sessions saved yet.</p> : (
          <div className="table-scroll">
            <table>
              <thead><tr><th scope="col">Display name</th><th scope="col">Camera reference</th><th scope="col">Created (UTC)</th></tr></thead>
              <tbody>{sessions.map(session => (
                <tr key={session.id}>
                  <td>{session.display_name}</td>
                  <td>{session.camera_ref}</td>
                  <td><time dateTime={session.created_at_utc}>{session.created_at_utc}</time></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
