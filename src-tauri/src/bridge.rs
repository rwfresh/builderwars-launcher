//! Bridge between the game webview (our site, remote origin) and the shell UI.
//!
//! Transport: Tauri IPC from the remote origin. A runtime capability (see lib.rs) scoped to the
//! `game` webview and the site origin grants exactly `run_prompt` and `open_x`. run_prompt is
//! forwarded to the shell UI (which owns the terminal, agent mapping and herdr mode) as an event and
//! awaits the shell's answer via `bridge_resolve`.

use crate::panes::{self, GAME, SHELL};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, Webview};
use tokio::sync::oneshot;

pub const MAX_PROMPT_CHARS: usize = 16_000;

#[derive(Default)]
pub struct Bridge {
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<String, String>>>>,
    next: AtomicU64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunPromptEvent {
    id: u64,
    prompt: String,
    agent: Option<String>,
}

/// Generous: the shell asks the player to confirm before anything runs.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Serialize)]
pub struct RunPromptResult {
    agent: String,
}

pub struct SiteOrigin(pub String);

/// Only the game webview, and only while it shows the configured site origin, may use the bridge.
/// (The capability already enforces this; this is defence in depth.)
fn check_caller(webview: &Webview, origin: &str) -> Result<(), String> {
    if webview.label() != GAME {
        return Err("bridge not available here".into());
    }
    let url = webview.url().map_err(|e| e.to_string())?;
    if url.origin().ascii_serialization() != origin {
        return Err("bridge not available on this origin".into());
    }
    Ok(())
}

pub fn validate_prompt(prompt: &str) -> Result<(), String> {
    if prompt.trim().is_empty() {
        return Err("empty prompt".into());
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!("prompt longer than {MAX_PROMPT_CHARS} characters"));
    }
    if prompt.contains('\0') {
        return Err("prompt contains NUL".into());
    }
    Ok(())
}

pub fn validate_agent(agent: &str) -> Result<(), String> {
    let ok = !agent.is_empty()
        && agent.len() <= 32
        && agent.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok { Ok(()) } else { Err("invalid agent id".into()) }
}

#[tauri::command]
pub async fn run_prompt(
    app: AppHandle,
    webview: Webview,
    bridge: State<'_, Bridge>,
    origin: State<'_, SiteOrigin>,
    prompt: String,
    agent: Option<String>,
) -> Result<RunPromptResult, String> {
    check_caller(&webview, &origin.0)?;
    validate_prompt(&prompt)?;
    if let Some(a) = &agent {
        validate_agent(a)?;
    }
    let id = bridge.next.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = oneshot::channel();
    bridge.pending.lock().unwrap().insert(id, tx);
    println!("[bridge] run_prompt #{id} from {} agent={agent:?} ({} chars)", webview.label(), prompt.chars().count());
    app.emit_to(SHELL, "bridge:run-prompt", RunPromptEvent { id, prompt, agent })
        .map_err(|e| e.to_string())?;
    let res = tokio::time::timeout(ANSWER_TIMEOUT, rx).await;
    if bridge.pending.lock().unwrap().remove(&id).is_some() {
        // Timed out: drop the confirmation the shell may still be showing.
        let _ = app.emit_to(SHELL, "bridge:expired", id);
    }
    match res {
        Ok(Ok(Ok(agent))) => Ok(RunPromptResult { agent }),
        Ok(Ok(Err(msg))) => Err(msg),
        Ok(Err(_)) => Err("launcher dropped the request".into()),
        Err(_) => Err("launcher did not answer in time".into()),
    }
}

/// Shell-only: answer a pending run_prompt.
#[tauri::command]
pub fn bridge_resolve(webview: Webview, bridge: State<'_, Bridge>, id: u64, ok: bool, value: String) -> Result<(), String> {
    crate::require_shell(&webview)?;
    println!("[bridge] resolve #{id} ok={ok} value={value}");
    if let Some(tx) = bridge.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(if ok { Ok(value) } else { Err(value) });
    }
    Ok(())
}

#[tauri::command]
pub fn open_x(app: AppHandle, webview: Webview, origin: State<'_, SiteOrigin>, url: Option<String>) -> Result<(), String> {
    check_caller(&webview, &origin.0)?;
    let target = match url.as_deref() {
        None | Some("") => None,
        Some(u) => Some(panes::parse_x_url(u)?),
    };
    println!("[bridge] open_x {:?}", target.as_ref().map(|u| u.as_str()));
    if let Some(u) = target {
        let x = app.get_webview(panes::XPANE).ok_or("X pane missing")?;
        x.navigate(u).map_err(|e| e.to_string())?;
    }
    app.emit_to(SHELL, "pane:reveal", panes::XPANE).map_err(|e| e.to_string())
}

/// Build the init script for the game webview.
pub fn init_script(origin: &str, env: &crate::envinfo::EnvInfo, default_agent: Option<&str>, herdr: bool) -> String {
    let cfg = serde_json::json!({
        "origin": origin,
        "platform": env.platform,
        "agents": env.agents,
        "defaultAgent": default_agent,
        "herdr": herdr,
    });
    include_str!("bridge_init.js").replace("/*BW_CONFIG*/ null", &cfg.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prompt_and_agent_validation() {
        assert!(validate_prompt("hello").is_ok());
        assert!(validate_prompt("  ").is_err());
        assert!(validate_prompt(&"a".repeat(MAX_PROMPT_CHARS + 1)).is_err());
        assert!(validate_agent("claude").is_ok());
        assert!(validate_agent("rm -rf").is_err());
    }
    #[test]
    fn init_script_has_config() {
        let env = crate::envinfo::EnvInfo { platform: "linux", shell: "/bin/bash".into(), agents: vec!["claude".into()], herdr: true };
        let s = init_script("https://builderwars.ai", &env, Some("claude"), true);
        assert!(s.contains("\"origin\":\"https://builderwars.ai\""));
        assert!(!s.contains("/*BW_CONFIG*/"));
    }
}
