//! Protect validated stream ranges using typed data, never source header claims.
use super::*;

#[cfg(test)]
pub(super) fn protect_lab_streams(event: &Value, lines: &mut [SourceLine]) {
    protect_cached_lab_streams(event, &ProjectionCache::new(&event["tool_response"]), lines);
}

pub(super) fn protect_cached_lab_streams<'a>(
    event: &'a Value,
    projections: &ProjectionCache<'a>,
    lines: &mut [SourceLine],
) {
    let body = &event["tool_response"];
    let tool = event["tool_name"].as_str().unwrap_or("");
    if lab_execute(event) || lab_poll(tool) || orchestration_tool(tool) {
        if let Some(view) = projections.direct.lab() {
            protect_view(view, 0, lines);
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
        let envelope = projections.serialized(text);
        let view = envelope.lab();
        if let Some(view) = view {
            protect_view(view, offset, lines);
        }
        let preview = view
            .map(|view| view.source.as_str())
            .unwrap_or_else(|| envelope.projection().unwrap_or(text));
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
            // Retain the typed stream identity even when its text resembles a
            // diagnostic, completion row, JSON record, or spoofed header.
            line.protected_reason = Some("stderr_output".into());
        }
    }
}
