/** The local reviewer name is an audit attribution kept on this computer for convenience, not an identity check. */
const REVIEWER_KEY = 'bat:reviewer';

export function savedReviewer(): string {
  try { return localStorage.getItem(REVIEWER_KEY) ?? ''; } catch { return ''; }
}

export function saveReviewer(value: string): void {
  try { localStorage.setItem(REVIEWER_KEY, value.trim()); } catch { /* convenience only */ }
}
