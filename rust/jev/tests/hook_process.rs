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

fn scoped(data: &Path, session: &str) -> PathBuf {
    data.join("sessions")
        .join(format!("{:x}", Sha256::digest(session.as_bytes())))
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
    stop.store(true, Ordering::Relaxed);
    assert!(thread.join().unwrap() > 1);
}

fn mock_server(
    fail_on: Option<usize>,
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
            assert!(body.len() <= 28_000);
            assert_eq!(request["model"], "jev-latest");
            let answers = if fail_on == Some(count + 1) {
                json!({})
            } else {
                Value::Object(
                    request["questions"]
                        .as_object()
                        .unwrap()
                        .iter()
                        .map(|(name, _)| {
                            (
                                name.clone(),
                                json!({"type":"noul","noul":if name.starts_with("omit_") {0.99}
                        else if name == "relevant_2" {0.91} else {0.01}}),
                            )
                        })
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

fn run(fail_on: Option<usize>, search: bool) -> (Value, tempfile::TempDir, usize) {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let data_dir = root.join("data");
    fs::create_dir(&data_dir).unwrap();
    fs::set_permissions(&data_dir, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(data_dir.join("config.json"), json!({"schema_version":2,"scope":"global","enabled":true,
        "test_build_enabled":false,"search_listing_enabled":search,"mode":"replace","min_chars":1024,
        "max_chars":2000000,"model":"jev-latest","timeout_seconds":3.0,
        "search_relevance":{"guard_enabled":search,"relevant_max":5},
        "line_policy":{"output":{"omit_min":95,"exact_max":5},
          "test_build":{"omit_min":95,"exact_max":5},"search_listing":{"omit_min":95,"exact_max":5}}}).to_string()).unwrap();
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
    let original = (0..120)
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
    let (endpoint, stop, thread) = mock_server(fail_on);
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
    let (reply, root, calls) = run(None, false);
    assert_eq!(reply["continue"], false);
    assert!(calls > 1);
    let data_dir = root.path().join("data");
    let logs = scoped(&data_dir, "fixture-session").join("logs");
    let snapshot: Value =
        serde_json::from_slice(&fs::read(logs.join("latest-decision.json")).unwrap()).unwrap();
    assert_eq!(snapshot["version"], 3);
    assert!(snapshot["rows"].as_array().unwrap().len() <= 250);
    assert_eq!(
        snapshot["rows"].as_array().unwrap().len(),
        snapshot["batch"]["target_count"].as_u64().unwrap() as usize
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
fn missing_batch_answers_keep_the_full_result() {
    let (reply, root, calls) = run(Some(1), false);
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
fn failure_after_a_completed_batch_removes_partial_panel_state() {
    let (reply, root, calls) = run(Some(2), false);
    assert_eq!(reply, json!({}));
    assert!(calls >= 2);
    assert!(!scoped(&root.path().join("data"), "fixture-session")
        .join("logs/latest-decision.json")
        .exists());
    assert!(!root.path().join("data/outputs").exists());
}

#[test]
fn search_relevance_reaches_receipt_panel_and_cumulative_stats() {
    let (reply, root, _) = run(None, true);
    assert_eq!(reply["continue"], false);
    let data = root.path().join("data");
    let snapshot: Value = serde_json::from_slice(
        &fs::read(scoped(&data, "fixture-session").join("logs/latest-decision.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(snapshot["filter"], "search_listing");
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
    assert_eq!(stats["linesRelevanceKept"], 1);
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
    assert_eq!(record["decisions"][1]["reason"], "task_relevant");
    assert_eq!(record["decisions"][1]["p_task_relevant"], 0.91);
}

#[test]
fn disabled_specialized_routes_make_no_request_or_activity_with_output_enabled() {
    let temporary = tempfile::tempdir().unwrap();
    let data = temporary.path().join("data");
    fs::create_dir(&data).unwrap();
    fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(
        data.join("config.json"),
        json!({"schema_version":2,"scope":"global","enabled":true,"test_build_enabled":false,
            "search_listing_enabled":false,"mode":"observe","min_chars":1024,
            "max_chars":2000000,"model":"jev-latest","timeout_seconds":3.0,
            "line_policy":{"output":{"omit_min":95,"exact_max":5},
                "test_build":{"omit_min":95,"exact_max":5},
                "search_listing":{"omit_min":95,"exact_max":5}}})
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
    for command in ["cargo test --workspace", "rg -n token src"] {
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
fn plain_local_read_and_text_search_results_reach_distinct_routes() {
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
    for (index, tool) in ["Read", "mcp__files__search", "exec_command", "Read"]
        .iter()
        .enumerate()
    {
        let result = if *tool == "exec_command" {
            json!({"output":source,"exit_code":0})
        } else if *tool == "Read" {
            json!(source)
        } else {
            json!({"content":[{"type":"text","text":source}]})
        };
        let event = json!({"hook_event_name":"PostToolUse","tool_name":tool,
            "session_id":"local-tool-routing","tool_use_id":format!("call-{index}"),
            "transcript_path":if index == 3 { None } else { Some(&transcript) },
            "tool_input":if *tool == "exec_command" { json!({"cmd":"rg -n context src"}) }
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
            if index == 0 { Some(false) } else { None }
        );
        let snapshot: Value = serde_json::from_slice(
            &fs::read(scoped(&data, "local-tool-routing").join("logs/latest-decision.json"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            snapshot["filter"],
            if *tool == "Read" {
                "output"
            } else {
                "search_listing"
            }
        );
        assert!(snapshot["totals"]["judged"].as_u64().unwrap() > 0);
    }
    stop.store(true, Ordering::Relaxed);
    assert!(thread.join().unwrap() >= 4);
}

#[test]
#[ignore = "uses a configured TypeSafe API key and makes a real Jev request"]
fn live_line_request_records_valid_independent_answers() {
    let key_file = std::env::var("CODEX_JEV_LIVE_KEY_FILE").expect("set CODEX_JEV_LIVE_KEY_FILE");
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let data = root.join("data");
    fs::create_dir(&data).unwrap();
    fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).unwrap();
    fs::copy(key_file, data.join(".env")).unwrap();
    fs::set_permissions(data.join(".env"), fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(data.join("config.json"), json!({"schema_version":2,"scope":"global","enabled":true,
        "test_build_enabled":false,"search_listing_enabled":false,"mode":"observe",
        "min_chars":1024,"max_chars":2000000,"model":"jev-1.13.0","timeout_seconds":4.0,
        "line_policy":{"output":{"omit_min":95,"exact_max":5},
          "test_build":{"omit_min":95,"exact_max":5},"search_listing":{"omit_min":95,"exact_max":5}}}).to_string()).unwrap();
    let transcript = root.join("transcript.jsonl");
    fs::write(&transcript, json!({"type":"response_item","payload":{"role":"user",
        "content":[{"type":"input_text","text":"Review whether this build completed and preserve its unique version"}]}}).to_string()+"\n").unwrap();
    let mut source = (0..40)
        .map(|index| format!("Compiling module {index:02} ... done\n"))
        .collect::<String>();
    source.push_str("Version: 7.42.19\nBUILD SUCCESSFUL\n");
    let event = json!({"hook_event_name":"PostToolUse","tool_name":"Bash",
        "session_id":"live-fixture-session","tool_use_id":"live-fixture-call","transcript_path":transcript,
        "tool_input":{"command":"echo build"},"tool_response":source});
    let binary = std::env::var("CODEX_JEV_HOOK_BIN")
        .unwrap_or_else(|_| env!("CARGO_BIN_EXE_jev-hook").into());
    let mut child = Command::new(&binary)
        .env("PLUGIN_DATA", &data)
        .env_remove("CODEX_JEV_TEST_ENDPOINT")
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
    let snapshot: Value = serde_json::from_slice(
        &fs::read(scoped(&data, "live-fixture-session").join("logs/latest-decision.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(snapshot["version"], 3);
    assert_eq!(snapshot["totals"]["seen"], 42);
    assert_eq!(snapshot["totals"]["judged"], 40);
    assert_eq!(snapshot["totals"]["protected"], 2);
    assert!(snapshot["totals"]["requests"].as_u64().unwrap() >= 1);

    fs::write(data.join("config.json"), json!({"schema_version":2,"scope":"global","enabled":false,
        "test_build_enabled":false,"search_listing_enabled":true,"mode":"observe",
        "min_chars":1024,"max_chars":2000000,"model":"jev-1.13.0","timeout_seconds":4.0,
        "search_relevance":{"guard_enabled":false,"relevant_max":5},
        "line_policy":{"output":{"omit_min":95,"exact_max":5},
          "test_build":{"omit_min":95,"exact_max":5},"search_listing":{"omit_min":95,"exact_max":5}}}).to_string()).unwrap();
    fs::write(&transcript, json!({"type":"response_item","payload":{"role":"user",
        "content":[{"type":"input_text","text":"Find the timeout setting relevant to client retries."}]}}).to_string()+"\n").unwrap();
    let search_source = (0..25).map(|index| format!(
        "src/settings_{index:02}.rs:{}:setting timeout_{index:02} controls client retries and routing behavior\n", index + 1
    )).collect::<String>();
    let search_event = json!({"hook_event_name":"PostToolUse","tool_name":"Bash",
        "session_id":"live-fixture-session","tool_use_id":"live-search-call","transcript_path":transcript,
        "tool_input":{"command":"rg -n 'setting' src"},"tool_response":search_source});
    let mut search_child = Command::new(&binary)
        .env("PLUGIN_DATA", &data)
        .env_remove("CODEX_JEV_TEST_ENDPOINT")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    search_child
        .stdin
        .take()
        .unwrap()
        .write_all(search_event.to_string().as_bytes())
        .unwrap();
    let search_output = search_child.wait_with_output().unwrap();
    assert!(search_output.status.success());
    assert!(search_output.stderr.is_empty());
    let search_snapshot: Value = serde_json::from_slice(
        &fs::read(scoped(&data, "live-fixture-session").join("logs/latest-decision.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(search_snapshot["filter"], "search_listing");
    assert_eq!(search_snapshot["totals"]["judged"], 25);
    assert!(search_snapshot["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["task_relevant"].is_number()));
    let stats: Value = serde_json::from_slice(
        &fs::read(scoped(&data, "live-fixture-session").join("stats.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(stats["linesRelevanceJudged"], 25);
}
