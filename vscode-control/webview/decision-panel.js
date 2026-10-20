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
  let currentActivity = null;
  let latestDecision = null;
  let rawPreferencePending = false;
  let rawPreferenceError = "";
  let rawContentKey = "";
  let panelMode = vscode.getState?.()?.panelMode === "totals" ? "totals" : "latest";

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
    currentActivity = activity || null;
    const { header } = makeHeader("Decision");
    const empty = element("section", "empty");
    if (activity && typeof activity.message === "string") {
      append(empty, element("p", "empty-status", activity.message));
    }
    app.replaceChildren(header, empty);
    updateActivity(currentActivity);
  }

  function makeHeader(label) {
    const title = element("strong", "batch-title", label);
    const counts = element("span", "activity-counts");
    const rawToggle = element("input");
    rawToggle.type = "checkbox";
    rawToggle.id = "raw-skips-toggle";
    const rawLabel = append(element("label", "raw-skips-toggle"), rawToggle,
      element("span", "", "Show raw skipped outputs"));
    rawLabel.title = "Capture and inspect future skipped tool calls locally for this thread. Filtering stays active.";
    const status = element("span", "batch-status");
    const meta = append(element("div", "batch-meta"), counts, rawLabel, status);
    const tabs = element("nav", "panel-tabs");
    tabs.setAttribute("aria-label", "Decision view");
    for (const [mode, name] of [["latest", "Latest"], ["totals", "Totals"]]) {
      const button = element("button", "panel-tab", name);
      button.type = "button";
      button.dataset.panelMode = mode;
      button.setAttribute("aria-pressed", String(panelMode === mode));
      tabs.appendChild(button);
    }
    const heading = append(element("div", "batch-heading"), tabs, title);
    const activity = element("div", "activity-status");
    activity.hidden = true;
    activity.setAttribute("aria-label", "Latest hook activity");
    return { header: append(element("header", "batch-header"), heading, meta, activity), title, status, counts };
  }

  function updateActivity(activity) {
    currentActivity = activity;
    const counts = app.querySelector(".activity-counts");
    if (!counts) return;
    const calls = activity?.calls ?? "—";
    const skipped = activity?.skipped ?? "—";
    const partial = activity?.totals?.partialCounters || [];
    const callLabel = Number.isSafeInteger(calls) && partial.includes("calls") ? `≥${calls}` : calls;
    const skipLabel = Number.isSafeInteger(skipped) && partial.includes("skipped") ? `≥${skipped}` : skipped;
    counts.textContent = `${callLabel} API request${calls === 1 ? "" : "s"} · ${skipLabel} skipped output${skipped === 1 ? "" : "s"}`;
    counts.title = `${activity?.message || "Activity for the selected thread"} API requests are recorded attempts; they do not establish provider receipt. ≥ marks an incomplete historical baseline.`;
    const summary = app.querySelector(".activity-status");
    const message = activity?.hookActivity?.message || activity?.message;
    if (summary) {
      summary.hidden = typeof message !== "string" || !message || (!latestDecision && panelMode !== "totals");
      summary.textContent = summary.hidden ? "" : `Latest hook: ${message}`;
    }
    updateRawSkips();
  }

  function payloadText(json) {
    // Render JSON tokens directly so large integer values remain exact.
    if (json.startsWith('"')) {
      try { return JSON.parse(json); } catch { /* Keep malformed text inert. */ }
    }
    return json;
  }

  function updateRawSkips() {
    const raw = currentActivity?.rawSkips;
    const toggle = app.querySelector("#raw-skips-toggle");
    if (toggle) {
      toggle.checked = raw?.enabled === true;
      toggle.disabled = rawPreferencePending || !currentActivity || currentActivity.unavailable;
    }
    const existing = app.querySelector(".raw-skips");
    if (!currentActivity || currentActivity.unavailable) { existing?.remove(); return; }
    const entries = raw?.entries || [];
    const key = JSON.stringify([raw?.enabled, raw?.unavailable, entries.map(entry => entry.id),
      currentActivity.skipped, rawPreferenceError]);
    if (existing && key === rawContentKey) return;
    rawContentKey = key;
    const section = element("section", "raw-skips");
    section.setAttribute("aria-label", "Raw skipped tool calls");
    if (rawPreferenceError) append(section, element("p", "raw-skips-note raw-skips-error", rawPreferenceError));
    if (raw?.unavailable) {
      append(section, element("p", "raw-skips-note", "Saved raw skipped outputs could not be read for this thread."));
    } else if (!raw?.enabled) {
      append(section, element("p", "raw-skips-note", "Enable to capture future skips locally for this thread. Earlier raw payloads are unavailable."));
    } else {
      append(section, element("h2", "raw-skips-heading", "Skipped tool calls"),
        element("p", "raw-skips-note", "Stored locally for this thread. Raw data can contain sensitive text. Filtering stays active."));
      if (!entries.length) append(section, element("p", "raw-skips-note", "Waiting for future skips. Earlier raw payloads are unavailable."));
      else {
        append(section, element("p", "raw-skips-note", "Recent captures only: up to 20 calls and 4 MiB. Payloads above 512 KiB are unavailable."));
        for (const [index, entry] of [...entries].reverse().entries()) {
          const item = element("details", "raw-skip-entry");
          item.open = index === 0;
          const summary = element("summary", "raw-skip-summary");
          const time = element("time", "raw-skip-time", new Date(entry.at).toLocaleTimeString());
          time.dateTime = entry.at;
          time.title = entry.at;
          append(summary, time, element("strong", "raw-skip-tool", entry.tool_name),
            element("span", "raw-skip-reason", (entry.detail || entry.reason).replaceAll("_", " ")));
          append(item, summary);
          if (entry.tool_use_id) append(item, element("p", "raw-skips-note raw-skip-id", `Tool call: ${entry.tool_use_id}`));
          if (!entry.payload) append(item, element("p", "raw-skips-note", "Raw payload unavailable: this tool call exceeded the capture size limit."));
          else {
            append(item, element("h3", "raw-payload-heading", "Tool input"),
              element("pre", "raw-payload", payloadText(entry.payload.tool_input_json)),
              element("h3", "raw-payload-heading", "Original tool response"),
              element("pre", "raw-payload", payloadText(entry.payload.tool_response_json)));
          }
          section.appendChild(item);
        }
        if (!Number.isSafeInteger(currentActivity.skipped) || currentActivity.skipped > entries.length) {
          append(section, element("p", "raw-skips-note", "Raw payloads from before capture or outside this recent history are unavailable."));
        }
      }
    }
    if (existing) existing.replaceWith(section);
    else app.appendChild(section);
  }

  function batchTitle(decision) {
    const totals = decision.totals;
    if (decision.status === "processing") return `${totals.judged} / ${totals.seen} judged`;
    if (decision.status === "candidate") return `${totals.omitted} / ${totals.seen} proposed removals`;
    return `${decision.status === "replace" ? totals.omitted : 0} / ${totals.seen} removed`;
  }

  function batchStatus(decision) {
    return decision.status === "candidate" ? "Preview · full output kept" :
      decision.status === "replace" ? "Hook replacement · delivery unverified" : decision.status === "processing" ? "Evaluating" : "Full output kept";
  }

  function showTotals() {
    currentId = null;
    cancelAnimationFrame(animation);
    const { header, status } = makeHeader(currentActivity ? "This thread" : "Decision");
    status.textContent = currentActivity?.unavailable ? "Saved activity unavailable" :
      currentActivity?.totals?.replaced > 0 ? "Hook totals · delivery unverified" :
      currentActivity ? "Saved totals" : "No thread selected";
    app.replaceChildren(header, window.DecisionTotals.render(currentActivity));
    updateActivity(currentActivity);
  }

  function showSelectedView() {
    if (panelMode === "totals") showTotals();
    else if (latestDecision) renderBatchDecision(latestDecision);
    else showEmpty(currentActivity);
    updateActivity(currentActivity);
    for (const button of app.querySelectorAll(".panel-tab")) {
      button.setAttribute("aria-pressed", String(button.dataset.panelMode === panelMode));
    }
  }

  app.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-panel-mode]");
    if (!button || button.dataset.panelMode === panelMode) return;
    panelMode = button.dataset.panelMode;
    vscode.setState?.({ panelMode });
    showSelectedView();
  });

  app.addEventListener("change", (event) => {
    if (event.target.id !== "raw-skips-toggle" || rawPreferencePending) return;
    rawPreferencePending = true;
    rawPreferenceError = "";
    event.target.disabled = true;
    vscode.postMessage({ type: "set-raw-skips", enabled: event.target.checked,
      scope: currentActivity?.rawSkips?.scope });
  });

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
      const { title, status, header } = makeHeader();
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
    if (event.data?.type === "raw-skips-error") {
      rawPreferencePending = false;
      rawPreferenceError = event.data.message;
      updateRawSkips();
      return;
    }
    if (event.data?.type === "activity") {
      rawPreferencePending = false;
      updateActivity(event.data.activity);
      if (panelMode === "totals") { showTotals(); return; }
      const emptyStatus = app.querySelector(".empty-status");
      if (emptyStatus && event.data.activity?.message) emptyStatus.textContent = event.data.activity.message;
      return;
    }
    if (event.data?.type !== "decision") return;
    rawPreferencePending = false;
    latestDecision = event.data.decision || null;
    currentActivity = event.data.activity ?? (latestDecision ? currentActivity : null);
    showSelectedView();
  });
  showSelectedView();
  vscode.postMessage({ type: "ready" });
})();
