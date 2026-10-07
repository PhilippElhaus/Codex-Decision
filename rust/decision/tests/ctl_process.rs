use serde_json::{json, Value};
use std::fs;
use std::process::Command;

#[test]
fn key_cli_defaults_to_openai_and_preserves_the_typesafe_key() {
    use std::io::Write;
    use std::process::Stdio;
    let directory = tempfile::tempdir().unwrap();
    for (provider, key) in [
        (None, "synthetic-openai-key"),
        (Some("typesafe"), "synthetic-typesafe-key"),
        (None, "updated-openai-key"),
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_decisionctl"));
        command
            .args(["set-key", "--data-dir"])
            .arg(directory.path());
        if let Some(provider) = provider {
            command.args(["--provider", provider]);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(format!("{key}\n").as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());
    }
    let content = fs::read_to_string(directory.path().join(".env")).unwrap();
    assert_eq!(content.lines().count(), 2);
    assert!(content.contains("OPENAI_API_KEY=updated-openai-key\n"));
    assert!(content.contains("JEV_API_KEY=synthetic-typesafe-key\n"));
    let invalid = Command::new(env!("CARGO_BIN_EXE_decisionctl"))
        .args(["set-key", "--data-dir"])
        .arg(directory.path())
        .args(["--provider", "unknown"])
        .output()
        .unwrap();
    assert!(!invalid.status.success());
    assert_eq!(
        fs::read_to_string(directory.path().join(".env")).unwrap(),
        content
    );
}

#[test]
fn shipped_commands_report_the_compiled_version() {
    for (name, binary) in [
        ("decisionctl", env!("CARGO_BIN_EXE_decisionctl")),
        ("decision-hook", env!("CARGO_BIN_EXE_decision-hook")),
    ] {
        let output = Command::new(binary).arg("--version").output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            output.stdout,
            format!("{name} {}\n", env!("CARGO_PKG_VERSION")).as_bytes()
        );
        assert!(output.stderr.is_empty());
    }
}

#[test]
fn packager_rejects_a_mislabeled_binary_before_creating_an_archive() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    for name in [
        ".codex-plugin/plugin.json",
        "skills/decision-output/SKILL.md",
        "hooks/hooks.json",
        "hooks/bin/linux-x86_64/decision-hook",
        "hooks/bin/linux-x86_64/decisionctl",
        "assets/logo.png",
        "assets/icon.png",
        "config.example.json",
        "LICENSE",
    ] {
        let target = root.join(name);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, "fixture").unwrap();
    }
    fs::write(
        root.join(".codex-plugin/plugin.json"),
        json!({"name":"codex-decision","version":env!("CARGO_PKG_VERSION")}).to_string(),
    )
    .unwrap();
    let mut header = [0u8; 64];
    header[..6].copy_from_slice(b"\x7fELF\x02\x01");
    header[18] = 183; // AArch64 must not ship under linux-x86_64.
    fs::write(root.join("hooks/bin/linux-x86_64/decision-hook"), header).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_decisionctl"))
        .args(["package", "--root"])
        .arg(root)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Linux x86_64 ELF"));
    assert!(!root.join(".local/submission").exists());
}

#[test]
fn quality_cli_reports_holdout_false_omissions_without_raw_text() {
    let temporary = tempfile::tempdir().unwrap();
    let receipt_path = temporary.path().join("receipt.json");
    fs::write(
        &receipt_path,
        json!({"version":2,"manifest":{"id":"a".repeat(32),"lines_seen":3,
            "lines_judged":3,"original_chars":100,"visible_chars":50,"status":"replace","requests":0},
            "initial_output":"private fixture text",
            "decisions":[{"number":1,"action":"keep"},{"number":2,"action":"omit"},
                {"number":3,"action":"keep"}]}).to_string(),
    ).unwrap();
    let cases_path = temporary.path().join("cases.json");
    fs::write(
        &cases_path,
        json!([{"id":"fixture","split":"holdout","receipt":"receipt.json",
            "required_lines":[2,3],"task_solved":false,"baseline_task_solved":true}])
        .to_string(),
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_decisionctl"))
        .args(["evaluate-quality", "--cases", cases_path.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["groups"]["holdout"]["false_omissions"], 1);
    assert_eq!(report["groups"]["holdout"]["saved_chars"], 50);
    assert_eq!(report["cases"][0]["false_omissions"], json!([2]));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("private fixture text"));
}
