//! Verify custom connections through the real fail-open hook process.
use super::*;
use codex_decision::provider::CustomProvider;
use std::io::{BufRead, BufReader};

type CapturedRequests = Vec<(Value, Vec<String>)>;
type CustomServer = (
    String,
    Arc<AtomicBool>,
    std::thread::JoinHandle<CapturedRequests>,
);

fn custom_server(protocol: &str, invalid: &str) -> CustomServer {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/decisions", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let done = stop.clone();
    let protocol = protocol.to_owned();
    let invalid = invalid.to_owned();
    let server = std::thread::spawn(move || {
        let mut captured = Vec::new();
        while !done.load(Ordering::Relaxed) {
            let Ok((mut stream, _)) = listener.accept() else {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut headers = Vec::new();
            let mut length = 0;
            loop {
                let mut header = String::new();
                assert!(reader.read_line(&mut header).unwrap() > 0);
                if header == "\r\n" {
                    break;
                }
                if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
                headers.push(header.trim().to_owned());
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let request: Value = serde_json::from_slice(&body).unwrap();
            let probability = if invalid == "probability" { 1.5 } else { 0.01 };
            let model = if invalid == "model" {
                "wrong-model"
            } else {
                "private-model-v2"
            };
            let response = if protocol == "openai" {
                let answers = request["questions"].as_array().unwrap().iter().map(|question| {
                    json!({"name":question["name"],"type":"predicate","probability":probability})
                }).collect::<Vec<_>>();
                json!({"model":model,"answers":answers})
            } else {
                let answers = request["questions"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(|name| (name.clone(), json!({"type":"noul","noul":probability})))
                    .collect::<serde_json::Map<_, _>>();
                json!({"model":model,"answers":answers})
            }
            .to_string();
            captured.push((request, headers));
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                response.len()
            )
            .unwrap();
        }
        captured
    });
    (endpoint, stop, server)
}

fn configure(data: &Path, endpoint: &str, protocol: &str, auth: &str) -> CustomProvider {
    let custom: CustomProvider = serde_json::from_value(json!({"name":"Private synthetic service",
        "protocol":protocol,"endpoint":endpoint,"model":"private-model-v2","auth":auth,
        "username":if auth == "basic" {"user"} else {""},
        "header_name":if auth == "header" {"X-Private-Key"} else {""}}))
    .unwrap();
    let raw = json!({"schema_version":5,"scope":"global","enabled":true,"mode":"replace",
        "provider":"custom","custom_provider":custom,"relevance_policy":{"relevant_max":5}});
    let config = codex_decision::contract::validate("config", &raw).unwrap();
    fs::write(data.join("config.json"), config.to_string()).unwrap();
    fs::write(data.join(".env"), format!("CUSTOM_CREDENTIAL_IDENTITY={}\nCUSTOM_API_KEY=synthetic-private-key\nCUSTOM_PASSWORD=test password\n", custom.credential_identity())).unwrap();
    custom
}

#[test]
fn custom_protocols_and_all_auth_modes_preserve_actual_models_in_receipts() {
    for protocol in ["openai", "jev"] {
        for auth in ["bearer", "basic", "header", "none"] {
            let (_root, data, event) = fixture("openai", false, BOTH_KEYS, 120);
            let (endpoint, stop, server) = custom_server(protocol, "");
            configure(&data, &endpoint, protocol, auth);
            if auth == "none" {
                fs::remove_file(data.join(".env")).unwrap();
            }
            assert_replacement(&data, &endpoint, &event);
            stop.store(true, Ordering::Relaxed);
            let captured = server.join().unwrap();
            assert!(!captured.is_empty());
            for (request, headers) in captured {
                assert_eq!(request["model"], "private-model-v2");
                assert_eq!(request["questions"].is_array(), protocol == "openai");
                let auth_headers = headers
                    .iter()
                    .filter(|header| {
                        let lower = header.to_ascii_lowercase();
                        lower.starts_with("authorization:") || lower.starts_with("x-private-key:")
                    })
                    .collect::<Vec<_>>();
                let expected = match auth {
                    "bearer" => Some("Authorization: Bearer synthetic-private-key"),
                    "basic" => Some("Authorization: Basic dXNlcjp0ZXN0IHBhc3N3b3Jk"),
                    "header" => Some("X-Private-Key: synthetic-private-key"),
                    _ => None,
                };
                assert_eq!(auth_headers.len(), usize::from(expected.is_some()));
                if let Some(expected) = expected {
                    assert_eq!(*auth_headers[0], expected);
                }
            }
            let manifest = receipt(&data)["manifest"].clone();
            assert_eq!(manifest["provider"], "custom");
            assert_eq!(manifest["model"], "private-model-v2");
            assert_eq!(manifest["configured_model"], "private-model-v2");
            assert_eq!(manifest["custom_provider"]["protocol"], protocol);
            assert_eq!(
                manifest["custom_provider"]["name"],
                "Private synthetic service"
            );
        }
    }
}

#[test]
fn invalid_custom_answers_or_retargeted_credentials_keep_the_full_output() {
    for scenario in ["model", "probability", "credential_target"] {
        let (_root, data, event) = fixture("openai", false, BOTH_KEYS, 120);
        let (endpoint, stop, server) = custom_server("openai", scenario);
        configure(&data, &endpoint, "openai", "bearer");
        if scenario == "credential_target" {
            fs::write(
                data.join(".env"),
                "CUSTOM_CREDENTIAL_IDENTITY=wrong-target\nCUSTOM_API_KEY=synthetic-private-key\n",
            )
            .unwrap();
        }
        assert_eq!(invoke(&data, &endpoint, &event), json!({}));
        stop.store(true, Ordering::Relaxed);
        let captured = server.join().unwrap();
        assert_eq!(captured.len(), usize::from(scenario != "credential_target"));
        assert!(!data.join("outputs").exists());
        assert!(!scoped(&data, "fallback")
            .join("logs/latest-decision.json")
            .exists());
        let stats: Value = serde_json::from_slice(
            &fs::read(scoped(&data, "fallback").join("stats.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(stats["completed"], 0);
    }
}
