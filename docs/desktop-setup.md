# Desktop App Setup (Tauri v2)

The desktop wrapper wraps the existing web app in a native window with system tray support and OS notifications. All code is in place but **cannot compile yet** — the MSVC C++ build tools are missing.

## What's Already Done

- Tauri v2 project initialized at `packages/desktop/`
- System tray with Show/Quit context menu (`src-tauri/src/lib.rs`)
- Minimize-to-tray on window close (close button hides instead of quitting)
- OS notifications via `tauri-plugin-notification` (fires on `session_completed` and `workspace_merged` board events)
- Client-side Tauri detection in `packages/client/src/lib/desktop.ts` (graceful no-op in browser)
- Root `package.json` has `dev:desktop` script that runs server + client + tauri concurrently
- Placeholder icons in `packages/desktop/src-tauri/icons/`

## Prerequisites

### 1. Rust (installed)

Rust is already installed via scoop. Verify:

```powershell
rustc --version
cargo --version
```

If missing: `scoop install rustup` then run `rustup-init.exe` and restart terminal.

### 2. MSVC C++ Build Tools (MISSING)

Tauri compiles Rust to native Windows code, which requires the MSVC linker (`link.exe`) from Visual Studio. Your VS 2022 Community installation is missing the C++ workload.

**Check if installed:**

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" `
  -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  -property installationPath
```

If this returns nothing, the tools are not installed.

**Install option A — modify existing VS 2022 Community (recommended):**

Open an **elevated** PowerShell (Run as Administrator) and run:

```powershell
& "C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe" modify `
  --installPath "C:\Program Files\Microsoft Visual Studio\2022\Community" `
  --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  --add Microsoft.VisualStudio.Component.Windows11SDK.22000 `
  --passive --norestart
```

This opens the VS Installer and adds the C++ workload. It takes ~5-10 minutes.

**Install option B — standalone Build Tools via scoop:**

```powershell
scoop install extras/visualstudio2022-buildtools
# Then add the C++ workload:
& "C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe" modify `
  --installPath "C:\Program Files\Microsoft Visual Studio\2022\BuildTools" `
  --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  --add Microsoft.VisualStudio.Component.Windows11SDK.22000 `
  --passive --norestart
```

**Install option C — via Visual Studio Installer GUI:**

1. Open "Visual Studio Installer" from Start Menu
2. Click "Modify" on Visual Studio Community 2022
3. Check "Desktop development with C++" workload
4. Click "Modify" and wait for installation

### 3. WebView2 (pre-installed on Windows 11)

Windows 11 includes WebView2 out of the box. On Windows 10, you may need to install it from https://developer.microsoft.com/en-us/microsoft-edge/webview2/

## Building and Running

### Development

Start all three processes (server, client, Tauri):

```powershell
pnpm dev:desktop
```

Or start them individually for more control:

```powershell
# Terminal 1 — server (port 3001)
pnpm dev:server

# Terminal 2 — client (port 5173, Vite dev server)
pnpm dev:client

# Terminal 3 — Tauri (opens native window pointed at localhost:5173)
pnpm --filter @agentic-kanban/desktop dev
```

Tauri's `dev` command compiles the Rust code first (~2-3 min on first run, ~30s after that) then opens a native window loading `http://localhost:5173`.

### Production Build

```powershell
# Build the client first
pnpm build

# Then build the Tauri app (produces installer in src-tauri/target/release/bundle/)
pnpm --filter @agentic-kanban/desktop build
```

## File Structure

```
packages/desktop/
  package.json              # npm package with tauri scripts
  src-tauri/
    Cargo.toml              # Rust dependencies
    tauri.conf.json         # Tauri config (window size, tray, dev URL)
    build.rs                # Tauri build script
    capabilities/
      default.json          # Permissions: notification, shell
    src/
      main.rs               # Entry point
      lib.rs                # App setup: tray, plugins, minimize-to-tray
    icons/
      icon.png              # Tray icon (32x32 placeholder)
      icon.ico              # Windows icon
      32x32.png, 128x128.png, 128x128@2x.png  # Bundle icons

packages/client/src/lib/
  desktop.ts                # Tauri detection + notification helper (no-op in browser)

packages/client/src/routes/
  BoardPage.tsx             # Wires board events to sendDesktopNotification()
```

## What to Verify After Setup

1. **Compilation**: `cargo check` in `packages/desktop/src-tauri/` should pass with no errors
2. **System tray icon**: Appears in Windows taskbar notification area with "Agentic Kanban" tooltip
3. **Tray context menu**: Right-click shows "Show" and "Quit" options
4. **Show**: Restores and focuses the window if hidden
5. **Quit**: Exits the app completely (`app.exit(0)`)
6. **Minimize to tray**: Clicking the window X button hides the window instead of quitting
7. **Notifications**: When an agent session completes, a Windows notification appears with "Agent session completed"

## Troubleshooting

### `link.exe not found`

MSVC tools not installed. See [Prerequisites > MSVC C++ Build Tools](#2-msvc-c-build-tools-missing) above.

### `cargo` not found

Rust not in PATH. Run `rustup-init.exe` from `~\scoop\shims\` or reinstall via `scoop install rustup`.

### Window opens but shows blank page

The Vite dev server isn't running. Make sure `pnpm dev:client` is running on port 5173 before starting Tauri. The `pnpm dev:desktop` script handles this automatically.

### Notifications don't appear

Windows notification settings may be blocking the app. Go to Settings > System > Notifications and ensure notifications are enabled. On first run, Tauri requests notification permission — grant it when prompted.

### Icons look wrong

The current icons are simple placeholders (blue square with white columns). Replace the files in `packages/desktop/src-tauri/icons/` with proper icons. The required sizes are listed in `tauri.conf.json` under `bundle.icon`.
