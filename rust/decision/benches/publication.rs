//! Exact private-record serializer comparison; no filesystem or API calls.
use codex_decision::{semantic::*, source_lines, Action, BatchRecord, SourceLine};
use serde_json::{json, Value};
use std::hint::black_box;

const MAX_RECEIPT_BYTES: usize = 8 * 1024 * 1024;
const PANEL_SNAPSHOT_MAX_BYTES: usize = 8 * 1024 * 1024;

#[path = "../src/bin/decision-hook/prepared_json.rs"]
#[allow(unused_imports)]
mod prepared_json;
use prepared_json::*;

#[path = "../src/bin/decision-hook/encoding.rs"]
// A harness-free bench enables cfg(test), but does not compile test functions.
#[allow(unused_imports)]
mod encoding;
#[path = "common/measure.rs"]
mod measurement;
#[path = "../src/bin/decision-hook/snapshot/encoding.rs"]
#[allow(unused_imports)]
mod snapshot_encoding;
use snapshot_encoding::tests::baseline as snapshot_baseline;

fn main() {
    for count in [100, 1000, 10000] {
        let source: String = (0..count)
            .map(|n| {
                format!("INFO routine synthetic worker poll {n:05} λ🌍 completed normally\r\n")
            })
            .collect();
        let lines = source_lines(&source);
        let probabilities = lines.iter().map(|line| (line.number, (0.01, 1))).collect();
        let decisions = apply_relevance_batches(&lines, &probabilities, 5);
        let visible =
            codex_decision::render(&source, &lines, &decisions, "/synthetic/original.txt");
        let event = json!({"tool_name":"Bash","tool_input":{"command":"printf synthetic-output"}});
        let timestamp = "2026-10-07T10:03:20.123456789+00:00";
        let manifest = json!({"version":3,"id":"synthetic","at":timestamp,"status":"replace","source_sha256":"synthetic","lines_seen":count});
        let baseline = || {
            serde_json::to_vec(&json!({"version":3,"manifest":manifest,"tool":event.get("tool_name"),
            "tool_input":event.get("tool_input"),"initial_output":source,"visible_output":Some(&visible),"decisions":decisions})).unwrap()
        };
        let borrowed = || {
            encoding::encode_receipt(&manifest, &event, &source, Some(&visible), &decisions)
                .unwrap()
        };
        assert_eq!(baseline(), borrowed());
        measurement::measure(&format!("receipt-value-{count}"), baseline);
        measurement::measure(&format!("receipt-borrowed-{count}"), borrowed);
        let prepared = || {
            encoding::prepare_receipt(&manifest, &event, &source, Some(&visible), &decisions)
                .unwrap()
        };
        assert_eq!(baseline(), prepared().finish(timestamp).unwrap());
        measurement::measure(&format!("receipt-prepared-{count}"), || {
            prepared().finish(timestamp).unwrap()
        });
        measurement::measure_input(
            &format!("receipt-locked-timestamp-{count}"),
            prepared,
            |value| value.finish(timestamp).unwrap(),
        );
        let batches = relevance_requests(
            "Find the failure",
            "printf synthetic-output",
            "repetitive_log",
            &lines,
            "gpt-6-luna",
        )
        .unwrap();
        let batch = BatchRecord {
            id: 1,
            target_numbers: batches[0].target_numbers.clone(),
            request: batches[0].request.clone(),
            response: json!({"model":"gpt-6-luna","answers":{"line_1":{"type":"noul","noul":0.01}}}),
            elapsed_ms: 100,
        };
        let baseline = || {
            serde_json::to_vec(&json!({"version":2,"receipt_id":"synthetic","batch":batch}))
                .unwrap()
        };
        let borrowed = || encoding::encode_batch("synthetic", black_box(&batch)).unwrap();
        assert_eq!(baseline(), borrowed());
        measurement::measure(&format!("batch-value-{count}"), baseline);
        measurement::measure(&format!("batch-borrowed-{count}"), borrowed);
        let snapshot = snapshot_baseline::line_snapshot(
            "synthetic-receipt",
            "synthetic-snapshot",
            "output",
            "replace",
            &lines,
            &decisions,
            &batch,
            1,
            1,
            1,
            timestamp,
        );
        let baseline = || serde_json::to_vec(&snapshot).unwrap();
        let prepared = || prepare_snapshot(&snapshot).unwrap();
        assert_eq!(baseline(), prepared().finish(timestamp).unwrap());
        measurement::measure(&format!("snapshot-value-encoder-{count}"), baseline);
        measurement::measure(&format!("snapshot-prepared-encoder-{count}"), || {
            prepared().finish(timestamp).unwrap()
        });
        measurement::measure_input(
            &format!("snapshot-locked-timestamp-{count}"),
            prepared,
            |value| value.finish(timestamp).unwrap(),
        );
        let prepared = || {
            snapshot_encoding::prepare_line_snapshot(
                "synthetic-receipt",
                "synthetic-snapshot",
                "output",
                "replace",
                &lines,
                &decisions,
                &batch,
                1,
                1,
                1,
            )
            .unwrap()
        };
        assert_eq!(baseline(), prepared().finish(timestamp).unwrap());
        measurement::measure(&format!("snapshot-value-build-{count}"), || {
            let value = snapshot_baseline::line_snapshot(
                "synthetic-receipt",
                "synthetic-snapshot",
                "output",
                "replace",
                &lines,
                &decisions,
                &batch,
                1,
                1,
                1,
                timestamp,
            );
            serde_json::to_vec(&value).unwrap()
        });
        measurement::measure(&format!("snapshot-borrowed-prepared-{count}"), || {
            prepared().finish(timestamp).unwrap()
        });
    }
}
