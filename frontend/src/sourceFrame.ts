import type { Rational, ReviewBinding, SummaryWindow } from '../../electron/src/contracts';

// UI-only evidence from the existing displayed-frame ledger, never a browser timer.
export interface DisplayedSourceFrame {
  previewID: string;
  segmentID: string;
  sourceSHA256: string;
  timeBase: Rational;
  sourcePTS: string;
}
export interface WindowSourceFrame extends DisplayedSourceFrame { windowID: string }

function parts(value: Rational): [bigint, bigint] {
  const numerator = BigInt(value.num), denominator = BigInt(value.den);
  if (denominator <= 0n) throw new Error('Invalid rational denominator');
  return [numerator, denominator];
}

function equal(left: Rational, right: Rational): boolean {
  const [a, b] = parts(left), [c, d] = parts(right);
  return a * d === c * b;
}

function compare(pts: bigint, value: Rational): bigint {
  const [numerator, denominator] = parts(value);
  return pts * denominator - numerator;
}

export function displayedPTSFor(
  frame: WindowSourceFrame | null | undefined,
  selected: SummaryWindow,
  binding: ReviewBinding | null | undefined,
  previewID: string | null,
  endpoint: 'start' | 'end',
): string | null {
  if (!frame || !binding || !previewID || frame.previewID !== previewID
      || frame.windowID !== selected.id || binding.window_id !== selected.id || binding.run_id !== selected.run_id
      || frame.segmentID !== selected.segment_id || binding.segment_id !== selected.segment_id
      || frame.sourceSHA256 !== selected.source_sha256 || binding.source_sha256 !== selected.source_sha256
      || (selected.source_state !== undefined && selected.source_state !== 'ready')) return null;
  try {
    if (!/^-?(0|[1-9][0-9]{0,18})$/.test(frame.sourcePTS)) return null;
    const pts = BigInt(frame.sourcePTS);
    if (pts < -(2n ** 63n) || pts >= 2n ** 63n
        || !equal(frame.timeBase, selected.time_base) || !equal(frame.timeBase, binding.time_base)
        || !equal(binding.interval.start_pts, selected.interval.start_pts)
        || (binding.interval.end_pts === null) !== (selected.interval.end_pts === null)
        || (binding.interval.end_pts && selected.interval.end_pts && !equal(binding.interval.end_pts, selected.interval.end_pts))) return null;
    const first = BigInt(binding.source_first_pts), last = BigInt(binding.source_last_pts);
    const sourceEnd = binding.source_end_pts ?? { num: binding.source_last_pts, den: '1' };
    const windowEnd = selected.interval.end_pts ?? sourceEnd;
    const sourceBound = compare(pts, sourceEnd);
    if (pts < first || pts > last || (endpoint === 'start' ? sourceBound >= 0n : sourceBound > 0n)) return null;
    const afterStart = compare(pts, selected.interval.start_pts), beforeEnd = compare(pts, windowEnd);
    // End is an exclusive boundary at this decoded PTS, not an inferred frame duration.
    return (endpoint === 'start' ? afterStart >= 0n && beforeEnd < 0n : afterStart > 0n && beforeEnd <= 0n)
      ? frame.sourcePTS : null;
  } catch { return null; }
}
