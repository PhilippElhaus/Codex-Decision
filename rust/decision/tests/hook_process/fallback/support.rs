//! Synthetic provider service and hook fixtures.
use super::*;
use std::io::{BufRead, BufReader};

#[derive(Clone, Copy)]
pub(super) enum Failure {
    Http,
    Protocol,
    Transport,
    None,
}

type MockServer = (
    String,
    Arc<AtomicBool>,
    std::thread::JoinHandle<Vec<String>>,
);

pub(super) fn server(
    primary_model: &'static str,
    failure: Failure,
    fail_after: usize,
    alternate_fails: bool,
) -> MockServer {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let done = stop.clone();
    let thread = std::thread::spawn(move || {
        let mut models = Vec::new();
        while !done.load(Ordering::Relaxed) {
            let Ok((mut stream, _)) = listener.accept() else {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut length = None;
            let mut authorization = None;
            loop {
                let mut header = String::new();
                assert!(reader.read_line(&mut header).unwrap() > 0);
                if header == "\r\n" {
                    break;
                }
                if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = Some(value.trim().parse::<usize>().unwrap());
                }
                if header.to_ascii_lowercase().starts_with("authorization:") {
                    authorization = Some(header["authorization:".len()..].trim().to_owned());
                }
            }
            let mut bytes = vec![0; length.unwrap()];
            reader.read_exact(&mut bytes).unwrap();
            let request: Value = serde_json::from_slice(&bytes).unwrap();
            let model = request["model"].as_str().unwrap().to_owned();
            let authorization = authorization.expect("synthetic authorization header");
            let key = authorization.strip_prefix("Bearer ").unwrap();
            let expected = if model == "gpt-6-luna" {
                key == "synthetic-openai-key" || key == "a".repeat(4096)
            } else {
                key == "synthetic-jev-key" || key == "j".repeat(4096)
            };
            assert!(
                expected,
                "request used the wrong provider's synthetic credential"
            );
            models.push(model.clone());
            let fail = if model == primary_model && models.len() > fail_after {
                failure
            } else if model != primary_model && alternate_fails {
                Failure::Protocol
            } else {
                Failure::None
            };
            if matches!(fail, Failure::Transport) {
                continue;
            }
            let status = if matches!(fail, Failure::Http) {
                "503 Service Unavailable"
            } else {
                "200 OK"
            };
            let response = if matches!(fail, Failure::Protocol | Failure::Http) {
                "{}".to_owned()
            } else if model == "gpt-6-luna" {
                let answers = request["questions"].as_array().unwrap().iter().map(|question| {
                    json!({"name":question["name"],"type":"predicate","probability":0.01})
                }).collect::<Vec<_>>();
                json!({"model":model,"answers":answers}).to_string()
            } else {
                let answers = request["questions"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(|name| (name.clone(), json!({"type":"noul","noul":0.01})))
                    .collect::<serde_json::Map<_, _>>();
                json!({"model":"jev-1.13.0","answers":answers}).to_string()
            };
            write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                response.len()
            )
            .unwrap();
        }
        models
    });
    (endpoint, stop, thread)
}

pub(super) fn fixture(
    provider: &str,
    fallback: bool,
    keys: &str,
    lines: usize,
) -> (tempfile::TempDir, PathBuf, Value) {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    fs::create_dir(&data).unwrap();
    fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).unwrap();
    let config = codex_decision::contract::validate(
        "config",
        &json!({
        "schema_version":5,"scope":"global","enabled":true,"provider":provider,
        "fallback_enabled":fallback,"mode":"replace","min_chars":256,
        "relevance_policy":{"relevant_max":5}}),
    )
    .expect("valid fallback fixture config");
    fs::write(data.join("config.json"), config.to_string()).unwrap();
    fs::write(data.join(".env"), keys).unwrap();
    fs::set_permissions(data.join(".env"), fs::Permissions::from_mode(0o600)).unwrap();
    let transcript = root.path().join("transcript.jsonl");
    fs::write(&transcript, json!({"type":"response_item","payload":{"role":"user",
        "content":[{"type":"input_text","text":"Check whether the synthetic service reports a failure"}]}})
        .to_string() + "\n").unwrap();
    let source = "INFO routine heartbeat status unchanged\n".repeat(lines)
        + "ERROR: synthetic failure\nDone\n";
    let event = json!({"hook_event_name":"PostToolUse","tool_name":"Bash","session_id":"fallback",
        "tool_use_id":"fallback-call","transcript_path":transcript,
        "tool_input":{"command":"synthetic-worker"},"tool_response":source});
    (root, data, event)
}

pub(super) const BOTH_KEYS: &str =
    "OPENAI_API_KEY=synthetic-openai-key\nJEV_API_KEY=synthetic-jev-key\n";

pub(super) fn invoke(data: &Path, endpoint: &str, event: &Value) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_decision-hook"))
        .env("PLUGIN_DATA", data)
        .env("CODEX_DECISION_TEST_ENDPOINT", endpoint)
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
    serde_json::from_slice(&output.stdout).unwrap()
}

pub(super) fn health(data: &Path) -> Value {
    serde_json::from_slice(
        &fs::read(scoped(data, "fallback").join("logs/hook-health.json")).unwrap(),
    )
    .unwrap()
}

pub(super) fn assert_replacement(data: &Path, endpoint: &str, event: &Value) {
    let output = invoke(data, endpoint, event);
    let diagnostics =
        fs::read_to_string(scoped(data, "fallback").join("logs/events.jsonl")).unwrap_or_default();
    assert_eq!(
        output["continue"], false,
        "hook output: {output}; events: {diagnostics}"
    );
    let feedback = output["reason"].as_str().unwrap();
    let original = feedback
        .split("full original: ")
        .nth(1)
        .unwrap()
        .split(']')
        .next()
        .unwrap();
    assert_eq!(
        fs::read(original).unwrap(),
        event["tool_response"].as_str().unwrap().as_bytes()
    );
    assert_eq!(receipt(data)["initial_output"], event["tool_response"]);
    assert!(feedback.contains("ERROR: synthetic failure"));
}

pub(super) fn receipt(data: &Path) -> Value {
    let logs = scoped(data, "fallback").join("logs");
    let receipts = fs::read_dir(logs)
        .unwrap()
        .filter_map(|entry| {
            let path = entry.unwrap().path();
            path.is_dir().then(|| fs::read_dir(path).unwrap())
        })
        .flatten()
        .filter_map(|entry| {
            let path = entry.unwrap().path();
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("receipt-")
                .then_some(path)
        })
        .collect::<Vec<_>>();
    assert_eq!(receipts.len(), 1);
    serde_json::from_slice(&fs::read(&receipts[0]).unwrap()).unwrap()
}
