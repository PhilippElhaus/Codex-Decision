//! Supported output formats and the single Jev enable switch.
use super::*;

pub(super) fn command(event: &Value) -> &str {
    event
        .pointer("/tool_input/command")
        .and_then(Value::as_str)
        .or_else(|| event.pointer("/tool_input/cmd").and_then(Value::as_str))
        .unwrap_or("")
}

pub(super) fn shell_tool(tool: &str) -> bool {
    matches!(tool, "Bash" | "exec_command" | "functions.exec_command")
}

pub(super) fn bash_route(command: &str) -> Option<&'static str> {
    let commands = output_commands(command, 0)?;
    let first = words_route(commands.first()?)?;
    for words in &commands[1..] {
        if words_route(words)? != first
            || first != "output" && structure_key(words) != structure_key(&commands[0])
        {
            return None;
        }
    }
    Some(first)
}

fn structure_key(words: &[String]) -> (&str, &str, bool, bool, bool) {
    let executable = basename(&words[0]);
    (
        executable,
        subcommand(words, executable),
        words
            .iter()
            .any(|word| word == "--json" || word == "-json" || word == "--message-format=json"),
        words
            .iter()
            .any(|word| word == "-n" || word == "--line-number"),
        words.iter().any(|word| word == "--files"),
    )
}

fn words_route(words: &[String]) -> Option<&'static str> {
    let executable = basename(words.first()?);
    let action = subcommand(words, executable);
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

pub(super) fn tool_route(tool: &str) -> Option<&'static str> {
    if matches!(
        tool,
        "apply_patch" | "functions.apply_patch" | "update_plan" | "functions.update_plan"
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

// Format recognition only preserves structured evidence. It does not select a filter.
pub(super) fn output_format(event: &Value) -> Option<&'static str> {
    let tool = event.get("tool_name")?.as_str()?;
    if shell_tool(tool) {
        bash_route(command(event))
    } else {
        tool_route(tool)
    }
}

pub(super) fn route(event: &Value, config: &Config) -> Option<&'static str> {
    (config.enabled && output_format(event).is_some()).then_some("output")
}
