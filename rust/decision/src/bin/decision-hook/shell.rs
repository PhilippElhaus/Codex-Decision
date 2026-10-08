//! Unambiguous direct shell command parsing.

pub(super) fn basename(word: &str) -> &str {
    word.rsplit(['/', '\\']).next().unwrap_or(word)
}

// Cargo accepts separated, repeated, and comma-separated message formats.
// Rendered diagnostics are a different carrier and do not claim this JSONL
// contract. Arguments after `--` belong to the invoked program/test runner.
pub(super) fn cargo_json_messages(words: &[String]) -> bool {
    let mut json = false;
    let mut index = 1;
    while let Some(word) = words.get(index) {
        index += 1;
        if word == "--" {
            break;
        }
        let value = if word == "--message-format" {
            let Some(value) = words.get(index) else {
                return false;
            };
            index += 1;
            Some(value.as_str())
        } else {
            word.strip_prefix("--message-format=")
        };
        if let Some(value) = value {
            for format in value.split(',') {
                match format {
                    "json" => json = true,
                    "json-diagnostic-short" | "json-diagnostic-rendered-ansi" => {}
                    _ => return false,
                }
            }
        } else if matches!(
            word.as_str(),
            "--features"
                | "-F"
                | "--package"
                | "-p"
                | "--target"
                | "--profile"
                | "--manifest-path"
                | "--target-dir"
                | "--artifact-dir"
                | "--config"
                | "--jobs"
                | "-j"
                | "--bin"
                | "--example"
                | "--test"
                | "--bench"
                | "--exclude"
        ) {
            index += 1;
        }
    }
    json
}

// Split only simple command lists and pipelines. Do not execute shell text.
pub(super) fn output_groups(command: &str) -> Option<Vec<Vec<&str>>> {
    let command = command.trim();
    let mut groups = Vec::new();
    let mut stages = Vec::new();
    let mut start = 0;
    let mut quote = None;
    let mut escaped = false;
    let mut required = false;
    let mut chars = command.char_indices().peekable();
    while let Some((index, ch)) = chars.next() {
        if escaped {
            escaped = false;
            if ch == '\n' || ch == '\r' {
                return None;
            }
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
        let pipeline = ch == '|';
        let conditional = ch == '&';
        if pipeline || conditional || matches!(ch, ';' | '\n' | '\r') {
            if pipeline && chars.peek().is_some_and(|(_, next)| *next == '|') {
                return None;
            }
            let segment = command[start..index].trim();
            if segment.is_empty() && (pipeline || conditional || required) {
                return None;
            }
            if !segment.is_empty() {
                stages.push(segment);
            }
            start = if conditional {
                if chars.peek()?.1 != '&' {
                    return None;
                }
                chars.next()?.0 + 1
            } else {
                index + ch.len_utf8()
            };
            required = pipeline || conditional;
            if !pipeline && !stages.is_empty() {
                groups.push(std::mem::take(&mut stages));
            }
        } else if matches!(ch, '<' | '>' | '(' | ')' | '{' | '}' | '#') {
            return None;
        }
    }
    if quote.is_some() || escaped {
        return None;
    }
    let last = command[start..].trim();
    if last.is_empty() && required {
        return None;
    }
    if !last.is_empty() {
        stages.push(last);
    }
    if !stages.is_empty() {
        groups.push(stages);
    }
    (!groups.is_empty() && groups.len() <= 32).then_some(groups)
}

// Only viewers that preserve complete output lines may follow a source.
fn line_viewer(words: &[String]) -> bool {
    let Some(executable) = words.first().map(|word| basename(word)) else {
        return false;
    };
    let args = &words[1..];
    match executable {
        "head" | "tail" => {
            args.is_empty() || args.len() == 2 && args[0] == "-n" && args[1].parse::<u32>().is_ok()
        }
        "cat" => args.is_empty(),
        "tee" => {
            args.len() == 1 && !args[0].starts_with('-')
                || args.len() == 2 && args[0] == "-a" && !args[1].starts_with('-')
        }
        _ => false,
    }
}

pub(super) fn output_commands(command: &str, depth: u8) -> Option<Vec<Vec<String>>> {
    if command.len() > 4096 || depth > 2 {
        return None;
    }
    let mut commands = Vec::new();
    for stages in output_groups(command)? {
        if stages.len() > 8 {
            return None;
        }
        for stage in &stages[1..] {
            if !line_viewer(&shell_words::split(stage).ok()?) {
                return None;
            }
        }
        let words = command_words(stages[0])?;
        let executable = basename(words.first()?);
        if executable == "cd" && words.len() == 2 && stages.len() == 1 {
            continue;
        }
        if matches!(executable, "bash" | "sh" | "zsh")
            && words.len() == 3
            && matches!(words[1].as_str(), "-c" | "-lc" | "-ec")
        {
            commands.extend(output_commands(&words[2], depth + 1)?);
        } else {
            commands.push(words);
        }
    }
    (!commands.is_empty() && commands.len() <= 32).then_some(commands)
}

pub(super) fn assignment(word: &str) -> bool {
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

pub(super) fn command_words(command: &str) -> Option<Vec<String>> {
    let words = shell_words::split(command).ok()?;
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
    words.get(start)?;
    Some(words[start..].to_vec())
}

pub(super) fn subcommand<'a>(words: &'a [String], executable: &str) -> &'a str {
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
