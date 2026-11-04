//! Child webviews: the game pane (our site) and the X pane (x.com), positioned over placeholders
//! in the shell UI. Hard rule for the X pane: no scripts of ours, no DOM access, no automation;
//! we only create it, set its bounds, and navigate/back/reload it on explicit user action.

use serde::Serialize;
use std::path::PathBuf;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Url, Webview, WebviewUrl, Window, Wry};
#[cfg(not(target_os = "linux"))]
use tauri::LogicalPosition;

pub const SHELL: &str = "shell";
pub const GAME: &str = "game";
pub const XPANE: &str = "xpane";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaneLoad<'a> {
    pane: &'a str,
    url: String,
    phase: &'a str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaneTitle<'a> {
    pane: &'a str,
    title: String,
}

pub fn is_x_host(url: &Url) -> bool {
    url.scheme() == "https"
        && matches!(url.host_str(), Some(h) if h == "x.com" || h.ends_with(".x.com") || h == "twitter.com" || h.ends_with(".twitter.com"))
}

pub fn parse_x_url(raw: &str) -> Result<Url, String> {
    let url: Url = raw.parse().map_err(|_| "invalid URL".to_string())?;
    if !is_x_host(&url) {
        return Err("only https://x.com URLs can be opened in the X pane".into());
    }
    Ok(url)
}

/// Open a URL in the system browser (http/https only).
pub fn open_external(url: &Url) {
    if url.scheme() != "https" && url.scheme() != "http" {
        return;
    }
    let u = url.as_str().to_string();
    let r = if cfg!(target_os = "windows") {
        std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", &u]).spawn()
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&u).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(&u).spawn()
    };
    if let Err(e) = r {
        eprintln!("[panes] could not open {u}: {e}");
    }
}

/// Shared persistent profile for the game and X webviews: the player signs in to X once and both
/// the site's "Sign in with X" OAuth and x.com see the same first-party cookies.
pub fn web_profile_dir(app: &AppHandle) -> PathBuf {
    if let Some(root) = crate::settings::data_root_override() {
        return root.join("web-profile");
    }
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("builderwars-launcher"))
        .join("web-profile")
}

fn emit_load(app: &AppHandle, pane: &'static str, url: &Url, phase: &'static str) {
    println!("[{pane}] page-load {phase} {url}");
    let _ = app.emit_to(SHELL, "pane:load", PaneLoad { pane, url: url.to_string(), phase });
}

/// macOS has no per-webview data directory (WKWebView); macOS 14+ uses a named persistent
/// WKWebsiteDataStore instead (older macOS falls back to the default store, shared with the shell).
/// Fixed UUID so the store survives restarts; shared by the game and X webviews.
#[cfg(target_os = "macos")]
const WEB_PROFILE_STORE_ID: [u8; 16] = [
    0x6b, 0x2f, 0x3e, 0x91, 0x5c, 0x0a, 0x4d, 0x8e, 0x9b, 0x77, 0x21, 0xd4, 0xb0, 0x5e, 0x13, 0xa6,
];

fn common(builder: WebviewBuilder<Wry>, app: &AppHandle, pane: &'static str, data_dir: PathBuf) -> WebviewBuilder<Wry> {
    let a1 = app.clone();
    let a2 = app.clone();
    // Linux: own WebKitWebContext in data_dir. Windows: WebView2 user data folder (both child
    // webviews share it, hence one WebView2 environment). macOS: ignored, see store id below.
    let builder = builder.data_directory(data_dir);
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(WEB_PROFILE_STORE_ID);
    builder
        .on_page_load(move |_wv, payload| {
            let phase = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            emit_load(&a1, pane, payload.url(), phase);
        })
        .on_document_title_changed(move |_wv, title| {
            println!("[{pane}] title {title:?}");
            let _ = a2.emit_to(SHELL, "pane:title", PaneTitle { pane, title });
        })
        .on_navigation(|url| matches!(url.scheme(), "http" | "https" | "about" | "blob" | "data"))
}

pub fn game_builder(app: &AppHandle, start: Url, init_script: String) -> WebviewBuilder<Wry> {
    let a = app.clone();
    common(WebviewBuilder::new(GAME, WebviewUrl::External(start)), app, GAME, web_profile_dir(app))
        // Only our own site gets a script, and the script itself checks the origin.
        .initialization_script(init_script)
        .on_new_window(move |url, _features| {
            if is_x_host(&url) {
                if let Some(x) = a.get_webview(XPANE) {
                    let _ = x.navigate(url);
                    let _ = a.emit_to(SHELL, "pane:reveal", XPANE);
                }
            } else {
                open_external(&url);
            }
            NewWindowResponse::Deny
        })
}

pub fn x_builder(app: &AppHandle, start: Url) -> WebviewBuilder<Wry> {
    let a = app.clone();
    common(WebviewBuilder::new(XPANE, WebviewUrl::External(start)), app, XPANE, web_profile_dir(app))
        .on_new_window(move |url, _features| {
            if is_x_host(&url) {
                if let Some(x) = a.get_webview(XPANE) {
                    let _ = x.navigate(url);
                }
            } else {
                open_external(&url);
            }
            NewWindowResponse::Deny
        })
}

/// Linux: Tauri packs every child webview into the window's vertical GtkBox, where `set_bounds`
/// is a no-op (wry only positions webviews whose parent is a GtkFixed). Re-parent them:
/// GtkOverlay { main child: shell webview (fills the window),
///              overlay child (input pass-through): GtkFixed { game webview, X webview } }.
/// GtkFixed places children at exact positions with their size request, so bounds are exact.
#[cfg(target_os = "linux")]
pub fn linux_overlay(window: &Window, webviews: &[&Webview]) -> tauri::Result<()> {
    use gtk::prelude::*;
    for wv in webviews {
        let label = wv.label().to_string();
        wv.with_webview(move |pv| pv.inner().set_widget_name(&label))?;
    }
    let w = window.clone();
    let win2 = window.clone();
    window.run_on_main_thread(move || {
        let Ok(vbox) = w.default_vbox() else { return };
        let overlay = gtk::Overlay::new();
        let fixed = gtk::Fixed::new();
        fixed.set_widget_name("bw-child-layer");
        let mut shell = None;
        let mut others = Vec::new();
        for child in vbox.children() {
            let name = child.widget_name().to_string();
            vbox.remove(&child);
            if name == SHELL {
                shell = Some(child);
            } else {
                others.push(child);
            }
        }
        if let Some(s) = shell {
            overlay.add(&s);
        }
        for c in others {
            c.set_size_request(1, 1);
            fixed.put(&c, 0, 0);
        }
        overlay.add_overlay(&fixed);
        // Clicks outside the child webviews fall through to the shell webview.
        overlay.set_overlay_pass_through(&fixed, true);
        vbox.pack_start(&overlay, true, true, 0);
        overlay.show();
        fixed.show();
        let _ = win2.show();
    })
}

/// `viewport` is the shell webview's CSS viewport size (window.innerWidth/innerHeight). On Linux,
/// WebKitGTK scales CSS px by the desktop font DPI (e.g. 1.1 on this machine), so CSS px from the
/// shell are converted to GTK px with (child layer size / viewport size).
pub fn set_bounds(wv: &Webview, x: f64, y: f64, width: f64, height: f64, viewport: (f64, f64)) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        wv.with_webview(move |pv| {
            let v = pv.inner();
            let fixed = v.parent().and_then(|p| p.downcast::<gtk::Fixed>().ok());
            let (sx, sy) = match &fixed {
                Some(f) if viewport.0 > 0.0 && viewport.1 > 0.0 && f.allocated_width() > 1 => (
                    f.allocated_width() as f64 / viewport.0,
                    f.allocated_height() as f64 / viewport.1,
                ),
                _ => (1.0, 1.0),
            };
            let (x, y) = ((x * sx).round() as i32, (y * sy).round() as i32);
            let (w, h) = (((width * sx).round() as i32).max(1), ((height * sy).round() as i32).max(1));
            if let Some(f) = &fixed {
                f.move_(&v, x, y);
            }
            v.set_size_request(w, h);
            v.queue_resize();
            if std::env::var("BW_DEBUG_BOUNDS").is_ok() {
                let (mw, nw) = v.preferred_width();
                let (mh, nh) = v.preferred_height();
                println!("[bounds] {} -> {x},{y} {w}x{h} (pref w {mw}/{nw} h {mh}/{nh})", v.widget_name());
            }
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = viewport;
        wv.set_bounds(tauri::Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(width, height).into(),
        })
        .map_err(|e| e.to_string())
    }
}

pub fn go_back(wv: &Webview) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::WebViewExt;
        wv.with_webview(|pv| pv.inner().go_back()).map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        // WKWebView -goBack (native history; no script runs in the page). Unverified: no Mac.
        wv.with_webview(|pv| {
            let view = pv.inner() as *mut objc2::runtime::AnyObject;
            if !view.is_null() {
                // SAFETY: with_webview runs on the main thread and `inner()` is the live WKWebView.
                let _: *mut objc2::runtime::AnyObject = unsafe { objc2::msg_send![view, goBack] };
            }
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        // ICoreWebView2::GoBack (native history). Unverified: no Windows machine.
        wv.with_webview(|pv| {
            // SAFETY: COM calls on the UI thread that owns the controller.
            unsafe {
                if let Ok(core) = pv.controller().CoreWebView2() {
                    let _ = core.GoBack();
                }
            }
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = wv;
        Err("back is not implemented on this platform".into())
    }
}

pub fn initial_size(window: &Window) -> LogicalSize<f64> {
    let scale = window.scale_factor().unwrap_or(1.0);
    window
        .inner_size()
        .map(|s| s.to_logical(scale))
        .unwrap_or(LogicalSize::new(1440.0, 900.0))
}

/// Debug aid (Linux): write a PNG snapshot of each webview plus its GTK allocation, so layout can
/// be verified headlessly. Triggered by BW_SNAPSHOT_DIR in autotest mode.
#[cfg(target_os = "linux")]
pub fn debug_snapshot(app: &AppHandle, dir: String) {
    for label in [SHELL, GAME, XPANE] {
        let Some(wv) = app.get_webview(label) else { continue };
        let dir = dir.clone();
        let _ = wv.with_webview(move |pv| {
            use gtk::prelude::*;
            use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};
            let v = pv.inner();
            let a = v.allocation();
            println!(
                "[snapshot] {label} parent={:?} visible={} alloc x={} y={} w={} h={}",
                v.parent().map(|p| p.type_().name().to_string()),
                v.is_visible(),
                a.x(),
                a.y(),
                a.width(),
                a.height()
            );
            let path = format!("{dir}/{label}.png");
            v.snapshot(SnapshotRegion::Visible, SnapshotOptions::NONE, None::<&gtk::gio::Cancellable>, move |res| match res {
                Ok(surface) => {
                    let r = gtk::cairo::ImageSurface::try_from(surface)
                        .map_err(|_| "not an image surface".to_string())
                        .and_then(|img| {
                            let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
                            img.write_to_png(&mut f).map_err(|e| e.to_string())
                        });
                    println!("[snapshot] {label} -> {path} {r:?}");
                }
                Err(e) => println!("[snapshot] {label} failed: {e}"),
            });
        });
    }
}
