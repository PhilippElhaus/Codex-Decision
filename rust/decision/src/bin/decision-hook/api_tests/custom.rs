use super::*;
use codex_decision::provider::Provider;

#[test]
fn custom_choice_answers_keep_strict_distribution_validation_for_both_schemas() {
    for protocol in [Provider::OpenAi, Provider::TypeSafe] {
        for invalid in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let data = root.path().join("data");
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let connection = Connection {
                endpoint: format!("http://{}/", listener.local_addr().unwrap()),
                protocol,
                model: "custom-choice-model".into(),
                header: None,
                custom: true,
            };
            let response = choice_response(protocol, invalid).to_string();
            let server = std::thread::spawn(move || {
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
                    if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:")
                    {
                        length = value.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let wire: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(wire["model"], "custom-choice-model");
                assert_eq!(wire["questions"].is_array(), protocol == Provider::OpenAi);
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                    response.len()
                )
                .unwrap();
            });
            let request = classification_request(
                "Find the failure",
                "Bash",
                "worker",
                &Value::Null,
                &source_lines("INFO routine\nERROR failure\n"),
                protocol.default_model(),
            );
            let result = evaluate(
                &data,
                &decision_agent(),
                &request,
                &connection,
                2.0,
                classification,
            );
            server.join().unwrap();
            if invalid {
                let failure = result.unwrap_err();
                assert_eq!(failure.reason, "invalid Decision class distribution");
                assert!(failure.provider_unavailable);
            } else {
                let (response, (kind, excerptable)) = result.unwrap();
                assert_eq!(response["model"], "custom-choice-model");
                assert_eq!(kind, "repetitive_log");
                assert!(excerptable);
            }
        }
    }
}

fn choice_response(protocol: Provider, invalid: bool) -> Value {
    let probability = if invalid { 0.5 } else { 1.0 };
    if protocol == Provider::OpenAi {
        let rows = KINDS
            .iter()
            .map(|kind| {
                json!({"value":kind,
            "probability":if *kind == "repetitive_log" {probability} else {0.0}})
            })
            .collect::<Vec<_>>();
        json!({"model":"custom-choice-model","answers":[{"name":"output_kind","type":"choice",
            "choice":"repetitive_log","confidence":probability,"probabilities":rows}]})
    } else {
        let probabilities = KINDS
            .iter()
            .map(|kind| {
                (
                    kind.to_string(),
                    json!(if *kind == "repetitive_log" {
                        probability
                    } else {
                        0.0
                    }),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        json!({"model":"custom-choice-model","answers":{"output_kind":{"type":"choice",
            "choice":"repetitive_log","confidence":probability,"probabilities":probabilities}}})
    }
}
