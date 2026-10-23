import type { Rational } from '../../../electron/src/contracts';

/** Display only: exact rational seconds stay authoritative and are shown in technical details. */
export function seconds(value: Rational | null | undefined): number | null {
  if (!value) return null;
  const result = Number(value.num) / Number(value.den);
  return Number.isFinite(result) ? result : null;
}

/** "1:05.3" or "1:02:05.3"; tenths only when the value is not a whole second. */
export function clock(value: Rational | number | null | undefined): string {
  const total = typeof value === 'number' ? value : seconds(value);
  if (total === null) return 'unknown';
  const sign = total < 0 ? '-' : '';
  const absolute = Math.abs(total);
  const tenths = Math.round(absolute * 10);
  const whole = Math.floor(tenths / 10);
  const hours = Math.floor(whole / 3600), minutes = Math.floor((whole % 3600) / 60), secs = whole % 60;
  const fraction = tenths % 10 ? `.${tenths % 10}` : '';
  const mm = hours ? String(minutes).padStart(2, '0') : String(minutes);
  return `${sign}${hours ? `${hours}:` : ''}${mm}:${String(secs).padStart(2, '0')}${fraction}`;
}

export function span(start: Rational | null | undefined, end: Rational | null | undefined): string {
  return `${clock(start)} - ${end ? clock(end) : 'end unknown'}`;
}

export const rational = (value: Rational | null | undefined) => value ? `${value.num}/${value.den}` : 'unknown';

/** Source PTS a whole number of milliseconds after `pts` in `timeBase` (floor; integer arithmetic). */
export function ptsAfter(pts: string, milliseconds: number, timeBase: Rational): string {
  const ticks = (BigInt(Math.trunc(milliseconds)) * BigInt(timeBase.den)) / (1000n * BigInt(timeBase.num));
  return (BigInt(pts) + ticks).toString();
}

/** Seconds between two PTS values of one source, for display. */
export function ptsSeconds(pts: string, origin: string, timeBase: Rational): number {
  return Number(BigInt(pts) - BigInt(origin)) * Number(timeBase.num) / Number(timeBase.den);
}

export function localDate(utc: string): string {
  const date = new Date(utc);
  return Number.isNaN(date.getTime()) ? utc : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
