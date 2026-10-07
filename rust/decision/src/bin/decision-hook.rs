//! Fail-open Codex PostToolUse adapter for per-line Decision judgments.

use chrono::Utc;
use codex_decision::semantic::*;
#[cfg(test)]
use codex_decision::{apply_probabilities, LinePolicy, SearchRelevancePolicy};
use codex_decision::{
    check_ancestors, protect_neighbors, render, source_lines, Action, BatchRecord, SourceLine,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use uuid::Uuid;

#[path = "decision-hook/json_limit.rs"]
mod json_limit;
#[path = "decision-hook/strict_json.rs"]
mod strict_json;

#[path = "decision-hook/runtime.rs"]
mod runtime;
use runtime::*;
#[path = "decision-hook/config.rs"]
mod config;
use config::*;
#[path = "decision-hook/shell.rs"]
mod shell;
use shell::*;
#[path = "decision-hook/routing.rs"]
mod routing;
use routing::*;
#[path = "decision-hook/context.rs"]
mod context;
use context::*;
#[path = "decision-hook/projection.rs"]
mod projection;
#[path = "decision-hook/task.rs"]
mod task;
use task::*;
#[path = "decision-hook/structure.rs"]
mod structure;
use structure::*;
#[path = "decision-hook/fast_path.rs"]
mod fast_path;
use fast_path::*;
#[path = "decision-hook/replacement.rs"]
mod replacement;
use replacement::*;
#[path = "decision-hook/api.rs"]
mod api;
use api::*;
#[path = "decision-hook/storage.rs"]
mod storage;
use storage::*;
#[path = "decision-hook/private_file.rs"]
mod private_file;
use private_file::*;
#[path = "decision-hook/retention.rs"]
mod retention;
use retention::*;
#[path = "decision-hook/telemetry.rs"]
mod telemetry;
use telemetry::*;
#[path = "decision-hook/snapshot.rs"]
mod snapshot;
use snapshot::*;
#[path = "decision-hook/prepared_json.rs"]
mod prepared_json;
use prepared_json::*;
#[path = "decision-hook/encoding.rs"]
mod encoding;
use encoding::*;
#[path = "decision-hook/record.rs"]
mod record;
use record::*;
#[path = "decision-hook/pipeline.rs"]
mod pipeline;
use pipeline::*;
#[cfg(test)]
#[path = "decision-hook/tests.rs"]
mod tests;

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("decision-hook {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let answer = execute().unwrap_or_else(|error| {
        eprintln!("Codex Decision hook skipped: {error}");
        // Errors after session parsing are recorded in that session by execute().
        json!({})
    });
    println!("{}", answer);
}
