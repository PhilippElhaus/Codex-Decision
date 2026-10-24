//! The native binary completes real provider I/O and the publication transaction.
use super::*;
use std::io::{BufRead, BufReader, Read};
use std::net::TcpListener;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

#[test]
fn native_provider_replacement_preserves_typed_originals_and_repeated_publication() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    fs::create_dir(&data).unwrap();
    let config = codex_decision::contract::validate(
        "config",
        &json!({
            "schema_version":5,"scope":"global","enabled":true,"mode":"replace",
            "min_chars":256,"provider":"openai","relevance_policy":{"relevant_max":5}
        }),
    )
    .unwrap();
    fs::write(data.join("config.json"), config.to_string()).unwrap();
    fs::write(
        data.join(".env"),
        b"OPENAI_API_KEY=synthetic-native-test-key\n",
    )
    .unwrap();
    let transcript = root.path().join("transcript.jsonl");
    fs::write(&transcript, json!({"type":"response_item","payload":{"role":"user",
        "content":[{"type":"input_text","text":"Check whether the synthetic service reports a failure"}]}})
        .to_string() + "\n").unwrap();
    codex_decision::windows::secure_tree(root.path()).unwrap();
    let source = "INFO routine heartbeat status unchanged\n".repeat(120)
        + "ERROR: synthetic failure\nDone\n";
    let envelope = json!({"output":source,"exit_code":0});
    let event = json!({"hook_event_name":"PostToolUse","session_id":"native-provider",
        "tool_use_id":"native-provider-call","transcript_path":transcript,
        "tool_name":"exec_command","tool_input":{"cmd":"cat worker.log"},"tool_response":envelope});
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let done = Arc::clone(&stop);
    let server = std::thread::spawn(move || {
        let mut count = 0;
        while !done.load(Ordering::Relaxed) {
            let Ok((mut stream, _)) = listener.accept() else {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut length = 0;
            loop {
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
            }
            assert!((1..1_000_000).contains(&length));
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let request: Value = serde_json::from_slice(&body).unwrap();
            let answers: Vec<_> = request["questions"].as_array().unwrap().iter()
                .map(|question| json!({"name":question["name"],"type":"predicate","probability":0.01}))
                .collect();
            let response = json!({"model":request["model"],"answers":answers}).to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                response.len()
            )
            .unwrap();
            count += 1;
        }
        count
    });
    let scoped = data
        .join("sessions")
        .join(format!("{:x}", Sha256::digest("native-provider")));
    let mut results = Vec::new();
    for _ in 0..2 {
        let mut child = Command::new(env!("CARGO_BIN_EXE_decision-hook"))
            .env("PLUGIN_DATA", &data)
            .env("CODEX_DECISION_TEST_ENDPOINT", &endpoint)
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
        results.push(child.wait_with_output().unwrap());
    }
    stop.store(true, Ordering::Relaxed);
    let requests = server.join().unwrap();
    assert!(requests >= 2);
    for result in results {
        assert!(result.status.success());
        assert!(
            result.stderr.is_empty(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let answer: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(answer["continue"], false, "{answer}");
        assert!(answer["reason"]
            .as_str()
            .unwrap()
            .contains("ERROR: synthetic failure"));
    }
    let hash = |value: &str| format!("{:x}", Sha256::digest(value))[..20].to_owned();
    let original = data
        .join("outputs")
        .join(hash("native-provider"))
        .join(format!("{}.txt", hash("native-provider-call")));
    assert_eq!(
        fs::read_to_string(&original).unwrap(),
        format!("Command result metadata: {{\"exit_code\":0}}\n{source}")
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(original.with_extension("json")).unwrap())
            .unwrap(),
        envelope
    );
    codex_decision::windows::private(&fs::File::open(original).unwrap(), 1).unwrap();
    let panel: Value =
        serde_json::from_slice(&fs::read(scoped.join("logs/latest-decision.json")).unwrap())
            .unwrap();
    assert_eq!(panel["status"], "replace");
    assert!(panel["totals"]["omitted"].as_u64().unwrap() > 0);
    let stats: Value =
        serde_json::from_slice(&fs::read(scoped.join("stats.json")).unwrap()).unwrap();
    assert_eq!(stats["calls"], requests);
    assert_eq!(stats["completed"], 2);
    assert_eq!(stats["replaced"], 2);
    assert!(!scoped
        .join("logs")
        .join(codex_decision::publication_contract::JOURNAL_NAME)
        .exists());
    let receipts: Vec<_> = fs::read_dir(scoped.join("logs"))
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
        .collect();
    assert_eq!(receipts.len(), 2);
    for receipt in receipts {
        let receipt: Value = serde_json::from_slice(&fs::read(receipt).unwrap()).unwrap();
        assert_eq!(
            receipt["initial_output"],
            format!("Command result metadata: {{\"exit_code\":0}}\n{source}")
        );
    }
}
