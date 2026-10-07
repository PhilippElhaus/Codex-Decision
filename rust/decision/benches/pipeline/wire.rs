//! Compare complete wire bytes and encoding costs for both request stages.
use super::measurement::measure;
use codex_decision::{provider::*, semantic::classification_request, SourceLine};
use serde_json::Value;

pub(super) fn run(request: &Value, lines: &[SourceLine], model: &str, count: usize, width: usize) {
    compare(request, &format!("{model}-{count}-{width}"));
    let classifier = classification_request(
        "Find the failure and final status",
        "Bash",
        "printf synthetic-output",
        &Value::Null,
        lines,
        model,
    );
    compare(
        &classifier,
        &format!("classification-{model}-{count}-{width}"),
    );
}

fn compare(request: &Value, fixture: &str) {
    let encoded = || encode_request(request).unwrap();
    let baseline = || serde_json::to_vec(&wire_request(request).unwrap()).unwrap();
    assert_eq!(encoded(), baseline());
    measure(&format!("wire-value-{fixture}"), baseline);
    measure(&format!("wire-borrowed-{fixture}"), encoded);
}
