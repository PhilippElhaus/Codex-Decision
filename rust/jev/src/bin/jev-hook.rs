//! Fail-open Codex PostToolUse adapter for per-line Jev judgments.

use chrono::Utc;
use codex_jev::{
    apply_probabilities, check_ancestors, pack_batches, parse_probabilities, protect_neighbors,
    render, source_lines, Action, BatchRecord, LinePolicy, SearchRelevancePolicy, SourceLine,
    MAX_REQUEST_BYTES,
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

const PANEL_SNAPSHOT_MAX_BYTES: usize = 256 * 1024;
const MAX_SOURCE_LINES: usize = 10_000;
const MAX_RECEIPT_BYTES: usize = 8 * 1024 * 1024;
thread_local! { static HOOK_STARTED: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) }; }
fn remaining() -> Result<Duration, String> {
    HOOK_STARTED
        .with(|started| {
            Duration::from_secs(45)
                .checked_sub(started.get().map_or(Duration::ZERO, |time| time.elapsed()))
        })
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| "hook deadline".into())
}

#[derive(Clone)]
struct Config {
    global_scope: bool,
    output: bool,
    test_build: bool,
    search_listing: bool,
    choice_gate_enabled: bool,
    mode: String,
    min_chars: usize,
    max_chars: usize,
    model: String,
    timeout: f64,
    allow_mcp_replacement: bool,
    policy: BTreeMap<String, LinePolicy>,
    search_relevance: SearchRelevancePolicy,
    log_limit_mb: u64,
    never_delete_logs: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SharedSettings {
    #[serde(rename = "schema_version")]
    _schema_version: u64,
    mode: String,
    line_policy: BTreeMap<String, LinePolicy>,
    search_relevance: SearchRelevancePolicy,
    choice_gate_enabled: bool,
    log_limit_mb: u64,
    never_delete_logs: bool,
}

fn apply_shared_settings(data_dir: &Path, config: &mut Config) -> Result<(), String> {
    let path = data_dir.join("settings.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("settings stat failed".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 8192 {
        return Err("unsafe shared settings".into());
    }
    let bytes = fs::read(&path).map_err(|_| "settings read failed")?;
    let raw: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid shared settings")?;
    let settings: SharedSettings =
        serde_json::from_value(codex_jev::contract::validate("settings", &raw)?)
            .map_err(|_| "invalid shared settings")?;
    config.mode = settings.mode;
    config.policy = settings.line_policy;
    config.search_relevance = settings.search_relevance;
    config.choice_gate_enabled = settings.choice_gate_enabled;
    config.log_limit_mb = settings.log_limit_mb;
    config.never_delete_logs = settings.never_delete_logs;
    Ok(())
}

fn config(data_dir: &Path) -> Result<Option<Config>, String> {
    check_ancestors(data_dir)?;
    let path = data_dir.join("config.json");
    match fs::symlink_metadata(&path) {
        Ok(meta) if !meta.is_file() || meta.len() > 64_000 => return Err("unsafe config".into()),
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            return Err("config stat failed".into())
        }
        _ => {}
    }
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
    if raw.get("schema_version").and_then(Value::as_f64) != Some(2.0) {
        return Err("unsupported config version".into());
    }
    let raw = codex_jev::contract::validate("config", &raw)?;
    Ok(Some(Config {
        global_scope: raw["scope"] == "global",
        output: raw["enabled"].as_bool().unwrap(),
        test_build: raw["test_build_enabled"].as_bool().unwrap(),
        search_listing: raw["search_listing_enabled"].as_bool().unwrap(),
        choice_gate_enabled: raw["choice_gate_enabled"].as_bool().unwrap(),
        mode: raw["mode"].as_str().unwrap().into(),
        min_chars: raw["min_chars"].as_u64().unwrap() as usize,
        max_chars: raw["max_chars"].as_u64().unwrap() as usize,
        model: raw["model"].as_str().unwrap().into(),
        timeout: raw["timeout_seconds"].as_f64().unwrap(),
        allow_mcp_replacement: raw["allow_mcp_replacement"].as_bool().unwrap(),
        policy: serde_json::from_value(raw["line_policy"].clone())
            .map_err(|_| "invalid line policy")?,
        search_relevance: serde_json::from_value(raw["search_relevance"].clone())
            .map_err(|_| "invalid search relevance")?,
        log_limit_mb: raw["log_limit_mb"].as_u64().unwrap(),
        never_delete_logs: raw["never_delete_logs"].as_bool().unwrap(),
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
        .or_else(|| event.pointer("/tool_input/cmd").and_then(Value::as_str))
        .unwrap_or("")
}

fn shell_tool(tool: &str) -> bool {
    matches!(tool, "Bash" | "exec_command" | "functions.exec_command")
}

fn basename(word: &str) -> &str {
    word.rsplit(['/', '\\']).next().unwrap_or(word)
}

fn shell_segments(command: &str) -> Option<Vec<&str>> {
    let mut segments = Vec::new();
    let mut start = 0;
    let mut quote = None;
    let mut escaped = false;
    let mut chars = command.char_indices().peekable();
    while let Some((index, ch)) = chars.next() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if ch == '\'' && quote != Some('"') {
            quote = if quote == Some('\'') {
                None
            } else {
                Some('\'')
            };
            continue;
        }
        if ch == '"' && quote != Some('\'') {
            quote = if quote == Some('"') { None } else { Some('"') };
            continue;
        }
        if quote != Some('\'')
            && (ch == '`' || ch == '$' && chars.peek().is_some_and(|(_, next)| *next == '('))
        {
            return None;
        }
        if quote.is_some() {
            continue;
        }
        match ch {
            '&' if chars.peek().is_some_and(|(_, next)| *next == '&') => {
                segments.push(&command[start..index]);
                start = chars.next()?.0 + 1;
            }
            ';' | '&' | '|' | '<' | '>' | '\n' | '\r' => return None,
            _ => {}
        }
    }
    if quote.is_some() || escaped {
        return None;
    }
    segments.push(&command[start..]);
    Some(segments)
}

fn assignment(word: &str) -> bool {
    let Some((name, _)) = word.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && name
            .bytes()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphabetic() || ch == b'_')
        && name
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == b'_')
}

fn direct_words(command: &str, depth: u8) -> Option<Vec<String>> {
    if command.len() > 4096 || depth > 2 {
        return None;
    }
    let segments = shell_segments(command)?;
    let direct = match segments.as_slice() {
        [single] => *single,
        [prefix, last]
            if shell_words::split(prefix)
                .ok()
                .is_some_and(|words| words.len() == 2 && basename(&words[0]) == "cd") =>
        {
            *last
        }
        _ => return None,
    };
    let words = shell_words::split(direct).ok()?;
    let mut start = 0;
    if words.first().is_some_and(|word| basename(word) == "env") {
        start = 1;
        while words.get(start).is_some_and(|word| word.starts_with('-')) {
            match words[start].as_str() {
                "--" => {
                    start += 1;
                    break;
                }
                "-u" | "--unset" => start += 2,
                _ => return None,
            }
        }
    }
    while words.get(start).is_some_and(|word| assignment(word)) {
        start += 1;
    }
    let executable = basename(words.get(start)?);
    if matches!(executable, "bash" | "sh" | "zsh")
        && matches!(
            words.get(start + 1).map(String::as_str),
            Some("-c" | "-lc" | "-ec")
        )
        && words.len() == start + 3
    {
        return direct_words(&words[start + 2], depth + 1);
    }
    Some(words[start..].to_vec())
}

fn subcommand<'a>(words: &'a [String], executable: &str) -> &'a str {
    let mut index = 1;
    if matches!(
        executable,
        "git" | "cargo" | "go" | "dotnet" | "gradle" | "gradlew" | "mvn" | "mvnw" | "make"
    ) {
        while let Some(word) = words.get(index) {
            if word == "--" {
                index += 1;
                break;
            }
            if matches!(
                word.as_str(),
                "-C" | "-c"
                    | "--git-dir"
                    | "--work-tree"
                    | "--manifest-path"
                    | "--target-dir"
                    | "--package"
                    | "-p"
                    | "--features"
                    | "--project"
            ) {
                index += 2;
            } else if word.starts_with('-') {
                index += 1;
            } else {
                break;
            }
        }
    }
    words.get(index).map(String::as_str).unwrap_or("")
}

fn bash_route(command: &str) -> Option<&'static str> {
    let words = direct_words(command, 0)?;
    let executable = basename(words.first()?);
    let action = subcommand(&words, executable);
    let package_action = if matches!(executable, "npm" | "pnpm" | "yarn") {
        let mut index = 1;
        while index < words.len() {
            if matches!(
                words[index].as_str(),
                "--prefix" | "--dir" | "--cwd" | "--workspace" | "--filter" | "-C" | "-w"
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
        ) && matches!(
            action,
            "test" | "build" | "package" | "check" | "clippy" | "vet"
        )
        || executable == "cmake" && action == "--build"
        || matches!(package_action, "test" | "build" | "check" | "lint")
        || executable == "node" && action == "--test"
        || executable.starts_with("python")
            && words
                .windows(2)
                .any(|pair| pair == ["-m", "unittest"] || pair == ["-m", "pytest"])
        || executable == "npx" && matches!(action, "vitest" | "jest" | "tsc");
    if build {
        return Some("test_build");
    }
    let search = matches!(executable, "rg" | "grep" | "find" | "fd" | "ls")
        || executable == "git"
            && (matches!(action, "ls-files" | "grep" | "status")
                || matches!(action, "diff" | "show")
                    && words
                        .iter()
                        .any(|word| matches!(word.as_str(), "--stat" | "--name-only")));
    if search {
        let search_args = if executable == "git" {
            let index = words.iter().position(|word| word == action).unwrap_or(0);
            &words[index + 1..]
        } else {
            &words[1..]
        };
        let unsafe_flag = search_args.iter().any(|word| {
            matches!(
                word.as_str(),
                "--null"
                    | "--zero"
                    | "-0"
                    | "-z"
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
                    | "-print0"
            ) || [
                "--context=",
                "--before-context=",
                "--after-context=",
                "--replace=",
            ]
            .iter()
            .any(|prefix| word.starts_with(prefix))
                || ["-C", "-A", "-B"]
                    .iter()
                    .any(|prefix| word.starts_with(prefix) && word.len() > prefix.len())
                || executable == "rg" && word.starts_with("-r") && word != "--regexp"
        });
        return (!unsafe_flag).then_some("search_listing");
    }
    if executable == "git" && matches!(action, "diff" | "show") {
        return None;
    }
    Some("output")
}

fn tool_route(tool: &str) -> Option<&'static str> {
    if matches!(
        tool,
        "apply_patch" | "functions.exec" | "functions.wait" | "update_plan"
    ) {
        return None;
    }
    let action = tool
        .rsplit("__")
        .next()
        .unwrap_or(tool)
        .to_ascii_lowercase();
    if action.split('_').any(|part| {
        matches!(
            part,
            "secret" | "secrets" | "credential" | "credentials" | "password" | "token" | "key"
        )
    }) || [
        "secret",
        "credential",
        "password",
        "apikey",
        "api_key",
        "accesskey",
    ]
    .iter()
    .any(|part| action.contains(part))
        || [
            "deploy", "publish", "install", "commit", "push", "merge", "delete", "remove",
        ]
        .iter()
        .any(|verb| action.contains(verb))
    {
        return None;
    }
    if action.starts_with("run_test")
        || action.starts_with("execute_test")
        || matches!(action.as_str(), "test" | "tests")
        || action.starts_with("build")
        || action.starts_with("compile")
        || action.starts_with("lint")
    {
        return Some("test_build");
    }
    if [
        "create", "update", "delete", "remove", "write", "edit", "patch", "apply", "send",
        "publish", "deploy", "install", "commit", "push", "merge", "set", "save", "post", "put",
        "upload", "execute", "run", "start", "stop", "restart", "move", "rename",
    ]
    .iter()
    .any(|verb| action.starts_with(verb))
    {
        return None;
    }
    if ["search", "grep", "glob", "find", "list", "lookup", "query"]
        .iter()
        .any(|verb| action.starts_with(verb))
    {
        return Some("search_listing");
    }
    Some("output")
}

fn route(event: &Value, config: &Config) -> Option<&'static str> {
    let tool = event.get("tool_name")?.as_str()?;
    let selected = if shell_tool(tool) {
        bash_route(command(event))?
    } else {
        tool_route(tool)?
    };
    match selected {
        "output" => config.output.then_some(selected),
        "test_build" => config.test_build.then_some(selected),
        "search_listing" => config.search_listing.then_some(selected),
        _ => None,
    }
}

fn task_context(event: &Value) -> Result<Option<String>, ()> {
    let Some(path) = event.get("transcript_path").and_then(Value::as_str) else {
        return Ok(None);
    };
    let path = Path::new(path);
    if !path.is_absolute() || path.is_symlink() {
        return Ok(None);
    }
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(None);
    };
    if !metadata.is_file() || metadata.len() > 50_000_000 {
        return Ok(None);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Ok(None);
        }
    }
    let Ok(mut file) = File::open(path) else {
        return Ok(None);
    };
    use std::io::{Seek, SeekFrom};
    if file
        .seek(SeekFrom::End(-(metadata.len().min(65_536) as i64)))
        .is_err()
    {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    if file.take(65_536).read_to_end(&mut bytes).is_err() {
        return Ok(None);
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
        if sensitive(&message) {
            return Err(());
        }
        let text: String = message
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(500)
            .collect();
        if !text.is_empty() {
            return Ok(Some(text));
        }
    }
    Ok(None)
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
        "secret=",
        "token=",
        "api key",
        "bearer ",
        "sk-",
        "ghp_",
        ".env",
        "id_rsa",
        "credentials.json",
        "/.env",
        "\\.env",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
}

fn sensitive_input(event: &Value) -> bool {
    event
        .get("tool_input")
        .and_then(|input| serde_json::to_string(input).ok())
        .is_some_and(|encoded| sensitive(&encoded))
}

fn fallback_task(event: &Value) -> String {
    let input = event.get("tool_input");
    let cue = [
        "query",
        "search_query",
        "pattern",
        "q",
        "description",
        "command",
        "path",
    ]
    .iter()
    .filter_map(|name| {
        input
            .and_then(|value| value.get(*name))
            .and_then(Value::as_str)
    })
    .find(|value| !value.trim().is_empty() && !sensitive(value));
    let detail = cue
        .unwrap_or("this tool result")
        .split_whitespace()
        .take(60)
        .collect::<Vec<_>>()
        .join(" ");
    format!("Review {detail}. Keep diagnostics, exact values, unique facts, and evidence needed to understand the result.")
}

fn response_text(event: &Value) -> Option<String> {
    event.get("tool_name")?.as_str()?;
    let body = event.get("tool_response")?;
    if let Some(text) = body.as_str() {
        return Some(text.to_owned());
    }
    if body.get("isError").and_then(Value::as_bool) == Some(true)
        || body.get("structuredContent").is_some()
    {
        return None;
    }
    if let Some(text) = body.get("output").and_then(Value::as_str) {
        return Some(text.to_owned());
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

fn apply_route_structure(route: &str, tool: &str, command: &str, lines: &mut [SourceLine]) -> bool {
    let words = if shell_tool(tool) {
        direct_words(command, 0)
    } else {
        None
    };
    let executable = words
        .as_ref()
        .and_then(|words| words.first())
        .map(|word| basename(word))
        .unwrap_or("");
    let action = words
        .as_ref()
        .map(|words| subcommand(words, executable))
        .unwrap_or("");
    let flag = |needle: &str| {
        words
            .as_ref()
            .is_some_and(|words| words.iter().any(|word| word == needle))
    };
    let explicit_json = route == "search_listing" && executable == "rg" && flag("--json")
        || route == "test_build"
            && (executable == "go" && action == "test" && flag("-json")
                || executable == "cargo" && flag("--message-format=json"));
    let looks_structured = lines
        .iter()
        .find(|line| !line.model_text.trim().is_empty())
        .is_some_and(|line| {
            let first = line.model_text.trim();
            matches!(first, "{" | "[") || serde_json::from_str::<Value>(first).is_ok()
        });
    if looks_structured && !explicit_json {
        return false;
    }
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
            if executable == "go" && action == "test" && flag("-json") {
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
            if executable == "cargo" && flag("--message-format=json") {
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
        let jsonl = executable == "rg" && flag("--json");
        let numbered = executable == "rg" && (flag("-n") || flag("--line-number"));
        let paths = executable == "rg" && flag("--files")
            || executable == "git" && action == "ls-files"
            || matches!(executable, "find" | "fd" | "ls");

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
                } else {
                    let Some(path) = row.pointer("/data/path/text").and_then(Value::as_str) else {
                        return false;
                    };
                    let Some(text) = row.pointer("/data/lines/text").and_then(Value::as_str) else {
                        return false;
                    };
                    let number = row
                        .pointer("/data/line_number")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    line.model_text =
                        format!("{path}:{number}:{}", text.trim_end_matches(['\r', '\n']));
                }
            } else if paths {
                if line.model_text.is_empty() || line.model_text.chars().any(char::is_control) {
                    return false;
                }
            } else if (numbered && !numbered_match(&line.model_text))
                || line.model_text.contains('\0')
            {
                return false;
            } else if line.model_text.trim().is_empty() {
                line.protected_reason = Some("blank".into());
            }
        }
    }
    true
}

fn numbered_match(text: &str) -> bool {
    text.match_indices(':').any(|(index, _)| {
        if index == 0 {
            return false;
        }
        text[index + 1..]
            .split_once(':')
            .is_some_and(|(number, _)| {
                number.starts_with(|c: char| ('1'..='9').contains(&c))
                    && number.bytes().all(|b| b.is_ascii_digit())
            })
    })
}

fn evaluate(
    agent: &ureq::Agent,
    request: &Value,
    key: &str,
    timeout: f64,
) -> Result<Value, String> {
    let encoded = serde_json::to_vec(request).map_err(|_| "request encoding")?;
    if encoded.len() > MAX_REQUEST_BYTES {
        return Err("request too large".into());
    }
    #[cfg(debug_assertions)]
    let endpoint = std::env::var("CODEX_JEV_TEST_ENDPOINT")
        .ok()
        .filter(|value| value.starts_with("http://127.0.0.1:"))
        .unwrap_or_else(|| "https://api.typesafe.ai/v1/systemone".into());
    #[cfg(not(debug_assertions))]
    let endpoint = "https://api.typesafe.ai/v1/systemone".to_owned();
    let response = agent
        .post(&endpoint)
        .timeout(Duration::from_secs_f64(timeout))
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

fn choice_request(task: &str, command: &str, lines: &[SourceLine], model: &str) -> Value {
    let eligible: Vec<&SourceLine> = lines
        .iter()
        .filter(|line| line.eligible && line.protected_reason.is_none())
        .collect();
    let mut samples = Vec::new();
    let count = eligible.len().min(21);
    for index in 0..count {
        let position = if count == 1 {
            0
        } else {
            index * (eligible.len() - 1) / (count - 1)
        };
        let line = eligible[position];
        samples.push(json!({"line":line.number,
            "text":line.model_text.chars().take(180).collect::<String>()}));
    }
    json!({"model":model,"state":{"task":task.chars().take(500).collect::<String>(),
        "command":command.chars().take(400).collect::<String>(),
        "line_count":lines.len(),"eligible_count":eligible.len(),"sample":samples},
        "questions":{"line_filter_fit":{"type":"choice",
            "instructions":"Would independent per-line filtering usefully remove routine repetition from this output while preserving task-relevant evidence? Judge only this sampled output. Choose uncertain if the sample is mixed or insufficient.",
            "criteria":{
                "line_filter":"Mostly repetitive standalone progress, status, or log lines; removing many routine lines would be useful.",
                "keep_full":"Mostly connected prose, source code, configuration, structured data, or distinct values where line removal would lose useful context or save little.",
                "uncertain":"Mixed or insufficient evidence; preserve the entire result."}}}})
}

fn choice_allows_line_filter(response: &Value) -> Result<bool, String> {
    let answer = response
        .pointer("/answers/line_filter_fit")
        .ok_or("missing Jev choice")?;
    if answer.get("type").and_then(Value::as_str) != Some("choice") {
        return Err("invalid Jev choice type".into());
    }
    let selected = answer
        .get("choice")
        .and_then(Value::as_str)
        .ok_or("missing Jev choice option")?;
    let probabilities = answer
        .get("probabilities")
        .and_then(Value::as_object)
        .ok_or("missing Jev choice probabilities")?;
    let options = ["line_filter", "keep_full", "uncertain"];
    if probabilities.len() != options.len() || !options.contains(&selected) {
        return Err("invalid Jev choice options".into());
    }
    let mut total = 0.0;
    let mut selected_probability = 0.0;
    for option in options {
        let value = probabilities
            .get(option)
            .and_then(Value::as_f64)
            .ok_or("missing Jev choice probability")?;
        if !value.is_finite() || !(0.0..=1.0).contains(&value) {
            return Err("invalid Jev choice probability".into());
        }
        total += value;
        if option == selected {
            selected_probability = value;
        }
    }
    let confidence = answer
        .get("confidence")
        .and_then(Value::as_f64)
        .ok_or("missing Jev choice confidence")?;
    if !confidence.is_finite()
        || !(0.0..=1.0).contains(&confidence)
        || (total - 1.0).abs() > 0.02
        || probabilities
            .values()
            .filter_map(Value::as_f64)
            .any(|value| value > selected_probability + 1e-9)
    {
        return Err("invalid Jev choice distribution".into());
    }
    Ok(selected == "line_filter" && selected_probability >= 0.80 && confidence >= 0.70)
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    check_ancestors(path)?;
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

fn check_dir_if_exists(path: &Path) -> Result<(), String> {
    check_ancestors(path)?;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("directory stat failed".into()),
    };
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
        let deadline = Instant::now() + remaining()?.min(Duration::from_secs(2));
        while unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::WouldBlock {
                return Err("log lock failed".into());
            }
            if Instant::now() >= deadline {
                return Err("log lock timeout".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    Ok(file)
}

// A small, private signal that the control can inspect without reading tool text or credentials.
// The log lock prevents concurrent hooks from replacing a newer signal with an older one.
fn hook_health(data_dir: &Path, outcome: &str, reason: &str) -> Result<(), String> {
    ensure_dir(data_dir)?;
    let logs = data_dir.join("logs");
    ensure_dir(&logs)?;
    let _lock = lock_logs(&logs)?;
    let path = logs.join("hook-health.json");
    let mut health = if path.exists() {
        let metadata = fs::symlink_metadata(&path).map_err(|_| "hook health stat")?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
            return Err("unsafe hook health".into());
        }
        serde_json::from_slice::<Value>(&fs::read(&path).map_err(|_| "hook health read")?)
            .map_err(|_| "invalid hook health")?
    } else {
        json!({})
    };
    if !health.is_object() {
        return Err("invalid hook health".into());
    }
    let now = Utc::now().timestamp_millis().max(
        health["last_seen_ms"]
            .as_i64()
            .unwrap_or(0)
            .saturating_add(1),
    );
    health["version"] = json!(1);
    health["hook_version"] = json!(env!("CARGO_PKG_VERSION"));
    health["last_seen_ms"] = json!(now);
    match outcome {
        "success" => health["last_success_ms"] = json!(now),
        "error" => {
            health["last_error_ms"] = json!(now);
            health["last_error"] = json!(reason);
        }
        "skip" => {
            health["last_skip_ms"] = json!(now);
            health["last_skip"] = json!(reason);
        }
        "seen" => {}
        _ => return Err("invalid hook health outcome".into()),
    }
    write_private(
        &path,
        &serde_json::to_vec(&health).map_err(|_| "hook health encoding")?,
        true,
    )
}

fn skip(data_dir: &Path, reason: &str) -> Result<Value, String> {
    hook_health(data_dir, "skip", reason)?;
    Ok(json!({}))
}

fn load_stats(path: &Path) -> Result<Value, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(_) => return Err("stats stat failed".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 8192 {
        return Err("unsafe stats file".into());
    }
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(|_| "stats read failed")?)
        .map_err(|_| "invalid stats file")?;
    let object = value.as_object().ok_or("invalid stats file")?;
    if object.values().any(|item| item.as_u64().is_none()) {
        return Err("invalid stats value".into());
    }
    Ok(value)
}

fn record_gate_skip(
    data_dir: &Path,
    event: &Value,
    source_chars: usize,
    elapsed_ms: u64,
) -> Result<(), String> {
    ensure_dir(data_dir)?;
    let logs = data_dir.join("logs");
    ensure_dir(&logs)?;
    let _lock = lock_logs(&logs)?;
    let stats_path = data_dir.join("stats.json");
    let mut stats = load_stats(&stats_path)?;
    let path = logs.join("events.jsonl");
    if path.is_symlink() {
        return Err("linked event log".into());
    }
    let mut options = OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path).map_err(|_| "event log")?;
    writeln!(
        file,
        "{}",
        json!({"version":2,"at":Utc::now().to_rfc3339(),
        "status":"skip","reason":"choice_kept_full_output","filter":"output",
        "tool":event.get("tool_name"),"original_chars":source_chars,"capsule_chars":source_chars,
        "elapsed_ms":elapsed_ms,"requests":1})
    )
    .map_err(|_| "event log write")?;
    for (name, amount) in [
        ("calls", 1),
        ("completed", 0),
        ("replaced", 0),
        ("timed", 1),
        ("elapsedMs", elapsed_ms),
    ] {
        stats[name] = json!(stats
            .get(name)
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .saturating_add(amount));
    }
    write_private(
        &stats_path,
        &serde_json::to_vec(&stats).map_err(|_| "stats encoding")?,
        true,
    )
}

fn session_dir(data_dir: &Path, session: &str) -> Result<PathBuf, String> {
    if session.is_empty()
        || session.len() > 128
        || !session
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err("invalid session id".into());
    }
    Ok(data_dir
        .join("sessions")
        .join(format!("{:x}", Sha256::digest(session.as_bytes()))))
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

#[allow(clippy::too_many_arguments)] // A complete immutable batch record is assembled here.
fn line_snapshot(
    receipt_id: &str,
    snapshot_id: &str,
    route: &str,
    status: &str,
    lines: &[SourceLine],
    decisions: &[codex_jev::LineDecision],
    batch: &BatchRecord,
    batch_number: usize,
    batch_count: usize,
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
    let rows: Vec<Value> = batch
        .target_numbers
        .iter()
        .filter_map(|number| {
            number
                .checked_sub(1)
                .and_then(|index| lines.get(index).zip(decisions.get(index)))
        })
        .filter(|(_, decision)| decision.batch_id == Some(batch.id))
        .map(|(line, decision)| {
            let excerpt: String = line
                .model_text
                .chars()
                .scan(0usize, |units, character| {
                    *units += character.len_utf16();
                    (*units <= 120).then_some(character)
                })
                .collect();
            json!({"line":line.number,"excerpt":excerpt,"action":decision.action,
                "reason":decision.reason,"can_omit":decision.p_can_omit,
                "exact_needed":decision.p_exact_needed,"task_relevant":decision.p_task_relevant})
        })
        .collect();
    let unjudged = lines
        .iter()
        .zip(decisions)
        .filter(|(line, decision)| {
            line.eligible && line.protected_reason.is_none() && decision.batch_id.is_none()
        })
        .count();
    json!({"version":3,"id":snapshot_id,"receipt_id":receipt_id,"at":Utc::now().to_rfc3339(),
        "filter":route,"status":status,"batch":{"number":batch_number,"count":batch_count,
            "target_count":batch.target_numbers.len()},"rows":rows,
        "totals":{"seen":seen,"judged":judged,"kept":seen-omitted,"omitted":omitted,
            "protected":protected,"unjudged":unjudged,"requests":batch_number},
        "batch_elapsed_ms":batch.elapsed_ms})
}

struct ProgressSnapshot {
    logs: PathBuf,
    receipt_id: String,
    previous: Option<Vec<u8>>,
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
            Ok(bytes) if bytes.len() <= PANEL_SNAPSHOT_MAX_BYTES => Some(bytes),
            Ok(_) => return Err("panel snapshot too large".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err("panel snapshot read failed".into()),
        };
        Ok(Self {
            logs,
            receipt_id,
            previous,
            last_snapshot_id: String::new(),
            active: false,
        })
    }

    fn publish(
        &mut self,
        route: &str,
        lines: &[SourceLine],
        decisions: &[codex_jev::LineDecision],
        batch: &BatchRecord,
        batch_number: usize,
        batch_count: usize,
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
            batch,
            batch_number,
            batch_count,
        );
        let bytes = serde_json::to_vec(&snapshot).map_err(|_| "snapshot encoding")?;
        if bytes.len() > PANEL_SNAPSHOT_MAX_BYTES {
            return Err("panel snapshot too large".into());
        }
        write_private(&self.logs.join("latest-decision.json"), &bytes, true)?;
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

#[allow(clippy::too_many_arguments)] // Keep event and decision evidence explicit at the write boundary.
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
    gate_record: Option<&BatchRecord>,
    config: &Config,
    receipt_id: &str,
    snapshot_id: &str,
) -> Result<(), String> {
    let gate_elapsed_ms = gate_record.map(|gate| gate.elapsed_ms);
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
    let unjudged = lines
        .iter()
        .zip(decisions)
        .filter(|(line, decision)| {
            line.eligible && line.protected_reason.is_none() && decision.batch_id.is_none()
        })
        .count();
    let relevance_judged = decisions
        .iter()
        .filter(|row| row.p_task_relevant.is_some())
        .count();
    let below_omit_cutoff = decisions
        .iter()
        .filter(|row| row.reason == "below_omit_cutoff")
        .count();
    let relevance_kept = decisions
        .iter()
        .filter(|row| row.reason == "task_relevant")
        .count();
    let summary = json!({"version":2,"id":id,"at":now.to_rfc3339(),"filter":route,"status":status,
        "reason":if config.mode == "observe" { "observe" } else { "line_policy" },
        "tool":event.get("tool_name"),"capsule_chars":visible.chars().count(),
        "elapsed_ms":batches.iter().map(|batch| batch.elapsed_ms).sum::<u64>() + gate_elapsed_ms.unwrap_or(0),
        "source_sha256":original_hash,"lines_seen":seen,"lines_judged":judged,"lines_kept":seen-omitted,
        "lines_omitted":omitted,"lines_protected":protected,"lines_unjudged":unjudged,
        "lines_relevance_judged":relevance_judged,"lines_below_omit_cutoff":below_omit_cutoff,
        "lines_relevance_kept":relevance_kept,"search_relevance_guard":config.search_relevance.guard_enabled,
        "line_policy":config.policy[route],"search_relevance_policy":config.search_relevance,
        "requests":batches.len()+usize::from(gate_elapsed_ms.is_some()),
        "choice_gate_ran":gate_elapsed_ms.is_some(),
        "original_chars":source.chars().count(),"visible_chars":visible.chars().count()});
    let receipt = json!({"version":2,"manifest":summary,"tool":event.get("tool_name"),
        "tool_input":event.get("tool_input"),"initial_output":source,
        "visible_output":if status == "replace" { Some(visible) } else { None },
        "decisions":decisions});
    let receipt_bytes = serde_json::to_vec(&receipt).map_err(|_| "receipt encoding")?;
    if receipt_bytes.len() > MAX_RECEIPT_BYTES {
        return Err("receipt too large".into());
    }
    let mut artifacts = vec![(folder.join(format!("receipt-{id}.json")), receipt_bytes)];
    for batch in gate_record.into_iter().chain(batches.iter()) {
        let bytes = serde_json::to_vec(&json!({"version":2,"receipt_id":id,"batch":batch}))
            .map_err(|_| "batch encoding")?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("batch record too large".into());
        }
        artifacts.push((folder.join(format!("batch-{id}-{}.json", batch.id)), bytes));
    }
    let last_batch = batches.last().ok_or("missing batch")?;
    let snapshot = line_snapshot(
        id,
        snapshot_id,
        route,
        status,
        lines,
        decisions,
        last_batch,
        batches.len(),
        batches.len(),
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
    let mut event_file = event_options.open(&event_path).map_err(|_| "event log")?;
    let event_size = event_file.metadata().map_err(|_| "event log stat")?.len();
    if !event_file
        .metadata()
        .map_err(|_| "event log stat")?
        .is_file()
    {
        return Err("unsafe event log".into());
    }
    let stats_path = data_dir.join("stats.json");
    let mut stats = load_stats(&stats_path)?;
    for (key, increment) in [
        (
            "calls",
            batches.len() as u64 + u64::from(gate_elapsed_ms.is_some()),
        ),
        ("completed", 1),
        ("replaced", u64::from(status == "replace")),
        (
            "timed",
            batches.len() as u64 + u64::from(gate_elapsed_ms.is_some()),
        ),
        (
            "elapsedMs",
            batches.iter().map(|batch| batch.elapsed_ms).sum::<u64>()
                + gate_elapsed_ms.unwrap_or(0),
        ),
        (
            "savedChars",
            if status == "replace" {
                source
                    .chars()
                    .count()
                    .saturating_sub(visible.chars().count()) as u64
            } else {
                0
            },
        ),
        ("linesSeen", seen as u64),
        ("linesJudged", judged as u64),
        ("linesKept", (seen - omitted) as u64),
        ("linesOmitted", omitted as u64),
        ("linesProtected", protected as u64),
        ("linesUnjudged", unjudged as u64),
        ("linesRelevanceJudged", relevance_judged as u64),
        ("linesBelowOmitCutoff", below_omit_cutoff as u64),
        ("linesRelevanceKept", relevance_kept as u64),
    ] {
        stats[key] = json!(stats
            .get(key)
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .saturating_add(increment));
    }
    let snapshot_path = logs.join("latest-decision.json");
    let snapshot_bytes = serde_json::to_vec(&snapshot).map_err(|_| "snapshot encoding")?;
    if snapshot_bytes.len() > PANEL_SNAPSHOT_MAX_BYTES {
        return Err("panel snapshot too large".into());
    }
    let stats_bytes = serde_json::to_vec(&stats).map_err(|_| "stats encoding")?;
    let previous_stats = private_backup(&stats_path, 8192)?;
    let previous_snapshot = private_backup(&snapshot_path, PANEL_SNAPSHOT_MAX_BYTES)?;
    let mut created = Vec::new();
    let result = (|| -> Result<(), String> {
        remaining()?;
        for (path, bytes) in artifacts {
            write_private(&path, &bytes, false)?;
            created.push(path);
        }
        write_private(&stats_path, &stats_bytes, true)?;
        write_private(&snapshot_path, &snapshot_bytes, true)?;
        // Append the completion event only after every required artifact exists.
        // No fallible operation may cancel the output after this commit point.
        writeln!(event_file, "{}", summary).map_err(|_| "event log write")?;
        event_file.sync_all().map_err(|_| "event log sync")?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = event_file.set_len(event_size);
        restore_private(&stats_path, previous_stats);
        restore_private(&snapshot_path, previous_snapshot);
        for path in created {
            let _ = fs::remove_file(path);
        }
        return Err(error);
    }
    if !config.never_delete_logs {
        prune(&logs, config.log_limit_mb * 1_000_000);
    }
    Ok(())
}

fn private_backup(path: &Path, limit: usize) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Ok(metadata)
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= limit as u64 =>
        {
            fs::read(path)
                .map(Some)
                .map_err(|_| "state backup read".into())
        }
        _ => Err("unsafe state backup".into()),
    }
}
fn restore_private(path: &Path, previous: Option<Vec<u8>>) {
    if let Some(bytes) = previous {
        let _ = write_private(path, &bytes, true);
    } else {
        let _ = fs::remove_file(path);
    }
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
    HOOK_STARTED.with(|started| started.set(Some(Instant::now())));
    let data_dir = std::env::var_os("PLUGIN_DATA")
        .map(PathBuf::from)
        .ok_or("missing plugin data")?;
    if !data_dir.is_absolute() || data_dir.is_symlink() {
        return Err("unsafe plugin data".into());
    }
    ensure_dir(&data_dir)?;
    let mut input = Vec::new();
    std::io::stdin()
        .take(16_000_001)
        .read_to_end(&mut input)
        .map_err(|_| "hook input read")?;
    if input.len() > 16_000_000 {
        return Err("hook input too large".into());
    }
    let event: Value = serde_json::from_slice(&input).map_err(|_| "invalid hook JSON")?;
    let session = event
        .get("session_id")
        .and_then(Value::as_str)
        .ok_or("missing session id")?;
    let scoped = session_dir(&data_dir, session)?;
    check_dir_if_exists(&data_dir.join("sessions"))?;
    check_dir_if_exists(&scoped)?;
    let scoped_config = match fs::symlink_metadata(scoped.join("config.json")) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err("config stat failed".into()),
    };
    let selected = if scoped_config {
        config(&scoped)?
    } else {
        config(&data_dir)?.filter(|global| global.global_scope)
    };
    let Some(mut config) = selected else {
        return Ok(json!({}));
    };
    apply_shared_settings(&data_dir, &mut config)?;
    if !(config.output || config.test_build || config.search_listing) {
        return Ok(json!({}));
    }
    ensure_dir(&data_dir.join("sessions"))?;
    hook_health(&scoped, "seen", "")?;
    let result = process_event(&data_dir, &scoped, &event, &config);
    if let Err(error) = &result {
        if let Err(status_error) = hook_health(&scoped, "error", error) {
            eprintln!("Codex Jev status write failed: {status_error}");
        }
    }
    result
}

fn process_event(
    data_dir: &Path,
    scoped: &Path,
    event: &Value,
    config: &Config,
) -> Result<Value, String> {
    if event.get("hook_event_name").and_then(Value::as_str) != Some("PostToolUse") {
        return skip(scoped, "unsupported_event");
    }
    let Some(route) = route(event, config) else {
        return skip(scoped, "unsupported_route");
    };
    let Some(source) = response_text(event) else {
        return skip(scoped, "unsupported_result");
    };
    if source.len() < config.min_chars {
        return skip(scoped, "small");
    }
    if source.len() > config.max_chars {
        return skip(scoped, "large");
    }
    if sensitive(&source) || sensitive(command(event)) || sensitive_input(event) {
        return skip(scoped, "sensitive");
    }
    if serde_json::to_vec(&event["tool_input"])
        .map_err(|_| "tool input encoding")?
        .len()
        > 256 * 1024
    {
        return skip(scoped, "tool_input_budget");
    }
    let user_task = match task_context(event) {
        Ok(task) => task,
        Err(()) => return skip(scoped, "unsafe_task_context"),
    };
    let has_user_task = user_task.is_some();
    let task = user_task.unwrap_or_else(|| fallback_task(event));
    let line_count =
        source.bytes().filter(|byte| *byte == b'\n').count() + usize::from(!source.ends_with('\n'));
    if line_count > MAX_SOURCE_LINES {
        return skip(scoped, "line_budget");
    }
    remaining()?;
    let mut lines = source_lines(&source);
    if lines.is_empty()
        || !apply_route_structure(
            route,
            event["tool_name"].as_str().unwrap_or(""),
            command(event),
            &mut lines,
        )
    {
        return skip(scoped, "structured_or_empty");
    }
    protect_neighbors(&mut lines);
    let batches = pack_batches(
        route,
        &task,
        &command(event).chars().take(400).collect::<String>(),
        &lines,
        &config.model,
    );
    if batches.is_empty() {
        return skip(scoped, "no_eligible_lines");
    }
    let api_key = key(data_dir)?;
    let agent = ureq::AgentBuilder::new().build();
    let mut gate_record = None;
    if config.choice_gate_enabled && route == "output" && batches.len() >= 2 {
        let request = choice_request(&task, command(event), &lines, &config.model);
        let before = Instant::now();
        let response = evaluate(
            &agent,
            &request,
            &api_key,
            config.timeout.min(remaining()?.as_secs_f64()),
        )?;
        let elapsed_ms = before.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        if !choice_allows_line_filter(&response)? {
            record_gate_skip(scoped, event, source.chars().count(), elapsed_ms)?;
            return skip(scoped, "choice_kept_full_output");
        }
        gate_record = Some(BatchRecord {
            id: 0,
            target_numbers: vec![],
            request,
            response,
            elapsed_ms,
        });
    }
    let receipt_id = Uuid::new_v4().simple().to_string();
    let mut progress = ProgressSnapshot::new(scoped, receipt_id.clone())?;
    let mut probabilities = BTreeMap::new();
    let mut records = Vec::new();
    let batch_count = batches.len();
    for batch in batches {
        remaining()?;
        let before = Instant::now();
        let response = evaluate(
            &agent,
            &batch.request,
            &api_key,
            config.timeout.min(remaining()?.as_secs_f64()),
        )?;
        let parsed = parse_probabilities(&batch, &response)?;
        for (number, (omit, exact, relevant)) in parsed {
            probabilities.insert(number, (omit, exact, relevant, batch.id));
        }
        records.push(BatchRecord {
            id: batch.id,
            target_numbers: batch.target_numbers,
            request: batch.request,
            response,
            elapsed_ms: before.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        });
        let partial = apply_probabilities(
            &lines,
            &probabilities,
            &config.policy[route],
            &config.search_relevance,
        );
        progress.publish(
            route,
            &lines,
            &partial,
            records.last().unwrap(),
            records.len(),
            batch_count,
        )?;
    }
    let decisions = apply_probabilities(
        &lines,
        &probabilities,
        &config.policy[route],
        &config.search_relevance,
    );
    let omitted = decisions
        .iter()
        .filter(|row| row.action == Action::Omit)
        .count();
    let candidate = omitted > 0;
    let path = output_path(data_dir, event)?;
    let feedback = render(&source, &lines, &decisions, &path.to_string_lossy());
    let replace = candidate
        && config.mode == "replace"
        && has_user_task
        && (shell_tool(event["tool_name"].as_str().unwrap_or(""))
            && event["tool_response"].is_string()
            || !event["tool_name"]
                .as_str()
                .unwrap_or("")
                .starts_with("mcp__")
                && event["tool_response"].is_string()
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
        ensure_dir(data_dir)?;
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
        scoped,
        event,
        route,
        status,
        &source,
        visible,
        &lines,
        &decisions,
        &records,
        gate_record.as_ref(),
        config,
        &receipt_id,
        &progress.last_snapshot_id,
    )?;
    // The committed output must survive a later telemetry failure.
    if let Err(error) = hook_health(scoped, "success", "") {
        eprintln!("Codex Jev status write failed: {error}");
    }
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
    let answer = execute().unwrap_or_else(|error| {
        eprintln!("Codex Jev hook skipped: {error}");
        // Errors after session parsing are recorded in that session by execute().
        json!({})
    });
    println!("{}", answer);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_or_unknown_config_never_looks_disabled() {
        let directory = tempfile::tempdir().unwrap();
        for value in [
            json!({"enabled":true}),
            json!({"schema_version":1,"enabled":true}),
            json!({"schema_version":3,"enabled":true}),
        ] {
            fs::write(directory.path().join("config.json"), value.to_string()).unwrap();
            assert!(config(directory.path())
                .err()
                .unwrap()
                .contains("unsupported config version"));
        }
    }

    #[test]
    fn malformed_optional_settings_do_not_fall_back_to_defaults() {
        let directory = tempfile::tempdir().unwrap();
        let baseline = json!({"schema_version":2,"enabled":true,"test_build_enabled":false,
            "search_listing_enabled":false,"mode":"replace",
            "line_policy":{"output":{},"test_build":{},"search_listing":{}}});
        for (key, bad) in [
            ("min_chars", json!("256")),
            ("max_chars", json!(-1)),
            ("timeout_seconds", json!("three")),
            ("model", json!("jev-")),
            ("allow_mcp_replacement", json!("yes")),
            ("never_delete_logs", json!(1)),
            ("log_limit_mb", json!(0)),
            ("unknown", json!(true)),
        ] {
            let mut entered = baseline.clone();
            entered[key] = bad;
            fs::write(directory.path().join("config.json"), entered.to_string()).unwrap();
            assert!(config(directory.path()).is_err(), "{key}");
        }
        fs::write(directory.path().join("config.json"), baseline.to_string()).unwrap();
        assert!(config(directory.path()).unwrap().is_some());
    }

    #[test]
    fn shared_settings_override_session_behavior_without_changing_route_selection() {
        let directory = tempfile::tempdir().unwrap();
        let baseline = json!({"schema_version":2,"enabled":true,"test_build_enabled":false,
            "search_listing_enabled":true,"mode":"replace",
            "line_policy":{"output":{},"test_build":{},"search_listing":{}}});
        fs::write(directory.path().join("config.json"), baseline.to_string()).unwrap();
        let mut selected = config(directory.path()).unwrap().unwrap();
        let settings = json!({"schema_version":1,"mode":"observe","choice_gate_enabled":false,
            "line_policy":{"output":{"omit_min":80,"exact_max":10},
                "test_build":{"omit_min":85,"exact_max":5},
                "search_listing":{"omit_min":90,"exact_max":4}},
            "search_relevance":{"guard_enabled":true,"relevant_max":15},
            "log_limit_mb":75,"never_delete_logs":true});
        fs::write(directory.path().join("settings.json"), settings.to_string()).unwrap();
        apply_shared_settings(directory.path(), &mut selected).unwrap();
        assert!(selected.output);
        assert!(!selected.test_build);
        assert!(selected.search_listing);
        assert_eq!(selected.mode, "observe");
        assert_eq!(selected.policy["output"].omit_min, 80);
        assert!(selected.search_relevance.guard_enabled);
        assert!(!selected.choice_gate_enabled);
        assert!(selected.never_delete_logs);
        let mut malformed = settings.clone();
        malformed["line_policy"]["output"]["omit_min"] = json!(101);
        fs::write(
            directory.path().join("settings.json"),
            malformed.to_string(),
        )
        .unwrap();
        assert!(apply_shared_settings(directory.path(), &mut selected).is_err());
    }

    #[test]
    fn hook_status_records_skips_and_errors_without_tool_text() {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("data");
        hook_health(&data, "seen", "").unwrap();
        skip(&data, "small").unwrap();
        hook_health(&data, "error", "invalid Jev response").unwrap();
        let bytes = fs::read(data.join("logs/hook-health.json")).unwrap();
        let status: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(status["last_skip"], "small");
        assert_eq!(status["last_error"], "invalid Jev response");
        assert!(!String::from_utf8_lossy(&bytes).contains("tool_response"));
        hook_health(&data, "success", "").unwrap();
        let updated: Value =
            serde_json::from_slice(&fs::read(data.join("logs/hook-health.json")).unwrap()).unwrap();
        assert!(updated["last_success_ms"].as_i64() >= status["last_error_ms"].as_i64());
    }

    fn enabled() -> Config {
        Config {
            global_scope: false,
            output: true,
            test_build: true,
            search_listing: true,
            choice_gate_enabled: true,
            mode: "observe".into(),
            min_chars: 1024,
            max_chars: 2_000_000,
            model: "jev-latest".into(),
            timeout: 3.0,
            allow_mcp_replacement: false,
            policy: BTreeMap::new(),
            search_relevance: SearchRelevancePolicy::default(),
            log_limit_mb: 50,
            never_delete_logs: false,
        }
    }

    #[test]
    fn choice_gate_rejects_inconsistent_answers_and_keeps_uncertainty() {
        let answer = |choice: &str, confidence: f64, filter: f64, full: f64, uncertain: f64| {
            json!({"answers":{"line_filter_fit":{"type":"choice","choice":choice,
                "confidence":confidence,"probabilities":{"line_filter":filter,
                    "keep_full":full,"uncertain":uncertain}}}})
        };
        assert!(choice_allows_line_filter(&answer("line_filter", 0.96, 0.98, 0.01, 0.01)).unwrap());
        assert!(!choice_allows_line_filter(&answer("keep_full", 0.96, 0.01, 0.98, 0.01)).unwrap());
        assert!(!choice_allows_line_filter(&answer("uncertain", 0.01, 0.33, 0.33, 0.34)).unwrap());
        assert!(
            !choice_allows_line_filter(&answer("line_filter", 0.60, 0.80, 0.10, 0.10)).unwrap()
        );
        for bad in [
            answer("line_filter", 0.96, 0.49, 0.50, 0.01),
            answer("line_filter", 0.96, 0.98, 0.98, 0.01),
            answer("other", 0.96, 0.98, 0.01, 0.01),
            json!({"answers":{"line_filter_fit":{"type":"choice","choice":"line_filter"}}}),
        ] {
            assert!(choice_allows_line_filter(&bad).is_err());
        }
    }

    #[test]
    fn failed_record_never_publishes_a_replace_event_or_receipt() {
        for failure in ["stats", "snapshot", "artifact"] {
            let root = tempfile::tempdir().unwrap();
            let data = root.path().join("data");
            ensure_dir(&data).unwrap();
            let logs = data.join("logs");
            ensure_dir(&logs).unwrap();
            let event = json!({"session_id":"transaction","tool_name":"Bash","tool_input":{"command":"echo progress"}});
            let source = "routine progress\nsummary\n";
            let lines = source_lines(source);
            let batch = pack_batches(
                "output",
                "Check progress",
                "echo progress",
                &lines,
                "jev-latest",
            )
            .remove(0);
            let probabilities = lines
                .iter()
                .map(|line| (line.number, (0.99, 0.01, None, 1)))
                .collect();
            let decisions = apply_probabilities(
                &lines,
                &probabilities,
                &LinePolicy::default(),
                &SearchRelevancePolicy::default(),
            );
            let records = vec![BatchRecord {
                id: 1,
                target_numbers: batch.target_numbers,
                request: batch.request,
                response: json!({}),
                elapsed_ms: 1,
            }];
            let mut config = enabled();
            config.mode = "replace".into();
            config.policy.insert("output".into(), LinePolicy::default());
            if failure == "stats" {
                fs::write(data.join("stats.json"), "{\"calls\":\"invalid\"}").unwrap();
            }
            if failure == "snapshot" {
                fs::create_dir(logs.join("latest-decision.json")).unwrap();
            }
            if failure == "artifact" {
                let hash = format!("{:x}", Sha256::digest(b"transaction"));
                let folder =
                    logs.join(format!("{}-{}", Utc::now().format("%Y-%m-%d"), &hash[..10]));
                ensure_dir(&folder).unwrap();
                fs::write(
                    folder.join("batch-receipt-1.json"),
                    "user-owned existing file",
                )
                .unwrap();
            }
            assert!(record(
                &data,
                &event,
                "output",
                "replace",
                source,
                "summary\n",
                &lines,
                &decisions,
                &records,
                None,
                &config,
                "receipt",
                "snapshot"
            )
            .is_err());
            assert!(
                !logs.join("events.jsonl").exists()
                    || fs::read(logs.join("events.jsonl")).unwrap().is_empty()
            );
            assert!(
                !data.join("stats.json").exists()
                    || fs::read_to_string(data.join("stats.json")).unwrap()
                        == "{\"calls\":\"invalid\"}"
            );
            for entry in fs::read_dir(&logs)
                .unwrap()
                .flatten()
                .filter(|entry| entry.path().is_dir())
            {
                assert!(!entry.path().join("receipt-receipt.json").exists());
            }
        }
    }

    #[test]
    fn ancestor_links_and_contended_log_locks_fail_within_a_bound() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        ensure_dir(&data).unwrap();
        #[cfg(unix)]
        {
            let linked = root.path().join("linked");
            std::os::unix::fs::symlink(&data, &linked).unwrap();
            assert!(ensure_dir(&linked.join("child")).is_err());
            assert!(!data.join("child").exists());
            let first = lock_logs(&data).unwrap();
            let started = Instant::now();
            assert!(lock_logs(&data).is_err());
            assert!(started.elapsed() < Duration::from_secs(3));
            drop(first);
        }
    }

    #[test]
    fn corrupt_stats_are_reported_instead_of_reset() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("stats.json");
        assert_eq!(load_stats(&path).unwrap(), json!({}));
        for invalid in ["{broken", "[]", "{\"calls\":-1}", "{\"calls\":\"one\"}"] {
            fs::write(&path, invalid).unwrap();
            assert!(load_stats(&path).is_err());
        }
        fs::write(&path, "{\"calls\":4}").unwrap();
        assert_eq!(load_stats(&path).unwrap()["calls"], 4);
    }

    #[test]
    fn direct_test_and_search_commands_route_to_line_adapters() {
        let config = enabled();
        for command in [
            "pytest tests -v",
            "python -m pytest -v",
            "cargo test --workspace",
            "cargo check --workspace",
            "cargo --manifest-path Cargo.toml test",
            "go -C src test ./...",
            "CARGO_TARGET_DIR=/tmp/jev-target cargo test",
            "env CI=1 cargo test",
            "bash -lc 'cargo test --workspace'",
            "cd src && cargo test",
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
            "rg -n 'foo|bar' src",
            "rg pattern src",
            "rg --json pattern src",
            "rg --files src",
            "grep -r pattern src",
            "find src -type f",
            "ls -l src",
            "cd src && rg -n pattern .",
            "git ls-files",
            "git -C src ls-files",
            "git grep pattern",
            "git diff --stat",
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
    fn integration_switches_select_exclusive_routes() {
        let cases = [
            ("cargo test --workspace", "test_build"),
            ("rg -n token src", "search_listing"),
            ("git ls-files", "search_listing"),
            ("cat output.log", "output"),
        ];
        for output in [false, true] {
            for test_build in [false, true] {
                for search_listing in [false, true] {
                    let config = Config {
                        output,
                        test_build,
                        search_listing,
                        ..enabled()
                    };
                    for (command, expected_route) in cases {
                        let selected = match expected_route {
                            "output" => output,
                            "test_build" => test_build,
                            _ => search_listing,
                        };
                        assert_eq!(
                            route(
                                &json!({"tool_name":"Bash","tool_input":{"command":command}}),
                                &config
                            ),
                            selected.then_some(expected_route),
                            "{command} with output={output}, test_build={test_build}, search_listing={search_listing}"
                        );
                    }
                    assert_eq!(
                        route(&json!({"tool_name":"mcp__demo__logs"}), &config),
                        output.then_some("output")
                    );
                    assert_eq!(
                        route(&json!({"tool_name":"mcp__files__search"}), &config),
                        search_listing.then_some("search_listing")
                    );
                    assert_eq!(
                        route(&json!({"tool_name":"Grep"}), &config),
                        search_listing.then_some("search_listing")
                    );
                    assert_eq!(
                        route(&json!({"tool_name":"Read"}), &config),
                        output.then_some("output")
                    );
                    assert_eq!(route(&json!({"tool_name":"apply_patch"}), &config), None);
                }
            }
        }
    }

    #[test]
    fn unsupported_or_compound_specialized_commands_do_not_use_output_fallback() {
        let config = enabled();
        for command in [
            "rg -n token src | head",
            "rg --context=3 token src",
            "rg -C3 token src",
            "rg --replace=word token src",
            "rg --json --null token src",
            "find src -print0",
            "git ls-files -z",
            "cargo test | tee results.log",
            "npm run test; echo done",
            "cargo test\necho done",
            "cat output.log | head",
            "cd src && cargo test && echo done",
            "git diff",
            "git show HEAD",
        ] {
            assert_eq!(
                route(
                    &json!({"tool_name":"Bash","tool_input":{"command":command}}),
                    &config
                ),
                None,
                "{command}"
            );
        }
    }

    #[test]
    fn local_text_is_eligible_but_structured_and_action_results_are_not() {
        let config = enabled();
        let read = json!({"tool_name":"Read","tool_response":"line one\nline two\n"});
        assert_eq!(route(&read, &config), Some("output"));
        assert_eq!(
            response_text(&read).as_deref(),
            Some("line one\nline two\n")
        );
        let shell = json!({"tool_name":"exec_command","tool_input":{"cmd":"rg -n token src"},
            "tool_response":{"output":"src/a.rs:12:token\n","exit_code":0}});
        assert_eq!(route(&shell, &config), Some("search_listing"));
        assert_eq!(
            response_text(&shell).as_deref(),
            Some("src/a.rs:12:token\n")
        );
        let search = json!({"tool_name":"mcp__files__search","tool_response":{
            "content":[{"type":"text","text":"src/main.rs:42:match"}]}});
        assert_eq!(route(&search, &config), Some("search_listing"));
        assert_eq!(
            response_text(&search).as_deref(),
            Some("src/main.rs:42:match")
        );
        for response in [
            json!({"content":[{"type":"image","data":"sample"}]}),
            json!({"content":[{"type":"text","text":"sample"}],"structuredContent":{"id":1}}),
            json!({"content":[{"type":"text","text":"sample"}],"isError":true}),
        ] {
            assert!(response_text(
                &json!({"tool_name":"mcp__files__search","tool_response":response})
            )
            .is_none());
        }
        for tool in [
            "apply_patch",
            "update_plan",
            "mcp__files__write_file",
            "mcp__repo__deploy",
            "mcp__keys__getApiKey",
            "mcp__repo__buildAndDeploy",
        ] {
            assert_eq!(route(&json!({"tool_name":tool}), &config), None, "{tool}");
        }
        assert!(sensitive_input(&json!({"tool_input":{"path":".env"}})));
    }

    #[test]
    fn completion_and_jsonl_structure_are_protected() {
        let mut build = source_lines("test_one PASSED\n40 passed in 2.1s\n");
        assert!(apply_route_structure(
            "test_build",
            "Bash",
            "pytest -v",
            &mut build
        ));
        assert_eq!(build[1].protected_reason.as_deref(), Some("completion"));
        let source = concat!(
            "{\"type\":\"begin\",\"data\":{}}\n",
            "{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"src/a.rs\"},\"lines\":{\"text\":\"needle\"}}}\n",
            "{\"type\":\"end\",\"data\":{}}\n");
        let mut search = source_lines(source);
        assert!(apply_route_structure(
            "search_listing",
            "Bash",
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
            "Bash",
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
            "Bash",
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
    fn unknown_json_text_is_not_filtered_line_by_line() {
        for route in ["output", "search_listing", "test_build"] {
            let mut lines = source_lines("{\n  \"items\": [1, 2],\n  \"ok\": true\n}\n");
            assert!(!apply_route_structure(route, "Read", "", &mut lines));
        }
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
            &BTreeMap::from([(1, (0.98, 0.02, None, 1))]),
            &LinePolicy::default(),
            &SearchRelevancePolicy::default(),
        );
        let path = data.join("logs/latest-decision.json");
        let batch = BatchRecord {
            id: 1,
            target_numbers: vec![1],
            request: json!({}),
            response: json!({}),
            elapsed_ms: 25,
        };
        {
            let mut progress = ProgressSnapshot::new(&data, "a".repeat(32)).unwrap();
            progress
                .publish("output", &lines, &judged, &batch, 1, 1)
                .unwrap();
            let snapshot: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert_eq!(snapshot["version"], 3);
            assert_eq!(snapshot["status"], "processing");
            assert_eq!(snapshot["totals"]["judged"], 1);
            assert_eq!(snapshot["rows"][0]["line"], 1);
        }
        assert!(!path.exists());
    }

    #[test]
    fn panel_snapshot_contains_a_full_bounded_250_line_batch() {
        let source = (1..=250)
            .map(|number| format!("Synthetic line {number:03}: {}\n", "x".repeat(500)))
            .collect::<String>();
        let lines = source_lines(&source);
        let probabilities = (1..=250)
            .map(|number| (number, (0.5, 0.2, None, 1)))
            .collect::<BTreeMap<_, _>>();
        let decisions = apply_probabilities(
            &lines,
            &probabilities,
            &LinePolicy::default(),
            &SearchRelevancePolicy::default(),
        );
        let batch = BatchRecord {
            id: 1,
            target_numbers: (1..=250).collect(),
            request: json!({}),
            response: json!({}),
            elapsed_ms: 25,
        };
        let snapshot = line_snapshot(
            &"a".repeat(32),
            &"b".repeat(32),
            "output",
            "keep",
            &lines,
            &decisions,
            &batch,
            1,
            1,
        );
        assert_eq!(snapshot["rows"].as_array().unwrap().len(), 250);
        assert!(snapshot["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["excerpt"].as_str().unwrap().encode_utf16().count() <= 120));
        assert!(serde_json::to_vec(&snapshot).unwrap().len() <= PANEL_SNAPSHOT_MAX_BYTES);
    }
}
