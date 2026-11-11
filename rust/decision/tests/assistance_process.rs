//! Exercise the packaged service boundary with synthetic loopback providers.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn private_dir(path: &Path) {
    fs::create_dir_all(path).unwrap();
    #[cfg(windows)]
    codex_decision::windows::secure(path, true).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
}

fn configuration(root: &Path, endpoint: &str, protocol: &str) {
    fs::write(root.join("config.json"),json!({"schema_version":5,"scope":"global","enabled":true,
        "mode":"replace","provider":"custom","custom_provider":{"name":"Synthetic fixture","protocol":protocol,
        "endpoint":endpoint,"model":"synthetic-model","auth":"none"},"relevance_policy":{"relevant_max":5}}).to_string()).unwrap();
}

fn server() -> (String, std::thread::JoinHandle<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/decide", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        let started = Instant::now();
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && started.elapsed() < Duration::from_secs(10) =>
                {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(error) => panic!("synthetic provider did not receive its request: {error}"),
            }
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(&stream);
        let mut length = 0;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
            if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse::<usize>().unwrap();
            }
        }
        assert!(length > 0 && length < 64_000);
        let mut bytes = vec![0; length];
        reader.read_exact(&mut bytes).unwrap();
        let request: Value = serde_json::from_slice(&bytes).unwrap();
        let openai = request["questions"].is_array();
        let questions: Vec<(String, Value)> = if openai {
            request["questions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|q| (q["name"].as_str().unwrap().into(), q.clone()))
                .collect()
        } else {
            request["questions"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(n, q)| (n.clone(), q.clone()))
                .collect()
        };
        let answers:Vec<_>=questions.into_iter().map(|(name,q)| {
            let mut a=match q["type"].as_str().unwrap() {
                "predicate"|"noul"=>{
                    let probability=if name.starts_with("contradicted") {0.99}else{0.01};
                    if openai {json!({"type":"predicate","probability":probability})}else{json!({"type":"noul","noul":probability})}
                }
                "score"=>{
                    let levels=if openai {&q["levels"]}else{&q["criteria"]};
                    let size=levels.as_array().unwrap().len();
                    let probabilities=if openai {json!((0..size).map(|i|json!({"label":i.to_string(),"value":i,"probability":if i==0{1.0}else{0.0}})).collect::<Vec<_>>())}
                        else{Value::Object((0..size).map(|i|(i.to_string(),json!(if i==0{1.0}else{0.0}))).collect())};
                    json!({"type":"score","score":0.0,"confidence":1.0,"probabilities":probabilities})
                }
                _=>{
                    let choices:Vec<String>=if openai {q["choices"].as_array().unwrap().iter().map(|c|c["value"].as_str().unwrap().into()).collect()}
                        else{q["criteria"].as_object().unwrap().keys().cloned().collect()};
                    let probabilities=if openai {json!(choices.iter().map(|v|json!({"value":v,"probability":if v=="unknown"{1.0}else{0.0}})).collect::<Vec<_>>())}
                        else{Value::Object(choices.iter().map(|v|(v.clone(),json!(if v=="unknown"{1.0}else{0.0}))).collect())};
                    json!({"type":"choice","choice":"unknown","confidence":1.0,"probabilities":probabilities})
                }
            };
            if openai {a["name"]=json!(name);}(name,a)
        }).collect();
        let body=json!({"model":"synthetic-model","answers":if openai{json!(answers.iter().map(|(_,a)|a).collect::<Vec<_>>())}
            else{Value::Object(answers.into_iter().collect())},"usage":{"input_tokens":1200,"output_tokens":5,"input_tokens_details":{"cached_tokens":1024,"cache_write_tokens":100}}}).to_string();
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        request
    });
    (endpoint, handle)
}

fn run(root: &Path, args: &[&str], input: &str) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_decision-hook"))
        .args(args)
        .env("PLUGIN_DATA", root)
        .env_remove("CODEX_DECISION_TEST_ENDPOINT")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn mcp_ranking_round_trip_preserves_originals_and_contains_no_protocol_noise() {
    let root = tempfile::tempdir().unwrap();
    private_dir(root.path());
    let (endpoint, provider) = server();
    configuration(root.path(), &endpoint, "openai");
    let args = json!({"query":"find assertion","candidates":[{"id":"source","text":"Exact λ source\nassert_eq!(a,b);"}]});
    let input=[json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"rank_context","arguments":args}})]
        .iter().map(Value::to_string).collect::<Vec<_>>().join("\n")+"\n";
    let output = run(root.path(), &["--mcp"], &input);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let rows: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[1]["result"]["tools"].as_array().unwrap().len(), 3);
    let result = &rows[2]["result"];
    assert_eq!(result["isError"], false);
    assert_eq!(
        result["structuredContent"]["candidates"][0]["text"],
        args["candidates"][0]["text"]
    );
    assert!(!root.path().join("logs/hook-health.json").exists());
    assert_eq!(
        provider.join().unwrap()["input"][0]["content"][1]["type"],
        "input_json"
    );
}

#[test]
fn native_failure_triage_works_with_both_provider_contracts() {
    for protocol in ["openai", "jev"] {
        let root = tempfile::tempdir().unwrap();
        private_dir(root.path());
        let (endpoint, provider) = server();
        configuration(root.path(), &endpoint, protocol);
        let output=run(root.path(),&["--assist"],&json!({"workflow":"triage_failure","failure":{"name":"case","output":"test failed: left 1, right 2"}}).to_string());
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["cause"]["choice"], "unknown");
        assert_eq!(result["test_selection"], "coverage_only");
        assert_eq!(result["usage"]["cached_tokens"], 1024);
        provider.join().unwrap();
    }
}

#[test]
fn stop_continues_a_contradicted_claim_once_and_never_counts_review_as_filtering() {
    let root = tempfile::tempdir().unwrap();
    private_dir(root.path());
    let (endpoint, provider) = server();
    configuration(root.path(), &endpoint, "openai");
    let settings = run(
        root.path(),
        &["--assistance-settings"],
        r#"{"version":1,"completion_verification":"enforce"}"#,
    );
    assert!(settings.status.success());
    let event = json!({"hook_event_name":"PostToolUse","session_id":"review-thread","turn_id":"review-turn",
        "tool_name":"Bash","tool_input":{"command":"cargo test"},"tool_response":"test failed: expected 2, got 1"});
    assert!(run(root.path(), &[], &event.to_string()).status.success());
    let stop = json!({"hook_event_name":"Stop","session_id":"review-thread","turn_id":"review-turn","stop_hook_active":false,
        "last_assistant_message":"All tests passed successfully."});
    let output = run(root.path(), &[], &stop.to_string());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result["decision"],
        "block",
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    provider.join().unwrap();
    let again = run(root.path(), &[], &stop.to_string());
    assert_eq!(
        serde_json::from_slice::<Value>(&again.stdout).unwrap(),
        json!({})
    );
    let scoped = root
        .path()
        .join("sessions")
        .join(format!("{:x}", Sha256::digest(b"review-thread")));
    let health: Value =
        serde_json::from_slice(&fs::read(scoped.join("logs/hook-health.json")).unwrap()).unwrap();
    assert_eq!(health["api_requests"], 0);
}
