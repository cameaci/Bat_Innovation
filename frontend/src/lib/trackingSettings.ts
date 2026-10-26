import type { TrackingRun, TrackingSettings } from '../../../electron/src/contracts';

/** Starting values for tracks-v2; shown to the user and versioned with each run, never presented as validated. */
export const DEFAULT_TRACKING_SETTINGS: TrackingSettings = {
  target_px: 12, polarity: 'both', sensitivity: 12, activity: 'normal', detection_area: [], exclusions: [],
  max_gap_s: 0.4, min_track_s: 0.2, join_gap_s: 1.0, min_displacement_targets: 2,
};

/** The settings a tracks-v2 run used, or the defaults for earlier runs and when there is no run. */
export function settingsOf(run: TrackingRun | null | undefined): TrackingSettings {
  const settings = run?.parameters?.settings;
  return settings && typeof settings === 'object' ? { ...DEFAULT_TRACKING_SETTINGS, ...(settings as Partial<TrackingSettings>) } : DEFAULT_TRACKING_SETTINGS;
}
