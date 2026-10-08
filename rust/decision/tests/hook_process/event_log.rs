use super::*;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::UnixListener;
use std::time::Instant;

#[test]
fn nonregular_event_logs_fail_open_before_any_network_request_or_write() {
    verify_nonregular_log("events.jsonl", "event retention");
}

#[test]
fn nonregular_log_locks_fail_open_before_any_network_request_or_write() {
    verify_nonregular_log(".lock", "log lock");
}

fn verify_nonregular_log(filename: &str, message: &str) {
    for kind in ["fifo", "fifo-with-reader", "socket", "directory", "link"] {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let session = scoped(&data, "special-event-log");
        let logs = session.join("logs");
        fs::create_dir_all(&logs).unwrap();
        for folder in [&data, &data.join("sessions"), &session, &logs] {
            fs::set_permissions(folder, fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::write(
            session.join("config.json"),
            json!({"schema_version":5,"enabled":true,
                "mode":"replace","provider":"openai","model":"gpt-6-luna",
                "relevance_policy":{"relevant_max":5}})
            .to_string(),
        )
        .unwrap();
        fs::write(
            data.join(".env"),
            "OPENAI_API_KEY=synthetic-no-network-key\n",
        )
        .unwrap();
        fs::set_permissions(data.join(".env"), fs::Permissions::from_mode(0o600)).unwrap();
        let transcript = root.path().join("transcript.jsonl");
        fs::write(
            &transcript,
            json!({"type":"response_item","payload":{"role":"user",
            "content":[{"type":"input_text","text":"Find the failure"}]}})
            .to_string()
                + "\n",
        )
        .unwrap();
        let path = logs.join(filename);
        let mut reader = None;
        let mut socket = None;
        match kind {
            "fifo" | "fifo-with-reader" => {
                use std::os::unix::ffi::OsStrExt;
                let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
                // SAFETY: name is a valid, terminated path in this private fixture.
                assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
                if kind == "fifo-with-reader" {
                    reader = Some(
                        fs::OpenOptions::new()
                            .read(true)
                            .custom_flags(libc::O_NONBLOCK)
                            .open(&path)
                            .unwrap(),
                    );
                }
            }
            "socket" => {
                let short_path = root.path().join("event.sock");
                socket = Some(UnixListener::bind(&short_path).unwrap());
                fs::rename(short_path, &path).unwrap();
            }
            "directory" => fs::create_dir(&path).unwrap(),
            "link" => std::os::unix::fs::symlink(&transcript, &path).unwrap(),
            _ => unreachable!(),
        }
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let event = json!({"hook_event_name":"PostToolUse","session_id":"special-event-log",
            "tool_name":"Bash","tool_use_id":"special-one","transcript_path":transcript,
            "tool_input":{"command":"printf synthetic-output"},
            "tool_response":"INFO routine worker poll completed\n".repeat(80)
                +"ERROR: synthetic failure\nRun ended with return value 73.\n"});
        let mut child = Command::new(env!("CARGO_BIN_EXE_decision-hook"))
            .env("PLUGIN_DATA", &data)
            .env(
                "CODEX_DECISION_TEST_ENDPOINT",
                format!("http://{}", listener.local_addr().unwrap()),
            )
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
        let started = Instant::now();
        while child.try_wait().unwrap().is_none() {
            if started.elapsed() >= Duration::from_secs(2) {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("hook blocked on {kind}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{kind}");
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            json!({})
        );
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(message),
            "{kind}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        if let Some(mut reader) = reader {
            let mut bytes = Vec::new();
            reader.read_to_end(&mut bytes).unwrap();
            assert!(bytes.is_empty(), "FIFO received event text");
        }
        drop(socket);
        if filename == "events.jsonl" {
            let stats: Value =
                serde_json::from_slice(&fs::read(session.join("stats.json")).unwrap()).unwrap();
            assert_eq!(stats["counter_scheme"], 1);
            assert_eq!(stats["completed"], 0);
            assert_eq!(stats["calls"], 0);
        } else {
            assert!(
                !session.join("stats.json").exists(),
                "unsafe log lock prevents initialization"
            );
        }
        assert!(!logs.join("latest-decision.json").exists());
        assert!(!data.join("outputs").exists());
    }
}
