mod bridge;
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
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewUrl};

pub struct AppState {
    env: EnvInfo,
    site_url: String,
    site_origin: String,
    settings: Mutex<Settings>,
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
    autotest: bool,
}

#[tauri::command]
fn launcher_info(webview: Webview, state: State<'_, AppState>) -> Result<LauncherInfo, String> {
    require_shell(&webview)?;
    Ok(LauncherInfo {
        env: state.env.clone(),
        settings: state.settings.lock().unwrap().clone(),
        site_url: state.site_url.clone(),
        site_origin: state.site_origin.clone(),
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
    settings::save(&app, &settings)?;
    *state.settings.lock().unwrap() = settings;
    Ok(())
}

#[tauri::command]
fn pty_spawn(webview: Webview, pty: State<'_, PtyState>, mode: String, cols: u16, rows: u16, on_event: Channel<PtyEvent>) -> Result<u32, String> {
    require_shell(&webview)?;
    let r = pty.spawn(&mode, cols.max(2), rows.max(2), on_event);
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
async fn herdr_dispatch(webview: Webview, command: String) -> Result<herdr::Dispatch, String> {
    require_shell(&webview)?;
    tauri::async_runtime::spawn_blocking(move || herdr::dispatch(&command))
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
        .manage(PtyState::default())
        .manage(Bridge::default())
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
                panes::game_builder(&handle, game_start, script),
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

            app.manage(AppState { env: env.clone(), site_url, site_origin, settings: Mutex::new(settings) });

            if std::env::var("BW_AUTOTEST").is_ok_and(|v| v == "1") {
                autotest_bridge(&handle);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Builder Wars launcher");
}
