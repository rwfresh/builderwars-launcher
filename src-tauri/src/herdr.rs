//! Prompt dispatch through herdr's CLI wrappers over its socket API.
//!
//! We target the launcher's own named session (`herdr --session builderwars`, started in the PTY),
//! never the user's default session. Flow: find the focused pane; if its shell is idle at the prompt
//! run the agent command there, otherwise split a new pane to the right and run it there.
//! `pane run` sends text + Enter atomically. We deliberately use `pane run "<agent> '<prompt>'"`
//! instead of `agent start` + `agent prompt`: `agent start` reports `agent_not_ready` when the CLI
//! opens a first-run/trust dialog and the prompt would be lost, while passing the prompt as the CLI's
//! initial-prompt argument survives such dialogs. herdr still detects and tracks the agent in the pane.

use crate::pty::HERDR_SESSION;
use serde::Serialize;
use serde_json::Value;
use std::process::Command;

fn herdr(args: &[&str]) -> Result<Value, String> {
    let mut cmd = Command::new("herdr");
    cmd.arg("--session").arg(HERDR_SESSION).args(args);
    for k in ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_SOCKET_PATH", "HERDR_BIN_PATH"] {
        cmd.env_remove(k);
    }
    let out = cmd.output().map_err(|e| format!("herdr not runnable: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = serde_json::from_str::<Value>(&err)
            .ok()
            .and_then(|v| v.pointer("/error/message").and_then(|m| m.as_str()).map(String::from))
            .unwrap_or_else(|| err.trim().to_string());
        return Err(format!("herdr {}: {msg}", args.first().copied().unwrap_or("")));
    }
    // Some commands (e.g. `pane run`) print nothing on success.
    if out.stdout.iter().all(u8::is_ascii_whitespace) {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("herdr returned non-JSON: {e}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dispatch {
    pub pane_id: String,
    pub split: bool,
}

pub fn dispatch(command: &str) -> Result<Dispatch, String> {
    let list = herdr(&["pane", "list"])?;
    let panes = list
        .pointer("/result/panes")
        .and_then(|p| p.as_array())
        .ok_or("herdr pane list: unexpected shape")?;
    let pane = panes
        .iter()
        .find(|p| p.get("focused").and_then(Value::as_bool) == Some(true))
        .or_else(|| panes.first())
        .ok_or("herdr has no panes")?;
    let pane_id = pane.get("pane_id").and_then(Value::as_str).ok_or("pane without id")?.to_string();

    let info = herdr(&["pane", "process-info", "--pane", &pane_id])?;
    let pi = info.pointer("/result/process_info");
    let idle = match (
        pi.and_then(|p| p.get("foreground_process_group_id")).and_then(Value::as_i64),
        pi.and_then(|p| p.get("shell_pid")).and_then(Value::as_i64),
    ) {
        (Some(fg), Some(shell)) => fg == shell,
        _ => false,
    };

    let (target, split) = if idle {
        (pane_id, false)
    } else {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        let res = herdr(&["pane", "split", "--pane", &pane_id, "--direction", "right", "--cwd", &home])?;
        let id = res
            .pointer("/result/pane/pane_id")
            .and_then(Value::as_str)
            .ok_or("herdr pane split: no pane id")?
            .to_string();
        (id, true)
    };
    herdr(&["pane", "run", &target, command])?;
    Ok(Dispatch { pane_id: target, split })
}
