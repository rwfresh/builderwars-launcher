mod bridge;
mod deeplink;
mod envinfo;
mod herdr;
mod panes;
mod pty;
mod settings;

use bridge::{Bridge, SiteOrigin};
use envinfo::EnvInfo;
use panes::{GAME, SHELL, XPANE};
use pty::{PtyEvent, PtyState};
use serde::Serialize;
use settings::Settings;
use std::sync::Mutex;
use tauri::ipc::{CapabilityBuilder, Channel};
use tauri::webview::WebviewBuilder;
use tauri::window::WindowBuilder;
use std::path::PathBuf;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewUrl};
#[cfg(target_os = "linux")]
use tauri::Emitter;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;

pub struct AppState {
    env: EnvInfo,
    site_url: String,
    site_origin: String,
    home: PathBuf,
    settings: Mutex<Settings>,
}

impl AppState {
    /// The agents' work directory, created on demand; falls back to home if it cannot be created.
    fn work_dir(&self) -> PathBuf {
        let dir = settings::work_dir(&self.settings.lock().unwrap(), &self.home);
        settings::ensure_work_dir(&dir).unwrap_or_else(|e| {
            eprintln!("[launcher] work dir: {e}; using home");
            self.home.clone()
        })
    }
}

/// Every command except run_prompt/open_x is for the shell UI only. The ACL already restricts
/// them (capabilities/shell.json is scoped to the `shell` webview, the remote game capability only
/// grants the two bridge commands, x.com gets nothing); this check is defence in depth.
pub fn require_shell(webview: &Webview) -> Result<(), String> {
    if webview.label() == SHELL { Ok(()) } else { Err("not allowed".into()) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherInfo {
    env: EnvInfo,
    settings: Settings,
    site_url: String,
    site_origin: String,
    work_dir: String,
    home: String,
    autotest: bool,
}

#[tauri::command]
fn launcher_info(webview: Webview, state: State<'_, AppState>) -> Result<LauncherInfo, String> {
    require_shell(&webview)?;
    // Separate statements: a lock guard temporary inside the struct literal would live until the
    // end of the expression and deadlock with work_dir()'s lock.
    let settings = state.settings.lock().unwrap().clone();
    let work_dir = state.work_dir();
    Ok(LauncherInfo {
        env: state.env.clone(),
        settings,
        site_url: state.site_url.clone(),
        site_origin: state.site_origin.clone(),
        work_dir: work_dir.to_string_lossy().into_owned(),
        home: state.home.to_string_lossy().into_owned(),
        autotest: std::env::var("BW_AUTOTEST").is_ok_and(|v| v == "1"),
    })
}

/// Shell-only: print a line to the launcher's stdout (spike diagnostics; the webview console is not
/// visible in `tauri dev` on Linux without opening devtools).
#[tauri::command]
fn debug_log(webview: Webview, msg: String) -> Result<(), String> {
    require_shell(&webview)?;
    println!("[shell] {}", msg.chars().take(500).collect::<String>());
    Ok(())
}

#[tauri::command]
fn settings_set(app: AppHandle, webview: Webview, state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    require_shell(&webview)?;
    settings::parse_site_url(&settings.site_url)?;
    panes::parse_x_url(&settings.grok_url)?;
    if let Some(a) = &settings.default_agent {
        bridge::validate_agent(a)?;
    }
    if settings.work_dir.as_deref().is_some_and(|d| !d.trim().is_empty()) {
        let dir = settings::work_dir(&settings, &state.home);
        if !dir.is_absolute() {
            return Err("work directory must be an absolute path (or start with ~/)".into());
        }
        settings::ensure_work_dir(&dir)?;
    }
    settings::save(&app, &settings)?;
    *state.settings.lock().unwrap() = settings;
    Ok(())
}

/// Shell-only: native folder picker for the work directory; saves the setting. None = cancelled.
#[tauri::command]
async fn pick_work_dir(app: AppHandle, webview: Webview) -> Result<Option<String>, String> {
    require_shell(&webview)?;
    let state = app.state::<AppState>();
    let current = state.work_dir();
    let picked = app
        .dialog()
        .file()
        .set_title("Builder Wars work directory")
        .set_directory(&current)
        .blocking_pick_folder();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let dir = settings::ensure_work_dir(&path)?;
    let mut s = state.settings.lock().unwrap().clone();
    s.work_dir = Some(dir.to_string_lossy().into_owned());
    settings::save(&app, &s)?;
    *state.settings.lock().unwrap() = s;
    Ok(Some(dir.to_string_lossy().into_owned()))
}

#[tauri::command]
fn pty_spawn(
    webview: Webview,
    pty: State<'_, PtyState>,
    state: State<'_, AppState>,
    mode: String,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    require_shell(&webview)?;
    let cwd = state.work_dir();
    let r = pty.spawn(&mode, cols.max(2), rows.max(2), &cwd, on_event);
    println!("[pty] spawn mode={mode} {cols}x{rows} -> {r:?}");
    r
}

#[tauri::command]
fn pty_write(webview: Webview, pty: State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    require_shell(&webview)?;
    pty.write(id, &data)
}

#[tauri::command]
fn pty_resize(webview: Webview, pty: State<'_, PtyState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    require_shell(&webview)?;
    pty.resize(id, cols.max(2), rows.max(2))
}

#[tauri::command]
fn pty_kill(webview: Webview, pty: State<'_, PtyState>, id: u32) -> Result<(), String> {
    require_shell(&webview)?;
    println!("[pty] kill {id}");
    pty.kill(id)
}

#[tauri::command]
fn pty_is_idle(webview: Webview, pty: State<'_, PtyState>, id: u32) -> Result<bool, String> {
    require_shell(&webview)?;
    pty.is_idle(id)
}

#[tauri::command]
async fn herdr_dispatch(webview: Webview, state: State<'_, AppState>, command: String) -> Result<herdr::Dispatch, String> {
    require_shell(&webview)?;
    let cwd = state.work_dir();
    tauri::async_runtime::spawn_blocking(move || herdr::dispatch(&command, &cwd))
        .await
        .map_err(|e| e.to_string())?
}

fn pane_label(pane: &str) -> Result<&'static str, String> {
    match pane {
        "game" => Ok(GAME),
        "xpane" | "x" => Ok(XPANE),
        _ => Err("unknown pane".into()),
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn pane_bounds(
    app: AppHandle,
    webview: Webview,
    pane: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport_width: f64,
    viewport_height: f64,
    visible: bool,
) -> Result<(), String> {
    require_shell(&webview)?;
    let wv = app.get_webview(pane_label(&pane)?).ok_or("pane missing")?;
    if std::env::var("BW_DEBUG_BOUNDS").is_ok() {
        println!("[pane_bounds] {pane} {x},{y} {width}x{height} visible={visible}");
    }
    if !visible || width < 2.0 || height < 2.0 {
        return wv.hide().map_err(|e| e.to_string());
    }
    panes::set_bounds(&wv, x, y, width, height, (viewport_width, viewport_height))?;
    wv.show().map_err(|e| e.to_string())
}

#[tauri::command]
fn pane_nav(app: AppHandle, webview: Webview, state: State<'_, AppState>, pane: String, action: String, url: Option<String>) -> Result<(), String> {
    require_shell(&webview)?;
    let label = pane_label(&pane)?;
    let wv = app.get_webview(label).ok_or("pane missing")?;
    match action.as_str() {
        "back" => panes::go_back(&wv),
        "reload" => wv.reload().map_err(|e| e.to_string()),
        "go" => {
            let raw = url.ok_or("missing url")?;
            let target: Url = if label == XPANE {
                panes::parse_x_url(&raw)?
            } else {
                let u: Url = raw.parse().map_err(|_| "invalid URL")?;
                if u.origin().ascii_serialization() != state.site_origin {
                    return Err("game pane only navigates within the site".into());
                }
                u
            };
            wv.navigate(target).map_err(|e| e.to_string())
        }
        _ => Err("unknown action".into()),
    }
}

#[tauri::command]
fn pane_focus(app: AppHandle, webview: Webview, pane: String) -> Result<(), String> {
    require_shell(&webview)?;
    let label = if pane == "terminal" { SHELL } else { pane_label(&pane)? };
    app.get_webview(label).ok_or("pane missing")?.set_focus().map_err(|e| e.to_string())
}

/// BW_AUTOTEST=1: exercise the bridge from inside the game webview once the site has loaded:
/// (a) a forbidden shell-only command must be denied by the ACL, (b) runPrompt must succeed.
fn autotest_bridge(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(8));
        let Some(game) = app.get_webview(GAME) else { return };
        let js = r#"
          window.__bwTest = { api: typeof window.builderwarsLauncher, origin: location.origin };
          window.__TAURI_INTERNALS__.invoke('pty_write', { id: 1, data: 'echo SHOULD-NOT-RUN\r' })
            .then(function () { window.__bwTest.ptyWrite = 'ALLOWED (BAD)'; },
                  function (e) { window.__bwTest.ptyWrite = 'denied: ' + String(e); });
          if (window.builderwarsLauncher) {
            window.__bwTest.info = { agents: window.builderwarsLauncher.agents, herdr: window.builderwarsLauncher.herdr, platform: window.builderwarsLauncher.platform };
            window.builderwarsLauncher.runPrompt('hello', 'claude')
              .then(function (r) { window.__bwTest.runPrompt = 'ok ' + r.agent; },
                    function (e) { window.__bwTest.runPrompt = 'error ' + e.message; });
          }
        "#;
        let _ = game.eval(js);
        std::thread::sleep(std::time::Duration::from_secs(6));
        let _ = game.eval_with_callback("JSON.stringify(window.__bwTest)", |r| println!("[autotest] game bridge result {r}"));
        #[cfg(target_os = "linux")]
        if let Ok(dir) = std::env::var("BW_SNAPSHOT_DIR") {
            std::thread::sleep(std::time::Duration::from_secs(4));
            panes::debug_snapshot(&app, dir);
        }
        // The shell's autotest answers the confirmation later; read the site's result again.
        std::thread::sleep(std::time::Duration::from_secs(12));
        let _ = game.eval_with_callback("JSON.stringify(window.__bwTest)", |r| println!("[autotest] game bridge result (after confirm) {r}"));
    });
}

/// BW_AUTOTEST_POPUP=1: from our own site in the game pane, open (a) an about:blank popup that
/// posts a message to its opener and closes itself, and (b) an accounts.google.com popup that the
/// opener closes. Proves popups stay in-app, keep window.opener, and close.
fn autotest_popup(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(8));
        let Some(game) = app.get_webview(GAME) else { return };
        let js = r#"
          window.__bwPopup = {};
          window.addEventListener('message', function (e) { if (e.data === 'bw-popup-hello') window.__bwPopup.message = 'received from popup (opener works)'; });
          var w = window.open('about:blank', '_blank', 'width=500,height=600');
          window.__bwPopup.blankOpened = !!w;
          if (w) {
            w.document.write('<title>bw popup test</title><p>popup test</p><script>window.opener.postMessage("bw-popup-hello", "*"); setTimeout(function () { window.close(); }, 1500);<\/script>');
            w.document.close();
          }
          setTimeout(function () { window.__bwPopup.blankClosedItself = w ? w.closed : null; }, 4000);
          var g = window.open('https://accounts.google.com/', '_blank', 'width=500,height=600');
          window.__bwPopup.googleOpened = !!g;
          setTimeout(function () { window.__bwPopup.googleOpenAfter5s = g ? !g.closed : null; if (g) g.close(); }, 5000);
          setTimeout(function () { window.__bwPopup.googleClosedByOpener = g ? g.closed : null; }, 7000);
        "#;
        let _ = game.eval(js);
        std::thread::sleep(std::time::Duration::from_secs(4));
        let windows: Vec<String> = app.webview_windows().keys().cloned().collect();
        println!("[autotest] popup windows at +4s: {windows:?}");
        std::thread::sleep(std::time::Duration::from_secs(5));
        let windows: Vec<String> = app.webview_windows().keys().cloned().collect();
        println!("[autotest] popup windows at +9s: {windows:?}");
        let _ = game.eval_with_callback("JSON.stringify(window.__bwPopup)", |r| println!("[autotest] popup result {r}"));
    });
}

pub fn run() {
    envinfo::adopt_login_shell_path();
    // WebKitGTK's DMA-BUF renderer crashed the app once on this Wayland+NVIDIA machine
    // ("Error 71 (Protocol error) dispatching to Wayland display"). Default it off; BW_KEEP_DMABUF=1
    // keeps WebKit's default. Runs before any thread starts.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() && std::env::var_os("BW_KEEP_DMABUF").is_none() {
        // SAFETY: single-threaded at this point (top of main).
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }
    let env = envinfo::detect();

    tauri::Builder::default()
        // Must be the first plugin. A second launch (e.g. a builderwars:// link opened from the
        // browser) is forwarded here; with the `deep-link` feature the URL reaches on_open_url.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyState::default())
        .manage(Bridge::default())
        .manage(deeplink::DeepLinks::default())
        .invoke_handler(tauri::generate_handler![
            launcher_info,
            debug_log,
            settings_set,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_is_idle,
            herdr_dispatch,
            pane_bounds,
            pane_nav,
            pane_focus,
            pick_work_dir,
            deeplink::deeplink_take,
            bridge::bridge_resolve,
            bridge::run_prompt,
            bridge::open_x,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let mut settings = settings::load(&handle);
            // Test/dev override, not persisted: BW_USE_HERDR=0|1.
            if let Ok(v) = std::env::var("BW_USE_HERDR") {
                settings.use_herdr = Some(v == "1");
            }
            let (site_url, site_origin) = settings::resolve_site_url(&settings);
            let use_herdr = settings.use_herdr.unwrap_or(env.herdr) && env.herdr;
            let default_agent = settings
                .default_agent
                .clone()
                .filter(|a| env.agents.contains(a))
                .or_else(|| env.agents.first().cloned());
            println!("[launcher] site={site_url} agents={:?} herdr={} (use={use_herdr}) shell={}", env.agents, env.herdr, env.shell);

            // The game webview (remote origin) may call exactly run_prompt and open_x.
            app.add_capability(
                CapabilityBuilder::new("game-bridge")
                    .remote(format!("{site_origin}/*"))
                    .local(false)
                    .webview(GAME)
                    .permission("allow-run-prompt")
                    .permission("allow-open-x"),
            )?;
            app.manage(SiteOrigin(site_origin.clone()));

            let window = WindowBuilder::new(app, "main")
                .title("Builder Wars")
                .inner_size(1600.0, 1000.0)
                .min_inner_size(960.0, 600.0)
                .visible(!cfg!(target_os = "linux"))
                .build()?;
            let size = panes::initial_size(&window);

            let shell = window.add_child(
                WebviewBuilder::new(SHELL, WebviewUrl::App("index.html".into())).auto_resize(),
                LogicalPosition::new(0.0, 0.0),
                size,
            )?;

            let game_start: Url = format!("{site_url}/dashboard").parse()?;
            let script = bridge::init_script(&site_origin, &env, default_agent.as_deref(), use_herdr);
            let game = window.add_child(
                panes::game_builder(&handle, game_start, script, site_origin.clone()),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(1.0, 1.0),
            )?;
            let x_start: Url = "https://x.com/home".parse()?;
            let xpane = window.add_child(panes::x_builder(&handle, x_start), LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0))?;
            game.hide()?;
            xpane.hide()?;

            #[cfg(target_os = "linux")]
            {
                panes::linux_overlay(&window, &[&shell, &game, &xpane])?;
                // F6 cycles pane focus even while a child webview has keyboard focus: the GtkWindow
                // sees key presses before its focused child. (Window-level routing only; nothing
                // is read from or sent into the page.)
                let h = handle.clone();
                let w = window.clone();
                window.run_on_main_thread(move || {
                    use gtk::prelude::*;
                    if let Ok(gw) = w.gtk_window() {
                        gw.connect_key_press_event(move |_, ev| {
                            if ev.keyval() == gtk::gdk::keys::constants::F6 {
                                let _ = h.emit_to(SHELL, "focus:cycle", ());
                                return gtk::glib::Propagation::Stop;
                            }
                            gtk::glib::Propagation::Proceed
                        });
                    }
                })?;
            }
            let _ = &shell;

            let home = settings::home_dir();
            let state = AppState { env: env.clone(), site_url, site_origin, home, settings: Mutex::new(settings) };
            println!("[launcher] work dir {}", state.work_dir().display());
            app.manage(state);

            // Deep links. Bundled builds register the scheme at install time (deb/rpm .desktop
            // MimeType, MSI/NSIS registry, macOS Info.plist). AppImage and dev builds register at
            // runtime: always for AppImage, opt-in for dev (BW_REGISTER_DEEPLINK=1) because it
            // writes a .desktop file / registry key pointing at the dev binary.
            #[cfg(any(target_os = "linux", windows))]
            if std::env::var_os("APPIMAGE").is_some() || std::env::var_os("BW_REGISTER_DEEPLINK").is_some() {
                if let Err(e) = app.deep_link().register_all() {
                    eprintln!("[deeplink] register failed: {e}");
                }
            }
            let h = handle.clone();
            app.deep_link().on_open_url(move |event| deeplink::handle_urls(&h, event.urls()));
            // Cold start: the link that launched us (argv on Linux/Windows, Apple event on macOS).
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                deeplink::handle_urls(&handle, urls);
            }

            if std::env::var("BW_AUTOTEST").is_ok_and(|v| v == "1") {
                autotest_bridge(&handle);
            }
            if std::env::var("BW_AUTOTEST_POPUP").is_ok_and(|v| v == "1") {
                autotest_popup(&handle);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Builder Wars launcher");
}
