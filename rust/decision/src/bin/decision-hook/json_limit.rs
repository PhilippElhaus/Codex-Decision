//! Stop oversized tool input without allocating its serialized representation.
use serde_json::Value;
use std::io::{self, Write};

struct Limit {
    remaining: usize,
    exceeded: bool,
}

impl Write for Limit {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.remaining {
            self.exceeded = true;
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "JSON size bound",
            ));
        }
        self.remaining -= bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(super) fn within(value: &Value, limit: usize) -> Result<bool, String> {
    let mut writer = Limit {
        remaining: limit,
        exceeded: false,
    };
    match serde_json::to_writer(&mut writer, value) {
        Ok(()) => Ok(true),
        Err(_) if writer.exceeded => Ok(false),
        Err(_) => Err("tool input encoding".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn serialized_input_limits_match_the_encoder_at_exact_boundaries() {
        for value in [
            Value::Null,
            json!({}),
            json!({"command":"λ🌍\"\\\n\t\u{0}"}),
            json!({"command":"x".repeat(300000),"nested":[null,true,u64::MAX]}),
        ] {
            let length = serde_json::to_vec(&value).unwrap().len();
            assert!(within(&value, length).unwrap());
            assert!(!within(&value, length - 1).unwrap());
            assert!(within(&value, length + 1).unwrap());
        }
    }
}
