#![cfg(windows)]

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

#[path = "windows_process/provider.rs"]
mod provider;

fn invoke(data: &Path, session: &str) -> std::process::Child {
    let mut child = Command::new(env!("CARGO_BIN_EXE_decision-hook"))
        .env("PLUGIN_DATA", data)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            json!({"session_id":session,"hook_event_name":"PostToolUse",
        "tool_name":"Bash","tool_input":{"command":"cargo test"},
        "tool_response":"test synthetic ... ok\n"})
            .to_string()
            .as_bytes(),
        )
        .unwrap();
    child
}

#[test]
fn native_hook_reads_private_configuration_and_serializes_activity() {
    let root = tempfile::tempdir().unwrap();
    let session = "native-windows-offline";
    let scoped = root
        .path()
        .join("sessions")
        .join(format!("{:x}", Sha256::digest(session)));
    fs::create_dir_all(&scoped).unwrap();
    let mut config: Value =
        serde_json::from_slice(include_bytes!("../../../config.example.json")).unwrap();
    config["enabled"] = json!(true);
    fs::write(
        scoped.join("config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    codex_decision::windows::secure_tree(root.path()).unwrap();
    let children: Vec<_> = (0..8).map(|_| invoke(root.path(), session)).collect();
    for child in children {
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            json!({})
        );
        assert!(
            output.stderr.is_empty(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let health: Value =
        serde_json::from_slice(&fs::read(scoped.join("logs/hook-health.json")).unwrap()).unwrap();
    assert_eq!(health["last_skip"], "small");
    assert_eq!(health["skipped"], 8);
    assert_eq!(health["api_requests"], 0);
    let stats: Value =
        serde_json::from_slice(&fs::read(scoped.join("stats.json")).unwrap()).unwrap();
    assert_eq!(stats["calls"], 0);
    codex_decision::windows::private(&fs::File::open(scoped.join("stats.json")).unwrap(), 1)
        .unwrap();
}

#[test]
fn native_hook_keeps_full_output_on_invalid_configuration() {
    let root = tempfile::tempdir().unwrap();
    let session = "native-windows-invalid";
    let scoped = root
        .path()
        .join("sessions")
        .join(format!("{:x}", Sha256::digest(session)));
    fs::create_dir_all(&scoped).unwrap();
    fs::write(scoped.join("config.json"), b"{invalid").unwrap();
    codex_decision::windows::secure_tree(root.path()).unwrap();
    let output = invoke(root.path(), session).wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({})
    );
    let health: Value =
        serde_json::from_slice(&fs::read(scoped.join("logs/hook-health.json")).unwrap()).unwrap();
    assert_eq!(health["last_error"], "invalid config");
}
