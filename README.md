# Builder Wars launcher

Electron desktop shell for Builder Wars (ARCHITECTURE.md §14). One window with three panes:

- **Terminal** (left): xterm.js wired to a PTY (`node-pty`) in the main process. It runs your login shell (`$SHELL -l`, falling back to bash; PowerShell on Windows), or `herdr --session builderwars` when herdr mode is on. The toolbar under it has the agent picker, the herdr toggle, settings, a prompt box and the focus-cycle button.
- **Game** (center): `https://builderwars.ai/dashboard` in a `WebContentsView`. It is not an iframe, so the site's cookies are first-party and "Sign in with X" works inside the pane.
- **X** (right): `https://x.com` in a `WebContentsView`. A toggle switches it to the Grok chat URL. It has back and reload buttons.

The game and X panes share one persistent session partition, `persist:web`, stored under the app's userData folder (`~/.config/Builder Wars` on Linux, `~/Library/Application Support/Builder Wars` on macOS, `%APPDATA%\Builder Wars` on Windows). You sign in to X once, and the login survives restarts. Settings live next to it in `settings.json`.

## Run

```bash
pnpm --filter @builderwars/launcher dev        # electron-vite dev: renderer with HMR, main/preload rebuilt on change
pnpm --filter @builderwars/launcher build      # typecheck (renderer + electron tsconfigs) and electron-vite build -> out/
pnpm --filter @builderwars/launcher start      # run the built app (electron .)
pnpm --filter @builderwars/launcher test       # vitest: agent CLI mapping and quoting, bridge, layout math, main-process helpers
```

Build output: `out/main/index.js`, `out/preload/shell.js`, `out/preload/game.js`, `out/renderer/**`. To package locally, see [Packaging](#packaging-ci-and-signing).

Options (CLI or env):

| | |
|---|---|
| `--url http://localhost:3000` or `BW_SITE_URL=...` | Game site URL. The bridge trusts only this origin. Precedence: `--url`, then env, then the setting, then `https://builderwars.ai`. In dev the env form is simplest: `BW_SITE_URL=http://localhost:3000 pnpm --filter @builderwars/launcher dev`. |
| `BW_DATA_ROOT=dir` | Moves userData (settings, the `persist:web` profile, the single-instance lock) into `dir`. Use it for tests or a second instance next to your real one. |
| `BW_REGISTER_DEEPLINK=1` | Registers `builderwars://` for this binary at startup in dev builds. Packaged builds always register at runtime too. |
| `BW_USE_HERDR=0/1` | Overrides the herdr setting for this run (not saved). |
| `BW_AUTOTEST=1` | Self-test: once the site has loaded, calls `builderwarsLauncher` from inside the game page (empty prompt and foreign `openX` must be rejected, `runPrompt('hello','claude')` goes through the confirmation) and prints `[autotest]` lines to stdout. |
| `BW_PTY_LOG=file` | Appends raw PTY output to `file`. |
| `BW_SNAPSHOT_DIR=dir`, `BW_DEBUG_BOUNDS=1`, `BW_DEVTOOLS=1` | Diagnostics: PNG snapshots of the shell and game views during the self-test (never the X pane), pane bounds logging, detached DevTools for the shell. |

## Bridge (site <-> launcher), v1

The contract is unchanged from the first launcher: the site code (`apps/web/lib/launcher-bridge.ts`) works as before. The TypeScript type is `BuilderwarsLauncherApi` in `src/bridge.ts`; the process/IPC contract is `electron/shared/contract.ts`.

`electron/preload/game.ts` is the preload of the **game view only**. It defines the global only when the top-level document is on the configured site origin, so an OAuth hop to x.com in that view (or a sign-in popup that inherits the preload) gets nothing:

```ts
window.builderwarsLauncher = {
  version: 1, platform: "linux" | "macos" | "windows", agents: string[], defaultAgent: string | null, herdr: boolean,
  runPrompt(prompt: string, agent?: string | null): Promise<{ agent: string }>, // rejects with Error(message)
  openX(url?: string | null): Promise<void>,                                   // https://x.com URLs only
}
```

**Transport: `ipcRenderer.invoke` on two channels** (`bridge:run-prompt`, `bridge:open-x`). The main process (`electron/main/ipc.ts`) re-checks every call: the sender must be the game view's webContents, `senderFrame` must be its top frame, and that frame's origin must be the site origin. Payloads are validated with zod. Shell channels (PTY, settings, panes, herdr, deep links) accept calls only from the shell renderer's webContents, so the site cannot reach them even if it found a way to call `ipcRenderer`.

How a prompt runs: main validates the prompt (non-empty, at most 16,000 chars, no NUL) and the agent id, then sends it to the shell UI, which owns the terminal. The shell chooses the agent and **asks the player to confirm**. On Run it quotes the prompt and types the command (or dispatches it through herdr), then answers through `bridge:resolve`, which resolves the site's promise.

**Confirmation.** Every prompt from the site or from a deep link opens a "RUN PROMPT?" panel in the terminal column (never over the web panes). The panel shows where the request came from, the agent, the work directory and the full prompt, with [Run] and [Cancel]. Cancel rejects the site's promise with `Error("Cancelled")`. For site prompts there is also an "Always allow prompts from builderwars.ai this session" checkbox, held in memory only. Deep links always ask. Several requests queue up. If the player never answers, the site's promise rejects after 5 minutes and the panel goes away. Prompts typed into the launcher's own prompt box run without asking.

## Deep links

`builderwars://run?prompt=<urlencoded>&agent=<claude|codex|gemini|grok|opencode>` (`agent` is optional) goes through the same confirmation (`electron/main/deeplink.ts`).

- The single-instance lock forwards a link opened while the app runs (`second-instance` argv on Linux and Windows, `open-url` on macOS) to the running window and focuses it. On a cold start the link from argv (or `open-url`) is queued until the shell UI asks for it (`deeplink:take`).
- Registration: deb and rpm write `MimeType=x-scheme-handler/builderwars` into the .desktop file, the NSIS installer writes `HKCU\Software\Classes\builderwars` (`build/installer.nsh`), and the macOS bundle declares it in `CFBundleURLTypes` (the app must be in /Applications; dev builds cannot receive links on macOS). Packaged builds also call `app.setAsDefaultProtocolClient` at startup. An AppImage has no install step, so on Linux it receives links only once it is integrated into the desktop (for example by AppImageLauncher); untested. Dev builds register only with `BW_REGISTER_DEEPLINK=1`, because that points the OS at the dev binary.

## Agents and herdr

- **Work directory.** Agents start in `~/BuilderWars` by default. The launcher creates it on first run with a README.md explaining what it is for, so Claude Code asks to trust it once. The toolbar shows the current directory, and its CHANGE button opens a native folder picker (Electron `dialog`, called from main). Settings also accept a typed path (`~/` is expanded). The terminal starts there, and every agent command is typed as `cd <dir> && <agent> ...` (`Set-Location -LiteralPath '<dir>'; ...` in PowerShell), so it starts in the right place even after you `cd` elsewhere. New herdr splits open there too.
- On startup the launcher reads `PATH` from your login shell, because desktop launchers often have a minimal one. It then detects `claude`, `codex`, `gemini`, `grok` and `opencode`.
- Initial-prompt syntax: `claude "<p>"`, `codex "<p>"`, `gemini -i "<p>"`, `grok "<p>"`, `opencode --prompt "<p>"`. Prompts are cleaned (control and escape characters stripped, tabs turned into spaces) and quoted for POSIX shells, fish or PowerShell (`src/agents.ts`).
- Without herdr, the command is typed only when the shell is idle (the PTY's foreground process group is the shell). Otherwise the site gets "the terminal is busy".
- **herdr mode** (on by default when `herdr` is installed): the pane runs `herdr --session builderwars`, a dedicated session that never touches your default one. `HERDR_*` variables are stripped so it works even when the launcher itself was started inside herdr. To dispatch a prompt, the launcher calls `herdr pane list` to find the focused pane and `pane process-info` to check that its shell is idle. If it is busy, it calls `pane split --direction right`. Then `pane run <pane> "<agent command>"`.
- **Why not `agent start` + `agent prompt`:** `agent start` returns `agent_not_ready` when the CLI opens a first-run or trust dialog (Claude's "trust this folder?"), and the prompt would be lost. Passing the prompt as the CLI's initial argument survives those dialogs, and herdr still detects and tracks the agent ("blocked" or "idle").
- **One pane per launch.** herdr keeps sessions alive in a background server and restores every pane on reattach, so without intervention each launch would reopen all the splits earlier prompts created. The launcher therefore runs `herdr session stop builderwars` + `session delete builderwars` before starting the terminal and stops the session again on quit. Agents end with the launcher, like in a normal terminal. (A "keep the session between launches" setting is a possible follow-up.)

## New windows and sign-in popups

`window.open` and `target=_blank` requests from either pane go through `setWindowOpenHandler` and `classifyNewWindow` (`electron/main/urls.ts`):

- **In-app "Sign in" popup** for Google (`google.com`, `*.google.com`), Apple (`apple.com`, `*.apple.com`), `api.x.com` / `api.twitter.com`, `about:blank`, and x.com requests that carry popup features (a size or position).
  - The popup is a real Chromium child window of the opener. It shares the opener's session (cookies), and `window.opener` / `postMessage` work exactly as in Chrome.
  - It closes when the page calls `window.close()`. Windows it tries to open itself go to the system browser.
  - Popups from the X pane get no preload. Popups from the game view inherit its preload, which defines nothing unless the popup's top frame is on the site origin, and main answers bridge calls from the game view itself only.
- **x.com / twitter.com links** load in the X pane (and the X pane is revealed if it was collapsed).
- **The site's own pages** (`target=_blank` in the game pane) load in the game pane.
- **Everything else** goes to the system browser. Non-http(s) schemes are dropped.

Same-window navigations are never diverted, so the site's "Sign in with X" redirect to x.com and back stays inside the game pane. The game pane's HOME button returns to the site origin from a dead end.

Each decision is logged as `[pane] new-window <scheme://host> -> popup|navigate-x|navigate-self|external|deny`. Page-load logs also print only scheme and host, because full URLs can carry OAuth codes.

**Why Electron.** The first launcher used Tauri 2 (WebKitGTK on Linux). There, X's "Continue with Google" never completes: Google's popup and hand-back finish, then x.com logs `Input2SSO: Unsupported provider` and drops the credential. No WebKit setting changed that. In Chromium the same flow behaves like Chrome. The web session's user agent is Chromium's default minus the `Electron/...` and app tokens, because Google refuses sign-in to user agents that advertise an embedded app.

**First-time Google sign-in (verified Nov 4 2026, Linux).** On a profile with no Google session yet, the first "Continue with Google" walks Google's full sign-in pages inside the popup; one of them enforces `Cross-Origin-Opener-Policy: same-origin`, which detaches the popup from x.com for good (Chromium logs "Cross-Origin-Opener-Policy policy would block the window.postMessage call"), so X stays signed out even though Google finished. The Google session is now in the shared `persist:web` profile, and the next click goes account chooser -> consent -> hand-back and signs X in. Clicking the button twice on first use is expected; nothing in the launcher can shorten that without touching Google's or X's pages.

## Layout notes

- The web panes are `WebContentsView`s added on top of the shell renderer. The shell renders placeholder boxes and sends their rectangles through `pane:bounds`. The shell's CSS px equal the window's DIPs, so the rectangles are used as they are, with no scale conversion. A collapsed or tiny pane is hidden with `setVisible(false)`.
- Views always draw above the shell, so nothing of ours renders inside the pane rectangles. Settings take over the terminal column, and dropdowns live in the left toolbar.
- **F6** cycles focus (terminal, game, X). It is caught with `before-input-event` on every webContents, including x.com, so it works whichever pane has focus. Ctrl+` works from the shell.
- No platform-specific window hacks: the same code positions the views on Linux (Wayland and X11), Windows and macOS.

## Security notes

- Every renderer (shell, game, X, popups) runs with `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`. The shell only navigates to its own bundle and cannot open windows. Its production page carries a strict CSP.
- IPC authorization as described in [Bridge](#bridge-site---launcher-v1): shell channels check the sender webContents, and bridge channels check the sender, top frame and site origin. All payloads go through zod.
- x.com gets nothing of ours: no preload, no `executeJavaScript`, no DOM, cookie or console access, no automation, no snapshots. We only set its bounds, load URLs, and go back or reload on a user click.
- The web session denies sensitive permission requests (camera and microphone, location, notifications, MIDI, HID, serial, USB, screen capture).
- Pages on the site origin, and any page that opens a `builderwars://` link, can only *ask* to run a prompt. The player sees the full prompt and must press Run (site prompts can be allowed for the session). An XSS on builderwars.ai still gets as far as that dialog, so keep the site's CSP tight.

## Packaging, CI and signing

Config: `electron-builder.yml`. Icons and installer resources: `build/` (`icon.png` 512 px, `icon.icns`, `icon.ico`, `entitlements.mac.plist`, `installer.nsh`). Output: `release/`.

| Platform | Artifacts |
|---|---|
| Linux (x64) | AppImage, deb, rpm (`builderwars-launcher`, category Game) |
| Windows (x64) | NSIS installer, per-user (no admin prompt) |
| macOS | one dmg per arch, x64 and arm64 (not universal: node-pty ships per-arch prebuilds, and each dmg is half the size) |

Package locally (after `build`):

```bash
cd apps/launcher
pnpm exec electron-builder --linux --publish never   # deb/rpm: see the note below
pnpm exec electron-builder --mac --publish never     # on a Mac; add -c.mac.identity=- for an ad-hoc signed build
pnpm exec electron-builder --win --publish never     # on Windows
pnpm exec electron-builder --linux dir               # unpacked app in release/linux-unpacked, quickest check
```

`node-pty` is an N-API addon, so it is not rebuilt for Electron (`npmRebuild: false`): macOS and Windows use the prebuilds in the package, and Linux uses the binary compiled by `pnpm install`. electron-builder 26 collects production dependencies through `pnpm list`, so the workspace's default isolated `node_modules` works without hoisting.

For deb and rpm, electron-builder runs its bundled fpm, whose Ruby needs `libcrypt.so.1` (on Arch: `libxcrypt-compat`); rpm also needs `rpmbuild` (the `rpm` package). The AppImage has no such needs. The AppImage's .desktop entry does not force `--no-sandbox` (`appImage.executableArgs: []`), so Chromium's sandbox stays on wherever unprivileged user namespaces work, and AppRun falls back to `--no-sandbox` only where they do not. The deb's post-install script sets up `chrome-sandbox` as usual.

`.github/workflows/launcher.yml` builds the installers and uploads them to a **draft** GitHub Release:

```bash
git tag launcher-v0.1.0 && git push origin launcher-v0.1.0   # tag build
gh workflow run launcher.yml --ref main                        # manual; uses tag launcher-v<package.json version>; -f platforms=linux|windows|macos
gh run watch                                                   # follow it
```

A first job creates the draft release, or reuses it if one exists for the tag. Each platform job then runs `pnpm install --frozen-lockfile`, `pnpm --filter @builderwars/launcher build` and `electron-builder --<platform> --publish never`, and uploads `release/*` with `gh release upload --clobber`. Electron and electron-builder downloads are cached. Publish the release by hand on GitHub.

Optional secrets (Settings > Secrets and variables > Actions). Builds are unsigned without them, and the macOS app is then ad-hoc signed (Gatekeeper blocks it: right-click > Open, or `xattr -dr com.apple.quarantine "/Applications/Builder Wars.app"`). The Tauri-era secret names keep working:

| electron-builder env | Repository secret (new name, or old name) | Purpose |
|---|---|---|
| `CSC_LINK` | `CSC_LINK` or `APPLE_CERTIFICATE` | base64 of the Developer ID Application .p12 |
| `CSC_KEY_PASSWORD` | `CSC_KEY_PASSWORD` or `APPLE_CERTIFICATE_PASSWORD` | its password |
| `CSC_NAME` | `APPLE_SIGNING_IDENTITY` (optional) | picks the certificate; the `Developer ID Application: ` prefix is stripped |
| `APPLE_ID` | `APPLE_ID` | notarization (needs signing as well) |
| `APPLE_APP_SPECIFIC_PASSWORD` | `APPLE_APP_SPECIFIC_PASSWORD` or `APPLE_PASSWORD` | notarization, app-specific password |
| `APPLE_TEAM_ID` | `APPLE_TEAM_ID` | notarization |
| (none) | `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | no longer used; delete them |

Signed builds use the hardened runtime with `build/entitlements.mac.plist`. Windows stays unsigned until a code-signing certificate exists (SmartScreen warns on first run).

## Platform notes

- **Linux** is the development platform (Omarchy/Hyprland, Wayland; X11 through Xwayland). The unpacked build and the AppImage were packaged and started here (PTY, game and X panes load). The deb and rpm builds have not been produced locally yet (see the fpm note above).
- **Windows and macOS are untested at runtime.** CI builds them, but nobody has run them yet. Known differences: on Windows the PTY is ConPTY running `powershell.exe -NoLogo`, and `pty:is-idle` always reports idle (there is no foreground process group), so a prompt can be typed into a busy terminal. On macOS the login-shell PATH comes from `$SHELL -l -i`, an application menu provides the standard edit shortcuts, and deep links reach only the installed bundle.

## Follow-ups

- **Updater:** add `electron-updater` and call `autoUpdater.checkForUpdatesAndNotify()` from main, and add a `zip` mac target (Squirrel.Mac needs it). `publish` in `electron-builder.yml` already points at this repo's releases with the `launcher-v` tag prefix, and CI already uploads `latest*.yml` and blockmaps. If the repo stays private, the updater needs a public feed (a `generic` provider) instead.
- **Tray icon** and level-up notifications (game-design-notes.md, "Extras").
- **Windows code signing** once a certificate exists (electron-builder `win.signtoolOptions` or Azure Trusted Signing).
- Electron fuses (`electronFuses`): keep `runAsNode` on, because node-pty on Windows forks a helper with `child_process.fork`.
