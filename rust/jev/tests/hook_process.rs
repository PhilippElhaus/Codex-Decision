use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

#[path = "hook_process/orchestration.rs"]
mod orchestration;

fn scoped(data: &Path, session: &str) -> PathBuf {
    data.join("sessions")
        .join(format!("{:x}", Sha256::digest(session.as_bytes())))
}

#[test]
fn invalid_session_configuration_records_an_actionable_hook_error() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let session = scoped(&data, "invalid-settings");
    for folder in [&data, &data.join("sessions"), &session] {
        fs::create_dir(folder).unwrap();
        fs::set_permissions(folder, fs::Permissions::from_mode(0o700)).unwrap();
    }
    fs::write(session.join("config.json"), "{invalid").unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_jev-hook"))
        .env("PLUGIN_DATA", &data)
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
            json!({"session_id":"invalid-settings"})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({})
    );
    let health: Value =
        serde_json::from_slice(&fs::read(session.join("logs/hook-health.json")).unwrap()).unwrap();
    assert_eq!(health["last_error"], "invalid config");
    assert_eq!(health["last_error_ms"], health["last_seen_ms"]);
    assert!(!session.join("stats.json").exists());
}

#[test]
fn linked_session_directory_fails_open_and_reports_the_problem() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    fs::create_dir(&data).unwrap();
    fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).unwrap();
    fs::create_dir(data.join("sessions")).unwrap();
    fs::set_permissions(data.join("sessions"), fs::Permissions::from_mode(0o700)).unwrap();
    let outside = root.path().join("outside");
    fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, scoped(&data, "linked-session")).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_jev-hook"))
        .env("PLUGIN_DATA", &data)
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
            json!({"hook_event_name":"PostToolUse","tool_name":"Bash",
            "session_id":"linked-session","tool_use_id":"call-one",
            "tool_input":{"command":"echo hello"},"tool_response":"hello"})
            .to_string()
            .as_bytes(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({})
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains("unsafe directory"));
    assert!(fs::read_dir(&outside).unwrap().next().is_none());
}

fn send_event(data: &Path, endpoint: &str, event: &Value) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_jev-hook"))
        .env("PLUGIN_DATA", data)
        .env("CODEX_JEV_TEST_ENDPOINT", endpoint)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(event.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn two_sessions_keep_switches_decisions_stats_and_health_separate() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    fs::create_dir(&data).unwrap();
    fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).unwrap();
    let global = json!({"schema_version":2,"enabled":true,"test_build_enabled":false,
        "search_listing_enabled":false,"mode":"replace","min_chars":256,
        "line_policy":{"output":{"omit_min":95,"exact_max":5},
          "test_build":{"omit_min":95,"exact_max":5},"search_listing":{"omit_min":95,"exact_max":5}}});
    fs::write(data.join("config.json"), global.to_string()).unwrap();
    fs::write(data.join(".env"), "JEV_API_KEY=synthetic-test-key\n").unwrap();
    fs::set_permissions(data.join(".env"), fs::Permissions::from_mode(0o600)).unwrap();
    fs::create_dir(data.join("sessions")).unwrap();
    fs::set_permissions(data.join("sessions"), fs::Permissions::from_mode(0o700)).unwrap();
    let first = scoped(&data, "window-one");
    fs::create_dir_all(&first).unwrap();
    fs::set_permissions(&first, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(first.join("config.json"), global.to_string()).unwrap();
    let transcript = root.path().join("transcript.jsonl");
    fs::write(
        &transcript,
        json!({"type":"response_item","payload":{"role":"user",
        "content":[{"type":"input_text","text":"Check the build"}]}})
        .to_string()
            + "\n",
    )
    .unwrap();
    let source = (0..120)
        .map(|index| format!("Compiling module {index:04} ... done\n"))
        .collect::<String>();
    let make_event = |session: &str| {
        json!({"hook_event_name":"PostToolUse","tool_name":"Bash",
        "session_id":session,"tool_use_id":"call-one","transcript_path":transcript,
        "tool_input":{"command":"echo build"},"tool_response":source})
    };
    let (endpoint, stop, thread) = mock_server(None);
    assert_eq!(
        send_event(&data, &endpoint, &make_event("window-two")),
        json!({})
    );
    assert!(!scoped(&data, "window-two").exists());
    assert_eq!(
        send_event(&data, &endpoint, &make_event("window-one"))["continue"],
        false
    );
    assert!(first.join("logs/latest-decision.json").exists());
    assert!(first.join("logs/hook-health.json").exists());
    assert!(first.join("stats.json").exists());
    assert_eq!(
        fs::metadata(data.join("sessions"))
            .unwrap()
            .permissions()
            .mode()
            & 0o077,
        0
    );
    assert!(!data.join("logs").exists());
    assert!(!data.join("stats.json").exists());
    let second = scoped(&data, "window-two");
    fs::create_dir_all(&second).unwrap();
    fs::set_permissions(&second, fs::Permissions::from_mode(0o700)).unwrap();
    let mut disabled = global.clone();
    disabled["enabled"] = json!(false);
    fs::write(second.join("config.json"), disabled.to_string()).unwrap();
    assert_eq!(
        send_event(&data, &endpoint, &make_event("window-two")),
        json!({})
    );
    assert!(!second.join("logs").exists());
    fs::write(second.join("config.json"), global.to_string()).unwrap();
    assert_eq!(
        send_event(&data, &endpoint, &make_event("window-two"))["continue"],
        false
    );
    assert!(second.join("logs/latest-decision.json").exists());
    assert!(second.join("stats.json").exists());
    let first_stats: Value =
        serde_json::from_slice(&fs::read(first.join("stats.json")).unwrap()).unwrap();
    let second_stats: Value =
        serde_json::from_slice(&fs::read(second.join("stats.json")).unwrap()).unwrap();
    assert_eq!(first_stats["completed"], 1);
    assert_eq!(second_stats["completed"], 1);
    let monitor = scoped(&data, "window-monitor");
    fs::create_dir(&monitor).unwrap();
    fs::set_permissions(&monitor, fs::Permissions::from_mode(0o700)).unwrap();
    let mut observed = global.clone();
    observed["mode"] = json!("observe");
    fs::write(monitor.join("config.json"), observed.to_string()).unwrap();
    assert_eq!(
        send_event(&data, &endpoint, &make_event("window-monitor")),
        json!({})
    );
    let monitor_stats: Value =
        serde_json::from_slice(&fs::read(monitor.join("stats.json")).unwrap()).unwrap();
    assert_eq!(monitor_stats["completed"], 1);
    assert_eq!(monitor_stats["savedChars"], 0);
    fs::write(
        data.join("settings.json"),
        json!({"schema_version":1,"mode":"observe",
        "choice_gate_enabled":true,"log_limit_mb":50,"never_delete_logs":false,
        "line_policy":{"output":{"omit_min":95,"exact_max":5},
            "test_build":{"omit_min":95,"exact_max":5},
            "search_listing":{"omit_min":95,"exact_max":5}},
        "search_relevance":{"guard_enabled":false,"relevant_max":5}})
        .to_string(),
    )
    .unwrap();
    for session in ["window-one", "window-two"] {
        assert_eq!(
            send_event(&data, &endpoint, &make_event(session)),
            json!({}),
            "shared Monitor mode keeps output complete in every session"
        );
    }
    let first_after: Value =
        serde_json::from_slice(&fs::read(first.join("stats.json")).unwrap()).unwrap();
    let second_after: Value =
        serde_json::from_slice(&fs::read(second.join("stats.json")).unwrap()).unwrap();
    assert_eq!(first_after["completed"], 2);
    assert_eq!(second_after["completed"], 2);
    assert_eq!(first_after["savedChars"], first_stats["savedChars"]);
    assert_eq!(second_after["savedChars"], second_stats["savedChars"]);
    stop.store(true, Ordering::Relaxed);
    assert!(thread.join().unwrap() > 1);
}

fn mock_server(
    fail_on: Option<usize>,
) -> (String, Arc<AtomicBool>, std::thread::JoinHandle<usize>) {
    mock_server_choice(fail_on, "line_filter")
}

fn mock_server_choice(
    fail_on: Option<usize>,
    choice: &'static str,
) -> (String, Arc<AtomicBool>, std::thread::JoinHandle<usize>) {
    mock_server_observed(fail_on, choice, None)
}

fn mock_server_observed(
    fail_on: Option<usize>,
    choice: &'static str,
    session: Option<PathBuf>,
) -> (String, Arc<AtomicBool>, std::thread::JoinHandle<usize>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/v1/systemone", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let running = stop.clone();
    let thread = std::thread::spawn(move || {
        let mut count = 0;
        while !running.load(Ordering::Relaxed) {
            let Ok((mut stream, _)) = listener.accept() else {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut data = Vec::new();
            let mut total = None;
            loop {
                let mut part = [0u8; 4096];
                let size = stream.read(&mut part).unwrap();
                if size == 0 {
                    break;
                }
                data.extend_from_slice(&part[..size]);
                if let Some(end) = data.windows(4).position(|window| window == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&data[..end]);
                    let length: usize = header
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse().ok())
                        })
                        .unwrap();
                    total = Some(end + 4 + length);
                }
                if total.is_some_and(|size| data.len() >= size) {
                    break;
                }
            }
            let body = &data[data
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .unwrap()
                + 4..];
            let request: Value = serde_json::from_slice(body).unwrap();
            if let Some(session) = &session {
                let events = fs::read_to_string(session.join("logs/events.jsonl")).unwrap();
                let starts: Vec<Value> = events
                    .lines()
                    .map(|line| serde_json::from_str(line).unwrap())
                    .filter(|event: &Value| event["status"] == "classifying")
                    .collect();
                assert_eq!(
                    starts.len(),
                    1,
                    "only classification emits an activity signal"
                );
                assert_eq!(starts[0]["requests"], 0);
                assert!(starts[0].get("tool_response").is_none());
                if count == 0 {
                    assert!(
                        !session.join("logs/latest-decision.json").exists(),
                        "classification never publishes a line decision"
                    );
                }
            }
            codex_jev::semantic::validate_request_budget(&request).unwrap();
            assert_eq!(request["model"], "jev-latest");
            let answers = if fail_on == Some(count + 1) {
                json!({})
            } else if request["questions"].get("output_kind").is_some() {
                let selected = match choice {
                    "keep_full" => "exact_content",
                    "uncertain" => "mixed_or_unknown",
                    "malformed" => "malformed",
                    _ => "repetitive_log",
                };
                let probabilities: serde_json::Map<String, Value> = codex_jev::semantic::KINDS
                    .iter()
                    .map(|kind| {
                        (
                            (*kind).into(),
                            json!(if *kind == selected { 0.98 } else { 0.02 / 7.0 }),
                        )
                    })
                    .collect();
                json!({"output_kind":{"type":"choice","choice":selected,
                    "confidence":if choice == "uncertain" {0.01} else {0.96},"probabilities":probabilities}})
            } else {
                Value::Object(
                    request["questions"]
                        .as_object()
                        .unwrap()
                        .iter()
                        .map(|(name, _)| (name.clone(), json!({"type":"noul","noul":0.01})))
                        .collect(),
                )
            };
            let response = json!({"model":"jev-1.13.0","answers":answers,"usage":{"input_tokens":100,"output_tokens":10}}).to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
            count += 1;
        }
        count
    });
    (endpoint, stop, thread)
}

fn run(
    fail_on: Option<usize>,
    search: bool,
    choice: Option<&'static str>,
) -> (Value, tempfile::TempDir, usize) {
    run_sized(fail_on, search, choice, 120)
}

fn run_sized(
    fail_on: Option<usize>,
    search: bool,
    choice: Option<&'static str>,
    size: usize,
) -> (Value, tempfile::TempDir, usize) {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let data_dir = root.join("data");
    fs::create_dir(&data_dir).unwrap();
    fs::set_permissions(&data_dir, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(
        data_dir.join("config.json"),
        json!({"schema_version":3,"scope":"global","enabled":true,
        "mode":"replace","min_chars":1024,
        "max_chars":2000000,"model":"jev-latest","timeout_seconds":3.0,
        "choice_gate_enabled":choice.is_some(),
        "line_policy":{"omit_min":95,"exact_max":5}})
        .to_string(),
    )
    .unwrap();
    fs::write(data_dir.join(".env"), "JEV_API_KEY=synthetic-test-key\n").unwrap();
    fs::set_permissions(data_dir.join(".env"), fs::Permissions::from_mode(0o600)).unwrap();
    let transcript = root.join("transcript.jsonl");
    fs::write(
        &transcript,
        json!({"type":"response_item","payload":{"role":"user",
        "content":[{"type":"input_text","text":"Check whether the build finished"}]}})
        .to_string()
            + "\n",
    )
    .unwrap();
    let original = (0..size)
        .map(|index| {
            if search {
                format!(
                    "src/module_{index:04}.rs:{}:Routine symbol {index:04}\n",
                    index + 1
                )
            } else {
                format!("Compiling module {index:04} ... done\n")
            }
        })
        .collect::<String>();
    let event = json!({"hook_event_name":"PostToolUse","tool_name":"Bash",
        "session_id":"fixture-session","tool_use_id":"fixture-call","transcript_path":transcript,
        "tool_input":{"command":if search {"rg -n symbol src"} else {"echo build"}},"tool_response":original});
    let (endpoint, stop, thread) = mock_server_observed(
        fail_on,
        choice.unwrap_or("line_filter"),
        Some(scoped(&data_dir, "fixture-session")),
    );
    let mut child = Command::new(env!("CARGO_BIN_EXE_jev-hook"))
        .env("PLUGIN_DATA", &data_dir)
        .env("CODEX_JEV_TEST_ENDPOINT", endpoint)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(event.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    stop.store(true, Ordering::Relaxed);
    let calls = thread.join().unwrap();
    assert!(output.status.success());
    if fail_on.is_some() {
        assert!(String::from_utf8_lossy(&output.stderr).contains("Codex Jev hook skipped:"));
    } else {
        assert!(output.stderr.is_empty());
    }
    let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
    (reply, temporary, calls)
}

#[test]
fn writes_one_original_and_line_receipt_for_valid_batches() {
    let (reply, root, calls) = run(None, false, None);
    assert_eq!(reply["continue"], false);
    assert!(calls > 1);
    let data_dir = root.path().join("data");
    let logs = scoped(&data_dir, "fixture-session").join("logs");
    let snapshot: Value =
        serde_json::from_slice(&fs::read(logs.join("latest-decision.json")).unwrap()).unwrap();
    assert_eq!(snapshot["version"], 5);
    assert_eq!(
        snapshot["rows"].as_array().unwrap().len(),
        snapshot["totals"]["seen"].as_u64().unwrap() as usize
    );
    assert_eq!(snapshot["totals"]["seen"], 120);
    assert_eq!(snapshot["totals"]["judged"], 120);
    assert!(snapshot["totals"]["omitted"].as_u64().unwrap() > 100);
    let originals = fs::read_dir(data_dir.join("outputs"))
        .unwrap()
        .flat_map(|entry| fs::read_dir(entry.unwrap().path()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(originals.len(), 1);
    let saved = fs::read_to_string(originals[0].as_ref().unwrap().path()).unwrap();
    assert!(saved.starts_with("Compiling module 0000"));
    assert!(reply["reason"].as_str().unwrap().contains("full original:"));
}

#[test]
fn all_four_hundred_lines_are_judged_across_bounded_requests() {
    let (reply, root, calls) = run_sized(None, false, None, 400);
    assert_eq!(reply["continue"], false);
    assert!(calls > 2);
    let logs = scoped(&root.path().join("data"), "fixture-session").join("logs");
    let snapshot: Value =
        serde_json::from_slice(&fs::read(logs.join("latest-decision.json")).unwrap()).unwrap();
    assert_eq!(snapshot["totals"]["seen"], 400);
    assert_eq!(snapshot["totals"]["judged"], 400);
    assert_eq!(snapshot["totals"]["unjudged"], 0);
    assert_eq!(snapshot["batch"]["count"], calls - 1);
    assert_eq!(snapshot["totals"]["requests"], calls);
}

#[test]
fn later_batch_failure_rolls_back_progress_and_keeps_the_entire_original() {
    let (reply, root, calls) = run_sized(Some(3), false, None, 400);
    assert_eq!(reply, json!({}));
    assert_eq!(calls, 3);
    let data = root.path().join("data");
    let session = scoped(&data, "fixture-session");
    assert!(!session.join("logs/latest-decision.json").exists());
    assert!(!session.join("stats.json").exists());
    assert!(!data.join("outputs").exists());
    let health: Value =
        serde_json::from_slice(&fs::read(session.join("logs/hook-health.json")).unwrap()).unwrap();
    assert!(health["last_error_ms"].is_number());
}

#[test]
fn missing_batch_answers_keep_the_full_result() {
    let (reply, root, calls) = run(Some(1), false, None);
    assert_eq!(reply, json!({}));
    assert!(calls >= 1);
    assert!(!root.path().join("data/outputs").exists());
    let health: Value = serde_json::from_slice(
        &fs::read(
            scoped(&root.path().join("data"), "fixture-session").join("logs/hook-health.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(health["last_error_ms"].is_number());
    assert!(health["last_success_ms"].is_null());
}

#[test]
fn failed_second_call_publishes_no_partial_panel_state() {
    let (reply, root, calls) = run(Some(2), false, None);
    assert_eq!(reply, json!({}));
    assert!(calls >= 2);
    assert!(!scoped(&root.path().join("data"), "fixture-session")
        .join("logs/latest-decision.json")
        .exists());
    assert!(!root.path().join("data/outputs").exists());
}

#[test]
fn search_output_uses_the_shared_policy_without_specialized_relevance() {
    let (reply, root, _) = run(None, true, None);
    assert_eq!(reply["continue"], false);
    let data = root.path().join("data");
    let snapshot: Value = serde_json::from_slice(
        &fs::read(scoped(&data, "fixture-session").join("logs/latest-decision.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(snapshot["filter"], "output");
    assert!(snapshot["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["task_relevant"].is_number()));
    let stats: Value = serde_json::from_slice(
        &fs::read(scoped(&data, "fixture-session").join("stats.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(stats["linesRelevanceJudged"], 120);
    assert_eq!(stats["linesRelevanceKept"], 0);
    let session = fs::read_dir(scoped(&data, "fixture-session").join("logs"))
        .unwrap()
        .filter_map(Result::ok)
        .find(|entry| entry.path().is_dir())
        .unwrap()
        .path();
    let receipt = fs::read_dir(session)
        .unwrap()
        .filter_map(Result::ok)
        .find(|entry| entry.file_name().to_string_lossy().starts_with("receipt-"))
        .unwrap()
        .path();
    let record: Value = serde_json::from_slice(&fs::read(receipt).unwrap()).unwrap();
    assert_eq!(record["decisions"][1]["reason"], "irrelevant");
    assert_eq!(record["decisions"][1]["p_task_relevant"], 0.01);
}

#[test]
fn choice_gate_keeps_full_output_with_one_request_when_filtering_is_unhelpful() {
    let (reply, root, calls) = run(None, false, Some("keep_full"));
    assert_eq!(reply, json!({}));
    assert_eq!(calls, 1);
    let scoped = scoped(&root.path().join("data"), "fixture-session");
    let health: Value =
        serde_json::from_slice(&fs::read(scoped.join("logs/hook-health.json")).unwrap()).unwrap();
    assert_eq!(health["last_skip"], "choice_kept_full_output");
    assert!(!scoped.join("logs/latest-decision.json").exists());
    let stats: Value =
        serde_json::from_slice(&fs::read(scoped.join("stats.json")).unwrap()).unwrap();
    assert_eq!(stats["calls"], 1);
    assert_eq!(stats["completed"], 0);
    let event = fs::read_to_string(scoped.join("logs/events.jsonl")).unwrap();
    assert!(event.contains("choice_kept_full_output"));
    assert!(!root.path().join("data/outputs").exists());
}

#[test]
fn choice_gate_runs_line_checks_only_after_a_confident_filter_decision() {
    let (reply, root, calls) = run(None, false, Some("line_filter"));
    assert_eq!(reply["continue"], false);
    assert!(calls >= 2);
    assert!(scoped(&root.path().join("data"), "fixture-session")
        .join("logs/latest-decision.json")
        .exists());
    let stats: Value = serde_json::from_slice(
        &fs::read(scoped(&root.path().join("data"), "fixture-session").join("stats.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(stats["calls"].as_u64().unwrap() as usize, calls);
    let (uncertain, root, calls) = run(None, false, Some("uncertain"));
    assert_eq!(uncertain, json!({}));
    assert_eq!(calls, 1);
    assert!(!scoped(&root.path().join("data"), "fixture-session")
        .join("logs/latest-decision.json")
        .exists());
}

#[test]
fn malformed_choice_reports_hook_error_and_preserves_full_output() {
    let (reply, root, calls) = run(Some(1), false, Some("line_filter"));
    assert_eq!(reply, json!({}));
    assert_eq!(calls, 1);
    let health: Value = serde_json::from_slice(
        &fs::read(
            scoped(&root.path().join("data"), "fixture-session").join("logs/hook-health.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(health["last_error_ms"].is_number());
    assert!(!root.path().join("data/outputs").exists());
}

#[test]
fn disabled_single_switch_makes_no_request_or_activity_for_any_output() {
    let temporary = tempfile::tempdir().unwrap();
    let data = temporary.path().join("data");
    fs::create_dir(&data).unwrap();
    fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(
        data.join("config.json"),
        json!({"schema_version":3,"scope":"global","enabled":false,"mode":"observe","min_chars":1024,
            "max_chars":2000000,"model":"jev-latest","timeout_seconds":3.0,
            "line_policy":{"omit_min":95,"exact_max":5}})
        .to_string(),
    )
    .unwrap();
    fs::write(data.join(".env"), "JEV_API_KEY=synthetic-test-key\n").unwrap();
    fs::set_permissions(data.join(".env"), fs::Permissions::from_mode(0o600)).unwrap();
    let transcript = temporary.path().join("transcript.jsonl");
    fs::write(
        &transcript,
        json!({"type":"response_item","payload":{"role":"user",
            "content":[{"type":"input_text","text":"Review the result"}]}})
        .to_string()
            + "\n",
    )
    .unwrap();
    let (endpoint, stop, thread) = mock_server(None);
    for command in [
        "cat output.log",
        "cargo test --workspace",
        "rg -n token src",
        "cargo test | tee result.log",
        "rg -n token src\nrg -n other tests",
    ] {
        let response = (0..120)
            .map(|index| format!("src/module_{index:04}.rs:{}:routine result\n", index + 1))
            .collect::<String>();
        let event = json!({"hook_event_name":"PostToolUse","tool_name":"Bash",
            "session_id":"disabled-route","tool_use_id":command,"transcript_path":transcript,
            "tool_input":{"command":command},"tool_response":response});
        let mut child = Command::new(env!("CARGO_BIN_EXE_jev-hook"))
            .env("PLUGIN_DATA", &data)
            .env("CODEX_JEV_TEST_ENDPOINT", &endpoint)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(event.to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            json!({})
        );
    }
    stop.store(true, Ordering::Relaxed);
    assert_eq!(thread.join().unwrap(), 0);
    assert!(!data.join("logs").exists());
    assert!(!data.join("stats.json").exists());
}

#[test]
fn plain_local_read_and_text_search_results_share_one_policy() {
    let temporary = tempfile::tempdir().unwrap();
    let data = temporary.path().join("data");
    fs::create_dir(&data).unwrap();
    fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(data.join("config.json"), json!({"schema_version":2,"scope":"global","enabled":true,
        "test_build_enabled":false,"search_listing_enabled":true,"mode":"replace",
        "min_chars":1024,"max_chars":2000000,"model":"jev-latest","timeout_seconds":3.0,
        "line_policy":{"output":{"omit_min":95,"exact_max":5},
          "test_build":{"omit_min":95,"exact_max":5},"search_listing":{"omit_min":95,"exact_max":5}}}).to_string()).unwrap();
    fs::write(data.join(".env"), "JEV_API_KEY=synthetic-test-key\n").unwrap();
    fs::set_permissions(data.join(".env"), fs::Permissions::from_mode(0o600)).unwrap();
    let transcript = temporary.path().join("transcript.jsonl");
    fs::write(
        &transcript,
        json!({"type":"response_item","payload":{"role":"user",
        "content":[{"type":"input_text","text":"Find the useful source line"}]}})
        .to_string()
            + "\n",
    )
    .unwrap();
    let source = (0..45)
        .map(|index| {
            format!(
                "src/file_{index:03}.rs:{}:Routine source line with matching context\n",
                index + 1
            )
        })
        .collect::<String>();
    let (endpoint, stop, thread) = mock_server(None);
    for (index, tool) in [
        "Read",
        "mcp__files__search",
        "exec_command",
        "Read",
        "Read",
        "Bash",
        "Bash",
    ]
    .iter()
    .enumerate()
    {
        let result = if index == 4 {
            json!([{"type":"input_text","text":source}])
        } else if *tool == "exec_command" {
            json!({"output":source,"exit_code":0})
        } else if *tool == "Read" || *tool == "Bash" {
            json!(source)
        } else {
            json!({"content":[{"type":"text","text":source}]})
        };
        let event = json!({"hook_event_name":"PostToolUse","tool_name":tool,
            "session_id":"local-tool-routing","tool_use_id":format!("call-{index}"),
            "transcript_path":if index == 3 { None } else { Some(&transcript) },
            "tool_input":if index == 5 { json!({"command":"rg -n context src | head -n 45"}) }
                else if index == 6 { json!({"command":"rg -n context src\nrg -n other tests"}) }
                else if *tool == "exec_command" { json!({"cmd":"rg -n context src"}) }
                else { json!({"query":"Find useful source lines"}) },
            "tool_response":result});
        let mut child = Command::new(env!("CARGO_BIN_EXE_jev-hook"))
            .env("PLUGIN_DATA", &data)
            .env("CODEX_JEV_TEST_ENDPOINT", &endpoint)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(event.to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            reply.get("continue").and_then(Value::as_bool),
            if matches!(index, 0 | 5 | 6) {
                Some(false)
            } else {
                None
            }
        );
        let snapshot: Value = serde_json::from_slice(
            &fs::read(scoped(&data, "local-tool-routing").join("logs/latest-decision.json"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(snapshot["filter"], "output");
        assert!(snapshot["totals"]["judged"].as_u64().unwrap() > 0);
    }
    stop.store(true, Ordering::Relaxed);
    assert!(thread.join().unwrap() >= 7);
}

#[test]
fn excessive_physical_lines_keep_full_output_before_any_api_request() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path();
    fs::set_permissions(data, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(data.join("config.json"), json!({"schema_version":2,"scope":"global","enabled":true,"test_build_enabled":true,
        "search_listing_enabled":true,"mode":"replace","line_policy":{"output":{},"test_build":{},"search_listing":{}}}).to_string()).unwrap();
    let event = json!({"hook_event_name":"PostToolUse","tool_name":"Bash","session_id":"line-budget","tool_use_id":"budget",
        "tool_input":{"command":"cat progress.log"},"tool_response":"x\n".repeat(100_000)});
    let reply = send_event(data, "http://127.0.0.1:1/", &event);
    assert_eq!(reply, json!({}));
    let health: Value = serde_json::from_slice(
        &fs::read(scoped(data, "line-budget").join("logs/hook-health.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(health["last_skip"], "line_budget");
    assert!(health.get("last_error").is_none());
    assert!(!scoped(data, "line-budget").join("stats.json").exists());
}
