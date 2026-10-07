//! Exact prefix costs replace temporary requests during the batch search.
use super::*;
use crate::semantic::budget::{encoded_size, question_sizes, state_size};

pub(super) struct WindowSizes {
    context: Vec<usize>,
    target_context: Vec<usize>,
    target_full: Vec<usize>,
    question_total: Vec<usize>,
    question_longest: Vec<usize>,
    base_state: usize,
    base_total: usize,
}

fn push(prefix: &mut Vec<usize>, size: usize) {
    prefix.push(prefix.last().copied().unwrap_or(0).saturating_add(size));
}

impl WindowSizes {
    pub(super) fn new(
        task: &str,
        command: &str,
        kind: &str,
        lines: &[SourceLine],
        targets: &[usize],
        model: &str,
    ) -> Result<Self, String> {
        let base = window::base_request(task, command, kind, lines.len(), model);
        let mut sizes = Self {
            context: Vec::with_capacity(lines.len() + 1),
            target_context: Vec::with_capacity(targets.len() + 1),
            target_full: Vec::with_capacity(targets.len() + 1),
            question_total: Vec::with_capacity(targets.len() + 1),
            question_longest: Vec::with_capacity(targets.len()),
            base_state: state_size(model, &base["state"])?,
            base_total: if model == "gpt-6-luna" {
                encoded_size(&crate::provider::wire_request(&base)?)?
            } else {
                encoded_size(&base)?
            },
        };
        for prefix in [
            &mut sizes.context,
            &mut sizes.target_context,
            &mut sizes.target_full,
            &mut sizes.question_total,
        ] {
            prefix.push(0);
        }
        let row_size = |row: &window::SourceRow<'_>| -> Result<usize, String> {
            // These row bytes are fragments inside the shared state. OpenAI
            // escapes them inside input; its two outer quotes are already in base.
            Ok(state_size(model, row)? - if model == "gpt-6-luna" { 2 } else { 0 })
        };
        let mut target = 0;
        let mut costs = [None; usize::MAX.ilog10() as usize + 1];
        for (index, line) in lines.iter().enumerate() {
            let context = row_size(&window::source_row(line, false))?;
            push(&mut sizes.context, context);
            if targets.get(target) == Some(&index) {
                push(&mut sizes.target_context, context);
                push(
                    &mut sizes.target_full,
                    row_size(&window::source_row(line, true))?,
                );
                // Only the decimal source number varies in a question. Equal
                // digit widths have equal encoded costs, measured once by the
                // same question builder used for the final request.
                let digits = line.number.max(1).ilog10() as usize;
                let (longest, total) = if let Some(cost) = costs[digits] {
                    cost
                } else {
                    let (name, question) = window::question(line.number);
                    let cost = question_sizes(model, &name, &question)?;
                    costs[digits] = Some(cost);
                    cost
                };
                sizes.question_longest.push(longest);
                push(&mut sizes.question_total, total);
                target += 1;
            }
        }
        Ok(sizes)
    }

    pub(super) fn fits(
        &self,
        start: usize,
        end: usize,
        targets: &[usize],
        anchors: &BTreeSet<usize>,
    ) -> bool {
        let budget = self.budget(start, end, targets, anchors);
        budget.state_longest_question_bound <= DECISION_STATE_QUESTION_TOKENS
            && budget.whole_request_bound <= DECISION_REQUEST_TOKENS
    }

    fn budget(
        &self,
        start: usize,
        end: usize,
        targets: &[usize],
        anchors: &BTreeSet<usize>,
    ) -> RequestBudget {
        let first = targets[start].saturating_sub(2);
        let last = (targets[end - 1] + 3).min(self.context.len() - 1);
        let mut rows = self.context[last] - self.context[first];
        let mut count = last - first;
        for index in anchors.range(..first).chain(anchors.range(last..)) {
            rows += self.context[index + 1] - self.context[*index];
            count += 1;
        }
        rows -= self.target_context[end] - self.target_context[start];
        rows += self.target_full[end] - self.target_full[start];
        rows += count - 1; // Commas between included rows; brackets are in base.
        rows += (first + 1).ilog10() as usize + last.ilog10() as usize;
        let longest = self.question_longest[start..end]
            .iter()
            .copied()
            .max()
            .unwrap();
        let questions = self.question_total[end] - self.question_total[start] + end - start - 1;
        RequestBudget {
            state_longest_question_bound: self.base_state + rows + longest + TOKEN_HEADROOM,
            whole_request_bound: self.base_total + rows + questions + TOKEN_HEADROOM,
        }
    }
}

#[cfg(test)]
#[path = "sizes_tests.rs"]
mod tests;
