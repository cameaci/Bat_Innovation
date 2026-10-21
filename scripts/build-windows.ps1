<#
Builds the Bat Innovation Windows installer on a native Windows 10/11 x64 machine, then smoke-tests the frozen backend.

Prerequisites: Python 3.12 x64 on PATH (py -3.12 also works), Node.js >= 22.12 with npm. Internet access is needed
at build time only; the installed application never downloads anything.
Usage (repository root):  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
Output: electron\dist-build\Bat-Innovation-Setup-<version>.exe and its SHA256.
#>
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Run([string]$Description, [scriptblock]$Command) {
    Write-Host "==> $Description"
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE" }
}

if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) { throw 'Build on 64-bit Windows.' }
if (Get-Command py -ErrorAction SilentlyContinue) { $pyExe = 'py'; $pyArgs = @('-3.12') } else { $pyExe = 'python'; $pyArgs = @() }
$found = (& $pyExe @pyArgs -c 'import sys; print("%d.%d" % sys.version_info[:2], sys.maxsize > 2**32)') | Out-String
if ($found.Trim() -ne '3.12 True') { throw "Python 3.12 x64 is required, found: $found" }

# A dedicated build environment keeps the frozen backend limited to the pinned requirements.
$venv = Join-Path (Get-Location) '.build\venv'
if (-not (Test-Path $venv)) { Run 'Create build environment' { & $pyExe @pyArgs -m venv $venv } }
$py = Join-Path $venv 'Scripts\python.exe'
Run 'Install pinned Python requirements' { & $py -m pip install --disable-pip-version-check -r backend\requirements-build.txt }
Run 'Install locked Node dependencies' { npm ci }
Run 'Build UI and desktop shell' { npm run build }

$env:PYTHONUTF8 = '1'
Run 'Freeze the backend' { & $py -m PyInstaller backend\bat-backend.spec --noconfirm --clean --distpath backend\dist --workpath .build\pyinstaller }
Run 'Smoke-test the frozen backend (import, preview, summaries, export)' { & $py scripts\smoke_backend.py backend\dist\bat-backend\bat-backend.exe }
Run 'Collect licence notices' { & $py scripts\collect_notices.py build\notices }

$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'   # The internal beta is unsigned.
Push-Location electron
try { Run 'Package the installer' { npx electron-builder --win --publish never } } finally { Pop-Location }

$installer = Get-ChildItem electron\dist-build\Bat-Innovation-Setup-*.exe | Select-Object -First 1
if (-not $installer) { throw 'Installer not found.' }
$hash = (Get-FileHash $installer.FullName -Algorithm SHA256).Hash.ToLower()
"$hash  $($installer.Name)" | Set-Content -Encoding ascii (Join-Path $installer.DirectoryName 'SHA256SUMS.txt')
Write-Host "Installer: $($installer.FullName)`nSHA256:    $hash"
