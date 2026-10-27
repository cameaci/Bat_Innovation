import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import type { PlaybackFrames } from '../../../../electron/src/contracts';
import { containView, type View } from './BatsLayer';
import { floorIndex } from './tracks';

export interface DisplayedFrame { index: number; pts: number; ms: number }

export interface PlayerHandle {
  togglePlay: () => void;
  pause: () => void;
  play: () => void;
  step: (direction: 1 | -1) => void;
  seekMs: (ms: number) => void;
  seekPTS: (pts: number) => void;
  setRate: (rate: number) => void;
  /** Redraw the overlays for the current frame (after data or option changes). */
  redraw: () => void;
}

export type Draw = (context: CanvasRenderingContext2D, view: View, frame: DisplayedFrame) => void;
/** One way of looking at the same frame: Bats, Flight map or Count. */
export interface PlayerView { key: string; label: string; draw: Draw }

/**
 * Continuous playback of one segment's playback copy. Every presented frame is mapped back to its exact source PTS
 * through the copy's frame map (requestVideoFrameCallback media time, within 0.5 ms); overlays draw only on a
 * matched frame, so nothing is drawn against an unknown time.
 */
export const Player = forwardRef<PlayerHandle, {
  frames: PlaybackFrames;
  sourceWidth: number;
  sourceHeight: number;
  /** The first view sits on the video element; in split layout the others repaint the same frame on their own canvas. */
  views: PlayerView[];
  layout: 'split' | 'single';
  active: string;
  onFrame: (frame: DisplayedFrame | null) => void;
  onPlaying: (playing: boolean) => void;
  onEnded: () => void;
  startPTS?: number | null;
  autoPlay?: boolean;
  /** When set, clicks on the video report the point in source pixels (drawing areas, placing the size reference). */
  onPick?: (point: [number, number]) => void;
}>(function Player({ frames, sourceWidth, sourceHeight, views, layout, active, onFrame, onPlaying, onEnded, startPTS, autoPlay, onPick }, ref) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const panes = useRef<(HTMLCanvasElement | null)[]>([]);
  const current = useRef<DisplayedFrame | null>(null);
  const shown = layout === 'split' ? views : views.filter(view => view.key === active).slice(0, 1);
  const viewsRef = useRef(shown);
  viewsRef.current = shown;
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const [failure, setFailure] = useState('');
  const pts = useRef<Float64Array>(new Float64Array());

  useEffect(() => {
    const values = new Float64Array(frames.source_pts.length);
    frames.source_pts.forEach((value, index) => { values[index] = Number(value); });
    if (!values.every(Number.isSafeInteger)) setFailure('Source timestamps exceed the safe display range.');
    pts.current = values;
  }, [frames]);

  function paint() {
    const player = video.current;
    if (!player) return;
    const dpr = window.devicePixelRatio || 1;
    viewsRef.current.forEach((view, index) => {
      const target = index === 0 ? canvas.current : panes.current[index];
      if (!target) return;
      const width = Math.round(target.clientWidth * dpr), height = Math.round(target.clientHeight * dpr);
      if (target.width !== width || target.height !== height) { target.width = width; target.height = height; }
      const context = target.getContext('2d');
      if (!context) return;
      context.clearRect(0, 0, width, height);
      const box = containView(width, height, sourceWidth, sourceHeight, dpr);
      // Other panes repaint the frame the video element is presenting, so all views show the same instant.
      if (index > 0 && current.current) context.drawImage(player, box.dx, box.dy, sourceWidth * box.scale, sourceHeight * box.scale);
      if (current.current) view.draw(context, box, current.current);
    });
  }

  function publish(frame: DisplayedFrame | null) {
    current.current = frame;
    onFrameRef.current(frame);
    paint();
  }

  function seekIndex(index: number) {
    const player = video.current;
    if (!player || frames.proxy_ms.length === 0) return;
    const clamped = Math.max(0, Math.min(frames.proxy_ms.length - 1, index));
    const start = frames.proxy_ms[clamped]!;
    const end = frames.proxy_ms[clamped + 1] ?? frames.duration_ms;
    // The middle of the frame's display interval avoids landing on the boundary with the previous frame.
    player.currentTime = (start + end) / 2000;
  }

  useImperativeHandle(ref, () => ({
    togglePlay: () => { const player = video.current; if (player) void (player.paused ? player.play().catch(() => undefined) : player.pause()); },
    pause: () => video.current?.pause(),
    play: () => { void video.current?.play().catch(() => undefined); },
    step: direction => { video.current?.pause(); seekIndex((current.current?.index ?? 0) + direction); },
    seekMs: ms => seekIndex(Math.max(0, floorIndex(frames.proxy_ms, ms))),
    seekPTS: value => seekIndex(Math.max(0, floorIndex(pts.current, value))),
    setRate: rate => { if (video.current) video.current.playbackRate = rate; },
    redraw: paint,
  }));

  useEffect(() => {
    const player = video.current;
    if (!player) return;
    if (typeof player.requestVideoFrameCallback !== 'function') {
      setFailure('This browser cannot identify displayed frames reliably. Overlays are unavailable.');
      return;
    }
    let active = true;
    let callback = 0;
    function frame(_now: number, metadata: VideoFrameCallbackMetadata) {
      if (!active || !player) return;
      const ms = metadata.mediaTime * 1000;
      const index = floorIndex(frames.proxy_ms, ms + 0.5001);
      if (index < 0 || Math.abs(frames.proxy_ms[index]! - ms) > 0.5001) {
        setFailure('A displayed frame could not be matched to its source time. Prepare the playback copy again.');
        publish(null);
        return;
      }
      const mapped = { index, pts: pts.current[index]!, ms: frames.proxy_ms[index]! };
      // A presented frame may precede the seeked event of the same seek; it is shown once the seek completes.
      if (player.seeking) { pending = mapped; publish(null); } else { pending = null; publish(mapped); }
      callback = player.requestVideoFrameCallback(frame);
    }
    let pending: DisplayedFrame | null = null;
    let held: DisplayedFrame | null = null;
    const seeking = () => { held = current.current ?? held; publish(null); };
    const contains = (frame: DisplayedFrame | null, position: number) =>
      !!frame && frame.ms <= position + 0.5001 && position < (frames.proxy_ms[frame.index + 1] ?? frames.duration_ms);
    const seeked = () => {
      const position = player.currentTime * 1000;
      // A seek within the frame on screen presents no new frame; the held one is still the frame shown.
      if (contains(pending, position)) publish(pending);
      else if (!pending && contains(held, position)) publish(held);
      pending = null;
      held = null;
    };
    const playing = () => onPlaying(true);
    const paused = () => onPlaying(false);
    const ended = () => {
      // At the end the element keeps showing the last frame, which a frame callback may not report.
      const last = frames.proxy_ms.length - 1;
      if (last >= 0 && current.current?.index !== last) publish({ index: last, pts: pts.current[last]!, ms: frames.proxy_ms[last]! });
      onPlaying(false);
      onEnded();
    };
    const loaded = () => {
      if (startPTS !== undefined && startPTS !== null) seekIndex(Math.max(0, floorIndex(pts.current, startPTS)));
      else seekIndex(0);
      if (autoPlay) void player.play().catch(() => undefined);
    };
    player.addEventListener('seeking', seeking);
    player.addEventListener('seeked', seeked);
    player.addEventListener('play', playing);
    player.addEventListener('pause', paused);
    player.addEventListener('ended', ended);
    player.addEventListener('loadedmetadata', loaded);
    callback = player.requestVideoFrameCallback(frame);
    const observer = new ResizeObserver(() => paint());
    if (canvas.current) observer.observe(canvas.current);
    return () => {
      active = false;
      player.cancelVideoFrameCallback(callback);
      player.removeEventListener('seeking', seeking);
      player.removeEventListener('seeked', seeked);
      player.removeEventListener('play', playing);
      player.removeEventListener('pause', paused);
      player.removeEventListener('ended', ended);
      player.removeEventListener('loadedmetadata', loaded);
      observer.disconnect();
    };
    // A copy's frame map is immutable; a different copy remounts this component.
  }, [frames]);

  const pick = (event: MouseEvent<HTMLCanvasElement>) => {
    const target = canvas.current;
    if (!onPick || !target) return;
    const box = target.getBoundingClientRect();
    const view = containView(box.width, box.height, sourceWidth, sourceHeight, 1);
    const x = (event.clientX - box.left - view.dx) / view.scale, y = (event.clientY - box.top - view.dy) / view.scale;
    if (x >= 0 && y >= 0 && x <= sourceWidth && y <= sourceHeight) onPick([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
  };
  const label = (text: string) => <span className="pointer-events-none absolute right-2 top-2 rounded bg-slate-950/70 px-2 py-0.5 text-[11px] font-medium text-slate-200">{text}</span>;
  return <div className={layout === 'split' ? 'grid h-full w-full gap-2 xl:grid-cols-3' : 'h-full w-full'}>
    <section aria-label={`${shown[0]?.label ?? 'Video'} view`} className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
      <video ref={video} src={`bat-media://proxy/${frames.id}`} preload="auto" muted playsInline aria-label="Playback copy"
        className="absolute inset-0 h-full w-full object-contain" />
      <canvas ref={canvas} aria-label={onPick ? 'Video drawing area' : undefined} aria-hidden={onPick ? undefined : true}
        className={`absolute inset-0 h-full w-full ${onPick ? 'cursor-crosshair' : 'pointer-events-none'}`} onClick={pick} />
      {layout === 'split' && shown[0] && label(shown[0].label)}
      {failure && <p role="alert" className="absolute inset-x-4 top-4 rounded-md bg-red-600/90 px-3 py-2 text-sm text-white">{failure}</p>}
    </section>
    {layout === 'split' && shown.slice(1).map((view, offset) => <section key={view.key} aria-label={`${view.label} view`} className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
      <canvas ref={element => { panes.current[offset + 1] = element; }} aria-hidden className="absolute inset-0 h-full w-full" />
      {label(view.label)}
    </section>)}
  </div>;
});
