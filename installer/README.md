# TestingPlatform setup installer — plain-language guide

## Download (the clean way)

You are looking at this file in the repo's `installer/` folder:
https://github.com/LUNCY579/TestingPlatform/tree/main/installer

Download only the file for your computer. Do not clone the repo
to get the installer — the installer itself clones the repo.

- **Mac:** in Terminal, in the folder where you want the installer:
  ```sh
  curl -O https://raw.githubusercontent.com/LUNCY579/TestingPlatform/main/installer/install-mac.sh
  chmod +x install-mac.sh
  ./install-mac.sh
  ```
  Or open the file page and use **Download raw file**:
  https://github.com/LUNCY579/TestingPlatform/blob/main/installer/install-mac.sh
- **Windows:** in PowerShell, in the folder where you want the
  installer:
  ```powershell
  Invoke-WebRequest -Uri https://raw.githubusercontent.com/LUNCY579/TestingPlatform/main/installer/install-windows.ps1 -OutFile install-windows.ps1
  Unblock-File .\install-windows.ps1
  powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
  ```
  Do not copy-paste the script text from a browser page into a
  file by hand — a browser save can add `.txt` or change line
  endings. Use the download command above, or the file page's
  **Download raw file** button:
  https://github.com/LUNCY579/TestingPlatform/blob/main/installer/install-windows.ps1


This installer only does setup. It gets TestingPlatform installed,
built, and started on your computer. It does not do anything else.
That is on purpose: setup is the part that was hard, so this fixes
setup only.

## Before you start

- You need an internet connection and a few minutes. The first
  install and build can take several minutes. Keep the terminal or
  PowerShell window open the whole time.
- The repo is public, so you do **not** need a GitHub account and
  you do **not** need anyone to grant you access. The installer
  clones it anonymously. It never asks you for a password, token,
  or key. If it ever asks for a login, stop: that means the repo
  is not public yet, and you should wait and try again later.
- You do **not** need to pick a model for the installer. The model
  a participant uses is recorded in their session log itself
  (the export contains the exact model id), so there is no separate
  model step at install time.

## Mac

1. Download `install-mac.sh` as shown in "Download" above.
2. Open Terminal. Go to the folder where you saved it. Then run:
   ```sh
   chmod +x install-mac.sh
   ./install-mac.sh
   ```
   Or, to double-click it instead: copy it to a file named
   `install-mac.command` and double-click that copy. If macOS
   blocks it, right-click it and choose Open.
3. The installer will check things, then install and build, then
   start the harness and print a URL (normally
   `http://127.0.0.1:3080`). That URL includes a login token:
   keep it private, do not share it.
4. Keep the Terminal window open while you use the harness.
   Press Ctrl+C to stop it.

To start again later, double-click `start-demo.command` inside
the TestingPlatform folder, or run from Terminal:
```sh
cd ~/Downloads/TestingPlatform
pnpm start
```

## Windows

1. Download `install-windows.ps1` as shown in "Download" above.
2. Note: double-clicking a `.ps1` file normally opens it in an
   editor instead of running it, and a downloaded script can also
   be blocked by Windows (execution policy / "downloaded from the
   internet" blocking). So run it this way, in PowerShell, in the
   folder where you saved it:
     ```powershell
     Unblock-File .\install-windows.ps1
     powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
     ```
   Right-click → **Run with PowerShell** is a fallback only: it
   can still be blocked by execution policy on a downloaded file,
   in which case use the two commands above.
3. The installer will check things, then install and build, then
   start the harness and print a URL (normally
   `http://127.0.0.1:3080`). That URL includes a login token:
   keep it private, do not share it.
4. Keep the PowerShell window open while you use the harness.
   Press Ctrl+C to stop it.

To start again later, double-click `start-demo.bat` inside the
TestingPlatform folder, or run from PowerShell:
```powershell
cd $env:USERPROFILE\Downloads\TestingPlatform
pnpm start
```

## Where it installs

By default, both installers use:

- Mac: `~/Downloads/TestingPlatform`
- Windows: `Downloads\TestingPlatform` in your user folder

If that folder already has a TestingPlatform checkout, the
installer updates it (fast-forward only) instead of cloning again.
If the folder already exists but is something else, the installer
stops and deletes nothing — pick another folder or move the old
one aside and run it again.

To use a different folder, pass it to the installer:

```sh
./install-mac.sh ~/MyFolder/TestingPlatform
```

```powershell
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -InstallDir "C:\Users\you\MyFolder\TestingPlatform"
```

## What the installer checks

| Check | Needed | If it fails, do this |
|---|---|---|
| macOS (Mac script) / Windows (PowerShell script) | The right script for your computer | Use the other script |
| Git | Version 2.26 or newer | Install or update Git, then re-run |
| Node | Version 24.9 or newer | See "Node problems" below |
| pnpm | Version 11.28.5 (the repo's pinned version) | The installer installs it with npm; if that fails, run `npm install --global pnpm@11.28.5` and re-run |
| Mac command-line developer tools | Present (the native addon needs a C compiler) | Run `xcode-select --install`, follow the prompt, then re-run |
| Repo checkout | `package.json` and `testing-platform/launcher.mjs` present | Re-run; if the folder is wrong, use a fresh folder |
| Native binding | A rolldown binding folder present after install | The installer forces one clean reinstall; if it is still missing, see below |
| Setup | `pnpm run setup` passes (build + check gates) | Do not start until setup passes; report the error |

## Node problems (the most common setup failure)

The installer will **not** silently change your Node for you.
If it stops on Node, read its message carefully:

- **Node is missing:** install Node 24 LTS from
  https://nodejs.org/en/download, then re-run the installer.
- **Node is too old (for example, Node 20):** install Node 24 LTS
  from the same page, make sure the Node 24 copy comes first on
  your PATH, then re-run. A common cause is an old Node copy
  (often from a conda "base" environment) shadowing the new one:
  the installer prints every Node copy it finds so you can see
  which one is winning.
- **After changing Node, the installer reinstalls cleanly:** it
  removes `node_modules` inside the TestingPlatform folder only
  and reinstalls. This is required, because `pnpm install` saying
  "Already up to date" does **not** prove the native binding is
  present — a binding can be missing after a Node switch even
  when install says that. The installer checks for the binding
  folder and forces a clean reinstall if it is absent.

Never delete `pnpm-lock.yaml`, and never run `npm i` inside this
repo. It is a pnpm repo.

## What the installer deliberately does NOT do

- It does not pick or test a model, run any task, or send any
  bundle. Those are separate steps after setup.
- It does not ask for, store, or send any password, token, key,
  or personal data.
- It does not change your global Node, your PATH, or any file
  outside the TestingPlatform folder (except installing the pinned
  pnpm globally when pnpm is missing or the wrong version, which
  is the repo README's own command).
- It does not delete your files. The only deletion is
  `node_modules` inside the TestingPlatform folder, on a Node
  version change, as described above.
- It does not run anything from inside `demo-target/`. All install
  and setup commands run from the repo root only. Running the
  harness from inside `demo-target/` fails with "Missing script:
  dev" — the installer never does that.

## If setup fails

1. Read the installer's last message. It tells you which step
   failed and what to try.
2. Do not keep re-running the same failing step and hoping it
   changes. In particular, a provider or model error later is not
   an install failure — the installer only proves the harness
   builds and starts.
3. Report three things: your computer type (Mac/Windows, chip),
   your Node version (`node --version`), and the installer's last
   error lines. Those three things are almost always enough to
   fix it.
