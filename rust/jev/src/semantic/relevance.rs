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
    let mut decisions: Vec<_> = lines
        .iter()
        .map(|line| {
            let p = probabilities.get(&line.number).copied();
            let (action, reason) = if !line.eligible || line.protected_reason.is_some() {
                (Action::KeepUnjudged, "protected")
            } else if let Some(p) = p {
                if p <= f64::from(cutoff) / 100.0 {
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
                batch_id: p.map(|_| 1),
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
    let values = probabilities
        .iter()
        .map(|(number, (p, _))| (*number, *p))
        .collect();
    let mut decisions = apply_relevance(lines, &values, cutoff);
    for row in &mut decisions {
        row.batch_id = probabilities.get(&row.number).map(|(_, batch)| *batch);
    }
    decisions
}
