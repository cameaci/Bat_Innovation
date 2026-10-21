"""Collect licence texts for the Python packages shipped inside the backend executable.

Run in the build environment after `pip install -r backend/requirements.txt`, before packaging:
    python scripts/collect_notices.py build/notices
It copies each shipped distribution's licence files and writes NOTICE.txt. It does not decide that a component
may be redistributed; the release owner remains responsible for that (see docs/18-windows-beta.md).
"""

from __future__ import annotations

import re
import shutil
import sys
from importlib import metadata
from pathlib import Path

from packaging.requirements import Requirement

ROOT = Path(__file__).resolve().parents[1]
LICENCE_FILE = re.compile(r"(licen[cs]e|copying|notice|authors)", re.IGNORECASE)
HEADER = """Bat Innovation - third-party notices (internal beta)

Bat Innovation is an exploratory local review tool. It is not an official WSP publication. Code ownership and the
licence for this project's own source have not been determined; do not infer one from its public visibility.

This installer bundles the components below. Their licence files are in the python/ folder beside this file.
The Electron runtime also installs LICENSE.electron.txt and LICENSES.chromium.html in the application folder.

IMPORTANT - video codecs: the PyAV wheel bundles FFmpeg shared libraries and codec libraries, including x264 and
x265 (GPL-2.0-or-later, or separate commercial terms) although the FFmpeg libraries self-report LGPL-3.0-or-later.
Whoever redistributes this installer is responsible for the corresponding source and notice obligations.
Sources: https://github.com/PyAV-Org/PyAV (the Python binding), https://github.com/PyAV-Org/pyav-ffmpeg (the FFmpeg
and codec build recipes and patches used for the wheel), https://ffmpeg.org/download.html (FFmpeg source).
The application decodes the original videos and encodes only VP9/WebM previews; it does not need x264/x265.
"""


def shipped_distributions() -> list[metadata.Distribution]:
    """The pinned requirements and their transitive runtime dependencies (extras excluded)."""
    pending = [Requirement(line).name for line in (ROOT / "backend/requirements.txt").read_text().splitlines()
               if line.strip() and not line.startswith(("#", "-"))]
    found: dict[str, metadata.Distribution] = {}
    while pending:
        name = pending.pop()
        key = re.sub(r"[-_.]+", "-", name).lower()
        if key in found:
            continue
        distribution = metadata.distribution(name)
        found[key] = distribution
        for text in distribution.requires or []:
            requirement = Requirement(text)
            if requirement.marker is None or requirement.marker.evaluate({"extra": ""}):
                pending.append(requirement.name)
    return sorted(found.values(), key=lambda item: item.metadata["Name"].lower())


def main(output: Path) -> None:
    if output.exists():
        shutil.rmtree(output)
    (output / "python").mkdir(parents=True)
    lines = [HEADER, "Component | Version | Declared licence", "--- | --- | ---"]
    for distribution in shipped_distributions():
        name, version = distribution.metadata["Name"], distribution.version
        declared = distribution.metadata.get("License-Expression") or distribution.metadata.get("License") or "see licence files"
        lines.append(f"{name} | {version} | {declared.splitlines()[0][:120]}")
        copied = 0
        for entry in distribution.files or []:
            parts = entry.parts
            if parts[0].endswith(".dist-info") and LICENCE_FILE.search(entry.name) and entry.suffix in {"", ".txt", ".md", ".rst"}:
                target = output / "python" / f"{name}-{version}" / Path(*parts[1:])
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(distribution.locate_file(entry), target)
                copied += 1
        if copied == 0:
            raise SystemExit(f"No licence file found for {name} {version}; resolve this before packaging.")
    (output / "NOTICE.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {len(lines) - 3} component notices to {output}")


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve() if len(sys.argv) == 2 else ROOT / "build/notices")
