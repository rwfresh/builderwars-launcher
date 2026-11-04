# Builder Wars launcher (spike)

Tauri 2 desktop shell for Builder Wars (ARCHITECTURE.md §14). One window with three panes:

- **Terminal** (left): xterm.js wired to our own PTY commands over `portable-pty`. It runs your login shell (`$SHELL`, falling back to bash; PowerShell on Windows), or `herdr --session builderwars` when herdr mode is on. The toolbar under it has the agent picker, the herdr toggle, settings, a prompt box and the focus-cycle button.
- **Game** (center): `https://builderwars.ai/dashboard` in a **child webview**. It is not an iframe, so the site's cookies are first-party and "Sign in with X" works inside the pane.
- **X** (right): `https://x.com` in a **child webview**. A toggle switches it to the Grok chat URL. It has back and reload buttons.

The game and X webviews share one persistent profile (`<app local data>/web-profile`, which is `~/.local/share/ai.builderwars.launcher/web-profile` on Linux). You sign in to X once, and the login survives restarts.

![spike](docs/spike.png)

`docs/spike.png` is built from WebKit's own snapshots of the three webviews, composited at their real GTK positions. `grim` hangs on this machine, so I could not take a compositor screenshot.

## Run

```bash
pnpm --filter @builderwars/launcher tauri dev            # dev (Vite on :1420 + cargo run)
pnpm --filter @builderwars/launcher tauri build --no-bundle   # release binary
apps/launcher/src-tauri/target/release/builderwars-launcher   # run it
```

Options (CLI or env):

| | |
|---|---|
| `--url http://localhost:3000` or `BW_SITE_URL=...` | Game site URL. The bridge trusts only this origin. Precedence: `--url`, then env, then the setting, then `https://builderwars.ai`. |
| `BW_DATA_ROOT=dir` | Moves settings (`dir/config/settings.json`) and the web profile (`dir/web-profile`) into `dir`. Use it for tests or a second instance next to your real one. |
| `BW_REGISTER_DEEPLINK=1` | Registers `builderwars://` for this binary at startup (dev builds on Linux and Windows). AppImage builds always register. |
| `BW_USE_HERDR=0/1` | Overrides the herdr setting for this run (not saved). |
| `BW_KEEP_DMABUF=1` | Keeps WebKitGTK's DMA-BUF renderer. By default we set `WEBKIT_DISABLE_DMABUF_RENDERER=1`, because it crashed once here (Wayland + NVIDIA: `Error 71 (Protocol error)`). |
| `BW_AUTOTEST=1` | Self-test: types `claude --version`, calls `builderwarsLauncher.runPrompt('hello','claude')` from inside the game page, checks that the ACL denies a shell-only command from the site, drags a divider and collapses/expands X. Results go to stdout. |
| `BW_PTY_LOG=file`, `BW_SNAPSHOT_DIR=dir`, `BW_DEBUG_BOUNDS=1` | Spike diagnostics: raw PTY output, per-webview PNG snapshots with GTK allocations, child-webview bounds. |

Tests: `pnpm --filter @builderwars/launcher test` (vitest: agent CLI mapping and quoting, bridge init script and payloads, layout math) and `cargo test` in `src-tauri`.

## Bridge (site <-> launcher), v1

The launcher injects `src-tauri/src/bridge_init.js` as an initialization script into the **game webview only**. The script does nothing unless the top-level page is on the configured site origin, so an OAuth hop to x.com in that webview gets nothing. On the site origin it defines:

```ts
window.builderwarsLauncher = {
  version: 1, platform: "linux" | "macos" | "windows", agents: string[], defaultAgent: string | null, herdr: boolean,
  runPrompt(prompt: string, agent?: string | null): Promise<{ agent: string }>, // rejects with Error(message)
  openX(url?: string | null): Promise<void>,                                   // https://x.com URLs only
}
```

The TypeScript contract is `BuilderwarsLauncherApi` in `src/bridge.ts`.

**Transport: Tauri IPC from the remote origin.** At startup the launcher adds a runtime capability (`game-bridge`). It is scoped to the `game` webview plus `<site origin>/*` and grants exactly `allow-run-prompt` and `allow-open-x`. App commands are deny-by-default: `build.rs` declares them in an `AppManifest`. The shell's own capability (`capabilities/shell.json`) applies only to the local `shell` webview. Every shell command also checks the caller label. The self-test confirmed this: `pty_write` called from builderwars.ai is rejected with `not allowed on ... webview "game"`. I did not need the custom-scheme fallback.

How a prompt runs: Rust's `run_prompt` validates the prompt (non-empty, at most 16,000 chars, no NUL) and the agent id. It then emits `bridge:run-prompt` to the shell UI, which owns the terminal. The shell chooses the agent and **asks the player to confirm**. On Run it quotes the prompt and types the command (or dispatches it through herdr), then answers through `bridge_resolve`, which resolves the site's promise.

**Confirmation.** Every prompt from the site or from a deep link opens a "RUN PROMPT?" panel in the terminal column (never over the child webviews). The panel shows where the request came from, the agent, the work directory and the full prompt, with [Run] and [Cancel]. Cancel rejects the site's promise with `Error("Cancelled")`. For site prompts there is also an "Always allow prompts from builderwars.ai this session" checkbox, held in memory only. Deep links always ask. Several requests queue up. If the player never answers, the site's promise rejects after 5 minutes and the panel goes away. Prompts typed into the launcher's own prompt box run without asking.

## Deep links

`builderwars://run?prompt=<urlencoded>&agent=<claude|codex|gemini|grok|opencode>` (`agent` is optional) goes through the same confirmation (`src-tauri/src/deeplink.rs`).

- tauri-plugin-deep-link handles the scheme (`plugins.deep-link.desktop.schemes` in `tauri.conf.json`). tauri-plugin-single-instance with its `deep-link` feature forwards a link opened while the app is running to the running window and focuses it. On a cold start, the link that launched the app is read with `get_current()` and queued until the shell UI asks for it (`deeplink_take`).
- Registration: deb, rpm, MSI and NSIS register the scheme at install time, and macOS does it through the bundle's Info.plist (the app must be in /Applications; dev builds cannot receive links on macOS). AppImage registers at runtime. Dev builds on Linux and Windows register only with `BW_REGISTER_DEEPLINK=1`, because that writes a .desktop file or registry key pointing at the dev binary.
- Verified on Linux: launching `builderwars-launcher 'builderwars://run?prompt=...&agent=claude'` while the app runs forwards the link through single-instance, shows the confirmation, and on Run types `cd <work dir> && claude '...'`. Opening a link from a browser after installing the .deb is untested.

## Agents and herdr

- **Work directory.** Agents start in `~/BuilderWars` by default. The launcher creates it on first run with a README.md explaining what it is for, so Claude Code asks to trust it once. The toolbar shows the current directory, and its CHANGE button opens a native folder picker (tauri-plugin-dialog, called from Rust; no dialog permission is given to the webview). Settings also accept a typed path (`~/` is expanded). The terminal starts there, and every agent command is typed as `cd <dir> && <agent> ...` (`Set-Location -LiteralPath '<dir>'; ...` in PowerShell), so it starts in the right place even after you `cd` elsewhere. New herdr splits open there too.
- On startup the launcher reads `PATH` from your login shell, because desktop launchers often have a minimal one. It then detects `claude`, `codex`, `gemini`, `grok` and `opencode`.
- Initial-prompt syntax, verified on this machine: `claude "<p>"`, `codex "<p>"`, `gemini -i "<p>"`, `grok "<p>"`, `opencode --prompt "<p>"`. Prompts are cleaned (control and escape characters stripped, tabs turned into spaces) and quoted for POSIX shells, fish or PowerShell (`src/agents.ts`).
- Without herdr, the command is typed only when the shell is idle (the PTY's foreground process group is the shell). Otherwise the site gets "the terminal is busy".
- **herdr mode** (on by default when `herdr` is installed): the pane runs `herdr --session builderwars`, a dedicated session that never touches your default one. `HERDR_*` variables are stripped so it works even when the launcher itself was started inside herdr. To dispatch a prompt, the launcher calls `herdr pane list` to find the focused pane and `pane process-info` to check that its shell is idle. If it is busy, it calls `pane split --direction right`. Then `pane run <pane> "<agent command>"`.
- **Why not `agent start` + `agent prompt`:** `agent start` returns `agent_not_ready` when the CLI opens a first-run or trust dialog (Claude's "trust this folder?"), and the prompt would be lost. Passing the prompt as the CLI's initial argument survives those dialogs, and herdr still detects and tracks the agent ("blocked" or "idle").
- The herdr session keeps running after the launcher quits (that is how herdr works). Stop it with `herdr session stop builderwars`.

## Layout notes

- Child webviews always draw above the shell webview, so nothing of ours renders inside the pane rectangles. Settings take over the terminal column, and dropdowns live in the left toolbar.
- On Linux, Tauri packs child webviews into the window's GtkBox, where `set_bounds` does nothing. We re-parent them into `GtkOverlay { shell webview, GtkFixed(pass-through) { game, x } }` and position them ourselves (`panes.rs`).
- WebKitGTK scales CSS px by the desktop text scale (1.1 on this Wayland session, 1.0 under X11). Bounds from the shell are therefore converted with child-layer size divided by the shell viewport size.
- **F6** cycles focus (terminal, game, X). On Linux it is caught at the GtkWindow level, so it works while x.com has focus. Ctrl+` works from the shell. On macOS and Windows F6 only works while the shell has focus (follow-up: menu accelerator).

## What works (Linux, Omarchy/Hyprland, NVIDIA)

- PTY plus xterm, `claude --version` (2.1.316), and `runPrompt` typing `claude hello` (from the toolbar and from the site through the bridge), in both plain-shell and herdr mode.
- Game child webview loads builderwars.ai, the bridge round-trip works, and the ACL denies everything else.
- X child webview loads x.com (the login page renders). Page-load and title events reach the shell header. The cookie jar persists: the same `guest_id` came back after a restart. Back (native `webkit_web_view_go_back`), reload and the Grok/Home toggle are wired up.
- Confirmation: a site prompt shows the RUN PROMPT? panel in the terminal column, and Cancel makes the site's `runPrompt` reject with `Cancelled`. A deep link forwarded by a second launch shows the panel, and Run starts the agent.
- Work directory: created with its README on first run, the terminal starts in it, and commands are prefixed with `cd <dir> &&`. Tested with `BW_DATA_ROOT` and a scratch work dir, so `~/BuilderWars` was not created on this machine.
- Divider drag, collapse and expand reposition and resize the child webviews (checked against GTK allocations).
- Wayland (native) and X11 (`GDK_BACKEND=x11`, through Xwayland) both start. Dev and release builds both work.
- Idle CPU over 30 s for the whole process tree (launcher, 4 WebKit processes, shell or claude): about 0.9 % of one core.

## Not done / not verified

- **A human X login** has not been done yet. Persistence is inferred from WebKit's on-disk cookie jar (`web-profile/cookies`) surviving restarts.
- Clicking a real "Run in terminal" button on the site: the site side is still being built. The self-test calls the same `window.builderwarsLauncher.runPrompt` from inside the page.
- Settings save through the UI has not been run end to end. It is `settings_set`, which writes `~/.config/ai.builderwars.launcher/settings.json`.
- Under X11 with Omarchy's global `GDK_SCALE=2`, the window is 616 logical px wide, which is too narrow for the three-pane minimums. It works with `GDK_SCALE=1`.
- The CHANGE folder picker has not been clicked through (it opens a modal GTK dialog, which needs a human).
- The tray is behind the Cargo feature `tray`, which is off (`libayatana-appindicator` is not installed).

## Windows and macOS (untested)

The code below was written from the Tauri, wry and WebView2/WKWebView docs and source. It compiles: `cargo check` and `cargo clippy` pass for `x86_64-pc-windows-msvc` and `aarch64-apple-darwin` (the latter with `CC_aarch64_apple_darwin=clang`). It has never run on either OS.

- **Windows (WebView2).**
  - The PTY uses ConPTY (portable-pty) and runs `powershell.exe -NoLogo`.
  - Child webviews use Tauri's native `set_bounds`.
  - Native back calls `ICoreWebView2::GoBack` through `with_webview` + `controller().CoreWebView2()`.
  - Webview creation: Tauri's rule is that creating webviews from a *synchronous* command deadlocks on Windows. We create all three in `setup` and never from a command, so no command creates a webview. `pick_work_dir` is an async command, and the blocking folder dialog runs off the main thread, as the dialog plugin requires.
  - The game and X webviews share one `data_directory`, so they share one WebView2 environment (one user data folder). The shell webview uses the default folder.
  - Unverified: that WebView2 accepts two environments in one window without trouble, z-order of child webviews over the shell, and focus handling.
  - `pty_is_idle` always reports idle on Windows (there is no foreground process group), so a prompt can be typed into a busy terminal.
  - F6 works only while the shell has focus.
- **macOS (WKWebView).**
  - WKWebView ignores `data_directory`. On macOS 14+ the game and X webviews use a fixed `data_store_identifier` (one persistent `WKWebsiteDataStore` shared by both), so the X login is kept separate from the shell and survives restarts. On macOS 11-13 wry falls back to the default store, shared with the shell webview; the login still persists.
  - Native back sends `-goBack` to the WKWebView through objc2 `msg_send!`.
  - Deep links only reach the bundled app.
  - The login-shell PATH is read with `zsh -l -i -c`.
  - Gatekeeper blocks unsigned builds (right-click > Open, or set up signing).
- Both: run `pnpm tauri dev` on each OS before calling them supported.

## Packaging, CI and signing

`.github/workflows/launcher.yml` (tauri-apps/tauri-action) builds unsigned installers and uploads them to a **draft** GitHub Release:

| Runner | Artifacts |
|---|---|
| ubuntu-latest | deb, rpm, AppImage |
| windows-latest | msi, nsis |
| macos-latest | universal (arm64 + x86_64) .app and dmg |

Triggers:

```bash
git tag launcher-v0.1.0 && git push origin launcher-v0.1.0   # tag build
gh workflow run launcher.yml --ref main                        # manual; uses tag launcher-v<tauri.conf.json version>
gh run watch                                                   # follow it
```

A first job creates the draft release, or reuses it if one exists for the tag, so the three builds upload to one release. Publish it by hand on GitHub.

Optional secrets (Settings > Secrets and variables > Actions). Each group activates only when its secrets are present:

- macOS signing: `APPLE_CERTIFICATE` (base64 of the Developer ID Application .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (e.g. `Developer ID Application: Name (TEAMID)`).
- macOS notarization (needs the signing secrets as well): `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID`.
- Updater signatures: `TAURI_SIGNING_PRIVATE_KEY` (from `pnpm tauri signer generate`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. These turn on `bundle.createUpdaterArtifacts` and `latest.json`. The in-app updater (`tauri-plugin-updater` plus its public key) is still a follow-up.
- Windows stays unsigned until a code-signing certificate exists.
- Linux tray: enable `--features tray` once the build image has libayatana-appindicator.
- Icons in `src-tauri/icons` are generated placeholders (`tauri icon`).

## Security notes

- x.com gets no scripts of ours: no init script, no `eval`, no DOM access, no automation. We only set its bounds and navigate, go back or reload on a user click. Caveat: Tauri itself adds its IPC bootstrap (`__TAURI_INTERNALS__`) to every webview it creates, x.com included. No capability matches x.com, so every IPC call from there is denied. Electron would avoid even that injection.
- Pages on the site origin, and any page that opens a `builderwars://` link, can only *ask* to run a prompt. The player sees the full prompt and must press Run (site prompts can be allowed for the session). An XSS on builderwars.ai still gets as far as that dialog, so keep the site's CSP tight.
