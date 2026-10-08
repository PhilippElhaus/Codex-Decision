"use strict";

(() => {
  const reasons = {
    sensitive: ["Protected text or input", "A credential marker prevented sending this output or command to the provider."],
    unsafe_task_context: ["Task context unavailable", "The latest task could not be safely read. Earlier skips stay in the saved totals."],
    unsupported_result: ["Response format kept full", "Structured or mixed-media responses have no supported text projection."],
    unsupported_route: ["Tool format kept full", "This tool or command has no supported filtering route."],
    small: ["Short output", "The output was below the minimum evaluation size."],
    large: ["Output size limit", "The output exceeded the evaluation size limit."],
    exact_content: ["Exact source content", "Source and diffs stay complete."],
    exhaustive_task: ["Complete result requested", "The task requires the complete result."],
    structure_guard: ["Coupled structure", "Independent lines could not be validated."],
    no_eligible_lines: ["All lines protected", "No removable independent lines remained."],
    insufficient_savings: ["Too little potential saving", "Protected evidence and the original-file link left too little text to remove."],
    choice_kept_full_output: ["Classified and kept full", "A classification request ran, but the output did not pass the gate for line evaluation."],
    line_budget: ["Line limit", "The output exceeded the source-line limit."],
    tool_input_budget: ["Input size limit", "The tool input exceeded the evaluation size limit."],
    relevance_budget: ["Request size limit", "The complete targets could not fit the request limits."],
    structured_or_empty: ["Structured or empty output", "No independent text lines were available."],
    observe: ["Monitor mode", "Line judgments were recorded while full output was kept."],
    missing_task_context: ["Task context unavailable", "No safely read task was available for replacement."],
    unsupported_command: ["Command format kept full", "The command wrapper did not satisfy the replacement contract."],
    mcp_replacement_disabled: ["MCP replacement disabled", "Replacement for this MCP result is disabled."],
    unsupported_envelope: ["Response shape kept full", "The response envelope has no supported replacement shape."],
  };

  function node(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }

  function count(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString("en-US") : "—";
  }

  function reasonTable(section, title, counts, details = {}) {
    const entries = Object.entries(counts || {}).filter(([, value]) => Number.isSafeInteger(value) && value > 0)
      .sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b));
    if (!entries.length) return;
    section.appendChild(node("h2", "totals-heading", title));
    const table = node("table", "totals-reasons");
    const head = node("thead");
    const heading = node("tr");
    for (const label of ["Reason", "Outputs", "What happened"]) {
      const cell = node("th", "", label); cell.scope = "col"; heading.appendChild(cell);
    }
    head.appendChild(heading);
    const body = node("tbody");
    for (const [reason, value] of entries) {
      const [label, description] = reasons[reason] || [reason.replaceAll("_", " "), "The full output was kept."];
      const detail = reason === "sensitive" && Object.values(details).some(value => value > 0) ?
        `Protected markers in new records: output ${count(details.protected_output || 0)} · command ${count(details.protected_command || 0)} · other input ${count(details.protected_input || 0)}.` : description;
      const row = node("tr");
      row.dataset.reason = reason;
      row.append(node("td", "", label), node("td", "reason-count", count(value)), node("td", "reason-detail", detail));
      body.appendChild(row);
    }
    table.append(head, body); section.appendChild(table);
  }

  function render(activity) {
    const section = node("section", "totals-layout");
    section.setAttribute("aria-label", "Saved totals for the selected thread");
    const totals = activity?.totals || {};
    const metrics = node("dl", "totals-metrics");
    const values = [
      ["seen", "Observed outputs", totals.seen],
      ["skipped", "Skipped outputs", activity?.skipped],
      ["calls", "API requests", activity?.calls],
      ["completed", "Outputs evaluated", totals.completed],
      ["replaced", "Outputs filtered", totals.replaced],
      ["candidates", "Previews", totals.candidates],
      ["kept", "Evaluated and kept full", totals.kept],
      ["linesRelevanceJudged", "Lines judged", totals.linesRelevanceJudged],
      ["linesActuallyOmitted", "Lines removed", totals.linesActuallyOmitted],
      ["errors", "Recorded hook errors", totals.errors],
    ];
    for (const [name, label, value] of values) {
      const metric = node("div", "totals-metric");
      metric.dataset.metric = name;
      metric.append(node("dt", "", label), node("dd", "", count(value)));
      metrics.appendChild(metric);
    }
    section.appendChild(metrics);
    reasonTable(section, "Why outputs were skipped", totals.skipCounts, totals.skipDetails);
    reasonTable(section, "Why previews kept full output", totals.candidateReasons);
    return section;
  }

  window.DecisionTotals = { render };
})();
