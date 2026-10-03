//! Fail-open Codex PostToolUse adapter for per-line Jev judgments.

use chrono::Utc;
use codex_jev::semantic::*;
#[cfg(test)]
use codex_jev::{apply_probabilities, LinePolicy, SearchRelevancePolicy};
use codex_jev::{
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

#[path = "jev-hook/runtime.rs"]
mod runtime;
use runtime::*;
#[path = "jev-hook/config.rs"]
mod config;
use config::*;
#[path = "jev-hook/shell.rs"]
mod shell;
use shell::*;
#[path = "jev-hook/routing.rs"]
mod routing;
use routing::*;
#[path = "jev-hook/context.rs"]
mod context;
use context::*;
#[path = "jev-hook/task.rs"]
mod task;
use task::*;
#[path = "jev-hook/structure.rs"]
mod structure;
use structure::*;
#[path = "jev-hook/api.rs"]
mod api;
use api::*;
#[path = "jev-hook/storage.rs"]
mod storage;
use storage::*;
#[path = "jev-hook/retention.rs"]
mod retention;
use retention::*;
#[path = "jev-hook/telemetry.rs"]
mod telemetry;
use telemetry::*;
#[path = "jev-hook/snapshot.rs"]
mod snapshot;
use snapshot::*;
#[path = "jev-hook/record.rs"]
mod record;
use record::*;
#[path = "jev-hook/pipeline.rs"]
mod pipeline;
use pipeline::*;
#[cfg(test)]
#[path = "jev-hook/tests.rs"]
mod tests;

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("jev-hook {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let answer = execute().unwrap_or_else(|error| {
        eprintln!("Codex Jev hook skipped: {error}");
        // Errors after session parsing are recorded in that session by execute().
        json!({})
    });
    println!("{}", answer);
}
