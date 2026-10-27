import type { FlowLayer } from '../../../electron/src/contracts';

export interface ProfileVideo { id: string; minutes: number }
export interface ProfileColumn { segmentID: string; minute: number; video: number; entered: number; exited: number; net: number }

/**
 * One column per minute of each video in survey order (empty minutes included), with the cumulative net (exits minus
 * entries) carried across videos. Bins of videos not in the list are left out.
 */
export function profileColumns(layer: FlowLayer, videos: ProfileVideo[]): ProfileColumn[] {
  const bins = new Map(layer.bins.map(bin => [`${bin.segment_id}:${bin.minute}`, bin]));
  const columns: ProfileColumn[] = [];
  let net = 0;
  videos.forEach((video, index) => {
    const last = Math.max(video.minutes, ...layer.bins.filter(bin => bin.segment_id === video.id).map(bin => bin.minute + 1));
    for (let minute = 0; minute < last; minute += 1) {
      const bin = bins.get(`${video.id}:${minute}`);
      net += (bin?.exited ?? 0) - (bin?.entered ?? 0);
      columns.push({ segmentID: video.id, minute, video: index + 1, entered: bin?.entered ?? 0, exited: bin?.exited ?? 0, net });
    }
  });
  return columns;
}

/** Minutes from the anchored video's first frame to the typed sunset (local clock), or null for an unreadable clock. */
export function sunsetMinute(anchorUTC: string, sunset: string): number | null {
  const clock = /T(\d\d):(\d\d):(\d\d(?:\.\d+)?)/.exec(anchorUTC);
  const typed = /^(\d\d):(\d\d)$/.exec(sunset);
  if (!clock || !typed) return null;
  let difference = Number(typed[1]) * 60 + Number(typed[2]) - (Number(clock[1]) * 60 + Number(clock[2]) + Number(clock[3]) / 60);
  // The same evening as the clock: a clock started after midnight refers to the day before.
  if (difference > 720) difference -= 1440;
  if (difference < -720) difference += 1440;
  return Math.round(difference * 10) / 10;
}
