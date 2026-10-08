//! Protect validated stream ranges using typed data, never source header claims.
use super::*;

pub(super) fn protect_lab_streams(event: &Value, lines: &mut [SourceLine]) {
    let body = &event["tool_response"];
    let tool = event["tool_name"].as_str().unwrap_or("");
    if lab_execute(event) || lab_poll(tool) || orchestration_tool(tool) {
        if let Some(view) = lab_result::lab_view(body) {
            protect_view(&view, 0, lines);
            return;
        }
    }
    if !orchestration_tool(tool) {
        return;
    }
    let Some(items) = body.as_array() else {
        return;
    };
    let mut offset = 0;
    for item in items {
        let Some(text) = item["text"].as_str() else {
            return;
        };
        let parsed = strict_json::parse(text.as_bytes()).ok();
        let view = parsed.as_ref().and_then(lab_result::lab_view);
        if let Some(view) = &view {
            protect_view(view, offset, lines);
        }
        let preview = view
            .as_ref()
            .map(|view| std::borrow::Cow::Borrowed(view.source.as_str()))
            .unwrap_or_else(|| command_preview(text));
        offset += preview.bytes().filter(|byte| *byte == b'\n').count() + 1;
    }
}

fn protect_view(view: &lab_result::LabView, offset: usize, lines: &mut [SourceLine]) {
    for index in [0, 1, view.stderr_start - 1] {
        if let Some(line) = lines.get_mut(offset + index) {
            line.protected_reason = Some("tool_metadata".into());
        }
    }
    if view.stdout_end > view.stdout_start {
        for index in [view.stdout_start, view.stdout_end - 1] {
            if let Some(line) = lines.get_mut(offset + index) {
                line.protected_reason
                    .get_or_insert_with(|| "stream_boundary".into());
            }
        }
    }
    for index in view.stderr_start..view.stderr_end {
        if let Some(line) = lines.get_mut(offset + index) {
            line.protected_reason
                .get_or_insert_with(|| "stderr_output".into());
        }
    }
}
