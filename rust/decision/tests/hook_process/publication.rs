use super::*;

#[test]
fn failed_publication_removes_only_owned_originals_and_allows_a_retry() {
    let (endpoint, stop, server) = mock_server(None);
    for failure in ["stats", "envelope", "text"] {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        fs::create_dir(&data).unwrap();
        fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            data.join("config.json"),
            json!({"schema_version":4,"scope":"global",
            "enabled":true,"mode":"replace","relevance_policy":{"relevant_max":5}})
            .to_string(),
        )
        .unwrap();
        fs::write(data.join(".env"), "JEV_API_KEY=synthetic-test-key\n").unwrap();
        fs::set_permissions(data.join(".env"), fs::Permissions::from_mode(0o600)).unwrap();
        let transcript = root.path().join("transcript.jsonl");
        fs::write(
            &transcript,
            json!({"type":"response_item","payload":{"role":"user",
            "content":[{"type":"input_text","text":"Find the connection failure."}]}})
            .to_string()
                + "\n",
        )
        .unwrap();
        let source = (0..80)
            .map(|i| format!("INFO routine poll {i:04}\r\n"))
            .collect::<String>()
            + "ERROR: synthetic connection failure\r\nDone\r\n";
        let response = json!({"output":source,"exit_code":1});
        let event = json!({"hook_event_name":"PostToolUse","tool_name":"exec_command",
            "session_id":"retry","tool_use_id":"same-call","transcript_path":transcript,
            "tool_input":{"cmd":"printf synthetic-output"},"tool_response":response});
        let session = scoped(&data, "retry");
        let hash = |text: &str| format!("{:x}", Sha256::digest(text.as_bytes()))[..20].to_owned();
        let output_dir = data.join("outputs").join(hash("retry"));
        fs::create_dir_all(&output_dir).unwrap();
        for path in [&data.join("outputs"), &output_dir] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let text_path = output_dir.join(format!("{}.txt", hash("same-call")));
        let json_path = text_path.with_extension("json");
        let blocker = match failure {
            "stats" => {
                fs::create_dir_all(&session).unwrap();
                for path in [&data.join("sessions"), &session] {
                    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
                }
                session.join("stats.json")
            }
            "envelope" => json_path.clone(),
            _ => text_path.clone(),
        };
        let sentinel = if failure == "stats" {
            "{broken"
        } else {
            "existing user-owned data"
        };
        fs::write(&blocker, sentinel).unwrap();
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
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            json!({})
        );
        assert!(!output.stderr.is_empty());
        assert_eq!(fs::read_to_string(&blocker).unwrap(), sentinel);
        for path in [&text_path, &json_path] {
            if path != &blocker {
                assert!(!path.exists(), "orphaned original after {failure}");
            }
        }
        assert!(!session.join("logs/latest-decision.json").exists());
        assert!(!fs::read_to_string(session.join("logs/events.jsonl"))
            .unwrap()
            .contains("\"status\":\"replace\""));
        fs::remove_file(&blocker).unwrap();
        let reply = send_event(&data, &endpoint, &event);
        assert_eq!(reply["continue"], false, "retry after {failure}");
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&json_path).unwrap()).unwrap(),
            response
        );
        assert!(fs::read_to_string(&text_path).unwrap().ends_with(&source));
        if failure == "stats" {
            // A foreign in-flight panel defers live publication. Completion
            // must still produce a valid snapshot and preserve prior originals.
            let panel_path = session.join("logs/latest-decision.json");
            let mut panel: Value = serde_json::from_slice(&fs::read(&panel_path).unwrap()).unwrap();
            panel["status"] = json!("processing");
            panel["receipt_id"] = json!("a".repeat(32));
            fs::write(&panel_path, panel.to_string()).unwrap();
            let mut next = event.clone();
            next["tool_use_id"] = json!("next-call");
            assert_eq!(send_event(&data, &endpoint, &next)["continue"], false);
            let final_panel: Value =
                serde_json::from_slice(&fs::read(&panel_path).unwrap()).unwrap();
            assert_eq!(final_panel["status"], "replace");
            let id = final_panel["id"].as_str().unwrap();
            assert_eq!(id.len(), 32);
            assert!(id.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert_ne!(final_panel["receipt_id"], panel["receipt_id"]);
            assert_eq!(
                serde_json::from_slice::<Value>(&fs::read(&json_path).unwrap()).unwrap(),
                response
            );
        }
    }
    stop.store(true, Ordering::Relaxed);
    assert_eq!(server.join().unwrap(), 7);
}
