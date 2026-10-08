use super::*;

struct ShortWriter {
    bytes: Vec<u8>,
    calls: usize,
    limit: Option<usize>,
    flushed: bool,
}

impl Write for ShortWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.calls += 1;
        if self.calls == 2 {
            return Err(std::io::ErrorKind::Interrupted.into());
        }
        if self.limit.is_some_and(|limit| self.bytes.len() >= limit) {
            return Err(std::io::ErrorKind::PermissionDenied.into());
        }
        let count = bytes.len().min(2).min(
            self.limit
                .map_or(usize::MAX, |limit| limit - self.bytes.len()),
        );
        self.bytes.extend_from_slice(&bytes[..count]);
        Ok(count)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.flushed = true;
        Ok(())
    }
}

#[test]
fn quoted_chunks_handle_short_writes_interruptions_and_every_escape() {
    let text = (0..=31).map(char::from).collect::<String>() + "\"\\λ🌍状態";
    let expected = serde_json::to_vec(&text).unwrap();
    for width in [1, 2, 7, text.len()] {
        let mut output = ShortWriter {
            bytes: Vec::new(),
            calls: 0,
            limit: None,
            flushed: false,
        };
        let mut writer = QuotedContent(&mut output);
        for chunk in text.as_bytes().chunks(width) {
            writer.write_all(chunk).unwrap();
        }
        writer.flush().unwrap();
        assert_eq!(output.bytes, expected[1..expected.len() - 1]);
        assert!(output.flushed);
    }
}

#[test]
fn quoted_chunks_propagate_failure_after_a_partial_underlying_write() {
    let text = "prefix\"\\\nλ🌍";
    let expected = serde_json::to_vec(text).unwrap();
    for limit in 0..expected.len() - 2 {
        let mut output = ShortWriter {
            bytes: Vec::new(),
            calls: 0,
            limit: Some(limit),
            flushed: false,
        };
        let error = QuotedContent(&mut output)
            .write_all(text.as_bytes())
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(output.bytes, expected[1..1 + limit]);
    }
}
