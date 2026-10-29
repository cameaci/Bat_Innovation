import type { BatAPI } from '../../electron/src/contracts';

declare global {
  interface Window {
    batAPI?: BatAPI;
  }
}

export function getAPI(): BatAPI | undefined {
  return window.batAPI;
}

const BUSY_RETRIES = 20, BUSY_WAIT_MS = 250;

/**
 * Repeat a call while the backend reports `code` (a short-lived lock, such as a preview encode holding the
 * media lock), for at most about five seconds. Any other result, or the last busy one, is returned unchanged.
 */
export async function whileBusy<T extends { ok: boolean; error?: { code: string } }>(code: string, call: () => Promise<T>, stale = () => false): Promise<T> {
  let result = await call();
  for (let attempt = 0; !result.ok && result.error?.code === code && attempt < BUSY_RETRIES && !stale(); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, BUSY_WAIT_MS));
    if (stale()) break;
    result = await call();
  }
  return result;
}
