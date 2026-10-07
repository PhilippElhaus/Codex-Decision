use super::*;
use std::collections::BTreeSet;

mod sizes;
mod window;
use sizes::WindowSizes;
use window::window_request;

pub fn relevance_requests(
    task: &str,
    command: &str,
    kind: &str,
    lines: &[SourceLine],
    model: &str,
) -> Result<Vec<Batch>, String> {
    let targets: Vec<_> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.eligible && line.protected_reason.is_none())
        .map(|(index, _)| index)
        .collect();
    if targets.is_empty() {
        return Err("no relevance targets".into());
    }
    let diagnostics: Vec<_> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| {
            matches!(
                line.protected_reason.as_deref(),
                Some("diagnostic_or_completion" | "completion" | "unrecognized_log_context")
            )
        })
        .map(|(index, _)| index)
        .collect();
    let mut anchors = BTreeSet::from([0, lines.len() - 1]);
    for n in 0..12.min(diagnostics.len()) {
        anchors.insert(
            diagnostics[n * diagnostics.len().saturating_sub(1)
                / 12.min(diagnostics.len()).saturating_sub(1).max(1)],
        );
    }
    // Check the first complete window before preparing costs for the output.
    validate_request_budget(&window_request(
        task,
        command,
        kind,
        lines,
        &targets[..1],
        &anchors,
        model,
    ))?;
    let sizes = WindowSizes::new(task, command, kind, lines, &targets, model)?;
    let mut batches: Vec<Batch> = Vec::new();
    let mut start = 0;
    while start < targets.len() {
        let fits = |end| sizes.fits(start, end, &targets, &anchors);
        // Fit both API limits without line-count or batch-count caps. Grow the
        // search window exponentially, then find its largest fitting prefix.
        // Avoid serializing the whole remaining output for every small batch.
        if !fits(start + 1) {
            return Err("Decision context budget".into());
        }
        let mut low = start + 1;
        let mut high = low;
        // Adjacent windows usually fit similar target counts. Reuse that count
        // as a hint, but validate it and shrink when later lines are wider.
        if let Some(previous) = batches.last() {
            let end = (start + previous.target_numbers.len()).min(targets.len());
            if fits(end) {
                low = end;
                high = end;
            } else {
                high = end - 1;
            }
        }
        // A one-target probe avoids a fresh exponential search for equal-sized
        // windows, while still allowing later, shorter lines to grow the batch.
        let mut grow = low == high;
        if grow && high < targets.len() {
            let end = high + 1;
            if fits(end) {
                low = end;
                high = end;
            } else {
                grow = false;
            }
        }
        while grow && high < targets.len() {
            let end = (start + 2 * (high - start)).min(targets.len());
            if !fits(end) {
                high = end - 1;
                break;
            }
            low = end;
            high = end;
        }
        while low < high {
            let middle = low + (high - low).div_ceil(2);
            if fits(middle) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        let request = window_request(
            task,
            command,
            kind,
            lines,
            &targets[start..low],
            &anchors,
            model,
        );
        // Keep the independent final-wire guard at the publication boundary.
        validate_request_budget(&request)?;
        batches.push(Batch {
            id: batches.len() + 1,
            target_numbers: targets[start..low]
                .iter()
                .map(|index| lines[*index].number)
                .collect(),
            request,
        });
        start = low;
    }
    Ok(batches)
}
