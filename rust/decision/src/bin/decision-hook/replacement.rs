//! Explicit reasons distinguish previews from actual reductions.
use super::*;

/// Originals belong to this invocation until its receipt commits. A failed
/// pair write or publication must neither strand files nor block a retry.
pub(super) struct SavedOriginals(Vec<PathBuf>);

impl SavedOriginals {
    pub(super) fn save(path: &Path, source: &str, envelope: &Value) -> Result<Self, String> {
        let mut saved = Self(Vec::with_capacity(2));
        remaining()?;
        write_private(path, source.as_bytes(), false)?;
        saved.0.push(path.to_owned());
        if !envelope.is_string() {
            let bytes = serde_json::to_vec(envelope).map_err(|_| "original envelope encoding")?;
            remaining()?;
            let path = path.with_extension("json");
            write_private(&path, &bytes, false)?;
            saved.0.push(path);
        }
        Ok(saved)
    }

    pub(super) fn commit(mut self) {
        self.0.clear();
    }
}

impl Drop for SavedOriginals {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}

pub(super) fn savings_possible(
    source: &str,
    lines: &[SourceLine],
    path: &Path,
    envelope: bool,
) -> bool {
    // A lower bound excludes omission markers and semantic keeps. If even
    // this bound cannot save enough, no Decision answer can produce a reduction.
    let mandatory = lines
        .iter()
        .filter(|line| {
            line.protected_reason.is_some() || !line.eligible || line.number == lines.len()
        })
        .map(|line| line.source(source).len())
        .sum::<usize>();
    let header = format!(
        "[Codex Decision: 1 of {} lines omitted; full original: {}]\n",
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
    if preview_only(event)
        && !(direct && (command_tool(event) || orchestration_tool(tool) || polling_tool(event)))
    {
        return Some("unsupported_command");
    }
    if mcp_tool(tool) && !config.allow_mcp_replacement && !(direct && supported_lab_command(event))
    {
        return Some("mcp_replacement_disabled");
    }
    if !(replacement_supported(event) || mcp_tool(tool) && config.allow_mcp_replacement) {
        return Some("unsupported_envelope");
    }
    if feedback.len() + 256 >= source.len() || feedback.len() * 5 >= source.len() * 4 {
        return Some("insufficient_savings");
    }
    None
}
