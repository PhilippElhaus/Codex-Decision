//! Unambiguous direct shell command parsing.

pub(super) fn basename(word: &str) -> &str {
    word.rsplit(['/', '\\']).next().unwrap_or(word)
}

pub(super) fn shell_segments(command: &str) -> Option<Vec<&str>> {
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

pub(super) fn direct_words(command: &str, depth: u8) -> Option<Vec<String>> {
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
