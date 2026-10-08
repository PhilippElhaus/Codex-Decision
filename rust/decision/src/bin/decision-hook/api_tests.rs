use super::*;
use codex_decision::Batch;
use std::io::{BufRead, BufReader};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

struct ResetDeadline(Option<Instant>);

impl ResetDeadline {
    fn with_remaining(duration: Duration) -> Self {
        let previous = HOOK_STARTED.with(|started| {
            let previous = started.get();
            started.set(Some(Instant::now() - (Duration::from_secs(45) - duration)));
            previous
        });
        Self(previous)
    }
}

impl Drop for ResetDeadline {
    fn drop(&mut self) {
        HOOK_STARTED.with(|started| started.set(self.0));
    }
}

fn request() -> Value {
    json!({"model":"gpt-6-luna","state":{"text":"synthetic log line"},
        "questions":{"line_1":{"type":"noul","instructions":"Is source line 1 required?"}}})
}

fn parse_answer(response: &Value) -> Result<BTreeMap<usize, f64>, String> {
    relevance_answers(
        &Batch {
            id: 1,
            target_numbers: vec![1],
            request: Value::Null,
        },
        response,
    )
}

fn read_request(stream: &mut TcpStream) {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut reader = BufReader::new(stream);
    let mut length = None;
    loop {
        let mut header = String::new();
        assert!(reader.read_line(&mut header).unwrap() > 0);
        if header == "\r\n" {
            break;
        }
        if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
            length = Some(value.trim().parse::<usize>().unwrap());
        }
    }
    let mut body = vec![0; length.unwrap()];
    reader.read_exact(&mut body).unwrap();
    let wire: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(wire["model"], "gpt-6-luna");
}

#[cfg(unix)]
#[test]
fn health_lock_wait_reduces_the_actual_request_timeout() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    hook_health(&data, "seen", "").unwrap();
    let lock = lock_logs(&data.join("logs")).unwrap();
    let (unlock_start, unlock_wait) = std::sync::mpsc::channel();
    let unlocker = std::thread::spawn(move || {
        unlock_wait.recv().unwrap();
        std::thread::sleep(Duration::from_millis(600));
        drop(lock);
    });
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let accepted = Arc::new(AtomicBool::new(false));
    let server_accepted = accepted.clone();
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("{error}"),
            }
        };
        read_request(&mut stream);
        server_accepted.store(true, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(600));
        let body = r#"{"model":"gpt-6-luna","answers":[{"name":"line_1","type":"predicate","probability":0.01}]}"#;
        // The corrected client closes before this delayed valid response.
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
    });
    let request = request();
    let encoded = codex_decision::provider::encode_request(&request).unwrap();
    let _deadline = ResetDeadline::with_remaining(Duration::from_secs(1));
    unlock_start.send(()).unwrap();
    let result = evaluate_prepared(
        &data,
        &decision_agent(),
        &request,
        &encoded,
        "synthetic-deadline-key",
        1.0,
        &endpoint,
        parse_answer,
    );
    unlocker.join().unwrap();
    server.join().unwrap();
    assert!(accepted.load(Ordering::SeqCst));
    assert_eq!(result.unwrap_err(), "Decision request failed");
    let health: Value =
        serde_json::from_slice(&fs::read(data.join("logs/hook-health.json")).unwrap()).unwrap();
    assert_eq!(health["api_requests"], 1);
    assert_eq!(health["request_cancelled"].as_u64().unwrap_or(0), 0);
}

#[test]
fn expired_budget_after_attempt_registration_sends_nothing_and_records_cancellation() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    hook_health(&data, "request", "").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let previous = HOOK_STARTED.with(|started| {
        let previous = started.get();
        started.set(Some(Instant::now() - Duration::from_secs(46)));
        previous
    });
    let _deadline = ResetDeadline(previous);
    let encoded = codex_decision::provider::encode_request(&request()).unwrap();
    let result = send_request(
        &data,
        &decision_agent(),
        &encoded,
        "synthetic-deadline-key",
        1.0,
        &endpoint,
        &mut RequestOutcome::default(),
    );
    assert_eq!(result.unwrap_err(), "hook deadline");
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    let health: Value =
        serde_json::from_slice(&fs::read(data.join("logs/hook-health.json")).unwrap()).unwrap();
    assert_eq!(health["api_requests"], 1);
    assert_eq!(health["request_cancelled"], 1);
}

#[path = "api_tests/response.rs"]
mod response;

#[path = "api_tests/redirects.rs"]
mod redirects;
