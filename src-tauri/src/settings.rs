//! Launcher settings, persisted as JSON in the app config dir.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const DEFAULT_SITE_URL: &str = "https://builderwars.ai";
pub const DEFAULT_GROK_URL: &str = "https://x.com/i/grok";
pub const DEFAULT_WORK_DIR_NAME: &str = "BuilderWars";

const WORK_DIR_README: &str = "# Builder Wars workspace\n\n\
This folder was created by the Builder Wars launcher. Your AI agent (Claude Code, Codex, Gemini,\n\
Grok, opencode) starts here when you press \"Run in terminal\" on builderwars.ai, so promo video\n\
drafts, spec sheets and renders for your Builder Wars products live here.\n\n\
Change it in the launcher toolbar (DIR > change). Deleting this folder is safe; the launcher\n\
recreates it (empty) the next time it starts with the default setting.\n";

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
    /// Directory agents start in. None = ~/BuilderWars.
    pub work_dir: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            default_agent: None,
            use_herdr: None,
            grok_url: DEFAULT_GROK_URL.into(),
            site_url: DEFAULT_SITE_URL.into(),
            work_dir: None,
        }
    }
}

/// BW_DATA_ROOT=<dir> relocates settings and the web profile (tests, side-by-side instances).
pub fn data_root_override() -> Option<PathBuf> {
    std::env::var_os("BW_DATA_ROOT").filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    if let Some(root) = data_root_override() {
        return Some(root.join("config").join("settings.json"));
    }
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

pub fn home_dir() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Configured work dir, or ~/BuilderWars. `~/` prefixes are expanded.
pub fn work_dir(s: &Settings, home: &Path) -> PathBuf {
    match s.work_dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some("~") => home.to_path_buf(),
        Some(d) if d.starts_with("~/") || d.starts_with("~\\") => home.join(&d[2..]),
        Some(d) => PathBuf::from(d),
        None => home.join(DEFAULT_WORK_DIR_NAME),
    }
}

/// Create the work dir if missing (with a README explaining it). Returns the directory.
pub fn ensure_work_dir(dir: &Path) -> Result<PathBuf, String> {
    if dir.is_dir() {
        return Ok(dir.to_path_buf());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let readme = dir.join("README.md");
    if !readme.exists() {
        std::fs::write(&readme, WORK_DIR_README).map_err(|e| e.to_string())?;
    }
    Ok(dir.to_path_buf())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn work_dir_defaults_and_expands_tilde() {
        let home = Path::new("/home/u");
        let mut s = Settings::default();
        assert_eq!(work_dir(&s, home), PathBuf::from("/home/u/BuilderWars"));
        s.work_dir = Some("~/code/bw".into());
        assert_eq!(work_dir(&s, home), PathBuf::from("/home/u/code/bw"));
        s.work_dir = Some("/srv/bw".into());
        assert_eq!(work_dir(&s, home), PathBuf::from("/srv/bw"));
        s.work_dir = Some("  ".into());
        assert_eq!(work_dir(&s, home), PathBuf::from("/home/u/BuilderWars"));
    }

    #[test]
    fn ensure_work_dir_creates_readme_once() {
        let dir = std::env::temp_dir().join(format!("bw-workdir-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        ensure_work_dir(&dir).unwrap();
        let readme = std::fs::read_to_string(dir.join("README.md")).unwrap();
        assert!(readme.contains("Builder Wars"));
        std::fs::write(dir.join("README.md"), "mine").unwrap();
        ensure_work_dir(&dir).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("README.md")).unwrap(), "mine");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
