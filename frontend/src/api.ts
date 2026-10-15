import type { BatAPI } from '../../electron/src/contracts';

declare global {
  interface Window {
    batAPI?: BatAPI;
  }
}

export function getAPI(): BatAPI | undefined {
  return window.batAPI;
}
