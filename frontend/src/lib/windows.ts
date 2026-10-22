import type { SummaryWindow } from '../../../electron/src/contracts';

/** Plain-language meaning of each quality flag the summary engine can set. */
export const flagText: Record<string, string> = {
  framewide_change: 'Large parts of the frame changed. Check for camera movement, lighting changes or compression noise.',
  brightness_transition: 'A large brightness change, for example IR switching on. Evidence was kept.',
  declared_timestamp_gap: 'The video has a timestamp gap here; the window may not contain continuous footage.',
  gap_examples_truncated: 'Only some timestamp gaps are listed; the total count is in technical details.',
  unknown_end_unassessable: 'The end time of the video is unknown, so motion in this last window cannot be assessed.',
  insufficient_comparison_frames: 'Too few frames to compare, so motion cannot be assessed.',
  rotation_not_applied: 'The video rotation was not applied.',
  rotation_unverified: 'The video rotation is unknown.',
  interlaced_not_deinterlaced: 'Interlaced video was not deinterlaced.',
  field_order_unverified: 'Interlacing field order is unknown.',
  derived_grayscale_evidence: 'Motion is computed in greyscale; weak changes can be lost or noise can show.',
  source_speed_unverified: 'The original recording speed is not verified.',
};

/** Flags present on (almost) every window are provenance notes, not warnings worth a badge. */
const routine = new Set(['derived_grayscale_evidence', 'source_speed_unverified', 'field_order_unverified']);
export const warningFlags = (window: SummaryWindow) => window.flags.filter(flag => !routine.has(flag));

export function motionText(window: SummaryWindow): string {
  if (window.status !== 'complete') return window.status === 'failed' ? 'Processing failed for this window.' : window.status === 'incomplete' ? 'Processing is incomplete for this window.' : 'Not processed yet.';
  if ((window.stats.comparison_count ?? 0) === 0) return 'No frames to compare; motion cannot be assessed.';
  return window.stats.motion_pixels === 0 ? 'No motion evidence above threshold.' : 'Motion evidence above threshold.';
}

export const isUnreviewed = (window: SummaryWindow) => !window.review || window.review.effective_decision === 'unreviewed';
