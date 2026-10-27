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

export const SUNSET_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)([+-])(0\d|1[0-4]):([0-5]\d)$/;

/**
 * Minutes from the anchored video's first frame to the typed sunset (local time with its UTC offset, on the clock's
 * evening), or null for an unreadable clock or entry.
 */
export function sunsetMinute(anchorUTC: string, sunset: string): number | null {
  const origin = Date.parse(anchorUTC);
  const typed = SUNSET_PATTERN.exec(sunset);
  if (!Number.isFinite(origin) || !typed) return null;
  const offset = (typed[3] === '+' ? 1 : -1) * (Number(typed[4]) * 60 + Number(typed[5])) * 60_000;
  const local = new Date(origin + offset);
  const at = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), Number(typed[1]), Number(typed[2])) - offset;
  let difference = (at - origin) / 60_000;
  // The same evening as the clock: a clock started after midnight refers to the day before.
  if (difference > 720) difference -= 1440;
  if (difference < -720) difference += 1440;
  return Math.round(difference * 10) / 10;
}
