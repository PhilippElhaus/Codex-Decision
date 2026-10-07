"use strict";

(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const BAR_FILL_MS = 900;
  const PERCENT_FADE_MS = 180;
  let currentId = null;
  let animation = 0;
  let cachedLayout = null;
  let cachedHeader = null;
  const cachedRows = [];
  let visibleRows = 0;

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

  function showEmpty(activity) {
    currentId = null;
    cachedLayout = null;
    cachedHeader = null;
    cachedRows.length = 0;
    visibleRows = 0;
    cancelAnimationFrame(animation);
    const empty = append(element("section", "empty"), element("span", "empty-label", "Decision"));
    if (activity && typeof activity.message === "string") {
      append(empty, element("p", "empty-status", activity.message),
        element("span", "empty-counts", `${activity.calls} API requests · ${activity.skipped} skipped outputs`));
    }
    app.replaceChildren(empty);
  }

  function batchTitle(decision) {
    const totals = decision.totals;
    return decision.status === "processing" ?
      `${totals.judged} / ${totals.seen} judged` : `${totals.kept} / ${totals.seen} kept`;
  }

  function batchStatus(decision) {
    return decision.status === "candidate" ? "Preview · full output kept" :
      decision.status === "replace" ? "Filtered" : decision.status === "processing" ? "Evaluating" : "Full output kept";
  }

  function renderBatchDecision(decision) {
    if (decision.id === currentId) {
      const title = app.querySelector(".batch-title");
      if (title && title.textContent !== batchTitle(decision)) title.textContent = batchTitle(decision);
      const status = app.querySelector(".batch-status");
      if (status && status.textContent !== batchStatus(decision)) status.textContent = batchStatus(decision);
      return;
    }
    currentId = decision.id;
    cancelAnimationFrame(animation);
    if (!cachedLayout) {
      const title = element("strong", "batch-title");
      const status = element("span", "batch-status");
      const header = append(element("header", "batch-header"), title, status);
      const list = element("div", "batch-list");
      cachedLayout = append(element("div", "batch-layout"), header, list);
      cachedHeader = { title, status, list };
    }
    const layout = cachedLayout;
    const { title, status, list } = cachedHeader;
    if (title.textContent !== batchTitle(decision)) title.textContent = batchTitle(decision);
    if (status.textContent !== batchStatus(decision)) status.textContent = batchStatus(decision);
    const fills = [];
    const values = [];
    list.setAttribute("role", "list");
    list.setAttribute("aria-label", "Lines in the latest Decision result");
    list.setAttribute("aria-live", "off");
    let index = 0;
    for (const row of decision.rows) {
      const cached = cachedRows[index];
      const score = row.retention_index;
      const unscored = score == null;
      const reason = (row.protected_reason || row.reason).replaceAll("_", " ");
      const protection = row.reason === "budget_unjudged" ? "Awaiting judgment; kept in full" : `Protected: ${reason}`;
      const item = cached?.item || element("div");
      item.className = `batch-row ${row.action}`;
      if (unscored) item.classList.add("unscored");
      item.setAttribute("role", "listitem");
      item.setAttribute("aria-label", `Line ${row.line}: ${row.action}. ${unscored ? `${protection}. No Decision score.` : `${decision.version >= 4 ? "Task relevance" : "Retention index"} ${score.toFixed(2)}.`}`);
      item.title = unscored ? `${row.excerpt}\nLine ${row.line} · ${protection} · no Decision relevance score` : row.can_omit === null ? `${row.excerpt}\nLine ${row.line} · ${reason} · task relevance ${row.task_relevant.toFixed(2)}` : `${row.excerpt}\nLine ${row.line} · ${reason} · retention index ${score.toFixed(2)} (display only) · Decision can omit ${row.can_omit?.toFixed(2) ?? "—"} · exact text ${row.exact_needed?.toFixed(2) ?? "—"}${row.task_relevant === null ? "" : ` · task relevance ${row.task_relevant.toFixed(2)}`}`;
      const track = cached?.track || element("div", "batch-bar-track");
      track.setAttribute("aria-hidden", "true");
      const fill = cached?.fill || element("span", "batch-bar-fill", "█".repeat(10));
      fill.style.width = "0%";
      if (!unscored) fills.push({ node: fill, score });
      if (!cached) append(track, element("span", "batch-bar-empty", "·".repeat(10)), fill);
      const value = cached?.value || element("span", "batch-value");
      if (value.textContent !== (unscored ? "—" : `${Math.round(score * 100)}%`)) value.textContent = unscored ? "—" : `${Math.round(score * 100)}%`;
      value.style.opacity = unscored ? "1" : "0";
      value.title = unscored ? `${protection}. No Decision relevance score.` : `${decision.version >= 4 ? "Task relevance" : "Retention index (display only)"}: ${score.toPrecision(4)}. ${decision.version < 4 ? reason : row.action === "omit" ? "At or below the omission cutoff." : row.reason === "task_relevant" ? "Above the omission cutoff." : reason}`;
      if (!unscored) values.push(value);
      const action = cached?.action || element("span", "batch-action");
      if (action.textContent !== row.action) action.textContent = row.action;
      action.title = unscored ? protection : reason;
      const number = cached?.number || element("span", "batch-line-number");
      const excerpt = cached?.excerpt || element("span", "batch-excerpt");
      if (number.textContent !== String(row.line)) number.textContent = String(row.line);
      if (excerpt.textContent !== (row.excerpt || "(empty line)")) excerpt.textContent = row.excerpt || "(empty line)";
      if (!cached) append(item, number, excerpt, action, track, value);
      if (item.parentNode !== list) list.appendChild(item);
      if (!cached) cachedRows[index] = { item, number, excerpt, action, track, fill, value };
      index += 1;
    }
    for (let i = index; i < visibleRows; i++) cachedRows[i].item.remove();
    visibleRows = index;
    if (layout.parentNode !== app) app.replaceChildren(layout);
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
    else showEmpty(event.data.activity);
  });
  showEmpty();
  vscode.postMessage({ type: "ready" });
})();
