import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
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

/**
 * Continuous playback of one segment's playback copy. Every presented frame is mapped back to its exact source PTS
 * through the copy's frame map (requestVideoFrameCallback media time, within 0.5 ms); overlays draw only on a
 * matched frame, so nothing is drawn against an unknown time.
 */
export const Player = forwardRef<PlayerHandle, {
  frames: PlaybackFrames;
  sourceWidth: number;
  sourceHeight: number;
  draw: Draw;
  onFrame: (frame: DisplayedFrame | null) => void;
  onPlaying: (playing: boolean) => void;
  onEnded: () => void;
  startPTS?: number | null;
  autoPlay?: boolean;
}>(function Player({ frames, sourceWidth, sourceHeight, draw, onFrame, onPlaying, onEnded, startPTS, autoPlay }, ref) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const current = useRef<DisplayedFrame | null>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
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
    const target = canvas.current, player = video.current;
    if (!target || !player) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(target.clientWidth * dpr), height = Math.round(target.clientHeight * dpr);
    if (target.width !== width || target.height !== height) { target.width = width; target.height = height; }
    const context = target.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, width, height);
    if (current.current) drawRef.current(context, containView(width, height, sourceWidth, sourceHeight, dpr), current.current);
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
      if (player.seeking) publish(null);
      else publish({ index, pts: pts.current[index]!, ms: frames.proxy_ms[index]! });
      callback = player.requestVideoFrameCallback(frame);
    }
    const seeking = () => publish(null);
    const playing = () => onPlaying(true);
    const paused = () => onPlaying(false);
    const ended = () => { onPlaying(false); onEnded(); };
    const loaded = () => {
      if (startPTS !== undefined && startPTS !== null) seekIndex(Math.max(0, floorIndex(pts.current, startPTS)));
      else seekIndex(0);
      if (autoPlay) void player.play().catch(() => undefined);
    };
    player.addEventListener('seeking', seeking);
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
      player.removeEventListener('play', playing);
      player.removeEventListener('pause', paused);
      player.removeEventListener('ended', ended);
      player.removeEventListener('loadedmetadata', loaded);
      observer.disconnect();
    };
    // A copy's frame map is immutable; a different copy remounts this component.
  }, [frames]);

  return <div className="relative h-full w-full overflow-hidden rounded-lg bg-black">
    <video ref={video} src={`bat-media://proxy/${frames.id}`} preload="auto" muted playsInline aria-label="Playback copy"
      className="absolute inset-0 h-full w-full object-contain" />
    <canvas ref={canvas} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />
    {failure && <p role="alert" className="absolute inset-x-4 top-4 rounded-md bg-red-600/90 px-3 py-2 text-sm text-white">{failure}</p>}
  </div>;
});
