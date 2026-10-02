//! Structured route validation and protected evidence.
use super::*;

pub(super) fn apply_route_structure(
    route: &str,
    tool: &str,
    command: &str,
    lines: &mut [SourceLine],
) -> bool {
    let words = if shell_tool(tool) {
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
