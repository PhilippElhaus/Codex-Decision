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
