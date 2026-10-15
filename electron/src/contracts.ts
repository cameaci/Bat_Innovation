export interface Health {
  status: 'ok';
  storage: 'ready';
  media_tools: 'ready';
}

export interface RecordingSession {
  id: string;
  display_name: string;
  camera_ref: string;
  created_at_utc: string;
}

export interface NewSession {
  display_name: string;
  camera_ref: string;
}

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: 'unavailable' | 'unauthorized' | 'invalid' | 'backend'; message: string } };

export interface BatAPI {
  health(): Promise<ApiResult<Health>>;
  listSessions(): Promise<ApiResult<RecordingSession[]>>;
  createSession(input: NewSession): Promise<ApiResult<RecordingSession>>;
}
