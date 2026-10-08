//! Credential and environment-file guards with identifier-aware boundaries.
use super::*;

#[path = "unicode_guard.rs"]
mod unicode_guard;

pub(super) fn sensitive(text: &str) -> bool {
    sensitive_string(text, false)
}

fn source_marker_sensitive(text: &str) -> bool {
    source_marker_sensitive_path(text, false)
}

fn source_marker_sensitive_path(text: &str, path: bool) -> bool {
    sensitive_string(text, path) || source_ansi_sensitive(text, path)
}

pub(super) fn sensitive_context(text: &str) -> bool {
    sensitive_context_limited(text, false, 0, &mut 16_000_000)
}

fn sensitive_context_limited(text: &str, path: bool, depth: usize, budget: &mut usize) -> bool {
    if source_marker_sensitive_path(text, path) {
        return true;
    }
    if !text.contains("\\u") {
        return false;
    }
    if depth >= 8 || text.len() > *budget {
        return true;
    }
    *budget -= text.len();
    unicode_guard::sensitive_escapes(text, depth, budget, path)
}

fn source_ansi_sensitive(text: &str, path: bool) -> bool {
    text.contains('\x1b')
        && text.lines().any(|line| {
            line.contains('\x1b') && sensitive_string(&codex_decision::strip_ansi(line), path)
        })
}

fn sensitive_string(text: &str, path: bool) -> bool {
    let lower = text.to_ascii_lowercase();
    sensitive_markers(&lower)
        || if path {
            lower.contains(".env")
        } else {
            environment_file(&lower)
        }
}

// Outputs can contain JSON/JSONL inside an already decoded hook event. Inspect
// the values the model can decode, including protected context/metadata rows.
// Plain logs take the raw-marker path without parsing every physical line.
pub(super) fn sensitive_source(text: &str) -> bool {
    let mut budget = 16_000_000;
    decoded_source_sensitive(text, 0, &mut budget)
}

fn decoded_source_sensitive(text: &str, depth: usize, budget: &mut usize) -> bool {
    if source_marker_sensitive(text) {
        return true;
    }
    if !text.contains('\\') && !quoted_path_field(text) {
        return false;
    }
    if depth >= 8 || text.len() > *budget {
        return true;
    }
    *budget -= text.len();
    if unicode_guard::sensitive_escapes(text, depth, budget, false) {
        return true;
    }
    let trimmed = text.trim();
    if json_start(trimmed) {
        if let Ok(value) = strict_json::parse(trimmed.as_bytes()) {
            return decoded_value_sensitive(&value, depth + 1, budget);
        }
    }
    text.lines().any(|line| {
        let line = line.trim();
        let candidate = line
            .strip_prefix("Command result metadata: ")
            .unwrap_or(line);
        if !json_start(candidate) || !candidate.contains('\\') && !quoted_path_field(candidate) {
            return false;
        }
        match strict_json::parse(candidate.as_bytes()) {
            Ok(value) => decoded_value_sensitive(&value, depth + 1, budget),
            // An escaped JSON-shaped record with ambiguous or invalid fields
            // has no safe decoded interpretation to send to a provider.
            Err(_) => true,
        }
    })
}

fn quoted_path_field(text: &str) -> bool {
    text.match_indices('"').any(|(index, _)| {
        let rest = &text[index + 1..];
        let Some(end) = rest.find('"') else {
            return false;
        };
        let name = &rest[..end];
        rest[end + 1..].trim_start().starts_with(':') && path_field(name, true)
    })
}

fn path_field(name: &str, source: bool) -> bool {
    [
        "path",
        "paths",
        "file_path",
        "filepath",
        "filename",
        "cwd",
        "workdir",
    ]
    .iter()
    .any(|key| name.eq_ignore_ascii_case(key))
        || source
            && [
                "manifest_path",
                "src_path",
                "file_name",
                "out_dir",
                "filenames",
                "linked_paths",
            ]
            .iter()
            .any(|key| name.eq_ignore_ascii_case(key))
}

fn json_start(text: &str) -> bool {
    if known_build_progress(text) {
        return false;
    }
    text.starts_with(['{', '"'])
        || text.strip_prefix('[').is_some_and(|rest| {
            let rest = rest.trim_start();
            rest.chars()
                .next()
                .is_some_and(|next| matches!(next, '{' | '[' | '"' | '-' | '0'..='9' | ']'))
                || ["null", "true", "false"].iter().any(|literal| {
                    rest.strip_prefix(*literal).is_some_and(|suffix| {
                        suffix
                            .chars()
                            .next()
                            .is_none_or(|next| !next.is_alphanumeric() && next != '_')
                    })
                })
        })
}

fn decoded_value_sensitive(value: &Value, depth: usize, budget: &mut usize) -> bool {
    sensitive_value(value, false, true, depth, budget)
        || nested_strings_sensitive(value, depth, budget)
}

fn nested_strings_sensitive(value: &Value, depth: usize, budget: &mut usize) -> bool {
    match value {
        Value::String(text) => {
            (text.contains('\\') || quoted_path_field(text))
                && decoded_source_sensitive(text, depth, budget)
        }
        Value::Array(items) => items
            .iter()
            .any(|item| nested_strings_sensitive(item, depth, budget)),
        Value::Object(object) => object
            .values()
            .any(|value| nested_strings_sensitive(value, depth, budget)),
        _ => false,
    }
}

fn sensitive_markers(lower: &str) -> bool {
    [
        "-----begin",
        "private key",
        "api_key=",
        "api-key:",
        "authorization:",
        "password=",
        "passwd=",
        "secret=",
        "token=",
        "api key",
        "bearer ",
        "id_rsa",
        "credentials.json",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
        || ["access_token", "client_secret"].iter().any(|name| {
            lower
                .match_indices(name)
                .any(|(index, _)| !environment_read_reference(lower, index, name))
        })
        || ["sk-", "ghp_"]
            .iter()
            .any(|prefix| credential_prefix(lower, prefix))
        || [
            "password",
            "passwd",
            "api_key",
            "api-key",
            "apikey",
            "secret",
            "token",
            "authorization",
        ]
        .iter()
        .any(|name| {
            lower.match_indices(name).any(|(index, _)| {
                let rest = lower[index + name.len()..]
                    .trim_start()
                    .trim_start_matches('\\');
                let rest = rest
                    .strip_prefix('"')
                    .or_else(|| rest.strip_prefix('\''))
                    .unwrap_or(rest)
                    .trim_start();
                rest.starts_with([':', '=', '>'])
            })
        })
}

fn environment_read_reference(text: &str, index: usize, name: &str) -> bool {
    let before = &text[..index];
    let after = &text[index + name.len()..];
    let rest =
        if let Some(owner) = before.strip_suffix(".env.") {
            if !expression_owner(owner, "process") {
                return false;
            }
            after
        } else {
            let Some((owner, closing)) =
                [(".env[\"", "\"]"), (".env['", "']")].into_iter().find_map(
                    |(opening, closing)| before.strip_suffix(opening).map(|owner| (owner, closing)),
                )
            else {
                return false;
            };
            if !expression_owner(owner, "process") {
                return false;
            }
            let Some(rest) = after.strip_prefix(closing) else {
                return false;
            };
            rest
        };
    // Permit only a complete member read. Assignment/value fields and arbitrary
    // text after a credential marker remain guarded, even in command input.
    rest.trim_start()
        .chars()
        .next()
        .is_none_or(|next| matches!(next, ';' | ',' | ')' | ']' | '}'))
}

fn credential_prefix(text: &str, prefix: &str) -> bool {
    text.match_indices(prefix).any(|(index, _)| {
        text[..index]
            .chars()
            .next_back()
            .is_none_or(|previous| !previous.is_alphanumeric() && previous != '_')
    })
}

fn environment_file(text: &str) -> bool {
    text.match_indices(".env").any(|(index, _)| {
        let rest = &text[index + ".env".len()..];
        let before = &text[..index];
        // A property reference is not a filename. Preserve every other .env
        // spelling, including .env_vars, .envproduction, and .environment files.
        if rest.strip_prefix("ironment").is_some_and(|suffix| {
            expression_owner(before, "settings") && member_suffix(suffix, true)
        }) {
            return false;
        }
        if expression_owner(before, "process") && member_suffix(rest, false) {
            return false;
        }
        true
    })
}

fn expression_owner(before: &str, owner: &str) -> bool {
    before.strip_suffix(owner).is_some_and(|prefix| {
        prefix
            .trim_end()
            .chars()
            .next_back()
            .is_none_or(|previous| {
                matches!(
                    previous,
                    '=' | '(' | '[' | '{' | ',' | ':' | ';' | '+' | '-' | '!' | '&' | '|' | '?'
                )
            })
    })
}

fn member_suffix(rest: &str, allow_end: bool) -> bool {
    rest.chars().next().map_or(allow_end, |next| {
        matches!(
            next,
            '.' | '[' | ';' | ',' | ')' | ']' | '}' | '=' | '?' | '!'
        )
    })
}

#[cfg(test)]
#[path = "context_tests.rs"]
mod tests;

pub(super) fn sensitive_input(event: &Value) -> bool {
    let Some(input) = event.get("tool_input") else {
        return false;
    };
    sensitive_input_value(input, false)
}

fn sensitive_input_value(value: &Value, path: bool) -> bool {
    sensitive_value(value, path, false, 0, &mut 16_000_000)
}

fn sensitive_value(
    value: &Value,
    path: bool,
    source: bool,
    depth: usize,
    budget: &mut usize,
) -> bool {
    match value {
        Value::String(text) => sensitive_context_limited(text, path, depth, budget),
        Value::Array(items) => items
            .iter()
            .any(|item| sensitive_value(item, path, source, depth, budget)),
        Value::Object(object) => object.iter().any(|(name, value)| {
            sensitive_markers(&format!("{}:", name.to_ascii_lowercase()))
                || environment_file(&name.to_ascii_lowercase())
                || sensitive_value(
                    value,
                    path || path_field(name, source),
                    source,
                    depth,
                    budget,
                )
        }),
        _ => false,
    }
}
