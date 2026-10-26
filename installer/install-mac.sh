#!/bin/sh
# TestingPlatform setup-only installer — macOS.
#
# What this does, in order, and nothing else:
#   1. Checks macOS, Git, Node, pnpm (versions only, see below).
#   2. Clones the PUBLIC repo (anonymous HTTPS, no account, no
#      credentials) or fast-forward-updates an existing checkout.
#   3. From the repo ROOT only (never from inside demo-target/):
#      frozen install, setup (the repo's own build + check gates),
#      artifact check.
#   4. Writes start-demo.command in the repo folder for later runs.
#   5. Starts the harness in this terminal (pnpm start) and prints
#      the URL. Keep this terminal open; Ctrl+C stops it.
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
# How to run it:
#   Terminal:  chmod +x install-mac.sh && ./install-mac.sh
#              (optional target folder: ./install-mac.sh ~/MyFolder/TestingPlatform)
#   Double-click: copy this file to install-mac.command and
#              double-click that copy. Terminal will open and run it.
#              If macOS blocks it, right-click it and choose Open.
#
# Requirements (from TestingPlatform README.md, verified 2026-10-26):
#   Node.js >= 24.9.0, pnpm 11.28.5 (pinned in package.json),
#   Git >= 2.26, macOS command-line developer tools
#   (xcode-select --install) for the native addon.
#
# Repo commands used (verified against TestingPlatform main):
#   git clone https://github.com/LUNCY579/TestingPlatform.git
#   pnpm install --frozen-lockfile
#   pnpm run setup
#   pnpm start        (opens http://127.0.0.1:3080, URL has a token)

REPO_URL="https://github.com/LUNCY579/TestingPlatform.git"
REPO_REMOTE="https://github.com/LUNCY579/TestingPlatform.git"
MIN_NODE_MAJOR=24
MIN_NODE_MINOR=9
MIN_GIT_MAJOR=2
MIN_GIT_MINOR=26
WANT_PNPM="11.28.5"

fail() {
  echo ""
  echo "INSTALLER STOPPED: $1" >&2
  exit 1
}

# version_ge VER1 VER2  — true if VER1 >= VER2, numerically, by
# dot-separated parts. Accepts a leading "v" (v24.22.1) and missing
# parts (24.9). Returns 0 (true) or 1 (false) via exit status.
# This function is the only part unit-tested on Linux in staging;
# the rest of the script needs a real macOS run.
version_ge() {
  a=$(printf '%s' "$1" | sed 's/^v//')
  b=$(printf '%s' "$2" | sed 's/^v//')
  # Compare part by part, treating missing parts as 0.
  i=1
  while [ "$i" -le 4 ]; do
    ap=$(printf '%s' "$a" | cut -d. -f"$i")
    bp=$(printf '%s' "$b" | cut -d. -f"$i")
    [ -z "$ap" ] && ap=0
    [ -z "$bp" ] && bp=0
    # Strip any non-digit suffix (e.g. "22.1-rc").
    ap=$(printf '%s' "$ap" | sed 's/[^0-9].*//')
    bp=$(printf '%s' "$bp" | sed 's/[^0-9].*//')
    [ -z "$ap" ] && ap=0
    [ -z "$bp" ] && bp=0
    if [ "$ap" -gt "$bp" ]; then return 0; fi
    if [ "$ap" -lt "$bp" ]; then return 1; fi
    i=$((i + 1))
  done
  return 0
}

# parse_version "v24.22.1" -> "24.22.1" (leading v stripped only).
parse_version() {
  printf '%s' "$1" | sed 's/^v//'
}

main() {
  TARGET="${1:-$HOME/Downloads/TestingPlatform}"
  echo "TestingPlatform setup installer (macOS)"
  echo "Target folder: $TARGET"
  echo ""

  # --- OS check ---------------------------------------------------
  OS=$(uname -s)
  ARCH=$(uname -m)
  if [ "$OS" != "Darwin" ]; then
    fail "This script is for macOS (found: $OS). Windows users run install-windows.ps1; Linux users follow the same repo commands manually."
  fi
  echo "OK: macOS ($ARCH)"

  # --- Git check --------------------------------------------------
  if ! command -v git >/dev/null 2>&1; then
    fail "Git is not installed. Install it first (for example, run: xcode-select --install), then run this installer again."
  fi
  GIT_VER=$(parse_version "$(git --version | awk '{print $3}')")
  if ! version_ge "$GIT_VER" "$MIN_GIT_MAJOR.$MIN_GIT_MINOR"; then
    fail "Git $GIT_VER is too old. TestingPlatform needs Git >= $MIN_GIT_MAJOR.$MIN_GIT_MINOR. Update Git, then run this installer again."
  fi
  echo "OK: Git $GIT_VER"

  # --- Command-line developer tools check -------------------------
  # The native addon needs a C compiler (README prerequisite).
  if ! xcode-select -p >/dev/null 2>&1; then
    fail "Apple command-line developer tools are not installed. Run: xcode-select --install  (follow the prompt), then run this installer again."
  fi
  echo "OK: command-line developer tools present"

  # --- Node check (never silently replaced) -----------------------
  if ! command -v node >/dev/null 2>&1; then
    echo ""
    echo "Node is not installed."
    echo "Install Node 24 LTS from https://nodejs.org/en/download"
    echo "(or, if you use Homebrew: brew install node@24)"
    echo "Then run this installer again."
    fail "Node is missing. See the install guidance above."
  fi
  NODE_VER=$(parse_version "$(node --version)")
  if ! version_ge "$NODE_VER" "$MIN_NODE_MAJOR.$MIN_NODE_MINOR"; then
    echo ""
    echo "Found Node $NODE_VER at: $(command -v node)"
    echo "All Node copies on your PATH:"
    command -v -a node
    echo ""
    echo "TestingPlatform needs Node >= $MIN_NODE_MAJOR.$MIN_NODE_MINOR."
    echo "This is the pilot failure to avoid: a Node 20 copy (often from"
    echo "a conda 'base' environment) shadowing your PATH breaks the"
    echo "harness with 'No such built-in module: node:sqlite'."
    echo "Fix: install Node 24 LTS from https://nodejs.org/en/download,"
    echo "make sure the Node 24 copy comes first on your PATH (for"
    echo "example, deactivate conda, or move the Node 24 folder ahead"
    echo "of the old one), then run this installer again."
    echo "This installer will NOT change your Node or your PATH for you."
    fail "Node $NODE_VER is too old. See the guidance above."
  fi
  echo "OK: Node $NODE_VER at $(command -v node)"

  # --- pnpm check (pinned version) --------------------------------
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "pnpm is missing. Installing the pinned version with npm (this is the README's own command):"
    echo "  npm install --global pnpm@$WANT_PNPM"
    if ! npm install --global "pnpm@$WANT_PNPM"; then
      fail "Could not install pnpm. Try manually: npm install --global pnpm@$WANT_PNPM  then run this installer again."
    fi
  fi
  PNPM_VER=$(parse_version "$(pnpm --version)")
  if [ "$PNPM_VER" != "$WANT_PNPM" ]; then
    echo "pnpm $PNPM_VER found, but this repo pins pnpm $WANT_PNPM. Installing the pinned version:"
    echo "  npm install --global pnpm@$WANT_PNPM"
    if ! npm install --global "pnpm@$WANT_PNPM"; then
      fail "Could not install pnpm $WANT_PNPM. Try manually: npm install --global pnpm@$WANT_PNPM  then run this installer again."
    fi
    PNPM_VER=$(parse_version "$(pnpm --version)")
  fi
  echo "OK: pnpm $PNPM_VER"

  # --- Clone or update (public repo, no login) --------------------
  export GIT_TERMINAL_PROMPT=0
  if [ -d "$TARGET/.git" ]; then
    echo ""
    echo "Existing checkout found at $TARGET. Updating it (fast-forward only)..."
    REMOTE_URL=$(git -C "$TARGET" remote get-url origin 2>/dev/null || echo "")
    if [ "$REMOTE_URL" != "$REPO_REMOTE" ] && [ "$REMOTE_URL" != "${REPO_REMOTE%.git}" ]; then
      fail "The folder $TARGET is a different repo (origin: $REMOTE_URL). Choose another target folder, or move that folder aside, then run this installer again. Nothing was deleted."
    fi
    if ! git -C "$TARGET" pull --ff-only; then
      fail "Could not fast-forward-update $TARGET (it may have local changes). Do not force it: move your changes aside, or choose a fresh target folder, then run this installer again."
    fi
  elif [ -e "$TARGET" ]; then
    fail "The folder $TARGET already exists but is not a git checkout. Move it aside, or pass a different target folder, then run this installer again. Nothing was deleted."
  else
    echo ""
    echo "Cloning the public repo (no login needed)..."
    if ! git clone "$REPO_URL" "$TARGET"; then
      echo ""
      echo "Clone failed. If git asked for a login, the repo is not public"
      echo "yet — wait until it is public and run this installer again."
      fail "Clone failed. See above."
    fi
  fi

  # --- From here on, repo ROOT only. Never cd into demo-target/. ---
  cd "$TARGET" || fail "Could not enter $TARGET."
  [ -f "package.json" ] || fail "package.json not found in $TARGET. This is not a TestingPlatform checkout."
  [ -f "testing-platform/launcher.mjs" ] || fail "testing-platform/launcher.mjs not found in $TARGET. This is not a TestingPlatform checkout."
  echo "OK: TestingPlatform checkout at $TARGET"

  # --- Clean reinstall when the Node version changed --------------
  # pnpm install saying "Already up to date" does NOT prove the
  # native binding is present (pilot: binding missing after a Node
  # switch, install still said "Already up to date" in 524ms).
  MARKER="$TARGET/.installer-node-version"
  RECORDED=""
  if [ -f "$MARKER" ]; then RECORDED=$(cat "$MARKER"); fi
  if [ -d "node_modules" ] && [ "$RECORDED" != "$NODE_VER" ]; then
    echo ""
    echo "Node version changed (recorded: ${RECORDED:-unknown}, now: $NODE_VER)."
    echo "Removing node_modules inside this repo folder only, for a clean reinstall."
    echo "This fixes missing native bindings after a Node switch."
    rm -rf node_modules
  fi

  # --- Frozen install (repo root) ---------------------------------
  echo ""
  echo "Installing dependencies (this can take several minutes)..."
  echo "  pnpm install --frozen-lockfile"
  if ! pnpm install --frozen-lockfile; then
    fail "pnpm install failed. See the error above; do NOT delete pnpm-lock.yaml and do NOT run npm i in this repo."
  fi

  # --- Native binding presence check ------------------------------
  # The pilot failure: @rolldown/binding-darwin-arm64 (or universal)
  # missing inside rolldown, caught only at the Host bundle gate.
  # If the binding folder is absent after install, force one clean
  # reinstall; if it is still absent, stop with the fix order.
  BINDING_FOUND=0
  if ls node_modules/.pnpm 2>/dev/null | grep -qi "rolldown.*binding"; then
    BINDING_FOUND=1
  fi
  if [ "$BINDING_FOUND" -eq 0 ]; then
    echo ""
    echo "Rolldown native binding folder not found after install. Forcing one clean reinstall..."
    rm -rf node_modules
    if ! pnpm install --frozen-lockfile; then
      fail "Forced reinstall failed. See the error above."
    fi
    if ls node_modules/.pnpm 2>/dev/null | grep -qi "rolldown.*binding"; then
      BINDING_FOUND=1
    fi
  fi
  if [ "$BINDING_FOUND" -eq 0 ]; then
    echo ""
    echo "The rolldown native binding is still missing after a clean reinstall."
    echo "Fix order (do not delete pnpm-lock.yaml, do not run npm i):"
    echo "  1. rm -rf node_modules && pnpm install --frozen-lockfile"
    echo "  2. If still missing, check: ls node_modules/.pnpm | grep -i rolldown"
    echo "  3. Report the Node version and the install log; do not proceed to setup."
    fail "Native binding missing after clean reinstall. See the fix order above."
  fi
  echo "OK: rolldown native binding folder present"

  # Record the Node version that this install was built with.
  printf '%s' "$NODE_VER" > "$MARKER"

  # --- Setup: the repo's own build + check gates ------------------
  # launcher setup = build:artifacts + build:check. Setup passing
  # is the definitive dependencies+build check.
  echo ""
  echo "Running setup (build + check gates; this can take several minutes)..."
  echo "  pnpm run setup"
  if ! pnpm run setup; then
    fail "pnpm run setup failed. Setup passing is the required check — do not start the harness until setup passes. See the error above."
  fi

  # --- Artifact check (same files the launcher requires) ----------
  [ -f "apps/cli/lib/bin.js" ] || fail "Setup finished but apps/cli/lib/bin.js is missing. Do not start; report this."
  [ -f "apps/web/dist/index.html" ] || fail "Setup finished but apps/web/dist/index.html is missing. Do not start; report this."
  echo "OK: setup passed, built artifacts present"

  # --- Launcher for later runs ------------------------------------
  cat > "$TARGET/start-demo.command" <<'LAUNCHER'
#!/bin/sh
# TestingPlatform launcher: double-click to start the harness.
# Runs from this repo folder. Keep the Terminal window open;
# Ctrl+C stops the harness. Start again by double-clicking this file.
cd "$(dirname "$0")"
exec pnpm start
LAUNCHER
  chmod +x "$TARGET/start-demo.command"
  echo "OK: launcher written to $TARGET/start-demo.command"

  # --- Start the harness (foreground, repo root) ------------------
  echo ""
  echo "Setup complete. Starting the harness..."
  echo "Keep this terminal open while you use it. Press Ctrl+C to stop."
  echo "Later, start again by double-clicking start-demo.command in $TARGET"
  echo "or by running: cd $TARGET && pnpm start"
  echo "The harness will print a URL (normally http://127.0.0.1:3080)."
  echo "That URL includes a login token — keep it private."
  echo ""
  exec pnpm start
}

# Only run main when this file is executed, not when sourced for tests.
if [ "${0##*/}" = "install-mac.sh" ] || [ "${0##*/}" = "install-mac.command" ]; then
  main "$@"
fi
