use super::*;

pub fn relevance_answers(batch: &Batch, response: &Value) -> Result<BTreeMap<usize, f64>, String> {
    validate_response(response)?;
    let answers = response["answers"]
        .as_object()
        .ok_or("missing Jev answers")?;
    if answers.len() != batch.target_numbers.len() {
        return Err("relevance answer ids do not match".into());
    }
    let mut result = BTreeMap::new();
    for number in &batch.target_numbers {
        let answer = answers
            .get(&format!("line_{number}"))
            .and_then(Value::as_object)
            .ok_or("missing line relevance")?;
        if answer.len() != 2 || answer.get("type").and_then(Value::as_str) != Some("noul") {
            return Err("invalid relevance answer type".into());
        }
        result.insert(
            *number,
            probability(answer.get("noul").ok_or("missing line probability")?)?,
        );
    }
    Ok(result)
}

pub fn apply_relevance(
    lines: &[SourceLine],
    probabilities: &BTreeMap<usize, f64>,
    cutoff: u8,
) -> Vec<LineDecision> {
    decisions_with_relevance(lines, cutoff, |number| {
        probabilities.get(&number).map(|p| (*p, 1))
    })
}

fn decisions_with_relevance(
    lines: &[SourceLine],
    cutoff: u8,
    lookup: impl Fn(usize) -> Option<(f64, usize)>,
) -> Vec<LineDecision> {
    let cutoff = f64::from(cutoff) / 100.0;
    let mut decisions: Vec<_> = lines
        .iter()
        .map(|line| {
            let judged = lookup(line.number);
            let p = judged.map(|(p, _)| p);
            let (action, reason) = if !line.eligible || line.protected_reason.is_some() {
                (Action::KeepUnjudged, "protected")
            } else if let Some(p) = p {
                if p <= cutoff {
                    (Action::Omit, "irrelevant")
                } else {
                    (Action::Keep, "task_relevant")
                }
            } else {
                (Action::KeepUnjudged, "budget_unjudged")
            };
            LineDecision {
                number: line.number,
                p_can_omit: None,
                p_exact_needed: None,
                p_task_relevant: p,
                action,
                reason: reason.into(),
                protected_reason: line.protected_reason.clone(),
                batch_id: judged.map(|(_, batch)| batch),
            }
        })
        .collect();
    crate::preserve_representatives(lines, &mut decisions);
    decisions
}

pub fn apply_relevance_batches(
    lines: &[SourceLine],
    probabilities: &BTreeMap<usize, (f64, usize)>,
    cutoff: u8,
) -> Vec<LineDecision> {
    decisions_with_relevance(lines, cutoff, |number| probabilities.get(&number).copied())
}
