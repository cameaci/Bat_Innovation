"""Write a synthetic infrared-style MP4 for trying the app: noisy dark scene, brief moving bright dots, a quiet end.

Usage: python scripts/make_test_video.py <output.mp4> [seconds]   (default 90 s = three 30 s windows)
The file contains no real survey data. Save it OUTSIDE the repository and the app data folder; the app refuses
originals stored there. Timing: dots cross at about 10-14 s and 40-46 s, nothing moves after 60 s, so the last
window should look quiet but still needs an explicit review decision.
"""

from __future__ import annotations

import sys
from pathlib import Path

import av
import numpy

WIDTH, HEIGHT, RATE = 640, 360, 25
# (start second, end second, y fraction, size in pixels): each dot crosses the frame left to right.
FLIGHTS = [(10, 14, 0.30, 5), (11, 15, 0.55, 4), (40, 46, 0.45, 6)]


def main(output: Path, seconds: int) -> None:
    if output.suffix.lower() != ".mp4":
        raise SystemExit("Choose a .mp4 output path.")
    random = numpy.random.default_rng(7)
    background = random.normal(40, 6, (HEIGHT, WIDTH))
    output.parent.mkdir(parents=True, exist_ok=True)
    with av.open(str(output), "w") as container:
        stream = container.add_stream("mpeg4", rate=RATE)
        stream.width, stream.height, stream.pix_fmt = WIDTH, HEIGHT, "yuv420p"
        stream.bit_rate = 2_000_000
        for index in range(seconds * RATE):
            second = index / RATE
            frame = background + random.normal(0, 0.4, (HEIGHT, WIDTH))
            for start, end, y, size in FLIGHTS:
                if start <= second < end:
                    x = int((second - start) / (end - start) * (WIDTH - size))
                    row = int(HEIGHT * y + 6 * numpy.sin(second * 9))
                    frame[row:row + size, x:x + size] = 230
            gray = numpy.clip(frame, 0, 255).astype(numpy.uint8)
            image = numpy.stack([gray, gray, gray], axis=-1)
            for packet in stream.encode(av.VideoFrame.from_ndarray(image, format="rgb24")):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    print(f"Wrote {output} ({output.stat().st_size / 1e6:.1f} MB, {seconds} s)")


if __name__ == "__main__":
    if not 2 <= len(sys.argv) <= 3:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]).resolve(), int(sys.argv[2]) if len(sys.argv) == 3 else 90)
