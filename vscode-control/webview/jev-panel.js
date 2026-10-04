"use strict";

(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const BAR_FILL_MS = 900;
  const PERCENT_FADE_MS = 180;
  let currentDecision = "";
  let currentId = null;
  let animation = 0;

  function element(tag, className, label) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (label !== undefined) node.textContent = label;
    return node;
  }

  function append(parent, ...children) {
    for (const child of children) parent.appendChild(child);
    return parent;
  }

  function showEmpty() {
    currentDecision = "";
    currentId = null;
    cancelAnimationFrame(animation);
    app.replaceChildren(append(element("section", "empty"),
      element("span", "empty-label", "Jev")));
  }

  function batchTitle(decision) {
    const totals = decision.totals;
    return decision.status === "processing" ?
      `${totals.judged} / ${totals.seen} judged` : `${totals.kept} / ${totals.seen} kept`;
  }

  function renderBatchDecision(decision) {
    const serialized = JSON.stringify(decision);
    if (serialized === currentDecision) return;
    if (decision.id === currentId) {
      currentDecision = serialized;
      const title = app.querySelector(".batch-title");
      if (title) title.textContent = batchTitle(decision);
      return;
    }
    currentDecision = serialized;
    currentId = decision.id;
    cancelAnimationFrame(animation);
    const layout = element("div", "batch-layout");
    const header = element("header", "batch-header");
    append(header, element("strong", "batch-title", batchTitle(decision)));
    const list = element("div", "batch-list");
    const fills = [];
    const values = [];
    list.setAttribute("role", "list");
    list.setAttribute("aria-label", "Judged lines in the latest Jev batch");
    list.setAttribute("aria-live", "off");
    for (const row of decision.rows) {
      const score = row.retention_index;
      const item = element("div", `batch-row ${row.action}`);
      item.setAttribute("role", "listitem");
      item.setAttribute("aria-label", `Line ${row.line}: ${row.action}. ${decision.version === 4 ? "Task relevance" : "Retention index"} ${score.toFixed(2)}.`);
      item.title = row.can_omit === null ? `${row.excerpt}\nLine ${row.line} · ${row.reason.replaceAll("_", " ")} · task relevance ${row.task_relevant.toFixed(2)}` : `${row.excerpt}\nLine ${row.line} · ${row.reason.replaceAll("_", " ")} · retention index ${score.toFixed(2)} (display only) · Jev can omit ${row.can_omit?.toFixed(2) ?? "—"} · exact text ${row.exact_needed?.toFixed(2) ?? "—"}${row.task_relevant === null ? "" : ` · task relevance ${row.task_relevant.toFixed(2)}`}`;
      const track = element("div", "batch-bar-track");
      track.setAttribute("aria-hidden", "true");
      const fill = element("span", "batch-bar-fill", "█".repeat(80));
      // A single visible block marks near-zero cut scores without changing the label.
      fills.push({ node: fill, score: row.action === "omit" ? Math.max(score, .04) : score });
      append(track, element("span", "batch-bar-empty", ".".repeat(80)), fill);
      const value = element("span", "batch-value", score.toFixed(2));
      values.push(value);
      const action = element("span", "batch-action", row.action);
      const explanation = { task_relevant: "task", exact_text: "exact",
        representative: "sample", last_line: "final" }[row.reason];
      if (row.action === "keep" && explanation) action.appendChild(element("small", "batch-reason", ` · ${explanation}`));
      append(item,
        element("span", "batch-line-number", String(row.line)),
        element("span", "batch-excerpt", row.excerpt || "(empty line)"),
        action,
        track,
        value);
      list.appendChild(item);
    }
    append(layout, header, list);
    app.replaceChildren(layout);
    // Start the clock on the first frame, after the zero-width state can paint.
    // Do not turn this explicit user-requested animation off for reduced motion.
    let started = null;
    let filled = false;
    function frame(now) {
      if (started === null) started = now;
      const elapsed = Math.max(0, now - started);
      const linear = Math.min(1, elapsed / BAR_FILL_MS);
      const progress = 1 - (1 - linear) ** 3;
      if (!filled) {
        for (const fill of fills) fill.node.style.width = `${(fill.score * progress * 100).toFixed(2)}%`;
        filled = linear === 1;
      }
      if (elapsed >= BAR_FILL_MS) {
        const opacity = Math.min(1, (elapsed - BAR_FILL_MS) / PERCENT_FADE_MS);
        for (const value of values) value.style.opacity = String(opacity);
      }
      if (elapsed < BAR_FILL_MS + PERCENT_FADE_MS) animation = requestAnimationFrame(frame);
    }
    animation = requestAnimationFrame(frame);
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type !== "decision") return;
    if (event.data.decision) renderBatchDecision(event.data.decision);
    else showEmpty();
  });
  showEmpty();
  vscode.postMessage({ type: "ready" });
})();
