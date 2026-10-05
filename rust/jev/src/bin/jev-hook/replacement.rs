//! Explicit reasons distinguish previews from actual reductions.
use super::*;

pub(super) fn savings_possible(
    source: &str,
    lines: &[SourceLine],
    path: &Path,
    envelope: bool,
) -> bool {
    // A lower bound excludes omission markers and semantic keeps. If even
    // this bound cannot save enough, no Jev answer can produce a reduction.
    let mandatory = lines
        .iter()
        .filter(|line| {
            line.protected_reason.is_some() || !line.eligible || line.number == lines.len()
        })
        .map(|line| line.source(source).len())
        .sum::<usize>();
    let header = format!(
        "[Codex Jev: 1 of {} lines omitted; full original: {}]\n",
        lines.len(),
        path.display()
    )
    .len();
    let envelope_header = if envelope {
        format!(
            "[Original tool envelope: {}]\n",
            path.with_extension("json").display()
        )
        .len()
    } else {
        0
    };
    let minimum = mandatory + header + envelope_header;
    minimum + 256 < source.len() && minimum * 5 < source.len() * 4
}

pub(super) fn replacement_blocker(
    event: &Value,
    config: &Config,
    has_task: bool,
    direct: bool,
    source: &str,
    feedback: &str,
) -> Option<&'static str> {
    if config.mode != "replace" {
        return Some("observe");
    }
    if !has_task {
        return Some("missing_task_context");
    }
    let tool = event["tool_name"].as_str().unwrap_or("");
    if preview_only(event) && !(direct && (shell_tool(tool) || orchestration_tool(tool))) {
        return Some("unsupported_command");
    }
    if tool.starts_with("mcp__") && !config.allow_mcp_replacement {
        return Some("mcp_replacement_disabled");
    }
    if !replacement_supported(event) && !(tool.starts_with("mcp__") && config.allow_mcp_replacement)
    {
        return Some("unsupported_envelope");
    }
    if feedback.len() + 256 >= source.len() || feedback.len() * 5 >= source.len() * 4 {
        return Some("insufficient_savings");
    }
    None
}
