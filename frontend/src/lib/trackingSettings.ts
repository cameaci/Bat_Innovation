import type { TrackingRun, TrackingSettings } from '../../../electron/src/contracts';

/** Starting values for tracks-v3; shown to the user and versioned with each run, never presented as validated. */
export const DEFAULT_TRACKING_SETTINGS: TrackingSettings = {
  target_px: 12, polarity: 'both', threshold: 7, target_speed: 4, activity: 'normal', detection_area: [], exclusions: [],
  max_gap_s: 0.4, min_track_s: 0.2, join_gap_s: 1.0, min_displacement_targets: 2,
};

/**
 * The settings a run used, as far as they still apply: a tracks-v2 run's grey-level sensitivity has no meaning for
 * tracks-v3, so only settings the current version knows are carried over and the rest start from the defaults.
 */
export function settingsOf(run: TrackingRun | null | undefined): TrackingSettings {
  const settings = run?.parameters?.settings;
  if (!settings || typeof settings !== 'object') return DEFAULT_TRACKING_SETTINGS;
  const known = Object.fromEntries(Object.entries(settings as Record<string, unknown>).filter(([key]) => key in DEFAULT_TRACKING_SETTINGS));
  return { ...DEFAULT_TRACKING_SETTINGS, ...(known as Partial<TrackingSettings>) };
}
