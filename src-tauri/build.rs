const COMMANDS: &[&str] = &[
    "launcher_info",
    "debug_log",
    "settings_set",
    "pty_spawn",
    "pty_write",
    "pty_resize",
    "pty_kill",
    "pty_is_idle",
    "herdr_dispatch",
    "pane_bounds",
    "pane_nav",
    "pane_focus",
    "bridge_resolve",
    "run_prompt",
    "open_x",
];

fn main() {
    // Declaring the app commands makes them deny-by-default: each needs an `allow-*` permission in
    // a capability. The shell capability grants all; the game (remote) capability only two.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
