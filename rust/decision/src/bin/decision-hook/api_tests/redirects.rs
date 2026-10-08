use super::*;
use std::sync::atomic::AtomicUsize;

#[test]
fn redirects_never_add_an_http_request_or_validate_a_non_success_status() {
    for status in [301, 302, 303, 307, 308, 399] {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = requests.clone();
        let (finished, finish) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        observed.fetch_add(1, Ordering::SeqCst);
                        stream
                            .set_read_timeout(Some(Duration::from_secs(1)))
                            .unwrap();
                        let mut reader = BufReader::new(&mut stream);
                        let mut length = 0;
                        loop {
                            let mut line = String::new();
                            assert!(reader.read_line(&mut line).unwrap() > 0);
                            if line == "\r\n" {
                                break;
                            }
                            if let Some(value) =
                                line.to_ascii_lowercase().strip_prefix("content-length:")
                            {
                                length = value.trim().parse::<usize>().unwrap();
                            }
                        }
                        let mut body = vec![0; length];
                        reader.read_exact(&mut body).unwrap();
                        let body = r#"{"model":"gpt-6-luna","answers":[{"name":"line_1","type":"predicate","probability":0.01}]}"#;
                        let code = if observed.load(Ordering::SeqCst) == 1 {
                            status
                        } else {
                            200
                        };
                        write!(stream, "HTTP/1.1 {code} Synthetic\r\nLocation: /follow\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if finish.try_recv().is_ok() {
                            return;
                        }
                        assert!(Instant::now() < deadline, "redirect fixture timed out");
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("{error}"),
                }
            }
        });
        let request = request();
        let encoded = codex_decision::provider::encode_request(&request).unwrap();
        let result = evaluate_prepared(
            &data,
            &decision_agent(),
            &request,
            &encoded,
            "synthetic-redirect-key",
            1.0,
            &endpoint,
            parse_answer,
        );
        finished.send(()).unwrap();
        server.join().unwrap();
        assert_eq!(result.unwrap_err(), "Decision request failed");
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        let health: Value =
            serde_json::from_slice(&fs::read(data.join("logs/hook-health.json")).unwrap()).unwrap();
        assert_eq!(health["api_requests"], 1);
        assert_eq!(health["responses_received"], 1);
        assert_eq!(health["responses_validated"], 0);
        assert_eq!(health["request_failures"], 1);
    }
}
