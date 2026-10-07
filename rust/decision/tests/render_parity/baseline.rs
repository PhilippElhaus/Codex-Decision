//! Frozen rendering oracle from commit 4b24210.
use codex_decision::{Action, LineDecision, SourceLine};

pub fn render(
    source: &str,
    lines: &[SourceLine],
    decisions: &[LineDecision],
    original_path: &str,
) -> String {
    let omitted = decisions
        .iter()
        .filter(|row| row.action == Action::Omit)
        .count();
    let mut output = format!(
        "[Codex Decision: {omitted} of {} lines omitted; full original: {original_path}]\n",
        lines.len()
    );
    let mut missing = 0;
    for (line, decision) in lines.iter().zip(decisions) {
        if decision.action == Action::Omit {
            missing += 1;
            continue;
        }
        if missing > 0 {
            output.push_str(&format!("[... {missing} source lines omitted ...]\n"));
            missing = 0;
        }
        output.push_str(line.source(source));
    }
    if missing > 0 {
        output.push_str(&format!("[... {missing} source lines omitted ...]\n"));
    }
    output
}
