//! Structured route validation and protected evidence.
use super::*;

#[path = "go_json.rs"]
mod go_json;

#[cfg(test)]
#[path = "structure_tests.rs"]
mod tests;

pub(super) fn apply_route_structure(
    route: &str,
    tool: &str,
    command: &str,
    lines: &mut [SourceLine],
) -> bool {
    let words = if shell_tool(tool) || tool_action(tool) == "lab_session_execute" {
        output_commands(command, 0).and_then(|commands| commands.into_iter().next())
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
    let go_json = executable == "go" && action == "test" && flag("-json");
    let cargo_json = executable == "cargo"
        && words
            .as_ref()
            .is_some_and(|words| cargo_json_messages(words));
    let explicit_json = route == "search_listing" && executable == "rg" && flag("--json")
        || route == "test_build" && (go_json || cargo_json);
    let looks_structured = lines
        .iter()
        .find(|line| !line.model_text.trim().is_empty() && !metadata_or_stderr(line))
        .is_some_and(|line| {
            let first = line.model_text.trim();
            matches!(first, "{" | "[") || serde_json::from_str::<Value>(first).is_ok()
        });
    if looks_structured && !explicit_json {
        return false;
    }
    // A build header does not turn a following multiline object/array into
    // independent records. Complete JSONL rows remain atomic source lines.
    if route == "test_build"
        && !explicit_json
        && lines
            .iter()
            .any(|line| !metadata_or_stderr(line) && multiline_json_start(&line.model_text))
    {
        return false;
    }
    if route == "test_build" {
        let mut complete = false;
        let mut go_events = go_json::GoEvents::default();
        for line in lines.iter_mut() {
            if metadata_or_stderr(line) {
                continue;
            }
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
            if go_json {
                let Some(package_complete) = go_events.apply(line) else {
                    return false;
                };
                complete |= package_complete;
            }
            if cargo_json {
                let Ok(row) = strict_json::parse(line.model_text.as_bytes()) else {
                    return false;
                };
                match row.get("reason").and_then(Value::as_str).unwrap_or("") {
                    "compiler-message" => {
                        if row
                            .pointer("/message/level")
                            .and_then(Value::as_str)
                            .is_none()
                            || row
                                .pointer("/message/message")
                                .and_then(Value::as_str)
                                .is_none()
                        {
                            return false;
                        }
                        // Notes, help, and future severity strings are still
                        // diagnostic carriers with attached source evidence.
                        line.protected_reason = Some("diagnostic_json".into());
                    }
                    "build-finished" => {
                        if row.get("success").and_then(Value::as_bool).is_none() {
                            return false;
                        }
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
            if metadata_or_stderr(line) {
                continue;
            }
            if jsonl {
                let Ok(row) = strict_json::parse(line.model_text.as_bytes()) else {
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
                    let Some(path) = row.pointer("/data/path").and_then(Value::as_object) else {
                        return false;
                    };
                    let Some(text) = row.pointer("/data/lines").and_then(Value::as_object) else {
                        return false;
                    };
                    let number = row
                        .pointer("/data/line_number")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    if path.len() != 1
                        || text.len() != 1
                        || number == 0
                        || path
                            .get("text")
                            .and_then(Value::as_str)
                            .is_none_or(str::is_empty)
                        || text.get("text").and_then(Value::as_str).is_none()
                    {
                        return false;
                    }
                    // A match is one independent record. Keep its complete
                    // model evidence, including absolute/submatch byte offsets.
                    // Normalizing to path:line:text hid distinct match facts.
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

fn metadata_or_stderr(line: &SourceLine) -> bool {
    matches!(
        line.protected_reason.as_deref(),
        Some("tool_metadata" | "stderr_output")
    )
}

fn multiline_json_start(text: &str) -> bool {
    let text = text.trim();
    if known_build_progress(text) {
        return false;
    }
    if !text.starts_with(['{', '[']) {
        return false;
    }
    if strict_json::parse(text.as_bytes()).is_ok() {
        return false;
    }
    if let Some(rest) = text.strip_prefix('{') {
        let rest = rest.trim_start();
        return rest.is_empty() || rest.starts_with(['"', '}']);
    }
    let Some(rest) = text.strip_prefix('[') else {
        return false;
    };
    let rest = rest.trim_start();
    rest.is_empty()
        || rest.starts_with(['"', '{', '[', ']', '-'])
        || rest.starts_with(|c: char| c.is_ascii_digit())
        || ["true", "false", "null"]
            .iter()
            .any(|prefix| rest.starts_with(prefix))
}

// CMake percentage and Ninja step counters precede a known build record, not
// JSON. Reuse this exact grammar when deciding whether JSON decoding applies.
pub(super) fn known_build_progress(text: &str) -> bool {
    let clean = if text.contains('\x1b') {
        std::borrow::Cow::Owned(codex_decision::strip_ansi(text))
    } else {
        std::borrow::Cow::Borrowed(text)
    };
    let Some(rest) = clean.trim_start().strip_prefix('[') else {
        return false;
    };
    let Some((counter, record)) = rest.split_once(']') else {
        return false;
    };
    let number = |value: &str| {
        !value.trim().is_empty() && value.trim().bytes().all(|byte| byte.is_ascii_digit())
    };
    let counter = counter.trim();
    (counter.strip_suffix('%').is_some_and(number)
        || counter
            .split_once('/')
            .is_some_and(|(step, total)| number(step) && number(total)))
        && ["Building ", "Compiling ", "Checking ", "Linking ", "Built "]
            .iter()
            .any(|prefix| record.trim_start().starts_with(prefix))
}

pub(super) fn numbered_match(text: &str) -> bool {
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
