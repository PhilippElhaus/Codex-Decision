//! Credential and environment-file guards with identifier-aware boundaries.
use super::*;

pub(super) fn sensitive(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    sensitive_markers(&lower) || environment_file(&lower)
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
    match value {
        Value::String(text) => {
            let lower = text.to_ascii_lowercase();
            sensitive_markers(&lower)
                || if path {
                    lower.contains(".env")
                } else {
                    environment_file(&lower)
                }
        }
        Value::Array(items) => items.iter().any(|item| sensitive_input_value(item, path)),
        Value::Object(object) => object.iter().any(|(name, value)| {
            sensitive_markers(&format!("{}:", name.to_ascii_lowercase()))
                || environment_file(&name.to_ascii_lowercase())
                || sensitive_input_value(
                    value,
                    path || matches!(
                        name.to_ascii_lowercase().as_str(),
                        "path"
                            | "paths"
                            | "file_path"
                            | "filepath"
                            | "filename"
                            | "cwd"
                            | "workdir"
                    ),
                )
        }),
        _ => false,
    }
}
