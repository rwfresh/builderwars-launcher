//! Environment discovery: the user's login-shell PATH, installed agent CLIs, herdr.

use serde::Serialize;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Agent CLIs we know how to start with an initial prompt (mapping lives in src/agents.ts).
pub const AGENTS: [&str; 5] = ["claude", "codex", "gemini", "grok", "opencode"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvInfo {
    pub platform: &'static str,
    pub shell: String,
    pub agents: Vec<String>,
    pub herdr: bool,
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

pub fn user_shell() -> String {
    if cfg!(windows) {
        return "powershell.exe".into();
    }
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/bash".into())
}

/// Apps started from a desktop launcher often get a minimal PATH (no mise/asdf/npm-global shims),
/// so agent CLIs would look "not installed". Ask the user's login+interactive shell for its PATH
/// and prepend it. Must run before any other thread starts (it mutates the process env).
pub fn adopt_login_shell_path() {
    if cfg!(windows) {
        return;
    }
    let shell = user_shell();
    let is_fish = shell.ends_with("/fish") || shell == "fish";
    let script = if is_fish {
        "printf '__BWPATH__%s__BWPATH__' (string join : $PATH)"
    } else {
        "printf '__BWPATH__%s__BWPATH__' \"$PATH\""
    };
    let Ok(mut child) = Command::new(&shell)
        .args(["-l", "-i", "-c", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
        }
    }
    let Ok(out) = child.wait_with_output() else { return };
    let text = String::from_utf8_lossy(&out.stdout);
    let Some(login_path) = text.split("__BWPATH__").nth(1) else { return };
    let current = std::env::var("PATH").unwrap_or_default();
    let mut parts: Vec<&str> = Vec::new();
    for p in login_path.split(':').chain(current.split(':')) {
        if !p.is_empty() && !parts.contains(&p) {
            parts.push(p);
        }
    }
    // SAFETY: called at the top of main(), before Tauri or any other thread is started.
    unsafe { std::env::set_var("PATH", parts.join(":")) };
}

pub fn detect() -> EnvInfo {
    let agents = AGENTS
        .iter()
        .filter(|a| which::which(a).is_ok())
        .map(|a| a.to_string())
        .collect();
    EnvInfo {
        platform: platform(),
        shell: user_shell(),
        agents,
        herdr: which::which("herdr").is_ok(),
    }
}
