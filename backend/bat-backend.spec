# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller onedir spec for the local API and its disposable workers (one executable, --worker re-entry).

Build from the repository root: python -m PyInstaller backend/bat-backend.spec --noconfirm --clean
        --distpath backend/dist --workpath backend/build
"""

from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules, copy_metadata

root = Path(SPECPATH).resolve().parent

datas, binaries, hiddenimports = [], [], []
# PyAV bundles FFmpeg shared libraries and Cython modules that static analysis cannot see.
for package in ("av",):
    package_datas, package_binaries, package_hidden = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hidden
# Summary runs record the numpy, Pillow and PyAV versions as processing evidence (backend/app/windows.py).
for distribution in ("numpy", "Pillow", "av", "scipy"):
    datas += copy_metadata(distribution)
# Loaded by name: workers are re-entered with --worker, and uvicorn/pydantic pick implementations at run time.
hiddenimports += collect_submodules("backend.app") + collect_submodules("uvicorn") + collect_submodules("pydantic")

analysis = Analysis(
    [str(root / "backend" / "run_backend.py")],
    pathex=[str(root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "pytest", "matplotlib", "backend.tests"],
    noarchive=False,
)
archive = PYZ(analysis.pure)
executable = EXE(
    archive,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="bat-backend",
    debug=False,
    strip=False,
    upx=False,  # UPX can corrupt signed binaries and trigger antivirus scans.
    console=True,  # Electron starts it hidden; a console keeps stderr available for startup diagnostics.
)
COLLECT(executable, analysis.binaries, analysis.datas, strip=False, upx=False, name="bat-backend")
