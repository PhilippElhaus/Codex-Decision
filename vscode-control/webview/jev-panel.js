"use strict";

(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const BAR_FILL_MS = 800;
  const PERCENT_FADE_MS = 170;
  const names = {
    filter_decision: "Shorten output?",
    routine_noise: "Routine noise",
    needs_exact_text: "Exact text needed",
    one_off_value: "Unique value present",
  };
  const themes = {
    output_filter: "Output · suggested shorten",
    output_keep: "Output · suggested keep",
    output_noul: "Output · safety check",
    output_evaluated: "Output · evaluated",
    build_filter: "Test/build · suggested trim",
    build_keep: "Test/build · suggested keep",
    build_noul: "Test/build · safety check",
    build_evaluated: "Test/build · evaluated",
    search_retain: "Search · retain exact matches",
    search_summarize: "Search · summarize group",
    search_drop: "Search · drop unrelated group",
    search_mixed: "Search · mixed group choices",
    search_evaluated: "Search · evaluated",
  };
  let currentDecision = "";
  let currentId = null;
  let animation = 0;
  let historyAnimation = 0;
  let currentAnimations = [];
  let currentProgress = 1;
  let previousRecent = [];

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

  function formatElapsed(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 3_600_000) return "—";
    return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(2)}s`;
  }

  function lineTotals(decision) {
    return `${decision.status === "processing" ? "Checking · " : ""}${decision.totals.judged} judged · ${decision.totals.omitted} omitted · ${decision.totals.protected} protected locally · ${decision.totals.unjudged} pending${decision.batch_elapsed_ms === null ? "" : ` · ${formatElapsed(decision.batch_elapsed_ms)} batch`}`;
  }

  function showEmpty(message) {
    currentDecision = "";
    currentId = null;
    cancelAnimationFrame(animation);
    cancelAnimationFrame(historyAnimation);
    currentAnimations = [];
    previousRecent = [];
    app.replaceChildren(append(element("section", "empty"),
      element("span", "empty-glyph", "[ . . . ]"),
      element("h1", "", "Jev decision"),
      element("p", "", message)));
  }

  function bar(parent, label, value, selected, animations) {
    const row = element("div", `bar-row${selected ? " selected" : ""}`);
    const head = append(element("div", "bar-head"), element("span", "bar-label", label),
      element("strong", "bar-percent", value === null ? "" : `${Math.round(value * 100)}%`));
    const track = element("div", "ascii-track");
    track.setAttribute("role", "img");
    if (value === null) {
      track.classList.add("placeholder-track");
      track.setAttribute("aria-label", `${label}: no result`);
      track.textContent = ".".repeat(160);
      append(row, head, track);
      parent.appendChild(row);
      return;
    }
    track.setAttribute("aria-label", `${label}: ${Math.round(value * 100)} percent`);
    const left = element("span", "bracket", "[");
    const cellsHost = element("span", "cells");
    const right = element("span", "bracket", "]");
    append(track, left, cellsHost, right);
    append(row, head, track);
    parent.appendChild(row);
    let measuredWidth = 0;
    let cells = [];
    let renderedCount = -1;
    animations.push((fraction) => {
      if (track.clientWidth !== measuredWidth) {
        measuredWidth = track.clientWidth;
        const probe = element("span", "cell", "█");
        cellsHost.appendChild(probe);
        const characterWidth = probe.getBoundingClientRect().width;
        probe.remove();
        const count = characterWidth > 0 ?
          Math.max(8, Math.min(160, Math.floor((measuredWidth - left.clientWidth - right.clientWidth) / characterWidth))) : 32;
        if (count !== cells.length) {
          cells = Array.from({ length: count }, () => element("span", "cell unfilled", "."));
          cellsHost.replaceChildren(...cells);
          renderedCount = -1;
        }
      }
      const count = Math.round(value * cells.length * fraction);
      if (count !== renderedCount) {
        const first = Math.max(0, Math.min(count, renderedCount));
        const last = Math.max(count, renderedCount);
        for (let index = first; index < last; index++) {
          const filled = index < count;
          cells[index].className = `cell ${filled ? "filled" : "unfilled"}`;
          cells[index].textContent = filled ? "█" : ".";
        }
        renderedCount = count;
      }
    });
  }

  function renderLineDecision(decision) {
    const serialized = JSON.stringify(decision);
    if (serialized === currentDecision) return;
    const newDecision = decision.id !== currentId;
    if (!newDecision) {
      currentDecision = serialized;
      const totals = app.querySelector(".line-totals");
      if (totals) totals.textContent = lineTotals(decision);
      return;
    }
    currentDecision = serialized;
    currentId = decision.id;
    cancelAnimationFrame(animation);
    cancelAnimationFrame(historyAnimation);
    const container = element("div", "line-layout");
    const history = element("section", "history-card line-history");
    const rows = element("div", "history-lines");
    rows.setAttribute("aria-label", "Five latest judged source lines, newest at bottom");
    const padded = Array(5 - decision.recent.length).fill(null).concat(decision.recent);
    const prior = Array(5 - previousRecent.length).fill(null).concat(previousRecent);
    const moving = [];
    for (let index = 0; index < 5; index += 1) {
      const item = padded[index];
      const row = element("div", `history-row${index === 4 && item ? " latest" : ""}`);
      if (item) {
        append(row, element("span", "history-action", item.action === "omit" ? "Omit" : "Keep"),
          element("span", "history-theme", item.excerpt || item.summary));
        row.title = `Line ${item.line}: ${item.excerpt}`;
        if (newDecision && previousRecent.length) {
          const former = prior.findIndex((entry) => entry?.id === item.id);
          if (former >= 0 && former !== index) {
            row.style.transform = `translateY(${(former - index) * 100}%)`;
            moving.push(row);
          } else if (former < 0) {
            row.style.transform = "translateY(100%)";
            row.style.opacity = "0";
            moving.push(row);
          }
        }
      } else row.setAttribute("aria-hidden", "true");
      rows.appendChild(row);
    }
    history.appendChild(rows);
    container.appendChild(history);
    previousRecent = decision.recent;

    const latest = decision.latest;
    const detail = element("section", "line-detail");
    const action = latest.action === "omit" ? "Omitted" : "Kept";
    const reasons = { below_omit_cutoff: "below omit cutoff", exact_text: "exact text",
      task_relevant: "task relevant", confident_omission: "confident omit",
      representative: "repeated sample", last_line: "final line" };
    const reason = reasons[latest.reason] ? ` · ${reasons[latest.reason]}` : "";
    append(detail,
      append(element("div", "line-detail-title"),
        element("span", "card-kicker", `LINE ${latest.line} · ${decision.filter.replace("_", "/")}`),
        element("strong", `line-action ${latest.action}`, action + reason)),
      element("div", "line-excerpt", latest.excerpt || "(empty source line)"),
      element("div", "line-totals", lineTotals(decision)));
    const animations = [];
    const signals = element("section", "line-signals");
    append(signals, element("span", "card-kicker", "NOUL / THIS LINE"));
    bar(signals, "Can omit", latest.can_omit, latest.action === "omit", animations);
    bar(signals, "Exact text needed", latest.exact_needed, false, animations);
    bar(signals, "Task relevant", latest.task_relevant, false, animations);
    append(container, detail, signals);
    app.replaceChildren(container);
    if (moving.length) {
      void rows.offsetHeight;
      historyAnimation = requestAnimationFrame(() => {
        for (const row of moving) {
          row.style.transition = "transform 280ms ease, opacity 280ms ease";
          row.style.transform = "translateY(0)";
          row.style.opacity = "1";
        }
      });
    }
    const percentages = [...container.querySelectorAll(".bar-percent")];
    const show = (opacity) => { for (const node of percentages) node.style.opacity = String(opacity); };
    currentAnimations = animations;
    currentProgress = 0;
    for (const update of animations) update(0);
    const duration = newDecision ? BAR_FILL_MS : 0;
    if (!duration) {
      currentProgress = 1;
      for (const update of animations) update(1);
      show(1);
      return;
    }
    const started = performance.now();
    function frame(now) {
      const elapsed = Math.max(0, now - started);
      currentProgress = Math.min(1, elapsed / duration);
      for (const update of animations) update(currentProgress);
      show(Math.min(1, Math.max(0, (elapsed - duration) / PERCENT_FADE_MS)));
      if (elapsed < duration + PERCENT_FADE_MS) animation = requestAnimationFrame(frame);
    }
    animation = requestAnimationFrame(frame);
  }

  function batchTotals(decision) {
    const totals = decision.totals;
    return `${decision.status === "processing" ? "Checking · " : ""}${decision.rows.length} lines in this batch · ${totals.judged} judged overall · ${totals.omitted} omitted · ${totals.protected} protected · ${formatElapsed(decision.batch_elapsed_ms)} batch`;
  }

  function renderBatchDecision(decision) {
    const serialized = JSON.stringify(decision);
    if (serialized === currentDecision) return;
    if (decision.id === currentId) {
      currentDecision = serialized;
      const summary = app.querySelector(".batch-summary");
      if (summary) summary.textContent = batchTotals(decision);
      return;
    }
    currentDecision = serialized;
    currentId = decision.id;
    cancelAnimationFrame(animation);
    cancelAnimationFrame(historyAnimation);
    currentAnimations = [];
    currentProgress = 1;
    previousRecent = [];
    const route = { output: "Output", test_build: "Test/build", search_listing: "Search/listing" }[decision.filter];
    const layout = element("div", "batch-layout");
    const header = element("header", "batch-header");
    append(header,
      append(element("div", "batch-heading"),
        element("span", "card-kicker", `${route.toUpperCase()} · NOUL / CAN OMIT`),
        element("strong", "batch-title", `Batch ${decision.batch.number} of ${decision.batch.count}`)),
      element("div", "batch-summary", batchTotals(decision)),
      append(element("div", "batch-scale"),
        element("span", "", "Source line"),
        element("span", "", "Decision"),
        element("span", "", "Can omit  0 ───────── 1")));
    const list = element("div", "batch-list");
    const fills = [];
    const values = [];
    list.setAttribute("role", "list");
    list.setAttribute("aria-label", "Judged lines in the latest Jev batch");
    list.setAttribute("aria-live", "off");
    for (const row of decision.rows) {
      const item = element("div", `batch-row ${row.action}`);
      item.setAttribute("role", "listitem");
      item.setAttribute("aria-label", `Line ${row.line}: ${row.action}. Can omit ${row.can_omit.toFixed(2)}.`);
      item.title = `Line ${row.line} · ${row.reason.replaceAll("_", " ")} · exact text ${row.exact_needed.toFixed(2)}${row.task_relevant === null ? "" : ` · task relevance ${row.task_relevant.toFixed(2)}`}`;
      const track = element("div", "batch-bar-track");
      track.setAttribute("aria-hidden", "true");
      append(track,
        element("span", "batch-bar-empty", ".".repeat(80)),
        element("span", "batch-bar-fill", "█".repeat(80)));
      fills.push({ node: track.querySelector(".batch-bar-fill"), score: row.can_omit });
      const value = element("span", "batch-value", row.can_omit.toFixed(2));
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
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    const duration = reduced ? 0 : BAR_FILL_MS;
    const started = performance.now();
    function frame(now) {
      const elapsed = Math.max(0, now - started);
      const linear = duration ? Math.min(1, elapsed / duration) : 1;
      const progress = 1 - (1 - linear) ** 2;
      for (const fill of fills) fill.node.style.width = `${fill.score * progress * 100}%`;
      const opacity = duration ? Math.min(1, Math.max(0, (elapsed - duration) / PERCENT_FADE_MS)) : 1;
      for (const value of values) value.style.opacity = String(opacity);
      if (elapsed < duration + (reduced ? 0 : PERCENT_FADE_MS)) animation = requestAnimationFrame(frame);
    }
    animation = requestAnimationFrame(frame);
  }

  function render(decision) {
    if (decision.version === 3) { renderBatchDecision(decision); return; }
    if (decision.version === 2) { renderLineDecision(decision); return; }
    const serialized = JSON.stringify(decision);
    if (serialized === currentDecision) return;
    const newDecision = decision.id !== currentId;
    currentDecision = serialized;
    currentId = decision.id;
    cancelAnimationFrame(animation);
    cancelAnimationFrame(historyAnimation);
    const animations = [];
    const cards = element("div", "cards");
    const history = element("section", "history-card");
    const historyLines = element("div", "history-lines");
    historyLines.setAttribute("aria-label", "Five latest Jev decisions, newest at bottom");
    const recent = decision.recent || [];
    const padded = Array(5 - recent.length).fill(null).concat(recent);
    const prior = Array(5 - previousRecent.length).fill(null).concat(previousRecent);
    const moving = [];
    for (let index = 0; index < 5; index += 1) {
      const item = padded[index];
      const row = element("div", `history-row${index === 4 && item ? " latest" : ""}`);
      if (item) {
        const summary = themes[item.theme] || "Jev decision";
        const theme = `${decision.demo ? "[DEMO] " : ""}${summary[0].toUpperCase()}${summary.slice(1)}`;
        const duration = formatElapsed(item.elapsed_ms);
        append(row, element("span", "history-theme", theme),
          element("span", "history-time", duration));
        row.title = `${theme} · ${duration}`;
        if (newDecision && previousRecent.length) {
          const former = prior.findIndex((entry) => entry?.id === item.id);
          if (former >= 0 && former !== index) {
            row.style.transform = `translateY(${(former - index) * 100}%)`;
            moving.push(row);
          } else if (former < 0) {
            row.style.transform = "translateY(100%)";
            row.style.opacity = "0";
            moving.push(row);
          }
        }
      } else {
        row.setAttribute("aria-hidden", "true");
      }
      historyLines.appendChild(row);
    }
    history.appendChild(historyLines);
    cards.appendChild(history);
    previousRecent = recent;

    const choice = decision.choices[0] || null;
    const choiceCard = element("section", `card decision-card choice-card${choice ? "" : " inactive"}`);
    const label = !choice || choice.name === "filter_decision" ?
      (decision.filter === "test_build" ? "Shorten test/build?" : names.filter_decision) :
      `Search group ${Number(choice.name.slice(6)) + 1}`;
    append(choiceCard, append(element("div", "card-title"), element("span", "card-kicker", "CHOICE"),
      element("h2", "", label)));
    const choiceRows = element("div", "bars");
    if (choice) {
      const options = Object.entries(choice.probabilities).sort((a, b) => b[1] - a[1]);
      for (const [option, value] of options) {
        bar(choiceRows, option[0].toUpperCase() + option.slice(1), value, option === choice.selected, animations);
      }
    } else {
      bar(choiceRows, "Filter", null, false, animations);
      bar(choiceRows, "Keep", null, false, animations);
    }
    choiceCard.appendChild(choiceRows);
    cards.appendChild(choiceCard);

    const checksCard = element("section", `card decision-card checks-card${decision.checks.length ? "" : " inactive"}`);
    append(checksCard, append(element("div", "card-title"), element("span", "card-kicker", "NOUL"),
      element("h2", "", "Safety signals")));
    const checkRows = element("div", "bars");
    const values = new Map(decision.checks.map((check) => [check.name, check.probability]));
    for (const name of ["routine_noise", "needs_exact_text", "one_off_value"]) {
      bar(checkRows, names[name], values.get(name) ?? null, false, animations);
    }
    checksCard.appendChild(checkRows);
    cards.appendChild(checksCard);

    app.replaceChildren(cards);
    if (moving.length) {
      // Establish the old positions before transitioning every retained row upward.
      void historyLines.offsetHeight;
      historyAnimation = requestAnimationFrame(() => {
        for (const row of moving) {
          row.style.transition = "transform 280ms ease, opacity 280ms ease";
          row.style.transform = "translateY(0)";
          row.style.opacity = "1";
        }
      });
    }
    const percentages = [...cards.querySelectorAll(".bar-percent")].filter((node) => node.textContent);
    const showPercentages = (opacity) => {
      for (const node of percentages) node.style.opacity = String(opacity);
    };
    currentAnimations = animations;
    currentProgress = 0;
    for (const update of animations) update(0);
    const fillDuration = !animations.length || !newDecision ? 0 : 800;
    if (!fillDuration) {
      currentProgress = 1;
      for (const update of animations) update(1);
      showPercentages(1);
      return;
    }
    const start = performance.now();
    function frame(now) {
      const elapsed = Math.max(0, now - start);
      const progress = Math.min(1, elapsed / fillDuration);
      currentProgress = progress;
      for (const update of animations) update(progress);
      showPercentages(Math.min(1, Math.max(0, (elapsed - fillDuration) / 170)));
      if (elapsed < fillDuration + 170) animation = requestAnimationFrame(frame);
    }
    animation = requestAnimationFrame(frame);
  }

  window.addEventListener("resize", () => {
    for (const update of currentAnimations) update(currentProgress);
  });

  window.addEventListener("message", (event) => {
    if (event.data?.type !== "decision") return;
    if (event.data.error) showEmpty(event.data.error);
    else if (event.data.decision) render(event.data.decision);
    else showEmpty("Waiting for a Jev check. The newest result will appear here automatically.");
  });
  showEmpty("Waiting for a Jev check. The newest result will appear here automatically.");
  vscode.postMessage({ type: "ready" });
})();
