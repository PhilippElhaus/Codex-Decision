/* Decision settings inside the version-pinned Codex settings view. */
(() => {
  const sections = [["output", "Tool output", [
    ["relevant_max", "Relevance, maximum for omission", "Remove a line only when its probability of being needed is at or below this cutoff."],
  ]]];
  const sectionDescriptions = {
    output: "Validated logs receive line relevance judgments directly. Unknown formats first pass an excerptability check. Diagnostics, completion evidence, and structured records stay protected.",
  };
  let active = false;
  let openingVoice = false;
  let navItem = null;
  let navAnchor = null;
  let panel = null;
  let hiddenContent = null;
  let hiddenDisplay = "";
  let scheduled = false;
  let nextId = 0;
  let pending = null;
  let hasKey = false;
  let busy = false;
  let defaults = null;
  let savedLogLimit = 50;
  let savedNeverDeleteLogs = false;
  const REPLY_TIMEOUT_MS = 10_000;

  function failRequest(id) {
    if (pending?.id !== id) return;
    const action = pending.action;
    clearTimeout(pending.timer);
    pending = null;
    setBusy(false);
    if (action === "settingsSetNeverDeleteLogs") showNeverDeleteLogs(savedNeverDeleteLogs);
    if (action === "settingsTest") showTest("Connection timed out", "error");
    showMessage("Codex did not reply. Reopen Decision settings to check saved values, then try again.", "error");
  }

  function visible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function voiceTab() {
    const settings = document.querySelector('nav[aria-label="Settings"]');
    const candidates = settings
      ? settings.querySelectorAll('button[aria-label="Voice"], [data-settings-panel-slug="voice"]')
      : document.querySelectorAll('[role="tab"], a[href*="/settings/voice"]');
    return [...candidates].find((item) =>
      (item.getAttribute("aria-label") === "Voice" || item.textContent.trim() === "Voice") && visible(item)) || null;
  }

  function navigationAnchor(voice) {
    const settings = voice.closest('nav[aria-label="Settings"]');
    if (!settings) return voice;
    const neighbor = [...settings.querySelectorAll('button[aria-label], [data-settings-panel-slug]')]
      .find((item) => item !== voice && ["Configuration", "General"].includes(item.getAttribute("aria-label")));
    if (!neighbor) return voice;
    let branch = voice;
    while (branch.parentElement && branch.parentElement !== settings &&
           !branch.parentElement.contains(neighbor)) branch = branch.parentElement;
    return branch;
  }

  function nativeContent(voice) {
    if (hiddenContent?.isConnected) return hiddenContent;
    const heading = [...document.querySelectorAll("h1,h2")]
      .find((item) => item.textContent.trim() === "Voice" && !voice.contains(item) && visible(item));
    if (heading) {
      const main = heading.closest('main,[role="tabpanel"]');
      if (main && !main.contains(voice)) return main;
      let branch = heading;
      while (branch.parentElement && !branch.parentElement.contains(voice)) branch = branch.parentElement;
      if (branch !== heading) return branch;
    }
    const content = voice.closest('.app-shell-left-panel')?.nextElementSibling;
    if (content && !content.contains(voice) && visible(content)) {
      const page = content.firstElementChild;
      return page && visible(page) ? page : content;
    }
    return [...document.querySelectorAll('main,[role="tabpanel"]')]
      .find((item) => !item.contains(voice) && visible(item)) || null;
  }

  function request(action, payload = {}) {
    const api = window.__codexDecisionApi;
    if (!api || pending) return false;
    const id = `decision-settings-${++nextId}`;
    pending = { id, action, deadline: Date.now() + REPLY_TIMEOUT_MS,
      timer: setTimeout(() => failRequest(id), REPLY_TIMEOUT_MS) };
    try {
      api.postMessage({ type: "codex-decision", id, action,
        viewId: window.__codexDecisionViewId?.(), sessionId: window.__codexDecisionSessionId?.() || null,
        expectsLocalSession: false,
        ...payload });
    } catch {
      failRequest(id);
      return false;
    }
    return true;
  }

  function showMessage(value, kind = "") {
    const item = panel?.querySelector("#codex-decision-settings-message");
    if (item) { item.textContent = value; item.className = kind; }
  }

  function showTest(value, kind = "") {
    const item = panel?.querySelector("#codex-decision-settings-test-status");
    if (item) { item.textContent = value; item.className = kind; }
  }

  function setBusy(value) {
    busy = value;
    if (!panel) return;
    panel.querySelector("#codex-decision-settings-provider").disabled = value;
    panel.querySelector("#codex-decision-settings-test").disabled = value;
    panel.querySelector("#codex-decision-settings-save").disabled = value;
    panel.querySelector("#codex-decision-settings-reset").disabled = value || !defaults;
    panel.querySelector("#codex-decision-settings-open-logs").disabled = value;
    panel.querySelector("#codex-decision-settings-never-delete").disabled = value;
  }

  function showNeverDeleteLogs(value) {
    panel.querySelector("#codex-decision-settings-never-delete").checked = value;
    panel.querySelector("#codex-decision-settings-log-limit").disabled = value;
  }

  function showSavedKeyLength(length) {
    panel.querySelector("#codex-decision-settings-key").placeholder =
      Number.isInteger(length) && length >= 8 && length <= 4096 ? "•".repeat(length) : "Enter API key";
  }

  function formatDuration(milliseconds) {
    if (!milliseconds) return "—";
    return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
  }

  function showLifetime(stats = {}) {
    const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0).toLocaleString("en-US");
    panel.querySelector("#codex-decision-settings-lifetime-tokens").textContent = count(stats.linesJudged);
    panel.querySelector("#codex-decision-settings-lifetime-replaced").textContent = count(stats.linesOmitted);
    panel.querySelector("#codex-decision-settings-lifetime-calls").textContent = count(stats.calls);
    panel.querySelector("#codex-decision-settings-lifetime-time").textContent = formatDuration(stats.averageMs);
    panel.querySelector("#codex-decision-settings-lifetime-protected").textContent = count(stats.linesProtected);
  }

  function parsePercentage(value) {
    const match = /^(\d{1,3})\s*%?$/.exec(value.trim());
    const number = match ? Number(match[1]) : NaN;
    return Number.isInteger(number) && number <= 100 ? number : null;
  }

  function parseLogLimit(value) {
    const text = value.trim();
    const number = /^\d{1,4}$/.test(text) ? Number(text) : NaN;
    return Number.isInteger(number) && number >= 1 && number <= 9999 ? number : null;
  }

  function setThresholds(thresholds) {
    for (const [hook, , fields] of sections) {
      for (const [name] of fields) {
        const value = thresholds?.[name];
        const input = panel.querySelector(`#codex-decision-settings-${hook}-${name}`);
        const slider = panel.querySelector(`#codex-decision-settings-${hook}-${name}-slider`);
        input.value = value === undefined ? "" : `${value}%`;
        slider.value = value === undefined ? "0" : String(value);
        slider.style.setProperty("--fill", `${slider.value}%`);
      }
    }
  }

  function thresholdValues() {
    const values = {};
    for (const [hook, , fields] of sections) {
      for (const [name] of fields) {
        const input = panel.querySelector(`#codex-decision-settings-${hook}-${name}`);
        const value = parsePercentage(input.value);
        if (value === null) {
          input.focus();
          throw new Error("Enter whole percentages from 0 to 100.");
        }
        values[name] = value;
      }
    }
    return values;
  }

  function createPanel() {
    if (panel) return panel;
    const style = document.createElement("style");
    style.textContent = `
      [data-codex-decision-settings="true"][aria-selected="false"] { background: transparent !important; }
      [data-codex-decision-settings="true"][aria-selected="true"] { background: var(--vscode-list-activeSelectionBackground, #303030) !important; color: var(--vscode-list-activeSelectionForeground, #f3f3f3) !important; }
      nav[aria-label="Settings"]:has([data-codex-decision-settings="true"][aria-selected="true"]) button[aria-label="Voice"] { background: transparent !important; }
      #codex-decision-settings-panel { box-sizing: border-box; width: 100%; max-width: 740px; margin: 0 auto; padding: 28px 24px 56px; color: var(--vscode-foreground, #d0d0d0); font: 13px var(--vscode-font-family, sans-serif); }
      #codex-decision-settings-panel { container-type: inline-size; }
      #codex-decision-settings-panel * { box-sizing: border-box; }
      #codex-decision-settings-panel .header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
      #codex-decision-settings-panel h1 { font-size: 24px; margin: 0; }
      #codex-decision-settings-panel h2 { font-size: 17px; margin: 26px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-panel-border, #333); }
      #codex-decision-settings-panel .section-description { margin: -5px 0 15px; color: var(--vscode-descriptionForeground, #999); font-size: 11px; line-height: 1.4; }
      #codex-decision-settings-panel .method-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 18px; margin: 0 0 15px; }
      #codex-decision-settings-panel .method-controls label { display: inline-flex; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground, #aaa); font-size: 11px; cursor: pointer; }
      #codex-decision-settings-panel .threshold-field input:disabled { opacity: .45; cursor: default; }
      #codex-decision-settings-panel .metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
      #codex-decision-settings-panel .metric { min-width: 0; padding: 13px; border: 1px solid var(--vscode-panel-border, #3b3b3b); border-radius: 10px; background: #ffffff06; }
      #codex-decision-settings-panel .metric strong { display: block; font-size: 20px; font-weight: 650; line-height: 1.2; font-variant-numeric: tabular-nums; }
      #codex-decision-settings-panel .metric span { display: block; margin-top: 5px; color: var(--vscode-descriptionForeground, #999); font-size: 11px; line-height: 1.3; }
      #codex-decision-settings-panel p, #codex-decision-settings-panel small { color: var(--vscode-descriptionForeground, #999); line-height: 1.5; }
      #codex-decision-settings-panel .field { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 11px 0; }
      #codex-decision-settings-panel .threshold-field { display: grid; grid-template-columns: minmax(0, 1fr) minmax(160px, 300px); }
      #codex-decision-settings-panel .threshold-controls { display: flex; align-items: center; gap: 12px; min-width: 0; }
      #codex-decision-settings-panel .field label { max-width: 540px; }
      #codex-decision-settings-panel small { display: block; margin-top: 3px; }
      #codex-decision-settings-panel input, #codex-decision-settings-panel select { background: var(--vscode-input-background, #181818); color: var(--vscode-input-foreground, #ddd); border: 1px solid var(--vscode-input-border, #555); border-radius: 9px; padding: 7px 9px; font: inherit; }
      #codex-decision-settings-panel .percent-input { width: 76px; flex: none; text-align: right; font-variant-numeric: tabular-nums; }
      #codex-decision-settings-panel .log-limit-input { width: 96px; text-align: right; font-variant-numeric: tabular-nums; }
      #codex-decision-settings-panel .log-retention { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
      #codex-decision-settings-panel .log-retention label { display: inline-flex; align-items: center; gap: 6px; }
      #codex-decision-settings-panel .relevance-controls { margin: 15px 0 8px; padding: 12px 0 0; border-top: 1px solid var(--vscode-panel-border, #333); }
      #codex-decision-settings-panel .relevance-controls > label { display: flex; align-items: center; gap: 8px; }
      #codex-decision-settings-panel .relevance-controls .field label { display: block; }
      #codex-decision-settings-panel input[type=checkbox] { -webkit-appearance: none; appearance: none; display: inline-grid; place-content: center; width: 16px; height: 16px; flex: none; margin: 0; padding: 0; border: 1px solid var(--vscode-checkbox-border, #777); border-radius: 3px; background: var(--vscode-checkbox-background, #3c3c3c); color: var(--vscode-checkbox-foreground, #fff); cursor: pointer; }
      #codex-decision-settings-panel input[type=checkbox]::after { content: ""; display: none; width: 8px; height: 5px; border: solid currentColor; border-width: 0 0 2px 2px; transform: translateY(-1px) rotate(-45deg); }
      #codex-decision-settings-panel input[type=checkbox]:checked::after { display: block; }
      #codex-decision-settings-panel input[type=checkbox]:disabled { opacity: .6; cursor: default; }
      #codex-decision-settings-panel .log-limit-input:disabled { opacity: .5; }
      #codex-decision-settings-panel input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; min-width: 0; flex: 1; height: 6px; padding: 0; border: 0; border-radius: 999px; background: linear-gradient(to right, var(--vscode-button-background, #3287ac) 0 var(--fill, 0%), var(--vscode-input-border, #555) var(--fill, 0%) 100%); cursor: pointer; }
      #codex-decision-settings-panel input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 16px; height: 16px; border: 2px solid var(--vscode-editor-background, #181818); border-radius: 50%; background: var(--vscode-button-background, #3287ac); box-shadow: 0 0 0 1px var(--vscode-button-background, #3287ac); }
      #codex-decision-settings-panel input[type=range]::-moz-range-thumb { width: 12px; height: 12px; border: 2px solid var(--vscode-editor-background, #181818); border-radius: 50%; background: var(--vscode-button-background, #3287ac); }
      #codex-decision-settings-panel input[type=password] { width: min(100%, 340px); }
      #codex-decision-settings-panel button { min-height: 36px; padding: 7px 12px; border: 1px solid var(--vscode-contrastBorder, #555); border-radius: 10px; background: var(--vscode-button-secondaryBackground, #282828); color: var(--vscode-button-secondaryForeground, #e5e5e5); font: inherit; cursor: pointer; }
      #codex-decision-settings-panel button:hover { background: var(--vscode-button-secondaryHoverBackground, #363636); }
      #codex-decision-settings-panel button.primary { border-color: transparent; background: #ececec; color: #202020; }
      #codex-decision-settings-panel button.primary:hover { background: #d6d6d6; }
      #codex-decision-settings-panel button.subtle { border-color: var(--vscode-panel-border, #3b3b3b); background: transparent; color: var(--vscode-descriptionForeground, #999); }
      #codex-decision-settings-panel button.subtle:hover { background: var(--vscode-button-secondaryHoverBackground, #363636); color: var(--vscode-foreground, #d0d0d0); }
      #codex-decision-settings-panel button:focus-visible, #codex-decision-settings-panel select:focus-visible, #codex-decision-settings-panel input:focus-visible { outline: 2px solid var(--vscode-focusBorder, #83bcf7); outline-offset: 2px; }
      #codex-decision-settings-panel button:disabled { opacity: .55; cursor: default; }
      #codex-decision-settings-panel .actions { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
      #codex-decision-settings-panel .save-actions { flex-wrap: wrap; }
      #codex-decision-settings-reset { margin-left: auto; }
      #codex-decision-settings-test-status { font-size: 12px; font-weight: 600; }
      #codex-decision-settings-panel .ok { color: var(--vscode-testing-iconPassed, #4ec97f); }
      #codex-decision-settings-panel .error { color: var(--vscode-errorForeground, #f48771); }
      #codex-decision-settings-message { min-height: 22px; margin-top: 12px; }
      @media (max-width: 650px) { #codex-decision-settings-panel .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } #codex-decision-settings-panel .field { display: block; } #codex-decision-settings-panel input, #codex-decision-settings-panel select { margin-top: 8px; } }
      @container (max-width: 520px) { #codex-decision-settings-panel .threshold-field { display: grid; grid-template-columns: minmax(0, 1fr); gap: 7px; } #codex-decision-settings-panel .threshold-controls { width: 100%; } }
      @container (max-width: 320px) { #codex-decision-settings-panel .threshold-controls { gap: 8px; } #codex-decision-settings-panel .percent-input { width: 68px; } }
    `;
    document.head.append(style);
    panel = document.createElement("div");
    panel.id = "codex-decision-settings-panel";
    panel.innerHTML = `<div class="header"><h1>Decision</h1><button id="codex-decision-settings-open-logs" type="button">Open logs</button></div><section aria-label="Installation totals"><h2>All sessions</h2><div class="metrics"><div class="metric"><strong id="codex-decision-settings-lifetime-tokens">—</strong><span>Lines judged</span></div><div class="metric"><strong id="codex-decision-settings-lifetime-replaced">—</strong><span>Lines omitted</span></div><div class="metric"><strong id="codex-decision-settings-lifetime-protected">—</strong><span>Protected locally</span></div><div class="metric"><strong id="codex-decision-settings-lifetime-calls">—</strong><span>Decision requests</span></div><div class="metric"><strong id="codex-decision-settings-lifetime-time">—</strong><span>Avg. request time</span></div></div></section><section><h2>Decision provider</h2><div class="field"><label for="codex-decision-settings-provider">Provider</label><select id="codex-decision-settings-provider"><option value="openai">OpenAI Decisions</option><option value="typesafe">TypeSafe Jev</option></select></div><h2>API key</h2><div class="field"><label for="codex-decision-settings-key">API key</label><input id="codex-decision-settings-key" type="password" autocomplete="off" spellcheck="false" maxlength="4096"></div><div class="actions"><button id="codex-decision-settings-test" type="button">Test API key</button><span id="codex-decision-settings-test-status" role="status" aria-live="polite"></span></div></section><section><h2>Log retention</h2><div class="log-retention"><label for="codex-decision-settings-log-limit">Storage limit (MB)</label><input id="codex-decision-settings-log-limit" class="log-limit-input" type="text" inputmode="numeric" maxlength="4" aria-label="Log storage limit in MB"><label for="codex-decision-settings-never-delete"><input id="codex-decision-settings-never-delete" type="checkbox">Never delete logs</label></div><small>Oldest session log files are removed when the limit is reached.</small></section><section><h2>Behavior</h2><div class="field"><label for="codex-decision-settings-mode">Mode<small>Monitor previews per-line Decision decisions while leaving tool output unchanged. Filter shortens approved results.</small></label><select id="codex-decision-settings-mode"><option value="observe">Monitor</option><option value="replace">Filter</option></select></div><div id="codex-decision-settings-thresholds"></div></section><div class="actions save-actions"><button id="codex-decision-settings-save" type="button" class="primary">Save settings</button><button id="codex-decision-settings-reset" type="button" class="subtle" title="Restore the default settings in this form. Save to apply." disabled>Reset defaults</button></div><p id="codex-decision-settings-message" role="status" aria-live="polite"></p>`;
    const thresholds = panel.querySelector("#codex-decision-settings-thresholds");
    for (const [hook, heading, fields] of sections) {
      const title = document.createElement("h2");
      title.textContent = heading;
      thresholds.append(title);
      const description = document.createElement("p");
      description.className = "section-description";
      description.textContent = sectionDescriptions[hook];
      thresholds.append(description);
      for (const [name, label, help] of fields) {
        const id = `codex-decision-settings-${hook}-${name}`;
        const row = document.createElement("div");
        row.className = "field";
        const caption = document.createElement("label");
        caption.htmlFor = id;
        caption.textContent = label;
        caption.title = help;
        const input = document.createElement("input");
        input.id = id;
        input.type = "text";
        input.inputMode = "numeric";
        input.maxLength = 4;
        input.className = "percent-input";
        input.required = true;
        input.setAttribute("aria-label", `${heading}: ${label} (percent)`);
        input.title = help;
        row.classList.add("threshold-field");
        const controls = document.createElement("div");
        controls.className = "threshold-controls";
        const slider = document.createElement("input");
        slider.id = `${id}-slider`;
        slider.type = "range";
        slider.min = "0";
        slider.max = "100";
        slider.step = "1";
        slider.title = help;
        slider.setAttribute("aria-label", `${heading}: ${label} slider`);
        slider.addEventListener("input", () => {
          input.value = `${slider.value}%`;
          slider.style.setProperty("--fill", `${slider.value}%`);
        });
        input.addEventListener("input", () => {
          const value = parsePercentage(input.value);
          input.setAttribute("aria-invalid", value === null ? "true" : "false");
          if (value !== null) {
            slider.value = String(value);
            slider.style.setProperty("--fill", `${value}%`);
          }
        });
        input.addEventListener("blur", () => {
          const value = parsePercentage(input.value);
          if (value === null) showMessage("Enter whole percentages from 0 to 100. Previous value restored.", "error");
          input.value = `${value === null ? slider.value : value}%`;
          input.setAttribute("aria-invalid", "false");
        });
        controls.append(slider, input);
        row.append(caption, controls);
        thresholds.append(row);
      }
    }
    panel.querySelector("#codex-decision-settings-test").addEventListener("click", () => {
      if (busy) return;
      const key = panel.querySelector("#codex-decision-settings-key").value.trim();

      if (request("settingsTest", { key, provider: panel.querySelector("#codex-decision-settings-provider").value })) { setBusy(true); showTest("Checking…"); showMessage(""); }
    });
    panel.querySelector("#codex-decision-settings-open-logs").addEventListener("click", () => {
      if (busy) return;
      if (request("settingsOpenLogs")) { setBusy(true); showMessage(""); }
    });
    panel.querySelector("#codex-decision-settings-key").addEventListener("input", () => showTest(""));
    panel.querySelector("#codex-decision-settings-provider").addEventListener("change", () => {
      panel.querySelector("#codex-decision-settings-key").value = "";
      panel.querySelector("#codex-decision-settings-key").placeholder = "Enter or test saved provider key";
      showTest("");
    });
    panel.querySelector("#codex-decision-settings-never-delete").addEventListener("change", (event) => {
      if (busy) { showNeverDeleteLogs(savedNeverDeleteLogs); return; }
      const limit = panel.querySelector("#codex-decision-settings-log-limit");
      if (event.target.checked && parseLogLimit(limit.value) === null) limit.value = String(savedLogLimit);
      limit.disabled = event.target.checked;
      if (request("settingsSetNeverDeleteLogs", { neverDeleteLogs: event.target.checked })) {
        setBusy(true);
        showMessage("Saving log retention…");
      } else {
        showNeverDeleteLogs(savedNeverDeleteLogs);
        showMessage("Decision settings are unavailable.", "error");
      }
    });
    panel.querySelector("#codex-decision-settings-reset").addEventListener("click", () => {
      if (busy || !defaults) return;
      panel.querySelector("#codex-decision-settings-provider").value = defaults.provider || "openai";
      panel.querySelector("#codex-decision-settings-provider").dispatchEvent(new Event("change"));
      panel.querySelector("#codex-decision-settings-mode").value = defaults.mode;
      setThresholds(defaults.relevance_policy);
      panel.querySelector("#codex-decision-settings-log-limit").value = String(defaults.log_limit_mb);
      showNeverDeleteLogs(defaults.never_delete_logs);
      showMessage("Defaults ready. Save settings to apply.");
    });
    panel.querySelector("#codex-decision-settings-save").addEventListener("click", () => {
      if (busy) return;
      try {
        const key = panel.querySelector("#codex-decision-settings-key").value.trim();
        const mode = panel.querySelector("#codex-decision-settings-mode").value;
        const relevancePolicy = thresholdValues();
        const logLimitMb = parseLogLimit(panel.querySelector("#codex-decision-settings-log-limit").value);
        if (logLimitMb === null) throw new Error("Enter a log limit from 1 to 9999 MB.");
        const neverDeleteLogs = panel.querySelector("#codex-decision-settings-never-delete").checked;
        if (request("settingsSave", { key, provider: panel.querySelector("#codex-decision-settings-provider").value, mode, relevancePolicy, logLimitMb, neverDeleteLogs })) {
          setBusy(true); showMessage("Saving…"); showTest("");
        }
      } catch (error) { showMessage(error.message, "error"); }
    });
    return panel;
  }

  function handleReply(data) {
    if (!pending || data?.type !== "codex-decision-reply" || data.id !== pending.id) return;
    const action = pending.action;
    clearTimeout(pending.timer);
    pending = null;
    setBusy(false);
    const reply = data.status?.settings;
    if (!reply || reply.action === "error") {
      if (action === "settingsSetNeverDeleteLogs") showNeverDeleteLogs(savedNeverDeleteLogs);
      showMessage(reply?.message || "Decision settings are unavailable.", "error");
      return;
    }
    if (action === "settingsRead" && reply.action === "ready") {
      hasKey = Boolean(reply.hasKey);
      defaults = reply.defaults || null;
      setBusy(false);
      showSavedKeyLength(reply.keyLength);
      showLifetime(reply.lifetime);
      panel.querySelector("#codex-decision-settings-provider").value = reply.config?.provider || "openai";
      panel.querySelector("#codex-decision-settings-mode").value = reply.config?.mode || "replace";
      setThresholds(reply.config?.relevance_policy);
      savedLogLimit = reply.config?.log_limit_mb || 50;
      panel.querySelector("#codex-decision-settings-log-limit").value = String(savedLogLimit);
      savedNeverDeleteLogs = Boolean(reply.config?.never_delete_logs);
      showNeverDeleteLogs(savedNeverDeleteLogs);
    } else if (action === "settingsSetNeverDeleteLogs" && reply.action === "neverDeleteLogsSaved") {
      savedNeverDeleteLogs = reply.neverDeleteLogs;
      showNeverDeleteLogs(savedNeverDeleteLogs);
      showMessage("Log retention saved.", "ok");
    } else if (action === "settingsTest" && reply.action === "tested") {
      if (reply.result?.ok) showTest("OK", "ok");
      else {
        const reasons = { DECISION_HTTP_401: "Invalid", DECISION_KEY_EXPIRED: "Expired", DECISION_HTTP_403: "Rejected",
          DECISION_HTTP_429: "Rate limited", DECISION_TIMEOUT: "Timed out", DECISION_NETWORK_ERROR: "Network error",
          DECISION_INVALID_RESPONSE: "Invalid response" };
        showTest(reasons[reply.result?.reason] || "Connection failed", "error");
      }
    } else if (action === "settingsSave" && reply.action === "saved") {
      hasKey = Boolean(reply.hasKey);
      savedLogLimit = parseLogLimit(panel.querySelector("#codex-decision-settings-log-limit").value) || 50;
      savedNeverDeleteLogs = panel.querySelector("#codex-decision-settings-never-delete").checked;
      panel.querySelector("#codex-decision-settings-key").value = "";
      showSavedKeyLength(reply.keyLength);
      showMessage("Settings saved.", "ok");
    } else if (action === "settingsSetNeverDeleteLogs") {
      showNeverDeleteLogs(savedNeverDeleteLogs);
      showMessage("Decision settings are unavailable.", "error");
    }
  }

  function restoreContent() {
    if (hiddenContent) hiddenContent.style.display = hiddenDisplay;
    hiddenContent = null;
    panel?.remove();
    if (navItem) { navItem.setAttribute("aria-selected", "false"); navItem.tabIndex = -1; }
  }

  function sync() {
    if (pending && Date.now() >= pending.deadline) failRequest(pending.id);
    const voice = voiceTab();
    if (!voice) { active = false; restoreContent(); navAnchor?.remove(); navItem = null; navAnchor = null; return; }
    const anchor = navigationAnchor(voice);
    if (!navItem || !navAnchor || navAnchor.parentElement !== anchor.parentElement ||
        navAnchor.previousElementSibling !== anchor) {
      navAnchor?.remove();
      navAnchor = anchor === voice ? voice.cloneNode(true) : anchor.cloneNode(true);
      navItem = anchor === voice ? navAnchor : navAnchor.querySelector('button[aria-label="Voice"], [data-settings-panel-slug="voice"]');
      if (!navItem) { navAnchor = null; return; }
      for (const element of [navAnchor, ...navAnchor.querySelectorAll("[id]")]) element.removeAttribute("id");
      navItem.removeAttribute("href");
      navItem.removeAttribute("aria-controls");
      navItem.removeAttribute("data-state");
      navItem.removeAttribute("aria-current");
      navItem.removeAttribute("data-settings-panel-slug");
      for (const element of navItem.querySelectorAll("[href]")) element.remove();
      navItem.setAttribute("data-codex-decision-settings", "true");
      navItem.setAttribute("aria-label", "Decision");
      const label = [...navItem.querySelectorAll("*")].reverse().find((item) => item.textContent.trim() === "Voice");
      if (label) label.textContent = "Decision";
      else navItem.textContent = "Decision";
      const icon = navItem.querySelector("svg");
      if (icon) {
        const image = document.createElement("img");
        image.src = "./assets/decision-icon.png";
        image.alt = "";
        image.setAttribute("aria-hidden", "true");
        image.style.cssText = "width:16px;height:16px;object-fit:contain;flex:none";
        icon.replaceWith(image);
      }
      for (const extra of navItem.querySelectorAll("svg")) extra.remove();
      navItem.setAttribute("aria-selected", "false");
      navItem.tabIndex = -1;
      navItem.addEventListener("click", (event) => {
        event.preventDefault(); event.stopPropagation();
        if (!active) {
          active = true;
          createPanel();
          openingVoice = true;
          voiceTab()?.click();
          openingVoice = false;
          if (!request("settingsRead")) showMessage("Decision settings are unavailable.", "error");
        }
        schedule();
      });
      navItem.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navItem.click(); }
      });
      anchor.insertAdjacentElement("afterend", navAnchor);
    }
    if (!active) return;
    const native = nativeContent(voice);
    if (!native) return;
    if (hiddenContent !== native) {
      restoreContent();
      hiddenContent = native;
      hiddenDisplay = native.style.display;
      native.insertAdjacentElement("afterend", createPanel());
    }
    if (native.style.display !== "none") native.style.display = "none";
    if (navItem.getAttribute("aria-selected") !== "true") navItem.setAttribute("aria-selected", "true");
    if (navItem.tabIndex !== 0) navItem.tabIndex = 0;
    if (voice.getAttribute("aria-selected") === "true") voice.setAttribute("aria-selected", "false");
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; sync(); }, 0);
  }

  function start() {
    document.addEventListener("click", (event) => {
      if (!active || openingVoice || event.target.closest('[data-codex-decision-settings="true"]')) return;
      if (event.target.closest('nav[aria-label="Settings"] button,[role="tab"],a[href*="/settings/"]')) {
        active = false;
        restoreContent();
      }
    }, true);
    window.addEventListener("message", (event) => handleReply(event.data));
    new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, characterData: true });
    window.addEventListener("popstate", schedule);
    setInterval(schedule, 1500);
    schedule();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
