import type { ApiResult } from '../../electron/src/contracts';

type Bytes = ApiResult<{ bytes: Uint8Array }>;
type Read = () => Promise<Bytes> | undefined;
type Task = {
  read: Read;
  priority: number;
  signal?: AbortSignal;
  resolve: (result: Bytes) => void;
  abort: () => void;
};

// PNG and WebM share the main process's one binary-transfer reservation.
// The gallery mounts at most 12 cards; this also leaves room for inspection/video.
export const MAX_QUEUED_BINARY_READS = 16;
const queued: Task[] = [];
let reading = false;
const cancelled = (): Bytes => ({ ok: false, error: { code: 'cancelled', message: 'This media view was closed or replaced.' } });
const unavailable = (): Bytes => ({ ok: false, error: { code: 'unavailable', message: 'The local backend is unavailable. Retry after checking the backend.' } });

function drain(): void {
  if (reading) return;
  const task = queued.shift();
  if (!task) return;
  task.signal?.removeEventListener('abort', task.abort);
  reading = true;
  void Promise.resolve().then(() => task.signal?.aborted ? cancelled() : task.read()).then(
    result => task.resolve(task.signal?.aborted ? cancelled() : result ?? unavailable()),
    () => task.resolve(unavailable()),
  ).finally(() => { reading = false; drain(); });
}

/** Serialize renderer binary reads; cancelling a view never frees a live transfer early. */
export function readMediaBytes(read: Read, { signal, priority = 0 }: { signal?: AbortSignal; priority?: number } = {}): Promise<Bytes> {
  if (signal?.aborted) return Promise.resolve(cancelled());
  if (queued.length >= MAX_QUEUED_BINARY_READS) return Promise.resolve({
    ok: false, error: { code: 'media_busy', message: 'Media reads are busy. Wait for the current view or retry.' },
  });
  return new Promise(resolve => {
    const task: Task = { read, signal, priority, resolve, abort: () => {
      const position = queued.indexOf(task);
      if (position < 0) return;
      queued.splice(position, 1);
      signal?.removeEventListener('abort', task.abort);
      resolve(cancelled());
    } };
    queued.push(task);
    // Stable sorting preserves FIFO order within a priority.
    queued.sort((left, right) => right.priority - left.priority);
    signal?.addEventListener('abort', task.abort, { once: true });
    drain();
  });
}
