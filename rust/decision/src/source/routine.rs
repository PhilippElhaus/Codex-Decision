//! Narrow routine-record grammars that cannot carry a diagnostic outcome.
use std::borrow::Cow;

pub(super) fn passing_test(text: &str) -> bool {
    let Some(name) = text
        .strip_prefix("test ")
        .and_then(|text| text.strip_suffix(" ... ok"))
    else {
        return false;
    };
    // Cargo test names have identifier segments separated by `::`. Do not
    // treat arbitrary prose or a diagnostic with an `ok` suffix as a pass.
    name.split("::").all(|part| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    })
}

pub(super) fn without_zero_counters(text: &str) -> Cow<'_, str> {
    let zero_counter = |token: &str| {
        let token = token.trim_end_matches([',', ';']);
        let Some((name, value)) = token.split_once('=') else {
            return false;
        };
        value == "0"
            && matches!(
                name,
                "error_count"
                    | "errors"
                    | "failed_count"
                    | "failure_count"
                    | "failures"
                    | "warning_count"
                    | "warnings"
            )
    };
    if !text.split_whitespace().any(zero_counter) {
        return Cow::Borrowed(text);
    }
    // Preserve separators and every other word so that another diagnostic or
    // completion marker on the same record still protects the whole line.
    Cow::Owned(
        text.split_inclusive(char::is_whitespace)
            .map(|part| {
                let token = part.trim_end_matches(char::is_whitespace);
                if zero_counter(token) {
                    &part[token.len()..]
                } else {
                    part
                }
            })
            .collect(),
    )
}
