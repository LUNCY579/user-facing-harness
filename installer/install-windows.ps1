# TestingPlatform setup-only installer — Windows (PowerShell).
#
# What this does, in order, and nothing else:
#   1. Checks Git, Node, pnpm (versions only, see below).
#   2. Clones the PUBLIC repo (anonymous HTTPS, no account, no
#      credentials) or fast-forward-updates an existing checkout.
#   3. From the repo ROOT only (never from inside demo-target/):
#      frozen install, setup (the repo's own build + check gates),
#      artifact check.
#   4. Writes start-demo.bat in the repo folder for later runs.
#   5. Starts the harness in this window (pnpm start) and prints
#      the URL. Keep this window open; Ctrl+C stops it.
#
# What it deliberately does NOT do:
#   - It never silently replaces or upgrades your Node. If Node is
#     missing or too old, it stops and tells you exactly what to
#     install. Your Node stays yours.
#   - It never asks for a password, token, or key, and never sends
#     anything anywhere. Clone uses GIT_TERMINAL_PROMPT=0 so a
#     non-public repo fails fast instead of prompting for a login.
#   - It never picks a model, runs a task, or sends a bundle. Those
#     are separate, human steps after setup.
#   - It never deletes anything except node_modules inside the repo
#     folder itself, and only when the recorded Node version changed
#     (or is unknown). That clean reinstall is what fixes a missing
#     native binding after a Node switch: "pnpm install" saying
#     "Already up to date" is NOT proof the binding is present.
#   - It never deletes pnpm-lock.yaml and never runs `npm i` in the
#     repo (this is a pnpm repo).
#
# How to run it (note: double-clicking a .ps1 file normally opens
# it in an editor instead of running it, so use one of these):
#   Right-click install-windows.ps1, then choose "Run with PowerShell".
#   Or, from a PowerShell window in the script's folder:
#     powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
#   Optional target folder:
#     powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -InstallDir "C:\Users\you\Downloads\TestingPlatform"
#
# Requirements (from TestingPlatform README.md, verified 2026-10-26):
#   Node.js >= 24.9.0, pnpm 11.28.5 (pinned in package.json),
#   Git >= 2.26, Node and Git for Windows with PowerShell.
#   (A separate WSL 2 checkout is an alternative the README allows,
#   but this script targets native Windows PowerShell, not WSL.)
#   Optional plugin desktop packaging needs Rust/MSVC — not needed
#   for the Web interface, and this installer does not do it.
#
# Repo commands used (verified against TestingPlatform main):
#   git clone https://github.com/LUNCY579/TestingPlatform.git
#   pnpm install --frozen-lockfile
#   pnpm run setup
#   pnpm start        (opens http://127.0.0.1:3080, URL has a token)
#
# Compatibility: stock Windows PowerShell 5.1 and PowerShell 7.
# This script avoids PowerShell 7-only syntax (no null-coalescing operator,
# no ternary operator), so it parses on 5.1 as well.

param(
  [string]$InstallDir = (Join-Path $env:USERPROFILE "Downloads\TestingPlatform")
)

$RepoUrl = "https://github.com/LUNCY579/TestingPlatform.git"
$RepoRemote = "https://github.com/LUNCY579/TestingPlatform.git"
$WantPnpm = "11.28.5"

function Fail($Message) {
  Write-Host ""
  Write-Host "INSTALLER STOPPED: $Message"
  exit 1
}

# Test-VersionAtLeast -Version "24.22.1" -Minimum "24.9"
# True when -Version >= -Minimum, numerically, part by part.
# Accepts a leading "v" (v24.22.1) and missing parts (24.9).
function Test-VersionAtLeast {
  param([string]$Version, [string]$Minimum)
  $a = $Version -replace '^v', ''
  $b = $Minimum -replace '^v', ''
  $aParts = $a -split '\.'
  $bParts = $b -split '\.'
  for ($i = 0; $i -lt 4; $i++) {
    $ap = 0
    $bp = 0
    if ($i -lt $aParts.Length) {
      $cleanA = ($aParts[$i] -replace '[^0-9].*', '')
      if ($cleanA -eq '') { $cleanA = '0' }
      $ap = [int]$cleanA
    }
    if ($i -lt $bParts.Length) {
      $cleanB = ($bParts[$i] -replace '[^0-9].*', '')
      if ($cleanB -eq '') { $cleanB = '0' }
      $bp = [int]$cleanB
    }
    if ($ap -gt $bp) { return $true }
    if ($ap -lt $bp) { return $false }
  }
  return $true
}

function Get-CleanVersion($Raw) {
  return ($Raw -replace '^v', '').Trim()
}

function Main {
  Write-Host "TestingPlatform setup installer (Windows)"
  Write-Host "Target folder: $InstallDir"
  Write-Host ""

  # --- Git check --------------------------------------------------
  $gitCmd = Get-Command git -ErrorAction SilentlyContinue
  if ($null -eq $gitCmd) {
    Fail "Git is not installed. Install Git for Windows, then run this installer again."
  }
  $gitOut = (git --version) -join ' '
  $gitVer = Get-CleanVersion (($gitOut -split ' ')[2])
  if (-not (Test-VersionAtLeast -Version $gitVer -Minimum "2.26")) {
    Fail "Git $gitVer is too old. TestingPlatform needs Git >= 2.26. Update Git, then run this installer again."
  }
  Write-Host "OK: Git $gitVer"

  # --- Node check (never silently replaced) -----------------------
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $nodeCmd) {
    Write-Host ""
    Write-Host "Node is not installed."
    Write-Host "Install Node 24 LTS from https://nodejs.org/en/download"
    Write-Host "Then run this installer again."
    Fail "Node is missing. See the install guidance above."
  }
  $nodeVer = Get-CleanVersion (node --version)
  if (-not (Test-VersionAtLeast -Version $nodeVer -Minimum "24.9")) {
    Write-Host ""
    Write-Host "Found Node $nodeVer at: $($nodeCmd.Source)"
    Write-Host "TestingPlatform needs Node >= 24.9."
    Write-Host "A Node 20 copy on your PATH breaks the harness with"
    Write-Host "'No such built-in module: node:sqlite'."
    Write-Host "Fix: install Node 24 LTS from https://nodejs.org/en/download,"
    Write-Host "make sure the Node 24 copy comes first on your PATH,"
    Write-Host "then run this installer again."
    Write-Host "This installer will NOT change your Node or your PATH for you."
    Fail "Node $nodeVer is too old. See the guidance above."
  }
  Write-Host "OK: Node $nodeVer at $($nodeCmd.Source)"

  # --- pnpm check (pinned version) --------------------------------
  $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($null -eq $pnpmCmd) {
    Write-Host "pnpm is missing. Installing the pinned version with npm (this is the README's own command):"
    Write-Host "  npm install --global pnpm@$WantPnpm"
    npm install --global "pnpm@$WantPnpm"
    if ($LASTEXITCODE -ne 0) {
      Fail "Could not install pnpm. Try manually: npm install --global pnpm@$WantPnpm  then run this installer again."
    }
    $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
  }
  $pnpmVer = ""
  if ($null -ne $pnpmCmd) { $pnpmVer = Get-CleanVersion (pnpm --version) }
  if ($pnpmVer -ne $WantPnpm) {
    Write-Host "pnpm $pnpmVer found, but this repo pins pnpm $WantPnpm. Installing the pinned version:"
    Write-Host "  npm install --global pnpm@$WantPnpm"
    npm install --global "pnpm@$WantPnpm"
    if ($LASTEXITCODE -ne 0) {
      Fail "Could not install pnpm $WantPnpm. Try manually: npm install --global pnpm@$WantPnpm  then run this installer again."
    }
    $pnpmVer = Get-CleanVersion (pnpm --version)
  }
  Write-Host "OK: pnpm $pnpmVer"

  # --- Clone or update (public repo, no login) --------------------
  $env:GIT_TERMINAL_PROMPT = '0'
  if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Host ""
    Write-Host "Existing checkout found at $InstallDir. Updating it (fast-forward only)..."
    $remoteUrl = (git -C $InstallDir remote get-url origin) -join ''
    if (($remoteUrl -ne $RepoRemote) -and ($remoteUrl -ne $RepoRemote.Replace('.git', ''))) {
      Fail "The folder $InstallDir is a different repo (origin: $remoteUrl). Choose another target folder, or move that folder aside, then run this installer again. Nothing was deleted."
    }
    git -C $InstallDir pull --ff-only
    if ($LASTEXITCODE -ne 0) {
      Fail "Could not fast-forward-update $InstallDir (it may have local changes). Do not force it: move your changes aside, or choose a fresh target folder, then run this installer again."
    }
  } elseif (Test-Path $InstallDir) {
    Fail "The folder $InstallDir already exists but is not a git checkout. Move it aside, or pass a different target folder (-InstallDir), then run this installer again. Nothing was deleted."
  } else {
    Write-Host ""
    Write-Host "Cloning the public repo (no login needed)..."
    git clone $RepoUrl $InstallDir
    if ($LASTEXITCODE -ne 0) {
      Write-Host ""
      Write-Host "Clone failed. If git asked for a login, the repo is not public"
      Write-Host "yet -- wait until it is public and run this installer again."
      Fail "Clone failed. See above."
    }
  }

  # --- From here on, repo ROOT only. Never cd into demo-target/. ---
  Set-Location $InstallDir
  if (-not (Test-Path "package.json")) {
    Fail "package.json not found in $InstallDir. This is not a TestingPlatform checkout."
  }
  if (-not (Test-Path "testing-platform\launcher.mjs")) {
    Fail "testing-platform\launcher.mjs not found in $InstallDir. This is not a TestingPlatform checkout."
  }
  Write-Host "OK: TestingPlatform checkout at $InstallDir"

  # --- Clean reinstall when the Node version changed --------------
  $marker = Join-Path $InstallDir ".installer-node-version"
  $recorded = ""
  if (Test-Path $marker) { $recorded = (Get-Content $marker -Raw).Trim() }
  if ((Test-Path "node_modules") -and ($recorded -ne $nodeVer)) {
    Write-Host ""
    Write-Host "Node version changed (recorded: $recorded, now: $nodeVer)."
    Write-Host "Removing node_modules inside this repo folder only, for a clean reinstall."
    Write-Host "This fixes missing native bindings after a Node switch."
    Remove-Item -Recurse -Force "node_modules"
  }

  # --- Frozen install (repo root) ---------------------------------
  Write-Host ""
  Write-Host "Installing dependencies (this can take several minutes)..."
  Write-Host "  pnpm install --frozen-lockfile"
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) {
    Fail "pnpm install failed. See the error above; do NOT delete pnpm-lock.yaml and do NOT run npm i in this repo."
  }

  # --- Native binding presence check ------------------------------
  $bindingFound = $false
  if (Test-Path "node_modules\.pnpm") {
    $hits = Get-ChildItem "node_modules\.pnpm" -Filter "*rolldown*binding*" -ErrorAction SilentlyContinue
    if ($null -ne $hits) { $bindingFound = $true }
  }
  if (-not $bindingFound) {
    Write-Host ""
    Write-Host "Rolldown native binding folder not found after install. Forcing one clean reinstall..."
    Remove-Item -Recurse -Force "node_modules"
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) {
      Fail "Forced reinstall failed. See the error above."
    }
    if (Test-Path "node_modules\.pnpm") {
      $hits = Get-ChildItem "node_modules\.pnpm" -Filter "*rolldown*binding*" -ErrorAction SilentlyContinue
      if ($null -ne $hits) { $bindingFound = $true }
    }
  }
  if (-not $bindingFound) {
    Write-Host ""
    Write-Host "The rolldown native binding is still missing after a clean reinstall."
    Write-Host "Fix order (do not delete pnpm-lock.yaml, do not run npm i):"
    Write-Host "  1. Remove node_modules, then pnpm install --frozen-lockfile"
    Write-Host "  2. If still missing, check node_modules\.pnpm for a rolldown binding folder"
    Write-Host "  3. Report the Node version and the install log; do not proceed to setup."
    Fail "Native binding missing after clean reinstall. See the fix order above."
  }
  Write-Host "OK: rolldown native binding folder present"

  # Record the Node version that this install was built with.
  Set-Content -Path $marker -Value $nodeVer -NoNewline

  # --- Setup: the repo's own build + check gates ------------------
  Write-Host ""
  Write-Host "Running setup (build + check gates; this can take several minutes)..."
  Write-Host "  pnpm run setup"
  pnpm run setup
  if ($LASTEXITCODE -ne 0) {
    Fail "pnpm run setup failed. Setup passing is the required check -- do not start the harness until setup passes. See the error above."
  }

  # --- Artifact check (same files the launcher requires) ----------
  if (-not (Test-Path "apps\cli\lib\bin.js")) {
    Fail "Setup finished but apps\cli\lib\bin.js is missing. Do not start; report this."
  }
  if (-not (Test-Path "apps\web\dist\index.html")) {
    Fail "Setup finished but apps\web\dist\index.html is missing. Do not start; report this."
  }
  Write-Host "OK: setup passed, built artifacts present"

  # --- Launcher for later runs ------------------------------------
  $launcher = "@echo off`r`nREM TestingPlatform launcher: double-click to start the harness.`r`nREM Runs from this repo folder. Keep the window open; Ctrl+C stops it.`r`ncd /d `"%~dp0`"`r`npnpm start`r`npause`r`n"
  Set-Content -Path (Join-Path $InstallDir "start-demo.bat") -Value $launcher -Encoding Ascii
  Write-Host "OK: launcher written to $(Join-Path $InstallDir 'start-demo.bat')"

  # --- Start the harness (foreground, repo root) ------------------
  Write-Host ""
  Write-Host "Setup complete. Starting the harness..."
  Write-Host "Keep this window open while you use it. Press Ctrl+C to stop."
  Write-Host "Later, start again by double-clicking start-demo.bat in $InstallDir"
  Write-Host "or by running: cd $InstallDir; pnpm start"
  Write-Host "The harness will print a URL (normally http://127.0.0.1:3080)."
  Write-Host "That URL includes a login token -- keep it private."
  Write-Host ""
  pnpm start
}

# Only run Main when this file is executed, not when dot-sourced for tests.
if ($MyInvocation.InvocationName -ne '.') {
  Main
}
