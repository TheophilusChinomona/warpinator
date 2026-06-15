//! warpinator: spawn and supervise the local AI bridge (a Node sidecar).
use std::process::{Command, Stdio};

/// Start the bridge if nothing is already listening on `port`. Best-effort and
/// non-fatal: if Node or the bridge dir is missing, AI simply won't work until
/// the user runs the bridge manually. The bridge dir defaults to
/// `<repo>/projects/warpinator/bridge` relative to the executable, overridable
/// via `WARPINATOR_BRIDGE_DIR`.
pub fn ensure_started(port: &str) {
    if std::net::TcpStream::connect(format!("127.0.0.1:{port}")).is_ok() {
        return;
    }
    let dir = bridge_dir();
    let server_js = dir.join("server.js");
    if !server_js.exists() {
        eprintln!(
            "warpinator: bridge not found at {} (set WARPINATOR_BRIDGE_DIR); AI disabled until started",
            server_js.display()
        );
        return;
    }
    let mut cmd = Command::new("node");
    cmd.arg("server.js")
        .current_dir(&dir)
        .env("WARPINATOR_BRIDGE_PORT", port)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match cmd.spawn() {
        Ok(_) => eprintln!("warpinator: started bridge ({})", server_js.display()),
        Err(e) => eprintln!("warpinator: failed to start bridge: {e}"),
    }
}

fn bridge_dir() -> std::path::PathBuf {
    if let Some(d) = std::env::var_os("WARPINATOR_BRIDGE_DIR") {
        return std::path::PathBuf::from(d);
    }
    let exe = std::env::current_exe().unwrap_or_default();
    let repo = exe
        .ancestors()
        .find(|p| p.join("projects/warpinator/bridge/server.js").exists())
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    repo.join("projects/warpinator/bridge")
}
