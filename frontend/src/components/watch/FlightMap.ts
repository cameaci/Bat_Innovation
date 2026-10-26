import type { FlightMap } from '../../../../electron/src/contracts';
import type { View } from './BatsLayer';
import type { TrackData } from './tracks';

/** Cumulative grids: prefix[b] holds every point of bins before b. Built once per loaded map. */
export interface FlightIndex { map: FlightMap; prefix: Float32Array[]; total: Float32Array; ticksPerBin: number; first: number }

export function indexFlightMap(map: FlightMap, ticksPerSecond: number): FlightIndex {
  const size = map.columns * map.rows;
  const last = map.bins.length ? map.bins[map.bins.length - 1]!.index : -1;
  const prefix: Float32Array[] = [new Float32Array(size)];
  const byIndex = new Map(map.bins.map(bin => [bin.index, bin.cells]));
  for (let index = 0; index <= last; index += 1) {
    const next = Float32Array.from(prefix[index]!);
    for (const [cell, count] of byIndex.get(index) ?? []) next[cell]! += count;
    prefix.push(next);
  }
  return { map, prefix, total: prefix[prefix.length - 1]!, ticksPerBin: map.bin_seconds * ticksPerSecond, first: Number(map.first_pts) };
}

/** Grid of track points up to `now`: whole earlier bins plus the live points of the current bin. */
export function gridAt(index: FlightIndex, tracks: TrackData[], now: number): Float32Array {
  const bin = Math.max(0, Math.floor((now - index.first) / index.ticksPerBin));
  if (bin >= index.prefix.length - 1) return index.total.slice();  // every stored point is before this bin
  const grid = Float32Array.from(index.prefix[bin]!);
  const start = index.first + bin * index.ticksPerBin;
  const { columns, rows, width, height } = index.map;
  for (const track of tracks) {
    if (track.quality === 'noise' || track.last < start || track.first > now) continue;
    for (let i = 0; i < track.pts.length; i += 1) {
      const pts = track.pts[i]!;
      if (pts < start || pts > now) continue;
      const x = Math.min(columns - 1, Math.max(0, Math.floor(track.x[i]! / width * columns)));
      const y = Math.min(rows - 1, Math.max(0, Math.floor(track.y[i]! / height * rows)));
      grid[y * columns + x]! += 1;
    }
  }
  return grid;
}

/** Green (few) to yellow to red (many), log-scaled; empty cells stay clear. */
function colour(value: number, max: number): [number, number, number, number] {
  if (value <= 0) return [0, 0, 0, 0];
  const t = Math.log1p(value) / Math.log1p(Math.max(1, max));
  const red = t < 0.5 ? Math.round(510 * t) : 255;
  const green = t < 0.5 ? 220 : Math.round(220 * (1 - (t - 0.5) * 2));
  return [red, green, 40, Math.round(110 + 120 * t)];
}

const scratch = typeof document === 'undefined' ? null : document.createElement('canvas');

export function drawFlightMap(context: CanvasRenderingContext2D, view: View, index: FlightIndex, grid: Float32Array) {
  const { columns, rows, width, height } = index.map;
  if (!scratch) return;
  scratch.width = columns;
  scratch.height = rows;
  const small = scratch.getContext('2d');
  if (!small) return;
  const image = small.createImageData(columns, rows);
  let max = 0;
  for (const value of grid) max = Math.max(max, value);
  grid.forEach((value, cell) => image.data.set(colour(value, max), cell * 4));
  small.putImageData(image, 0, 0);
  context.save();
  context.imageSmoothingEnabled = true;
  context.filter = `blur(${Math.max(2, 4 * view.dpr)}px)`;
  context.drawImage(scratch, view.dx, view.dy, width * view.scale, height * view.scale);
  context.restore();
  // Legend.
  const x = view.dx + 10 * view.dpr, y = view.dy + height * view.scale - 30 * view.dpr;
  const gradient = context.createLinearGradient(x, 0, x + 120 * view.dpr, 0);
  gradient.addColorStop(0, 'rgb(0, 220, 40)');
  gradient.addColorStop(0.5, 'rgb(255, 220, 40)');
  gradient.addColorStop(1, 'rgb(255, 0, 40)');
  context.fillStyle = 'rgba(2, 6, 23, 0.7)';
  context.fillRect(x - 6 * view.dpr, y - 16 * view.dpr, 250 * view.dpr, 28 * view.dpr);
  context.fillStyle = gradient;
  context.fillRect(x, y, 120 * view.dpr, 6 * view.dpr);
  context.fillStyle = '#e2e8f0';
  context.font = `${11 * view.dpr}px ui-sans-serif, system-ui`;
  context.fillText(`Track points, not individuals (max ${max})`, x, y - 4 * view.dpr);
}
