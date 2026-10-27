use super::*;

#[test]
fn request_outcomes_distinguish_headers_from_valid_typed_answers() {
    let valid = r#"{"model":"gpt-6-luna","answers":[{"name":"line_1","type":"predicate","probability":0.01}]}"#;
    let invalid = valid.replace("0.01", "1.5");
    for (status, body, error, received, validated) in [
        ("200 OK", valid, None, true, true),
        (
            "200 OK",
            invalid.as_str(),
            Some("Decision probability out of range"),
            true,
            false,
        ),
        (
            "500 Internal Server Error",
            "{}",
            Some("Decision request failed"),
            true,
            false,
        ),
        (
            "200 OK",
            "{broken",
            Some("invalid decision response"),
            true,
            false,
        ),
        ("", "", Some("Decision request failed"), false, false),
        (
            "200 OK",
            "",
            Some("Decision response read failed"),
            true,
            false,
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let body = body.to_owned();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "request was not sent");
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            read_request(&mut stream);
            if !status.is_empty() {
                // Empty 200 deliberately ends before its declared body length.
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len().max(1)
                )
                .unwrap();
            }
        });
        let request = request();
        let encoded = codex_decision::provider::encode_request(&request).unwrap();
        let result = evaluate_prepared(
            &data,
            &decision_agent(),
            &request,
            &encoded,
            "synthetic-outcome-key",
            1.0,
            &endpoint,
            parse_answer,
        );
        server.join().unwrap();
        match error {
            Some(error) => assert_eq!(result.unwrap_err(), error),
            None => assert_eq!(result.unwrap().1[&1], 0.01),
        }
        let health: Value =
            serde_json::from_slice(&fs::read(data.join("logs/hook-health.json")).unwrap()).unwrap();
        assert_eq!(health["api_requests"], 1);
        assert_eq!(health["responses_received"], u64::from(received));
        assert_eq!(health["responses_validated"], u64::from(validated));
        assert_eq!(health["request_failures"], u64::from(!validated));
        assert_eq!(health["errors"], 0);
    }
}

#[test]
fn request_failures_and_successes_are_joined_without_counting_requests_as_outputs() {
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    let root = tempfile::tempdir().unwrap();
    ensure_dir(root.path()).unwrap();
    write_private(&root.path().join("config.json"),
        br#"{"schema_version":5,"enabled":true,"mode":"observe","provider":"openai","model":"gpt-6-luna","relevance_policy":{"relevant_max":5}}"#,
        false).unwrap();
    let config = config(root.path()).unwrap().unwrap();
    usage::start(root.path(), &json!({"tool_name":"exec"}), &config);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/private-endpoint", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        for (status, body) in [
            ("503 Service Unavailable", "private-error-response"),
            (
                "200 OK",
                r#"{"model":"gpt-6-luna","answers":[{"name":"line_1","type":"predicate","probability":0.01}]}"#,
            ),
        ] {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut length = 0;
            loop {
                let mut header = String::new();
                assert!(reader.read_line(&mut header).unwrap() > 0);
                if header == "\r\n" {
                    break;
                }
                if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
            }
            reader.read_exact(&mut vec![0; length]).unwrap();
            write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        }
    });
    let connection = Connection {
        protocol: codex_decision::provider::Provider::OpenAi,
        endpoint,
        model: "private-model-name".into(),
        header: Some(("Authorization".into(), "Bearer private-test-key".into())),
        custom: false,
    };
    let request_value = json!({"model":"gpt-6-luna","state":{"text":"private-input-text"},
        "questions":{"line_1":{"type":"noul","instructions":"private-question"}}});
    let agent = decision_agent();
    assert!(evaluate(
        root.path(),
        &agent,
        &request_value,
        &connection,
        1.0,
        |_| Ok(())
    )
    .is_err());
    usage::fallback();
    assert!(evaluate(
        root.path(),
        &agent,
        &request_value,
        &connection,
        1.0,
        |_| Ok(())
    )
    .is_ok());
    usage::completed("candidate", "observe", 10, 6, 0);
    usage::finish(&Ok(json!({})));
    server.join().unwrap();
    let records: Vec<Value> = fs::read_to_string(root.path().join("logs/telemetry.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(records.len(), 4);
    assert_eq!(records[1]["event"], "request");
    assert_eq!(records[1]["http_status"], 503);
    assert_eq!(records[1]["outcome"], "http_error");
    assert_eq!(records[1]["request_index"], 1);
    assert_eq!(records[2]["http_status"], 200);
    assert_eq!(records[2]["outcome"], "validated");
    assert_eq!(records[2]["request_index"], 2);
    assert!(records[2]["response_bytes"].as_u64().unwrap() > 0);
    assert_eq!(records[3]["request_count"], 2);
    assert_eq!(records[3]["fallback_used"], true);
    assert_eq!(records[3]["delivery"], "unverified");
    assert_eq!(records[3]["proposed_omitted"], 6);
    assert_eq!(records[3]["prepared_saved_chars"], 0);
    for record in &records {
        assert_eq!(record["invocation_id"], records[0]["invocation_id"]);
    }
    let serialized = serde_json::to_string(&records).unwrap();
    for sentinel in [
        "private-endpoint",
        "private-error-response",
        "private-model-name",
        "private-test-key",
        "private-input-text",
        "private-question",
    ] {
        assert!(!serialized.contains(sentinel), "leaked {sentinel}");
    }
}
