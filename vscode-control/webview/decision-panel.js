"use strict";

(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const BAR_FILL_MS = 900;
  const PERCENT_FADE_MS = 180;
  const RAW_DISPLAY_MS = 3000;
  const RAW_FLUSH_COUNT = 5;
  const RAW_QUEUE_COUNT = 20;
  const RAW_QUEUE_BYTES = 4 * 1024 * 1024;
  let currentId = null;
  let animation = 0;
  let cachedLayout = null;
  let cachedHeader = null;
  const cachedRows = [];
  let visibleRows = 0;
  let currentActivity = null;
  let presentedActivity = null;
  let latestDecision = null;
  let receivedDecision = null;
  let rawPreferencePending = false;
  let rawPreferenceDesired = false;
  let rawPreferenceError = "";
  let rawContentKey = "";
  let presentationScope;
  let presentationStarted = false;
  let receivedRawIds = new Set();
  let presentedRawId = null;
  let expandedRawIds = new Set();
  let rawHoldUntil = 0;
  let rawTimer = 0;
  let presentationRevision = 0;
  let inspectionPaused = false;
  const expandedStates = new Map();
  const resultQueue = [];
  const rawEntries = new Map();
  let expiredRawCount = 0;
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
      element("span", "", "Show skipped output"));
    const helpButton = element("button", "raw-skips-help", "ⓘ");
    helpButton.type = "button";
    helpButton.setAttribute("aria-label", "About skipped output");
    helpButton.setAttribute("aria-describedby", "raw-skips-tooltip");
    const help = element("span", "raw-skips-tooltip",
      "Capture future skipped output on this computer. Earlier data is unavailable. May contain private text. " +
      "Filtering stays on. Applies to this thread. With no thread, sets the default. " +
      "Store and waiting queue: 20 calls or 4 MiB. Payload limit: 512 KiB. Select an entry to pause updates.");
    help.id = "raw-skips-tooltip";
    help.setAttribute("role", "tooltip");
    const helpWrap = append(element("span", "raw-skips-help-wrap"), helpButton, help);
    const showHelp = () => {
      helpWrap.classList.remove("help-dismissed");
      const box = helpButton.getBoundingClientRect();
      const width = Math.min(290, innerWidth - 32);
      help.style.left = `${Math.max(16, Math.min(box.left, innerWidth - width - 16))}px`;
      help.style.top = `${Math.max(8, Math.min(box.bottom + 5, innerHeight - help.offsetHeight - 8))}px`;
    };
    helpWrap.addEventListener("mouseenter", showHelp);
    helpWrap.addEventListener("focusin", showHelp);
    helpWrap.addEventListener("keydown", event => {
      if (event.key === "Escape") helpWrap.classList.add("help-dismissed");
    });
    const rawControls = append(element("div", "raw-skips-controls"), rawLabel, helpWrap, element("span", "raw-queue-count"));
    const resume = element("button", "raw-resume", "Resume live");
    resume.type = "button";
    resume.hidden = true;
    append(rawControls, resume);
    const status = element("span", "batch-status");
    const meta = append(element("div", "batch-meta"), counts, rawControls, status);
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
    const message = presentedActivity?.hookActivity?.message || presentedActivity?.message;
    if (summary) {
      summary.hidden = typeof message !== "string" || !message || (!latestDecision && panelMode !== "totals");
      summary.textContent = summary.hidden ? "" : message;
      summary.title = presentedActivity?.hookActivity?.detail || "";
    }
    let emptyStatus = app.querySelector(".empty-status");
    if (!emptyStatus && typeof message === "string" && message && app.querySelector(".empty")) {
      emptyStatus = element("p", "empty-status");
      app.querySelector(".empty").appendChild(emptyStatus);
    }
    if (emptyStatus) {
      emptyStatus.textContent = message || "";
      emptyStatus.title = presentedActivity?.hookActivity?.detail || "";
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
    const raw = presentedActivity?.rawSkips;
    const toggle = app.querySelector("#raw-skips-toggle");
    if (toggle) {
      toggle.checked = rawPreferencePending ? rawPreferenceDesired : currentActivity?.rawSkips?.enabled === true;
      toggle.disabled = false;
    }
    const queued = app.querySelector(".raw-queue-count");
    if (queued) {
      const count = resultQueue.filter(item => item.rawId).length;
      queued.textContent = [!inspectionPaused && count ? `${count} queued` : "",
        expiredRawCount ? `${expiredRawCount} expired` : ""].filter(Boolean).join(" · ");
      queued.title = expiredRawCount ? "Older queued captures exceeded local retention. Current inspection is unchanged." : "";
    }
    const resume = app.querySelector(".raw-resume");
    if (resume) {
      resume.hidden = !inspectionPaused;
      resume.textContent = resultQueue.length ? `Resume live (${resultQueue.length})` : "Resume live";
    }
    if (inspectionPaused) return;
    const existing = app.querySelector(".raw-skips");
    if (!presentedActivity || presentedActivity.unavailable) { existing?.remove(); return; }
    const entries = raw?.entries || [];
    const key = JSON.stringify([raw?.enabled, raw?.unavailable, entries.map(entry => entry.id),
      presentedRawId, [...expandedRawIds], rawPreferenceError]);
    if (existing && key === rawContentKey) return;
    rawContentKey = key;
    const section = element("section", "raw-skips");
    section.setAttribute("aria-label", "Raw skipped tool calls");
    if (rawPreferenceError) append(section, element("p", "raw-skips-note raw-skips-error", rawPreferenceError));
    if (raw?.unavailable) {
      append(section, element("p", "raw-skips-note", "Saved skipped output is unavailable."));
    } else if (raw?.enabled && entries.length) {
        for (const [index, entry] of [...entries].reverse().entries()) {
          const item = element("details", "raw-skip-entry");
          item.dataset.rawId = entry.id;
          item.open = expandedStates.has(entry.id) ? expandedStates.get(entry.id) :
            expandedRawIds.has(entry.id) || (presentedRawId ? entry.id === presentedRawId : index === 0);
          item.dataset.presentedOpen = String(item.open);
          const summary = element("summary", "raw-skip-summary");
          const time = element("time", "raw-skip-time", new Date(entry.at).toLocaleTimeString());
          time.dateTime = entry.at;
          time.title = entry.at;
          append(summary, time, element("strong", "raw-skip-tool", entry.tool_name),
            element("span", "raw-skip-reason", (entry.detail || entry.reason).replaceAll("_", " ")));
          append(item, summary);
          if (entry.tool_use_id) append(item, element("p", "raw-skips-note raw-skip-id", `Tool call: ${entry.tool_use_id}`));
          if (!entry.payload) append(item, element("p", "raw-skips-note", "Output unavailable. Capture size limit exceeded."));
          else {
            append(item, element("h3", "raw-payload-heading", "Tool input"),
              element("pre", "raw-payload", payloadText(entry.payload.tool_input_json)),
              element("h3", "raw-payload-heading", "Tool output"),
              element("pre", "raw-payload", payloadText(entry.payload.tool_response_json)));
          }
          section.appendChild(item);
        }
    }
    if (!section.childNodes.length) { existing?.remove(); return; }
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
    return decision.status === "candidate" ? "Preview" :
      decision.status === "replace" ? "Filtered" : decision.status === "processing" ? "Evaluating" : "Full output kept";
  }

  function batchStatusDetail(decision) {
    return decision.status === "candidate" ? "Preview only. Full output kept." :
      decision.status === "replace" ? "The hook shortened the output. Delivery to Codex is not verified." : "";
  }

  function showTotals() {
    currentId = null;
    cancelAnimationFrame(animation);
    const { header, status } = makeHeader(currentActivity ? "This thread" : "Decision");
    status.textContent = currentActivity?.unavailable ? "Saved activity unavailable" :
      currentActivity ? "Saved totals" : "No thread selected";
    status.title = currentActivity?.totals?.replaced > 0 ? "Delivery of shortened output to Codex is not verified." : "";
    if (status.title) status.tabIndex = 0;
    app.replaceChildren(header, window.DecisionTotals.render(currentActivity));
    updateActivity(currentActivity);
  }

  function showSelectedView() {
    const inspectedRaw = inspectionPaused ? app.querySelector(".raw-skips") : null;
    if (panelMode === "totals") showTotals();
    else if (latestDecision) renderBatchDecision(latestDecision);
    else showEmpty(presentedActivity);
    updateActivity(currentActivity);
    if (inspectedRaw && inspectedRaw.parentNode !== app) app.appendChild(inspectedRaw);
    for (const button of app.querySelectorAll(".panel-tab")) {
      button.setAttribute("aria-pressed", String(button.dataset.panelMode === panelMode));
    }
  }

  app.addEventListener("click", (event) => {
    if (event.target.closest(".raw-resume")) {
      inspectionPaused = false;
      if (!resultQueue.length && Date.now() >= rawHoldUntil) {
        presentedActivity = currentActivity;
        showSelectedView();
      }
      drainResults();
      return;
    }
    const button = event.target.closest("button[data-panel-mode]");
    if (!button || button.dataset.panelMode === panelMode) return;
    panelMode = button.dataset.panelMode;
    vscode.setState?.({ panelMode });
    showSelectedView();
  });

  function pauseInspection() {
    if (inspectionPaused) return;
    inspectionPaused = true;
    clearTimeout(rawTimer);
    rawTimer = 0;
    updateRawSkips();
  }

  for (const name of ["pointerdown", "focusin", "wheel"]) {
    app.addEventListener(name, event => {
      if (event.target.closest(".raw-skip-entry, .batch-row")) pauseInspection();
    }, { passive: true });
  }
  app.addEventListener("toggle", event => {
    const item = event.target;
    if (!item.matches(".raw-skip-entry") || item.dataset.presentedOpen === String(item.open)) return;
    expandedStates.set(item.dataset.rawId, item.open);
    item.dataset.presentedOpen = String(item.open);
    pauseInspection();
  }, true);
  document.addEventListener("selectionchange", () => {
    const selection = document.getSelection();
    const node = selection?.anchorNode;
    const target = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (selection && !selection.isCollapsed && target?.closest(".raw-skips, .batch-list")) pauseInspection();
  });

  app.addEventListener("change", (event) => {
    if (event.target.id !== "raw-skips-toggle") return;
    rawPreferencePending = true;
    rawPreferenceDesired = event.target.checked;
    rawPreferenceError = "";
    vscode.postMessage({ type: "set-raw-skips", enabled: event.target.checked,
      scope: currentActivity?.rawSkips?.scope });
  });

  function renderBatchDecision(decision) {
    if (decision.id === currentId) {
      const title = app.querySelector(".batch-title");
      if (title && title.textContent !== batchTitle(decision)) title.textContent = batchTitle(decision);
      const status = app.querySelector(".batch-status");
      if (status && status.textContent !== batchStatus(decision)) status.textContent = batchStatus(decision);
      if (status) status.title = batchStatusDetail(decision);
      if (status?.title) status.tabIndex = 0;
      else status?.removeAttribute("tabindex");
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
    status.title = batchStatusDetail(decision);
    if (status.title) status.tabIndex = 0;
    else status.removeAttribute("tabindex");
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

  function clearPresentationQueue() {
    clearTimeout(rawTimer);
    rawTimer = 0;
    rawHoldUntil = 0;
    presentationRevision += 1;
    resultQueue.length = 0;
    receivedRawIds = new Set();
    presentedRawId = null;
    expandedRawIds = new Set();
    inspectionPaused = false;
    expandedStates.clear();
    rawEntries.clear();
    expiredRawCount = 0;
    presentedActivity = null;
  }

  function present(snapshot) {
    if (snapshot.activity?.rawSkips?.enabled && !snapshot.activity.rawSkips.unavailable) {
      const history = new Map();
      for (const entry of presentedActivity?.rawSkips?.entries || []) history.set(entry.id, entry);
      for (const entry of snapshot.activity.rawSkips.entries || []) history.set(entry.id, entry);
      // A completion flush can expose all retained waiting entries together.
      // Normal history follows the capture limits without discarding the new item.
      if (!snapshot.expandedIds) {
        let bytes = [...history.values()].reduce((sum, entry) => sum + rawEntryBytes(entry), 0);
        while (history.size > RAW_QUEUE_COUNT || (bytes > RAW_QUEUE_BYTES && history.size > 1)) {
          const oldest = history.values().next().value;
          bytes -= rawEntryBytes(oldest);
          history.delete(oldest.id);
        }
      }
      snapshot = { ...snapshot, activity: { ...snapshot.activity,
        rawSkips: { ...snapshot.activity.rawSkips, entries: [...history.values()] } } };
    }
    latestDecision = snapshot.decision;
    presentedActivity = snapshot.activity;
    presentedRawId = snapshot.rawId || null;
    expandedRawIds = new Set(snapshot.expandedIds || []);
    const revision = ++presentationRevision;
    showSelectedView();
    if (presentedRawId) {
      rawHoldUntil = Date.now() + RAW_DISPLAY_MS;
      requestAnimationFrame(() => {
        if (revision === presentationRevision) rawHoldUntil = Math.max(rawHoldUntil, Date.now() + RAW_DISPLAY_MS);
      });
    }
    pruneRawReferences();
  }

  function rawEntryBytes(entry) {
    return rawEntries.get(entry.id)?.bytes || new TextEncoder().encode(JSON.stringify(entry)).length;
  }

  function pruneRawReferences() {
    const ids = new Set([...(currentActivity?.rawSkips?.entries || []).map(entry => entry.id),
      ...(presentedActivity?.rawSkips?.entries || []).map(entry => entry.id),
      ...resultQueue.filter(item => item.rawId).map(item => item.rawId)]);
    for (const id of rawEntries.keys()) if (!ids.has(id)) rawEntries.delete(id);
    for (const id of expandedStates.keys()) if (!ids.has(id)) expandedStates.delete(id);
    receivedRawIds = ids;
  }

  function trimWaitingQueue() {
    let count = 0;
    let bytes = 0;
    for (const item of resultQueue) {
      if (item.rawId) { count += 1; bytes += rawEntryBytes(item.activity.rawSkips.entries[0]); }
    }
    while (count > RAW_QUEUE_COUNT || bytes > RAW_QUEUE_BYTES) {
      const index = resultQueue.findIndex(item => item.rawId);
      const [expired] = resultQueue.splice(index, 1);
      bytes -= rawEntryBytes(expired.activity.rawSkips.entries[0]);
      count -= 1;
      expiredRawCount = Math.min(Number.MAX_SAFE_INTEGER, expiredRawCount + 1);
    }
    for (let index = resultQueue.length - 2; index >= 0; index -= 1) {
      if (!resultQueue[index].rawId && !resultQueue[index + 1].rawId) resultQueue.splice(index, 1);
    }
    pruneRawReferences();
  }

  function queuedActivity(raw, entries) {
    return { message: currentActivity?.message, hookActivity: currentActivity?.hookActivity,
      rawSkips: raw ? { ...raw, entries } : undefined };
  }

  function drainResults() {
    clearTimeout(rawTimer);
    rawTimer = 0;
    if (inspectionPaused || document.hidden) { updateRawSkips(); return; }
    const remaining = rawHoldUntil - Date.now();
    if (remaining > 0) {
      if (resultQueue.length) rawTimer = setTimeout(drainResults, remaining);
      updateRawSkips();
      return;
    }
    // A completed turn can release a long queue together. The active result
    // still gets its full reading time. Keep every queued payload, even if the
    // capture file has already rotated it out of its bounded history.
    if (currentActivity?.workComplete && resultQueue.filter(item => item.rawId).length >= RAW_FLUSH_COUNT) {
      const pending = resultQueue.splice(0);
      const entries = new Map();
      for (const entry of presentedActivity?.rawSkips?.entries || []) entries.set(entry.id, entry);
      for (const snapshot of pending) {
        for (const entry of snapshot.activity?.rawSkips?.entries || []) entries.set(entry.id, entry);
      }
      const last = pending.at(-1);
      present({ decision: last.decision,
        activity: { ...currentActivity, rawSkips: { ...currentActivity.rawSkips, entries: [...entries.values()] } },
        expandedIds: pending.filter(item => item.rawId).map(item => item.rawId) });
      return;
    }
    while (resultQueue.length) {
      const next = resultQueue.shift();
      present(next);
      if (next.rawId) break;
    }
    if (resultQueue.length) rawTimer = setTimeout(drainResults, Math.max(0, rawHoldUntil - Date.now()));
    updateRawSkips();
  }

  function receiveResult(data) {
    if (data.type === "decision") receivedDecision = data.decision || null;
    const previousActivity = currentActivity;
    currentActivity = data.activity ?? (data.type === "activity" || !receivedDecision ? null : currentActivity);
    let raw = currentActivity?.rawSkips;
    if (rawPreferencePending && raw?.enabled === rawPreferenceDesired) rawPreferencePending = false;
    const scope = raw?.scope;
    if (scope !== presentationScope) {
      rawPreferencePending = false;
      rawPreferenceError = "";
    }
    const reset = !presentationStarted || scope !== presentationScope || !currentActivity ||
      currentActivity.unavailable || raw?.unavailable ||
      (previousActivity?.rawSkips?.enabled === true && !raw?.enabled);
    const entries = raw?.entries || [];
    if (reset) {
      clearPresentationQueue();
      raw = currentActivity?.rawSkips;
      for (const entry of raw?.entries || []) rawEntries.set(entry.id, { entry,
        bytes: new TextEncoder().encode(JSON.stringify(entry)).length });
      presentationStarted = true;
      presentationScope = scope;
      receivedRawIds = new Set(entries.map(entry => entry.id));
      present({ decision: receivedDecision, activity: currentActivity,
        rawId: raw?.enabled && !raw.unavailable ? entries.at(-1)?.id : null });
      return;
    }
    if (raw?.entries) {
      const entries = raw.entries.map(entry => {
        if (!rawEntries.has(entry.id)) rawEntries.set(entry.id, { entry,
          bytes: new TextEncoder().encode(JSON.stringify(entry)).length });
        return rawEntries.get(entry.id).entry;
      });
      raw = { ...raw, entries };
      currentActivity = { ...currentActivity, rawSkips: raw };
    }
    const fresh = (raw?.entries || []).filter(entry => !receivedRawIds.has(entry.id));
    for (const entry of fresh) {
      resultQueue.push({ decision: receivedDecision,
        activity: queuedActivity(raw, [entry]), rawId: entry.id });
    }
    // Only retain IDs that remain in storage or in the presentation queue.
    receivedRawIds = new Set([...entries.map(entry => entry.id),
      ...resultQueue.filter(item => item.rawId).map(item => item.rawId)]);
    if (!fresh.length && data.type === "decision") {
      const snapshot = { decision: receivedDecision, activity: queuedActivity(raw, []) };
      if (!resultQueue.at(-1)?.rawId && resultQueue.length) resultQueue[resultQueue.length - 1] = snapshot;
      else resultQueue.push(snapshot);
    } else if (!fresh.length && !resultQueue.length && !inspectionPaused && Date.now() >= rawHoldUntil) {
      presentedActivity = currentActivity;
      if (panelMode === "totals") showTotals();
    }
    trimWaitingQueue();
    // Counters and the capture preference stay current while result content waits.
    updateActivity(currentActivity);
    if (fresh.length || resultQueue.length || currentActivity?.workComplete !== previousActivity?.workComplete) drainResults();
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type === "raw-skips-error") {
      rawPreferencePending = false;
      rawPreferenceError = event.data.message;
      updateRawSkips();
      return;
    }
    if (event.data?.type !== "activity" && event.data?.type !== "decision") return;
    receiveResult(event.data);
  });
  document.addEventListener("visibilitychange", () => {
    clearTimeout(rawTimer);
    rawTimer = 0;
    if (!document.hidden) {
      if (presentedRawId) rawHoldUntil = Date.now() + RAW_DISPLAY_MS;
      drainResults();
    }
  });
  showSelectedView();
  vscode.postMessage({ type: "ready" });
})();
