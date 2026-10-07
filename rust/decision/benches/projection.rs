//! Isolated exact command-envelope projection measurements.
use serde_json::json;
#[path = "common/measure.rs"]
mod measurement;
#[path = "../src/bin/decision-hook/projection.rs"]
#[allow(unused_imports)]
mod projection;

use projection::tests::baseline;

fn main() {
    for (stdout, chunk) in [(1000, 16), (2000000, 16), (1000, 500000)] {
        let value = json!({"output":"INFO λ🌍 worker poll\r\n".repeat(stdout/27),"chunk_id":"x\"\\λ".repeat(chunk/5),
            "exit_code":null,"session_id":42,"wall_time_seconds":-0.0,"original_token_count":u64::MAX});
        let object = value.as_object().unwrap();
        assert_eq!(baseline(object), projection::command_projection(object));
        measurement::measure(&format!("projection-value-{stdout}-{chunk}"), || {
            baseline(object)
        });
        measurement::measure(&format!("projection-borrowed-{stdout}-{chunk}"), || {
            projection::command_projection(object)
        });
    }
}
