//! Use local format contracts before asking Jev for semantic relevance.
use super::*;

#[derive(Clone, Copy)]
pub(super) enum FormatDecision {
    Direct(&'static str),
    Classify,
    Keep(&'static str),
}
#[cfg(test)]
#[path = "fast_path_tests.rs"]
mod tests;

pub(super) fn format_decision(event: &Value, lines: &mut [SourceLine]) -> FormatDecision {
    let tool = event["tool_name"].as_str().unwrap_or("");
    let route = output_format(event).unwrap_or("output");
    if route != "output" && shell_tool(tool) {
        if !apply_route_structure(route, tool, command(event), lines) {
            return FormatDecision::Keep("structure_guard");
        }
        return FormatDecision::Direct(if route == "test_build" {
            if lines.iter().any(|line| {
                line.model_text.trim_start().starts_with("Compiling ")
                    || line.model_text.trim_start().starts_with("Building ")
            }) {
                "progress_output"
            } else {
                "repetitive_log"
            }
        } else if lines.iter().any(|line| numbered_match(&line.model_text)) {
            "independent_matches"
        } else {
            "independent_records"
        });
    }
    // Arbitrary JSON and source/diff reads have no independent-line contract.
    if !apply_route_structure("output", tool, command(event), lines) {
        return FormatDecision::Keep("structure_guard");
    }
    if shell_tool(tool) && exact_read(command(event)) {
        return FormatDecision::Keep("exact_content");
    }
    // Code-mode wrappers do not expose a trustworthy shell command. Validate
    // numbered records directly, while preserving their metadata and headers.
    let records = lines
        .iter()
        .filter(|line| {
            line.protected_reason.as_deref() != Some("tool_metadata")
                && !line.model_text.trim().is_empty()
        })
        .collect::<Vec<_>>();
    if records.len() >= 3 && records.iter().all(|line| numbered_match(&line.model_text)) {
        return FormatDecision::Direct("independent_matches");
    }
    // Recognize an entire log, including sparse diagnostic/context lines. A
    // mixed explanation does not acquire this contract because it has logs.
    let independent = lines
        .iter()
        .filter(|line| log_line(&line.model_text))
        .count();
    let substantive = lines
        .iter()
        .filter(|line| !line.model_text.trim().is_empty())
        .count();
    let unknown = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| {
            !log_line(&line.model_text)
                && line.protected_reason.is_none()
                && !line.model_text.trim().is_empty()
                && !final_status(&line.model_text)
                && !line.model_text.starts_with("Command result metadata:")
                && !line.model_text.starts_with("Script completed")
                && !line.model_text.starts_with("Wall time ")
                && line.model_text.trim() != "Output:"
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let sparse_context = unknown.len() <= 10
        && unknown.iter().all(|index| {
            let text = lines[*index].model_text.trim();
            !text.ends_with('.')
                && ![
                    "```",
                    "diff --git",
                    "---",
                    "+++",
                    "{",
                    "[",
                    "<",
                    "const ",
                    "function ",
                ]
                .iter()
                .any(|prefix| text.starts_with(prefix))
        });
    if sparse_context && independent >= 3 && independent * 2 >= substantive {
        // A sparse fact does not require classifying an otherwise known log.
        // Keep every unfamiliar line locally; Jev judges only known events.
        for index in unknown {
            lines[index].protected_reason = Some("unrecognized_log_context".into());
        }
        return FormatDecision::Direct(
            if lines
                .iter()
                .any(|line| line.model_text.trim_start().starts_with("Compiling "))
            {
                "progress_output"
            } else {
                "repetitive_log"
            },
        );
    }
    FormatDecision::Classify
}

fn exact_read(command: &str) -> bool {
    let Some(commands) = output_commands(command, 0) else {
        return false;
    };
    commands.iter().any(|words| {
        let executable = basename(&words[0]);
        let action = subcommand(words, executable);
        executable == "git" && matches!(action, "diff" | "show")
            || matches!(executable, "cat" | "sed" | "head" | "tail")
                && words.iter().skip(1).any(|word| {
                    !word.starts_with('-') && word.contains('.') && !word.ends_with(".log")
                })
    })
}

fn final_status(text: &str) -> bool {
    let text = text.trim().to_ascii_lowercase();
    matches!(
        text.as_str(),
        "done" | "complete" | "completed" | "finished" | "ok"
    ) || [
        "finished ",
        "build successful",
        "run complete",
        "service stopped",
        "test result:",
    ]
    .iter()
    .any(|prefix| text.starts_with(prefix))
}

fn log_line(text: &str) -> bool {
    let text = text.trim_start();
    [
        "INFO ",
        "INFO:",
        "DEBUG ",
        "DEBUG:",
        "TRACE ",
        "TRACE:",
        "WARN ",
        "WARN:",
        "WARNING ",
        "ERROR ",
        "ERROR:",
        "Compiling ",
        "Checking ",
        "Downloading ",
        "Building ",
        "Finished ",
    ]
    .iter()
    .any(|prefix| text.starts_with(prefix))
        || text.starts_with("test ") && text.contains(" ... ")
}
