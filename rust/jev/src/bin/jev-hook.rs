//! Fail-open Codex PostToolUse adapter for per-line Jev judgments.

use chrono::Utc;
use codex_jev::{
    apply_probabilities, pack_batches, parse_probabilities, protect_neighbors, render,
    source_lines, Action, BatchRecord, LinePolicy, SourceLine, MAX_REQUEST_BYTES,
};
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use uuid::Uuid;

#[derive(Clone)]
struct Config {
    output: bool,
    test_build: bool,
    search_listing: bool,
    mode: String,
    min_chars: usize,
    max_chars: usize,
    model: String,
    timeout: f64,
    allow_mcp_replacement: bool,
    policy: BTreeMap<String, LinePolicy>,
    log_limit_mb: u64,
    never_delete_logs: bool,
}

fn config(data_dir: &Path) -> Result<Option<Config>, String> {
    let path = data_dir.join("config.json");
    if path.is_symlink() {
        return Err("linked config".into());
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("config read".into()),
    };
    if bytes.len() > 64_000 {
        return Err("config too large".into());
    }
    let raw: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid config")?;
    if raw.get("schema_version").and_then(Value::as_u64) != Some(2) {
        return Ok(None);
    }
    let boolean = |key: &str| {
        raw.get(key)
            .and_then(Value::as_bool)
            .ok_or_else(|| format!("invalid {key}"))
    };
    let output = boolean("enabled")?;
    let test_build = boolean("test_build_enabled")?;
    let search_listing = boolean("search_listing_enabled")?;
    let mode = raw
        .get("mode")
        .and_then(Value::as_str)
        .ok_or("invalid mode")?
        .to_owned();
    if !matches!(mode.as_str(), "replace" | "observe") {
        return Err("invalid mode".into());
    }
    let min_chars = raw.get("min_chars").and_then(Value::as_u64).unwrap_or(8192) as usize;
    let max_chars = raw
        .get("max_chars")
        .and_then(Value::as_u64)
        .unwrap_or(2_000_000) as usize;
    if !(1024..=2_000_000).contains(&min_chars) || min_chars > max_chars || max_chars > 2_000_000 {
        return Err("invalid size bounds".into());
    }
    let model = raw
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("jev-latest")
        .to_owned();
    if !model.starts_with("jev-")
        || model.len() > 48
        || !model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-_".contains(&byte))
    {
        return Err("invalid model".into());
    }
    let timeout = raw
        .get("timeout_seconds")
        .and_then(Value::as_f64)
        .unwrap_or(3.0);
    if !(0.1..=4.0).contains(&timeout) {
        return Err("invalid timeout".into());
    }
    let mut policy = BTreeMap::new();
    let entered = raw
        .get("line_policy")
        .and_then(Value::as_object)
        .ok_or("missing line policy")?;
    for route in ["output", "test_build", "search_listing"] {
        let value = entered.get(route).ok_or("missing route policy")?;
        let item: LinePolicy =
            serde_json::from_value(value.clone()).map_err(|_| "invalid route policy")?;
        if !item.valid() {
            return Err("invalid route threshold".into());
        }
        policy.insert(route.to_owned(), item);
    }
    let log_limit_mb = raw
        .get("log_limit_mb")
        .and_then(Value::as_u64)
        .unwrap_or(50);
    if !(1..=9999).contains(&log_limit_mb) {
        return Err("invalid log limit".into());
    }
    Ok(Some(Config {
        output,
        test_build,
        search_listing,
        mode,
        min_chars,
        max_chars,
        model,
        timeout,
        allow_mcp_replacement: raw
            .get("allow_mcp_replacement")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        policy,
        log_limit_mb,
        never_delete_logs: raw
            .get("never_delete_logs")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }))
}

fn key(data_dir: &Path) -> Result<String, String> {
    let path = data_dir.join(".env");
    let metadata = fs::symlink_metadata(&path).map_err(|_| "missing credential")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 8192 {
        return Err("unsafe credential".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("unsafe credential permissions".into());
        }
    }
    let content = fs::read_to_string(path).map_err(|_| "invalid credential encoding")?;
    let values: Vec<&str> = content
        .lines()
        .filter_map(|line| line.trim().strip_prefix("JEV_API_KEY="))
        .collect();
    if values.len() != 1 {
        return Err("missing credential".into());
    }
    let value = values[0].trim().trim_matches(['\'', '"']);
    if !(8..=4096).contains(&value.len())
        || value.chars().any(char::is_whitespace)
        || value.contains('\0')
    {
        return Err("invalid credential".into());
    }
    Ok(value.into())
}

fn command(event: &Value) -> &str {
    event
        .pointer("/tool_input/command")
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn route(event: &Value, config: &Config) -> Option<&'static str> {
    let tool = event.get("tool_name")?.as_str()?;
    if tool != "Bash" {
        return config.output.then_some("output");
    }
    let command = command(event);
    if command.len() > 4096 || command.contains(['\n', '\r', '`']) || command.contains("$(") {
        return config.output.then_some("output");
    }
    let words = shell_words::split(command).ok()?;
    let executable = words
        .first()
        .map(|word| word.rsplit('/').next().unwrap_or(word.as_str()))
        .unwrap_or("");
    let action = words.get(1).map(String::as_str).unwrap_or("");
    let package_action = if matches!(executable, "npm" | "pnpm" | "yarn") {
        let mut index = 1;
        while index < words.len() {
            if matches!(
                words[index].as_str(),
                "--prefix" | "--dir" | "--cwd" | "--workspace" | "-C" | "-w"
            ) {
                index += 2;
            } else if words[index].starts_with('-') {
                index += 1;
            } else {
                break;
            }
        }
        if words.get(index).map(String::as_str) == Some("run") {
            index += 1;
        }
        words.get(index).map(String::as_str).unwrap_or("")
    } else {
        ""
    };
    let build = matches!(executable, "pytest" | "py.test")
        || matches!(
            executable,
            "cargo" | "go" | "dotnet" | "gradle" | "gradlew" | "mvn" | "mvnw" | "make"
        ) && matches!(action, "test" | "build" | "package")
        || executable == "cmake" && action == "--build"
        || matches!(package_action, "test" | "build")
        || executable == "node" && action == "--test"
        || executable.starts_with("python")
            && words
                .windows(2)
                .any(|pair| pair == ["-m", "unittest"] || pair == ["-m", "pytest"]);
    if build && config.test_build {
        return Some("test_build");
    }
    let search = if executable == "rg"
        && words
            .iter()
            .any(|word| matches!(word.as_str(), "-n" | "--line-number" | "--json" | "--files"))
    {
        true
    } else {
        executable == "git" && action == "ls-files"
    };
    let unsafe_search = words.iter().any(|word| {
        matches!(
            word.as_str(),
            "--null"
                | "-0"
                | "--multiline"
                | "-U"
                | "--context"
                | "-C"
                | "--before-context"
                | "-B"
                | "--after-context"
                | "-A"
                | "--only-matching"
                | "-o"
                | "--replace"
                | "-r"
        )
    }) || command.contains([';', '&', '|', '<', '>']);
    if search && !unsafe_search && config.search_listing {
        return Some("search_listing");
    }
    config.output.then_some("output")
}

fn task_context(event: &Value) -> String {
    let Some(path) = event.get("transcript_path").and_then(Value::as_str) else {
        return String::new();
    };
    let path = Path::new(path);
    if !path.is_absolute() || path.is_symlink() {
        return String::new();
    }
    let Ok(metadata) = fs::metadata(path) else {
        return String::new();
    };
    if !metadata.is_file() || metadata.len() > 50_000_000 {
        return String::new();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } {
            return String::new();
        }
    }
    let Ok(mut file) = File::open(path) else {
        return String::new();
    };
    use std::io::{Seek, SeekFrom};
    if file
        .seek(SeekFrom::End(-(metadata.len().min(65_536) as i64)))
        .is_err()
    {
        return String::new();
    }
    let mut bytes = Vec::new();
    if file.take(65_536).read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    let tail = String::from_utf8_lossy(&bytes);
    for raw in tail.lines().rev() {
        let Ok(row) = serde_json::from_str::<Value>(raw) else {
            continue;
        };
        if row.get("type").and_then(Value::as_str) != Some("response_item")
            || row.pointer("/payload/role").and_then(Value::as_str) != Some("user")
        {
            continue;
        }
        let Some(parts) = row.pointer("/payload/content").and_then(Value::as_array) else {
            continue;
        };
        let message = parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("input_text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" ");
        let text: String = message
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(500)
            .collect();
        if !text.is_empty() && !sensitive(&text) {
            return text;
        }
    }
    String::new()
}

fn sensitive(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "-----begin",
        "private key",
        "api_key=",
        "api-key:",
        "access_token",
        "client_secret",
        "authorization:",
        "password=",
        "passwd=",
        "bearer ",
        "sk-",
        "ghp_",
        "/.env",
        "\\.env",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
}

fn response_text(event: &Value) -> Option<String> {
    if event.get("tool_name")?.as_str()? == "Bash" {
        return event.get("tool_response")?.as_str().map(str::to_owned);
    }
    if !event.get("tool_name")?.as_str()?.starts_with("mcp__") {
        return None;
    }
    let body = event.get("tool_response")?;
    if body.get("isError").and_then(Value::as_bool) == Some(true)
        || body.get("structuredContent").is_some()
    {
        return None;
    }
    let content = body.get("content")?.as_array()?;
    if content.is_empty() {
        return None;
    }
    let mut result = Vec::new();
    for item in content {
        if item.get("type").and_then(Value::as_str) != Some("text") {
            return None;
        }
        result.push(item.get("text")?.as_str()?);
    }
    Some(result.join("\n"))
}

fn apply_route_structure(route: &str, command: &str, lines: &mut [SourceLine]) -> bool {
    if route == "test_build" {
        let mut complete = false;
        for line in lines.iter_mut() {
            let text = line.model_text.trim().to_ascii_lowercase();
            let count_summary = text
                .chars()
                .next()
                .is_some_and(|first| first.is_ascii_digit())
                && [" passed", " failed", " errors", " warnings"]
                    .iter()
                    .any(|part| text.contains(part));
            let is_complete = text.starts_with("ran ")
                || text.starts_with("test result:")
                || text.starts_with("build successful")
                || text.starts_with("build failed")
                || text.starts_with("finished ")
                || text.starts_with("ok ")
                || text.starts_with("# tests")
                || text.starts_with("ℹ tests")
                || text.starts_with("test suites:")
                || text.starts_with("tests:")
                || count_summary;
            if is_complete {
                line.protected_reason = Some("completion".into());
                complete = true;
            }
            if command.starts_with("go test") && command.contains("-json") {
                let Ok(row) = serde_json::from_str::<Value>(&line.model_text) else {
                    return false;
                };
                let action = row.get("Action").and_then(Value::as_str).unwrap_or("");
                if !matches!(
                    action,
                    "start" | "run" | "pause" | "cont" | "pass" | "fail" | "skip" | "output"
                ) || row.get("Package").and_then(Value::as_str).is_none()
                {
                    return false;
                }
                if matches!(action, "fail" | "skip")
                    || action == "output"
                        && row
                            .get("Output")
                            .and_then(Value::as_str)
                            .is_some_and(|output| {
                                sensitive(output)
                                    || ["error", "panic", "failed", "assert"]
                                        .iter()
                                        .any(|word| output.to_ascii_lowercase().contains(word))
                            })
                {
                    line.protected_reason = Some("diagnostic_json".into());
                }
                if matches!(action, "pass" | "fail") && row.get("Test").is_none() {
                    line.protected_reason = Some("completion".into());
                    complete = true;
                }
            }
            if command.starts_with("cargo ") && command.contains("--message-format=json") {
                let Ok(row) = serde_json::from_str::<Value>(&line.model_text) else {
                    return false;
                };
                match row.get("reason").and_then(Value::as_str).unwrap_or("") {
                    "compiler-message" => {
                        if row
                            .pointer("/message/level")
                            .and_then(Value::as_str)
                            .is_some_and(|level| {
                                matches!(level, "error" | "warning" | "failure-note")
                            })
                        {
                            line.protected_reason = Some("diagnostic_json".into());
                        }
                    }
                    "build-finished" => {
                        line.protected_reason = Some("completion".into());
                        complete = true;
                    }
                    "compiler-artifact" | "build-script-executed" => {}
                    _ => return false,
                }
            }
        }
        if !complete {
            return false;
        }
    }
    if route == "search_listing" {
        let jsonl = command.contains("--json");
        let match_line = Regex::new(r"^.+:[1-9][0-9]*:.*$").ok();
        for line in lines {
            if jsonl {
                let Ok(row) = serde_json::from_str::<Value>(&line.model_text) else {
                    return false;
                };
                let Some(kind) = row.get("type").and_then(Value::as_str) else {
                    return false;
                };
                if !matches!(kind, "begin" | "match" | "end" | "summary") {
                    return false;
                }
                if kind != "match" {
                    line.eligible = false;
                    line.protected_reason = Some("jsonl_structure".into());
                } else if row
                    .pointer("/data/path/text")
                    .and_then(Value::as_str)
                    .is_none()
                    || row
                        .pointer("/data/lines/text")
                        .and_then(Value::as_str)
                        .is_none()
                {
                    return false;
                }
            } else if command.contains("--files") || command.contains("ls-files") {
                if line.model_text.is_empty() || line.model_text.chars().any(char::is_control) {
                    return false;
                }
            } else if !match_line
                .as_ref()
                .is_some_and(|pattern| pattern.is_match(&line.model_text))
            {
                return false;
            }
        }
    }
    true
}

fn evaluate(request: &Value, key: &str, timeout: f64) -> Result<Value, String> {
    let encoded = serde_json::to_vec(request).map_err(|_| "request encoding")?;
    if encoded.len() > MAX_REQUEST_BYTES {
        return Err("request too large".into());
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs_f64(timeout))
        .build();
    #[cfg(debug_assertions)]
    let endpoint = std::env::var("CODEX_JEV_TEST_ENDPOINT")
        .ok()
        .filter(|value| value.starts_with("http://127.0.0.1:"))
        .unwrap_or_else(|| "https://api.typesafe.ai/v1/systemone".into());
    #[cfg(not(debug_assertions))]
    let endpoint = "https://api.typesafe.ai/v1/systemone".to_owned();
    let response = agent
        .post(&endpoint)
        .set("Authorization", &format!("Bearer {key}"))
        .set("Content-Type", "application/json")
        .send_bytes(&encoded)
        .map_err(|_| "Jev request failed")?;
    let mut body = Vec::new();
    response
        .into_reader()
        .take(1_000_001)
        .read_to_end(&mut body)
        .map_err(|_| "Jev response read failed")?;
    if body.len() > 1_000_000 {
        return Err("Jev response too large".into());
    }
    serde_json::from_slice(&body).map_err(|_| "invalid Jev response".into())
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    if path.is_symlink() {
        return Err("linked directory".into());
    }
    if !path.exists() {
        fs::create_dir_all(path).map_err(|_| "directory create failed")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                .map_err(|_| "directory permissions")?;
        }
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| "directory stat failed")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("unsafe directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("directory permissions".into());
        }
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8], replace: bool) -> Result<(), String> {
    if path.is_symlink() {
        return Err("linked file".into());
    }
    let temp = path.with_file_name(format!(".jev-{}.tmp", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|_| "file create failed")?;
    let operation = (|| -> Result<(), String> {
        file.write_all(bytes).map_err(|_| "file write failed")?;
        file.sync_all().map_err(|_| "file sync failed")?;
        if replace {
            fs::rename(&temp, path).map_err(|_| "file rename failed")?;
        } else {
            fs::hard_link(&temp, path).map_err(|_| "original already exists")?;
            fs::remove_file(&temp).map_err(|_| "temporary file removal failed")?;
        }
        Ok(())
    })();
    if operation.is_err() {
        let _ = fs::remove_file(&temp);
    }
    operation
}

fn lock_logs(logs: &Path) -> Result<File, String> {
    let path = logs.join(".lock");
    if path.is_symlink() {
        return Err("linked log lock".into());
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|_| "log lock open")?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err("log lock failed".into());
        }
    }
    Ok(file)
}

fn output_path(data_dir: &Path, event: &Value) -> Result<PathBuf, String> {
    let valid = |key: &str| {
        key.len() <= 128
            && !key.is_empty()
            && key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    };
    let session = event
        .get("session_id")
        .and_then(Value::as_str)
        .ok_or("missing session id")?;
    let call = event
        .get("tool_use_id")
        .and_then(Value::as_str)
        .ok_or("missing tool id")?;
    if !valid(session) || !valid(call) {
        return Err("invalid tool id".into());
    }
    let hash = |text: &str| format!("{:x}", Sha256::digest(text.as_bytes()))[..20].to_owned();
    Ok(data_dir
        .join("outputs")
        .join(hash(session))
        .join(format!("{}.txt", hash(call))))
}

fn line_snapshot(
    receipt_id: &str,
    snapshot_id: &str,
    route: &str,
    status: &str,
    lines: &[SourceLine],
    decisions: &[codex_jev::LineDecision],
    history: &[Value],
    requests: usize,
    batch_elapsed_ms: Option<u64>,
) -> Value {
    let seen = lines.len();
    let judged = decisions
        .iter()
        .filter(|row| row.batch_id.is_some())
        .count();
    let omitted = decisions
        .iter()
        .filter(|row| row.action == Action::Omit)
        .count();
    let protected = decisions
        .iter()
        .filter(|row| row.protected_reason.is_some())
        .count();
    let mut recent = history.to_vec();
    let mut latest = Value::Null;
    for (line, decision) in lines.iter().zip(decisions) {
        if decision.batch_id.is_none() {
            continue;
        }
        let excerpt: String = line
            .model_text
            .chars()
            .scan(0usize, |units, character| {
                *units += character.len_utf16();
                (*units <= 240).then_some(character)
            })
            .collect();
        let item = json!({"id":format!("{receipt_id}-{}", line.number),"line":line.number,"excerpt":excerpt,
            "summary":format!("{} · line {}", route.replace('_', "/"),line.number),
            "action":decision.action,"can_omit":decision.p_can_omit,"exact_needed":decision.p_exact_needed});
        recent.push(item.clone());
        latest = item;
    }
    if recent.len() > 5 {
        recent.drain(..recent.len() - 5);
    }
    json!({"version":2,"id":snapshot_id,"receipt_id":receipt_id,"at":Utc::now().to_rfc3339(),
        "filter":route,"status":status,"latest":latest,"recent":recent,
        "totals":{"seen":seen,"judged":judged,"kept":seen-omitted,"omitted":omitted,
            "protected":protected,"unjudged":seen-judged,"requests":requests},
        "batch_elapsed_ms":batch_elapsed_ms})
}

struct ProgressSnapshot {
    logs: PathBuf,
    receipt_id: String,
    previous: Option<Vec<u8>>,
    history: Vec<Value>,
    last_snapshot_id: String,
    active: bool,
}

impl ProgressSnapshot {
    fn new(data_dir: &Path, receipt_id: String) -> Result<Self, String> {
        let logs = data_dir.join("logs");
        ensure_dir(&logs)?;
        let path = logs.join("latest-decision.json");
        if path.is_symlink() {
            return Err("linked panel snapshot".into());
        }
        let previous = match fs::read(&path) {
            Ok(bytes) if bytes.len() <= 16_384 => Some(bytes),
            Ok(_) => return Err("panel snapshot too large".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err("panel snapshot read failed".into()),
        };
        let history = previous
            .as_ref()
            .and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok())
            .filter(|value| value.get("version").and_then(Value::as_u64) == Some(2))
            .and_then(|value| value.get("recent").and_then(Value::as_array).cloned())
            .unwrap_or_default();
        Ok(Self {
            logs,
            receipt_id,
            previous,
            history,
            last_snapshot_id: String::new(),
            active: false,
        })
    }

    fn publish(
        &mut self,
        route: &str,
        lines: &[SourceLine],
        decisions: &[codex_jev::LineDecision],
        requests: usize,
        batch_elapsed_ms: u64,
    ) -> Result<(), String> {
        let _lock = lock_logs(&self.logs)?;
        let id = Uuid::new_v4().simple().to_string();
        let snapshot = line_snapshot(
            &self.receipt_id,
            &id,
            route,
            "processing",
            lines,
            decisions,
            &self.history,
            requests,
            Some(batch_elapsed_ms),
        );
        write_private(
            &self.logs.join("latest-decision.json"),
            &serde_json::to_vec(&snapshot).map_err(|_| "snapshot encoding")?,
            true,
        )?;
        self.last_snapshot_id = id;
        self.active = true;
        Ok(())
    }
}

impl Drop for ProgressSnapshot {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let Ok(_lock) = lock_logs(&self.logs) else {
            return;
        };
        let path = self.logs.join("latest-decision.json");
        let current = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        if current
            .as_ref()
            .and_then(|value| value.get("receipt_id"))
            .and_then(Value::as_str)
            != Some(self.receipt_id.as_str())
        {
            return;
        }
        if let Some(previous) = &self.previous {
            let _ = write_private(&path, previous, true);
        } else {
            let _ = fs::remove_file(path);
        }
    }
}

fn record(
    data_dir: &Path,
    event: &Value,
    route: &str,
    status: &str,
    source: &str,
    visible: &str,
    lines: &[SourceLine],
    decisions: &[codex_jev::LineDecision],
    batches: &[BatchRecord],
    config: &Config,
    receipt_id: &str,
    snapshot_id: &str,
    history: &[Value],
) -> Result<(), String> {
    ensure_dir(data_dir)?;
    let logs = data_dir.join("logs");
    ensure_dir(&logs)?;
    let _lock = lock_logs(&logs)?;
    let now = Utc::now();
    let session = event
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let session_hash = format!("{:x}", Sha256::digest(session.as_bytes()));
    let folder = logs.join(format!(
        "{}-{}",
        now.format("%Y-%m-%d"),
        &session_hash[..10]
    ));
    ensure_dir(&folder)?;
    let id = receipt_id;
    let original_hash = format!("{:x}", Sha256::digest(source.as_bytes()));
    let seen = lines.len();
    let judged = decisions
        .iter()
        .filter(|row| row.batch_id.is_some())
        .count();
    let omitted = decisions
        .iter()
        .filter(|row| row.action == Action::Omit)
        .count();
    let protected = decisions
        .iter()
        .filter(|row| row.protected_reason.is_some())
        .count();
    let summary = json!({"version":2,"id":id,"at":now.to_rfc3339(),"filter":route,"status":status,
        "reason":if config.mode == "observe" { "observe" } else { "line_policy" },
        "tool":event.get("tool_name"),"capsule_chars":visible.chars().count(),
        "elapsed_ms":batches.iter().map(|batch| batch.elapsed_ms).sum::<u64>(),
        "source_sha256":original_hash,"lines_seen":seen,"lines_judged":judged,"lines_kept":seen-omitted,
        "lines_omitted":omitted,"lines_protected":protected,"lines_unjudged":seen-judged,
        "requests":batches.len(),"original_chars":source.chars().count(),"visible_chars":visible.chars().count()});
    let receipt = json!({"version":2,"manifest":summary,"tool":event.get("tool_name"),
        "tool_input":event.get("tool_input"),"initial_output":source,
        "visible_output":if status == "replace" { Some(visible) } else { None },
        "decisions":decisions});
    write_private(
        &folder.join(format!("receipt-{id}.json")),
        &serde_json::to_vec_pretty(&receipt).map_err(|_| "receipt encoding")?,
        false,
    )?;
    for batch in batches {
        let row = json!({"version":2,"receipt_id":id,"batch":batch});
        write_private(
            &folder.join(format!("batch-{id}-{}.json", batch.id)),
            &serde_json::to_vec_pretty(&row).map_err(|_| "batch encoding")?,
            false,
        )?;
    }
    let snapshot = line_snapshot(
        id,
        snapshot_id,
        route,
        status,
        lines,
        decisions,
        history,
        batches.len(),
        batches.last().map(|batch| batch.elapsed_ms),
    );
    let event_path = logs.join("events.jsonl");
    if event_path.is_symlink() {
        return Err("linked event log".into());
    }
    let mut event_options = OpenOptions::new();
    event_options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        event_options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut event_file = event_options.open(event_path).map_err(|_| "event log")?;
    writeln!(event_file, "{}", summary).map_err(|_| "event log write")?;
    let stats_path = data_dir.join("stats.json");
    let mut stats = fs::read(&stats_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or_else(|| json!({}));
    for (key, increment) in [
        ("calls", batches.len() as u64),
        ("completed", 1),
        ("replaced", u64::from(status == "replace")),
        ("timed", batches.len() as u64),
        (
            "elapsedMs",
            batches.iter().map(|batch| batch.elapsed_ms).sum(),
        ),
        ("linesSeen", seen as u64),
        ("linesJudged", judged as u64),
        ("linesKept", (seen - omitted) as u64),
        ("linesOmitted", omitted as u64),
        ("linesProtected", protected as u64),
        ("linesUnjudged", (seen - judged) as u64),
    ] {
        stats[key] = json!(stats
            .get(key)
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .saturating_add(increment));
    }
    if status == "replace" {
        stats["savedChars"] = json!(stats
            .get("savedChars")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .saturating_add(source.len().saturating_sub(visible.len()) as u64));
    }
    write_private(
        &stats_path,
        &serde_json::to_vec(&stats).map_err(|_| "stats encoding")?,
        true,
    )?;
    if !config.never_delete_logs {
        prune(&logs, config.log_limit_mb * 1_000_000);
    }
    // Publish last: a partially written receipt or stats update must never appear as a live result.
    write_private(
        &logs.join("latest-decision.json"),
        &serde_json::to_vec(&snapshot).map_err(|_| "snapshot encoding")?,
        true,
    )?;
    Ok(())
}

fn prune(logs: &Path, budget: u64) {
    let index = logs.join("events.jsonl");
    if !index.is_symlink() {
        if let Ok(metadata) = fs::metadata(&index) {
            if metadata.is_file() && metadata.len() > 1_048_576 {
                use std::io::{Seek, SeekFrom};
                if let Ok(mut file) = File::open(&index) {
                    if file.seek(SeekFrom::End(-1_048_576)).is_ok() {
                        let mut tail = Vec::new();
                        if file.read_to_end(&mut tail).is_ok() {
                            if let Some(newline) = tail.iter().position(|byte| *byte == b'\n') {
                                let _ = write_private(&index, &tail[newline + 1..], true);
                            }
                        }
                    }
                }
            }
        }
    }
    let Ok(entries) = fs::read_dir(logs) else {
        return;
    };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_symlink() {
            continue;
        }
        if path.is_dir() {
            if let Ok(children) = fs::read_dir(path) {
                for child in children.flatten() {
                    let item = child.path();
                    if item.is_file()
                        && !item.is_symlink()
                        && (item
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .starts_with("receipt-")
                            || item
                                .file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .starts_with("batch-"))
                    {
                        if let Ok(meta) = item.metadata() {
                            files.push((meta.modified().ok(), item, meta.len()));
                        }
                    }
                }
            }
        }
    }
    let mut total: u64 = files.iter().map(|(_, _, size)| size).sum();
    files.sort_by_key(|(time, path, _)| (*time, path.clone()));
    for (_, path, size) in files {
        if total <= budget {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

fn execute() -> Result<Value, String> {
    let data_dir = std::env::var_os("PLUGIN_DATA")
        .map(PathBuf::from)
        .ok_or("missing plugin data")?;
    if !data_dir.is_absolute() || data_dir.is_symlink() {
        return Err("unsafe plugin data".into());
    }
    ensure_dir(&data_dir)?;
    let Some(config) = config(&data_dir)? else {
        return Ok(json!({}));
    };
    if !(config.output || config.test_build || config.search_listing) {
        return Ok(json!({}));
    }
    let mut input = Vec::new();
    std::io::stdin()
        .take(16_000_001)
        .read_to_end(&mut input)
        .map_err(|_| "hook input read")?;
    if input.len() > 16_000_000 {
        return Err("hook input too large".into());
    }
    let event: Value = serde_json::from_slice(&input).map_err(|_| "invalid hook JSON")?;
    if event.get("hook_event_name").and_then(Value::as_str) != Some("PostToolUse") {
        return Ok(json!({}));
    }
    let Some(route) = route(&event, &config) else {
        return Ok(json!({}));
    };
    let Some(source) = response_text(&event) else {
        return Ok(json!({}));
    };
    if source.len() < config.min_chars
        || source.len() > config.max_chars
        || sensitive(&source)
        || sensitive(command(&event))
    {
        return Ok(json!({}));
    }
    let task = task_context(&event);
    if task.is_empty() {
        return Ok(json!({}));
    }
    let mut lines = source_lines(&source);
    if lines.is_empty() || !apply_route_structure(route, command(&event), &mut lines) {
        return Ok(json!({}));
    }
    protect_neighbors(&mut lines);
    let batches = pack_batches(
        route,
        &task,
        &command(&event).chars().take(400).collect::<String>(),
        &lines,
        &config.model,
    );
    if batches.is_empty() {
        return Ok(json!({}));
    }
    let api_key = key(&data_dir)?;
    let receipt_id = Uuid::new_v4().simple().to_string();
    let mut progress = ProgressSnapshot::new(&data_dir, receipt_id.clone())?;
    let started = Instant::now();
    let mut probabilities = BTreeMap::new();
    let mut records = Vec::new();
    for batch in batches {
        if started.elapsed() > Duration::from_secs(45) {
            return Err("hook deadline".into());
        }
        let before = Instant::now();
        let response = evaluate(&batch.request, &api_key, config.timeout)?;
        let parsed = parse_probabilities(&batch, &response)?;
        for (number, (omit, exact)) in parsed {
            probabilities.insert(number, (omit, exact, batch.id));
        }
        records.push(BatchRecord {
            id: batch.id,
            target_numbers: batch.target_numbers,
            request: batch.request,
            response,
            elapsed_ms: before.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        });
        let partial = apply_probabilities(&lines, &probabilities, &config.policy[route]);
        progress.publish(
            route,
            &lines,
            &partial,
            records.len(),
            records.last().unwrap().elapsed_ms,
        )?;
    }
    let decisions = apply_probabilities(&lines, &probabilities, &config.policy[route]);
    let omitted = decisions
        .iter()
        .filter(|row| row.action == Action::Omit)
        .count();
    let candidate = omitted > 0;
    let path = output_path(&data_dir, &event)?;
    let feedback = render(&source, &lines, &decisions, &path.to_string_lossy());
    let replace = candidate
        && config.mode == "replace"
        && (event.get("tool_name").and_then(Value::as_str) == Some("Bash")
            || config.allow_mcp_replacement)
        && feedback.len() + 1024 < source.len()
        && feedback.len() * 10 < source.len() * 7;
    let status = if replace {
        "replace"
    } else if candidate {
        "candidate"
    } else {
        "keep"
    };
    if replace {
        ensure_dir(&data_dir)?;
        ensure_dir(&data_dir.join("outputs"))?;
        ensure_dir(path.parent().ok_or("invalid output path")?)?;
        write_private(&path, source.as_bytes(), false)?;
    }
    let visible = if replace {
        feedback.as_str()
    } else {
        source.as_str()
    };
    record(
        &data_dir,
        &event,
        route,
        status,
        &source,
        visible,
        &lines,
        &decisions,
        &records,
        &config,
        &receipt_id,
        &progress.last_snapshot_id,
        &progress.history,
    )?;
    progress.active = false;
    if replace {
        Ok(
            json!({"continue":false,"stopReason":"Line-filtered tool output stored by Codex Jev","reason":feedback}),
        )
    } else {
        Ok(json!({}))
    }
}

fn main() {
    let answer = execute().unwrap_or_else(|_| json!({}));
    println!("{}", answer);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enabled() -> Config {
        Config {
            output: true,
            test_build: true,
            search_listing: true,
            mode: "observe".into(),
            min_chars: 1024,
            max_chars: 2_000_000,
            model: "jev-latest".into(),
            timeout: 3.0,
            allow_mcp_replacement: false,
            policy: BTreeMap::new(),
            log_limit_mb: 50,
            never_delete_logs: false,
        }
    }

    #[test]
    fn direct_test_and_search_commands_route_to_line_adapters() {
        let config = enabled();
        for command in [
            "pytest tests -v",
            "python -m pytest -v",
            "cargo test --workspace",
            "npm --prefix vscode-control test",
            "cmake --build build",
        ] {
            assert_eq!(
                route(
                    &json!({"tool_name":"Bash","tool_input":{"command":command}}),
                    &config
                ),
                Some("test_build"),
                "{command}"
            );
        }
        for command in [
            "rg -n pattern src",
            "rg --json pattern src",
            "rg --files src",
            "git ls-files",
        ] {
            assert_eq!(
                route(
                    &json!({"tool_name":"Bash","tool_input":{"command":command}}),
                    &config
                ),
                Some("search_listing"),
                "{command}"
            );
        }
    }

    #[test]
    fn completion_and_jsonl_structure_are_protected() {
        let mut build = source_lines("test_one PASSED\n40 passed in 2.1s\n");
        assert!(apply_route_structure("test_build", "pytest -v", &mut build));
        assert_eq!(build[1].protected_reason.as_deref(), Some("completion"));
        let source = concat!(
            "{\"type\":\"begin\",\"data\":{}}\n",
            "{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"src/a.rs\"},\"lines\":{\"text\":\"needle\"}}}\n",
            "{\"type\":\"end\",\"data\":{}}\n");
        let mut search = source_lines(source);
        assert!(apply_route_structure(
            "search_listing",
            "rg --json needle src",
            &mut search
        ));
        assert!(!search[0].eligible);
        assert!(search[1].eligible);
        assert!(!search[2].eligible);
    }

    #[test]
    fn structured_test_and_build_failures_stay_visible() {
        let mut go = source_lines(concat!(
            "{\"Action\":\"output\",\"Package\":\"example/a\",\"Output\":\"case failed\\n\"}\n",
            "{\"Action\":\"fail\",\"Package\":\"example/a\"}\n"
        ));
        assert!(apply_route_structure(
            "test_build",
            "go test -json ./...",
            &mut go
        ));
        assert_eq!(go[0].protected_reason.as_deref(), Some("diagnostic_json"));
        assert_eq!(go[1].protected_reason.as_deref(), Some("completion"));
        let mut cargo = source_lines(concat!(
            "{\"reason\":\"compiler-message\",\"message\":{\"level\":\"error\",\"message\":\"bad type\"}}\n",
            "{\"reason\":\"build-finished\",\"success\":false}\n"));
        assert!(apply_route_structure(
            "test_build",
            "cargo build --message-format=json",
            &mut cargo
        ));
        assert_eq!(
            cargo[0].protected_reason.as_deref(),
            Some("diagnostic_json")
        );
        assert_eq!(cargo[1].protected_reason.as_deref(), Some("completion"));
    }

    #[test]
    fn completed_batch_is_visible_and_failed_result_restores_empty_panel() {
        let temporary = tempfile::tempdir().unwrap();
        let data = temporary.path().join("data");
        fs::create_dir(&data).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let lines = source_lines("Compiling module\nDone\n");
        let judged = apply_probabilities(
            &lines,
            &BTreeMap::from([(1, (0.98, 0.02, 1))]),
            &LinePolicy::default(),
        );
        let path = data.join("logs/latest-decision.json");
        {
            let mut progress = ProgressSnapshot::new(&data, "a".repeat(32)).unwrap();
            progress.publish("output", &lines, &judged, 1, 25).unwrap();
            let snapshot: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert_eq!(snapshot["status"], "processing");
            assert_eq!(snapshot["totals"]["judged"], 1);
        }
        assert!(!path.exists());
    }
}
