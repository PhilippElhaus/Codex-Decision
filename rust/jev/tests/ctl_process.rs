use serde_json::{json, Value};
use std::fs;
use std::process::Command;

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
    let output = Command::new(env!("CARGO_BIN_EXE_jevctl"))
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
