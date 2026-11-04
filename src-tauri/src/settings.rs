//! Launcher settings, persisted as JSON in the app config dir.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub const DEFAULT_SITE_URL: &str = "https://builderwars.ai";
pub const DEFAULT_GROK_URL: &str = "https://x.com/i/grok";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Agent CLI used when the site does not ask for one. None = first installed.
    pub default_agent: Option<String>,
    /// None = auto (on when herdr is installed).
    pub use_herdr: Option<bool>,
    pub grok_url: String,
    /// Game site base URL; its origin is the only origin allowed to use the bridge.
    pub site_url: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            default_agent: None,
            use_herdr: None,
            grok_url: DEFAULT_GROK_URL.into(),
            site_url: DEFAULT_SITE_URL.into(),
        }
    }
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let p = path(app).ok_or("no config dir")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(p, json).map_err(|e| e.to_string())
}

/// Parse and normalise a site URL: http(s) only, returns (base URL without trailing slash, origin).
pub fn parse_site_url(raw: &str) -> Result<(String, String), String> {
    let url: tauri::Url = raw.trim().parse().map_err(|e| format!("invalid site URL: {e}"))?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("site URL must be http(s)".into());
    }
    let origin = url.origin().ascii_serialization();
    let base = url.as_str().trim_end_matches('/').to_string();
    Ok((base, origin))
}

/// Site URL precedence: `--url <u>` CLI arg > BW_SITE_URL env > settings > default.
pub fn resolve_site_url(s: &Settings) -> (String, String) {
    let mut args = std::env::args().skip(1);
    let mut from_arg = None;
    while let Some(a) = args.next() {
        if a == "--url" {
            from_arg = args.next();
        } else if let Some(v) = a.strip_prefix("--url=") {
            from_arg = Some(v.to_string());
        }
    }
    let candidates = [from_arg, std::env::var("BW_SITE_URL").ok(), Some(s.site_url.clone())];
    for c in candidates.into_iter().flatten() {
        if let Ok(v) = parse_site_url(&c) {
            return v;
        }
    }
    parse_site_url(DEFAULT_SITE_URL).expect("default site URL")
}
