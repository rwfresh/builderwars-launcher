//! Minimal PTY commands over portable-pty: spawn / write / resize / kill, output via a Channel.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;

pub const HERDR_SESSION: &str = "builderwars";

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Arc<Mutex<HashMap<u32, Session>>>,
    next: AtomicU32,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PtyEvent {
    Data { data: String },
    Exit { code: Option<u32> },
}

/// Take the longest valid UTF-8 prefix, keeping an incomplete trailing sequence for the next read.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let s = s.to_owned();
            pending.clear();
            s
        }
        Err(e) if e.error_len().is_none() => {
            let valid = e.valid_up_to();
            let s = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            s
        }
        Err(_) => {
            let s = String::from_utf8_lossy(pending).into_owned();
            pending.clear();
            s
        }
    }
}

fn build_command(mode: &str) -> CommandBuilder {
    let mut cmd = if mode == "herdr" {
        let mut c = CommandBuilder::new("herdr");
        c.args(["--session", HERDR_SESSION]);
        c
    } else if cfg!(windows) {
        let mut c = CommandBuilder::new("powershell.exe");
        c.arg("-NoLogo");
        c
    } else {
        // $SHELL (passwd entry fallback) as a login shell.
        CommandBuilder::new_default_prog()
    };
    if let Some(home) = dirs_home() {
        cmd.cwd(home);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("BUILDERWARS_LAUNCHER", "1");
    // If the launcher itself was started from inside herdr, do not leak that context:
    // herdr refuses to nest and would target the outer session.
    for k in [
        "HERDR_ENV",
        "HERDR_PANE_ID",
        "HERDR_TAB_ID",
        "HERDR_WORKSPACE_ID",
        "HERDR_SOCKET_PATH",
        "HERDR_BIN_PATH",
    ] {
        cmd.env_remove(k);
    }
    cmd
}

fn dirs_home() -> Option<String> {
    std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).ok()
}

fn log_path() -> Option<String> {
    std::env::var("BW_PTY_LOG").ok().filter(|s| !s.is_empty())
}

impl PtyState {
    pub fn spawn(&self, mode: &str, cols: u16, rows: u16, on_event: Channel<PtyEvent>) -> Result<u32, String> {
        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
        let mut child = pair.slave.spawn_command(build_command(mode)).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let pid = child.process_id();
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.sessions.lock().unwrap().insert(id, Session { master: pair.master, writer, killer, pid });

        let out = on_event.clone();
        std::thread::Builder::new()
            .name(format!("pty-{id}-read"))
            .spawn(move || {
                let mut log = log_path().and_then(|p| {
                    std::fs::OpenOptions::new().create(true).append(true).open(p).ok()
                });
                let mut buf = [0u8; 16 * 1024];
                let mut pending = Vec::new();
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if let Some(f) = log.as_mut() {
                                let _ = f.write_all(&buf[..n]);
                            }
                            pending.extend_from_slice(&buf[..n]);
                            let s = take_utf8(&mut pending);
                            if !s.is_empty() && out.send(PtyEvent::Data { data: s }).is_err() {
                                break;
                            }
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        let sessions = self.sessions.clone();
        std::thread::Builder::new()
            .name(format!("pty-{id}-wait"))
            .spawn(move || {
                let code = child.wait().ok().map(|s| s.exit_code());
                sessions.lock().unwrap().remove(&id);
                let _ = on_event.send(PtyEvent::Exit { code });
            })
            .map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn write(&self, id: u32, data: &str) -> Result<(), String> {
        let mut map = self.sessions.lock().unwrap();
        let s = map.get_mut(&id).ok_or("no such pty")?;
        s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        s.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let map = self.sessions.lock().unwrap();
        let s = map.get(&id).ok_or("no such pty")?;
        s.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    }

    pub fn kill(&self, id: u32) -> Result<(), String> {
        let mut map = self.sessions.lock().unwrap();
        if let Some(mut s) = map.remove(&id) {
            let _ = s.killer.kill();
        }
        Ok(())
    }

    /// True when the shell itself is the foreground process (nothing else running in it).
    /// Unknown platforms report true.
    pub fn is_idle(&self, id: u32) -> Result<bool, String> {
        let map = self.sessions.lock().unwrap();
        let s = map.get(&id).ok_or("no such pty")?;
        #[cfg(unix)]
        {
            if let (Some(leader), Some(pid)) = (s.master.process_group_leader(), s.pid) {
                return Ok(leader as i64 == pid as i64);
            }
        }
        let _ = s.pid;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::take_utf8;

    #[test]
    fn keeps_incomplete_utf8_tail() {
        let mut p = "ab".as_bytes().to_vec();
        p.extend_from_slice(&"é".as_bytes()[..1]);
        assert_eq!(take_utf8(&mut p), "ab");
        assert_eq!(p.len(), 1);
        p.extend_from_slice(&"é".as_bytes()[1..]);
        assert_eq!(take_utf8(&mut p), "é");
        assert!(p.is_empty());
    }
}
