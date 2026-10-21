/* Decision settings inside the version-pinned Codex settings view. */
(() => {
  const sections = [["output", "Tool output", [
    ["relevant_max", "Omit cutoff", "Omit a line only when its relevance is at or below this limit."],
  ]]];
  const sectionDescriptions = {
    output: "Check validated logs by line. Check unknown formats first. Keep diagnostics, completion evidence, and structured records.",
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
  let providerKeys = { openai: { hasKey: false }, typesafe: { hasKey: false } };
  let busy = false;
  let testedConnection = null;
  let pendingConnectionSave = null;
  let savedConnection = null;
  let savedCustomProvider = null;
  let defaults = null;
  let savedLogLimit = 50;
  let savedNeverDeleteLogs = false;
  const REPLY_TIMEOUT_MS = 10_000;
  let helpId = 0;

  function helpTip(text, label, id = "", className = "") {
    const wrap = document.createElement("span");
    wrap.className = "decision-help";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "decision-help-button";
    button.setAttribute("aria-label", `About ${label}`);
    const tip = document.createElement("span");
    tip.id = id || `decision-settings-help-${++helpId}`;
    tip.className = `decision-help-text ${className}`.trim();
    tip.textContent = text;
    tip.setAttribute("role", "tooltip");
    button.setAttribute("aria-describedby", tip.id);
    const place = () => {
      wrap.classList.remove("help-dismissed");
      const target = button.getBoundingClientRect();
      const size = tip.getBoundingClientRect();
      const anchor = wrap.getBoundingClientRect();
      tip.style.left = `${Math.max(8, Math.min(target.left, innerWidth - size.width - 8)) - anchor.left}px`;
      tip.style.top = `${(target.bottom + size.height + 12 > innerHeight ? Math.max(8, target.top - size.height - 5) : target.bottom + 5) - anchor.top}px`;
    };
    wrap.addEventListener("mouseenter", place);
    button.addEventListener("focus", place);
    button.addEventListener("keydown", event => {
      if (event.key === "Escape") { wrap.classList.add("help-dismissed"); event.stopPropagation(); }
    });
    wrap.append(button, tip);
    return wrap;
  }

  function moveHelp(source, target, label, text) {
    const item = panel.querySelector(source);
    const tooltip = helpTip(text || item.textContent, label, item.id, item.className);
    item.remove();
    target.append(tooltip);
    return tooltip;
  }

  function failRequest(id) {
    if (pending?.id !== id) return;
    const action = pending.action;
    pendingConnectionSave = null;
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
    for (const field of panel.querySelectorAll(".connection-input")) field.disabled = value;
    panel.querySelector("#codex-decision-settings-test").disabled = value;
    panel.querySelector("#codex-decision-settings-save").disabled = value;
    panel.querySelector("#codex-decision-settings-reset").disabled = value || !defaults;
    panel.querySelector("#codex-decision-settings-open-logs").disabled = value;
    panel.querySelector("#codex-decision-settings-never-delete").disabled = value;
    panel.querySelector("#codex-decision-settings-fallback").disabled = value;
  }

  function showNeverDeleteLogs(value) {
    panel.querySelector("#codex-decision-settings-never-delete").checked = value;
    panel.querySelector("#codex-decision-settings-log-limit").disabled = value;
  }

  function connectionValues() {
    const value = name => panel.querySelector(`#codex-decision-settings-${name}`).value;
    const selected = value("provider");
    return { provider: selected, key: selected === "custom" && ["basic", "none"].includes(value("auth")) ? "" : value("key"),
      password: selected === "custom" && value("auth") === "basic" ? value("password") : "",
      ...(selected === "custom" ? { customProvider: { name: value("name").trim() || "Custom provider", protocol: value("protocol"),
        endpoint: value("endpoint").trim(), model: value("model").trim(), auth: value("auth"),
        username: value("auth") === "basic" ? value("username") : "", header_name: value("auth") === "header" ? value("header-name").trim() : "" } } : {}) };
  }

  function loadConnection(custom = {}) {
    custom ||= {};
    for (const [field, value] of Object.entries({ name: custom.name || "", protocol: custom.protocol || "openai",
      endpoint: custom.endpoint || "", model: custom.model || "", auth: custom.auth || "bearer",
      username: custom.username || "", "header-name": custom.header_name || "" })) panel.querySelector(`#codex-decision-settings-${field}`).value = value;
  }

  function showConnectionFields() {
    const values = connectionValues();
    const custom = values.provider === "custom";
    const auth = values.customProvider?.auth;
    for (const row of panel.querySelectorAll(".connection-custom")) row.hidden = !custom;
    panel.querySelector(".connection-username").hidden = !custom || auth !== "basic";
    panel.querySelector(".connection-header").hidden = !custom || auth !== "header";
    panel.querySelector(".connection-password").hidden = !custom || auth !== "basic";
    panel.querySelector(".connection-key").hidden = custom && ["basic", "none"].includes(auth);
    panel.querySelector(`#codex-decision-settings-connection-help`).textContent = custom
      ? "Use an endpoint for the selected schema. Chat endpoints need an adapter."
      : values.provider === "typesafe" ? "Use TypeSafe Jev. Your OpenAI key stays saved." : "Use OpenAI Decisions. Your TypeSafe key stays saved.";
    const credentialHelp = panel.querySelector("#codex-decision-settings-credential-help").closest(".decision-help");
    credentialHelp.hidden = custom && auth === "none";
    panel.querySelector(`label[for="codex-decision-settings-${custom && auth === "basic" ? "password" : "key"}"]`).append(credentialHelp);
    panel.querySelector("#codex-decision-settings-fallback").closest(".fallback-setting").hidden = custom;
    if (custom) panel.querySelector("#codex-decision-settings-fallback").checked = false;
  }

  function validateConnection() {
    const values = connectionValues();
    const custom = values.customProvider;
    if (custom) {
      if (!custom.endpoint || !custom.model) throw new Error("Enter the endpoint URL and model ID.");
      if (custom.auth === "basic" && !custom.username) throw new Error("Enter a username for Basic authentication.");
      if (custom.auth === "header" && !custom.header_name) throw new Error("Enter the API key header name.");
    }
    return values;
  }

  function showProviderKeys(reply) {
    const selected = panel.querySelector("#codex-decision-settings-provider").value;
    showConnectionFields();
    if (reply?.providerKeys) providerKeys = reply.providerKeys;
    else if (reply) providerKeys = { ...providerKeys, [selected]: { hasKey: Boolean(reply.hasKey) } };
    for (const [name, label] of [["openai", "OpenAI Decisions"], ["typesafe", "TypeSafe Jev"]]) {
      panel.querySelector(`#codex-decision-settings-${name}-key-status`).textContent =
        `${label}: ${providerKeys[name]?.hasKey ? "key saved" : "no saved key"}`;
    }
    const identity = custom => JSON.stringify([custom?.endpoint, custom?.auth, custom?.username || "", custom?.header_name || ""]);
    const saved = providerKeys[selected]?.hasKey && (selected !== "custom" || identity(savedCustomProvider) === identity(connectionValues().customProvider));
    for (const field of ["key", "password"]) panel.querySelector(`#codex-decision-settings-${field}`).placeholder = saved
      ? "Leave blank to keep saved credential" : "Enter credential for this connection";
    panel.querySelector("#codex-decision-settings-custom-key-status").textContent = selected === "custom"
      ? `Custom: ${saved ? "credential saved" : "new credentials required for a new destination"}` : "";
  }

  function formatDuration(milliseconds) {
    if (!milliseconds) return "—";
    return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
  }

  function showLifetime(stats = {}) {
    const partial = new Set(stats.partialCounters || []);
    const count = (name) => Number.isSafeInteger(stats[name]) && stats[name] >= 0 ?
      `${partial.has(name) ? "≥" : ""}${stats[name].toLocaleString("en-US")}` : "—";
    panel.querySelector("#codex-decision-settings-lifetime-tokens").textContent = count("linesJudged");
    panel.querySelector("#codex-decision-settings-lifetime-replaced").textContent = count("linesOmitted");
    panel.querySelector("#codex-decision-settings-lifetime-calls").textContent = count("calls");
    panel.querySelector("#codex-decision-settings-lifetime-time").textContent =
      ["averageMs","elapsedMs","timed"].some(name=>partial.has(name)) ? "—" : formatDuration(stats.averageMs);
    panel.querySelector("#codex-decision-settings-lifetime-protected").textContent = count("linesProtected");
    for (const [field, name] of [["tokens", "linesJudged"], ["replaced", "linesOmitted"],
      ["calls", "calls"], ["time", "averageMs"], ["protected", "linesProtected"]]) {
      panel.querySelector(`#codex-decision-settings-lifetime-${field}`).title = stats.overflowCounters?.includes(name) ?
        "This aggregate exceeds the exact numeric range and is unavailable." : partial.has(name) ?
          "The historical baseline is incomplete." : name === "linesOmitted" ? "Lines omitted by the hook. Delivery to Codex is unverified." : "Recorded activity across all sessions.";
      const value = panel.querySelector(`#codex-decision-settings-lifetime-${field}`);
      value.closest(".metric").querySelector(".decision-help-text").textContent = value.title;
    }
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
      #codex-decision-settings-panel .metric > span { display: block; margin-top: 5px; color: var(--vscode-descriptionForeground, #999); font-size: 11px; line-height: 1.3; }
      #codex-decision-settings-panel p, #codex-decision-settings-panel small { color: var(--vscode-descriptionForeground, #999); line-height: 1.5; }
      #codex-decision-settings-panel .field { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 11px 0; }
      #codex-decision-settings-panel .threshold-field { display: grid; grid-template-columns: minmax(0, 1fr) minmax(160px, 300px); }
      #codex-decision-settings-panel .threshold-controls { display: flex; align-items: center; gap: 12px; min-width: 0; }
      #codex-decision-settings-panel .field label { max-width: 540px; flex: none; }
      #codex-decision-settings-panel small { display: block; margin-top: 3px; }
      #codex-decision-settings-panel input, #codex-decision-settings-panel select { background: var(--vscode-input-background, #181818); color: var(--vscode-input-foreground, #ddd); border: 1px solid var(--vscode-input-border, #555); border-radius: 9px; padding: 7px 9px; font: inherit; }
      #codex-decision-settings-panel .percent-input { width: 76px; flex: none; text-align: right; font-variant-numeric: tabular-nums; }
      #codex-decision-settings-panel .log-limit-input { width: 96px; text-align: right; font-variant-numeric: tabular-nums; }
      #codex-decision-settings-panel .log-retention { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
      #codex-decision-settings-panel [hidden] { display:none !important; }
      #codex-decision-settings-panel .connection-description, #codex-decision-settings-panel .connection-credential-help { font-size:12px; line-height:1.5; color:var(--vscode-descriptionForeground,#999); overflow-wrap:anywhere; }
      #codex-decision-settings-panel .connection-input { min-width:0; width:100%; }
      #codex-decision-settings-panel .fallback-setting { margin: 15px 0; }
      #codex-decision-settings-panel .fallback-setting label { display: inline-flex; align-items: center; gap: 8px; }
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
      #codex-decision-settings-panel .decision-help { position: relative; display: inline-flex; vertical-align: middle; margin: 0 0 0 5px; }
      #codex-decision-settings-panel button.decision-help-button { display: inline-grid; place-items: center; width: 18px; height: 18px; min-height: 0; padding: 0; border: 0; border-radius: 3px; background: transparent; color: var(--vscode-descriptionForeground, #999); font-size: 13px; cursor: help; }
      #codex-decision-settings-panel .decision-help-button::before { content: "ⓘ"; }
      #codex-decision-settings-panel .decision-help-text { position: absolute; z-index: 100; display: none; width: min(290px, calc(100vw - 16px)); max-height: calc(100vh - 16px); overflow: auto; margin: 0; padding: 8px 10px; border: 1px solid var(--vscode-editorHoverWidget-border, #555); border-radius: 4px; background: var(--vscode-editorHoverWidget-background, #252526); color: var(--vscode-editorHoverWidget-foreground, #ccc); font-size: 11px; font-weight: 400; line-height: 1.5; text-align: left; visibility: hidden; opacity: 0; pointer-events: none; }
      #codex-decision-settings-panel .decision-help:hover .decision-help-text, #codex-decision-settings-panel .decision-help:focus-within .decision-help-text { display: block; visibility: visible; opacity: 1; pointer-events: auto; }
      #codex-decision-settings-panel .decision-help.help-dismissed .decision-help-text { display: none; visibility: hidden; opacity: 0; pointer-events: none; }
      #codex-decision-settings-panel .metric > span { display: flex; align-items: center; }
      #codex-decision-settings-panel .metric .decision-help { display: inline-flex; margin: 0 0 0 5px; }
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
    panel.innerHTML = `<div class="header"><h1>Decision</h1><button id="codex-decision-settings-open-logs" type="button">Open logs</button></div><section aria-label="Installation totals"><h2>All sessions</h2><div class="metrics"><div class="metric"><strong id="codex-decision-settings-lifetime-tokens">—</strong><span>Lines judged</span></div><div class="metric"><strong id="codex-decision-settings-lifetime-replaced">—</strong><span>Lines omitted by hook</span></div><div class="metric"><strong id="codex-decision-settings-lifetime-protected">—</strong><span>Protected locally</span></div><div class="metric"><strong id="codex-decision-settings-lifetime-calls">—</strong><span>Decision requests</span></div><div class="metric"><strong id="codex-decision-settings-lifetime-time">—</strong><span>Avg. request time</span></div></div></section><section><h2>Decision provider</h2><div class="field connection-field"><label for="codex-decision-settings-provider">Provider</label><select id="codex-decision-settings-provider" class="connection-input"><option value="openai">OpenAI Decisions</option><option value="typesafe">TypeSafe Jev</option><option value="custom">Custom provider</option></select></div><p class="connection-description" id="codex-decision-settings-connection-help"></p><div class="field connection-field connection-custom" hidden><label for="codex-decision-settings-name">Connection name</label><input id="codex-decision-settings-name" class="connection-input" type="text" maxlength="80" autocomplete="off" spellcheck="false" placeholder="My model provider"></div><div class="field connection-field connection-custom" hidden><label for="codex-decision-settings-protocol">JSON schema</label><select id="codex-decision-settings-protocol" class="connection-input"><option value="openai">OpenAI Decisions</option><option value="jev">TypeSafe Jev</option></select></div><div class="field connection-field connection-custom" hidden><label for="codex-decision-settings-endpoint">Endpoint URL</label><input id="codex-decision-settings-endpoint" class="connection-input" type="url" maxlength="2048" autocomplete="off" spellcheck="false" placeholder="https://provider.example/v1/decisions"></div><div class="field connection-field connection-custom" hidden><label for="codex-decision-settings-model">Model ID</label><input id="codex-decision-settings-model" class="connection-input" type="text" maxlength="128" autocomplete="off" spellcheck="false" placeholder="provider-model-id"></div><div class="field connection-field connection-custom" hidden><label for="codex-decision-settings-auth">Authentication</label><select id="codex-decision-settings-auth" class="connection-input"><option value="bearer">Bearer API key</option><option value="basic">Username and password</option><option value="header">API key header</option><option value="none">No authentication</option></select></div><div class="field connection-field connection-custom connection-username" hidden><label for="codex-decision-settings-username">Username</label><input id="codex-decision-settings-username" class="connection-input" type="text" maxlength="256" autocomplete="off" spellcheck="false" placeholder=""></div><div class="field connection-field connection-custom connection-header" hidden><label for="codex-decision-settings-header-name">Header name</label><input id="codex-decision-settings-header-name" class="connection-input" type="text" maxlength="128" autocomplete="off" spellcheck="false" placeholder="X-API-Key"></div><div class="field connection-field connection-key"><label for="codex-decision-settings-key">API key</label><input id="codex-decision-settings-key" class="connection-input" type="password" maxlength="4096" autocomplete="off" spellcheck="false" placeholder=""></div><div class="field connection-field connection-custom connection-password" hidden><label for="codex-decision-settings-password">Password</label><input id="codex-decision-settings-password" class="connection-input" type="password" maxlength="4096" autocomplete="off" spellcheck="false" placeholder=""></div><p class="connection-credential-help" id="codex-decision-settings-credential-help">Credentials stay private on this computer. Leave blank to keep the saved credential.</p><div class="provider-key-status"><small id="codex-decision-settings-openai-key-status"></small><small id="codex-decision-settings-typesafe-key-status"></small><small id="codex-decision-settings-custom-key-status"></small></div><div class="fallback-setting"><label for="codex-decision-settings-fallback"><input id="codex-decision-settings-fallback" type="checkbox">Use the other provider if needed</label><small>If the selected provider fails, allow tool output to be sent to the other provider with its saved key. Off by default.</small></div><div class="actions"><button id="codex-decision-settings-test" type="button">Test connection</button><span id="codex-decision-settings-test-status" role="status" aria-live="polite"></span></div></section><section><h2>Log retention</h2><div class="log-retention"><label for="codex-decision-settings-log-limit">Storage limit (MB)</label><input id="codex-decision-settings-log-limit" class="log-limit-input" type="text" inputmode="numeric" maxlength="4" aria-label="Log storage limit in MB"><label for="codex-decision-settings-never-delete"><input id="codex-decision-settings-never-delete" type="checkbox">Never delete logs</label></div><small>Oldest session log files are removed when the limit is reached.</small></section><section><h2>Behavior</h2><div class="field"><label for="codex-decision-settings-mode">Mode<small>Monitor previews per-line Decision decisions while leaving tool output unchanged. Filter shortens approved results.</small></label><select id="codex-decision-settings-mode"><option value="observe">Monitor</option><option value="replace">Filter</option></select></div><div id="codex-decision-settings-thresholds"></div></section><div class="actions save-actions"><button id="codex-decision-settings-save" type="button" class="primary">Save settings</button><button id="codex-decision-settings-reset" type="button" class="subtle" title="Restore the default settings in this form. Save to apply." disabled>Reset defaults</button></div><p id="codex-decision-settings-message" role="status" aria-live="polite"></p>`;
    moveHelp(".connection-description", panel.querySelector('label[for="codex-decision-settings-provider"]'), "provider");
    moveHelp(".connection-credential-help", panel.querySelector('label[for="codex-decision-settings-key"]'),
      "saved credentials", "Credentials stay on this device. Leave blank to keep the saved value.");
    moveHelp(".fallback-setting > small", panel.querySelector(".fallback-setting"), "provider fallback",
      "If this provider fails, send output to the other saved provider. Off by default.");
    moveHelp('section > small', panel.querySelector('label[for="codex-decision-settings-log-limit"]'),
      "log storage", "Remove the oldest logs at this limit. Saved originals stay available.");
    moveHelp('label[for="codex-decision-settings-mode"] small', panel.querySelector('label[for="codex-decision-settings-mode"]'),
      "mode", "Monitor keeps full output and shows line decisions. Filter shortens approved output. Delivery to Codex is unverified.");
    for (const metric of panel.querySelectorAll(".metric")) {
      const caption = metric.querySelector("span");
      caption.append(helpTip("Recorded activity across all sessions.", caption.textContent));
    }
    const thresholds = panel.querySelector("#codex-decision-settings-thresholds");
    for (const [hook, heading, fields] of sections) {
      const title = document.createElement("h2");
      title.textContent = heading;
      title.append(helpTip(sectionDescriptions[hook], heading, "", "section-description"));
      thresholds.append(title);
      for (const [name, label, help] of fields) {
        const id = `codex-decision-settings-${hook}-${name}`;
        const row = document.createElement("div");
        row.className = "field";
        const caption = document.createElement("label");
        caption.htmlFor = id;
        caption.textContent = label;
        caption.append(helpTip(help, label));
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
      try {
        const values = validateConnection();
        if (request("settingsTest", values)) { setBusy(true); showTest("Checking…"); showMessage(""); }
      } catch (error) { showTest(error.message, "error"); }
    });
    panel.querySelector("#codex-decision-settings-open-logs").addEventListener("click", () => {
      if (busy) return;
      if (request("settingsOpenLogs")) { setBusy(true); showMessage(""); }
    });
    for (const field of panel.querySelectorAll(".connection-input")) {
      const changed = () => {
        if (["endpoint", "auth", "username", "header-name"].some(name => field.id === `codex-decision-settings-${name}`)) {
          panel.querySelector("#codex-decision-settings-key").value = "";
          panel.querySelector("#codex-decision-settings-password").value = "";
        }
        testedConnection = null; pendingConnectionSave = null; showProviderKeys(); showTest("");
      };
      field.addEventListener("input", changed);
      field.addEventListener("change", changed);
    }
    panel.querySelector("#codex-decision-settings-provider").addEventListener("change", () => {
      panel.querySelector("#codex-decision-settings-key").value = "";
      panel.querySelector("#codex-decision-settings-password").value = "";
      showProviderKeys();
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
      panel.querySelector("#codex-decision-settings-fallback").checked = defaults.fallback_enabled === true;
      panel.querySelector("#codex-decision-settings-mode").value = defaults.mode;
      setThresholds(defaults.relevance_policy);
      panel.querySelector("#codex-decision-settings-log-limit").value = String(defaults.log_limit_mb);
      showNeverDeleteLogs(defaults.never_delete_logs);
      showMessage("Defaults ready. Save settings to apply.");
    });
    panel.querySelector("#codex-decision-settings-save").addEventListener("click", () => {
      if (busy) return;
      try {
        const connection = validateConnection();
        const mode = panel.querySelector("#codex-decision-settings-mode").value;
        const relevancePolicy = thresholdValues();
        const logLimitMb = parseLogLimit(panel.querySelector("#codex-decision-settings-log-limit").value);
        if (logLimitMb === null) throw new Error("Enter a log limit from 1 to 9999 MB.");
        const neverDeleteLogs = panel.querySelector("#codex-decision-settings-never-delete").checked;
        const payload = { ...connection, fallbackEnabled: panel.querySelector("#codex-decision-settings-fallback").checked, mode, relevancePolicy, logLimitMb, neverDeleteLogs };
        if (JSON.stringify(connection) !== savedConnection && JSON.stringify(connection) !== testedConnection) {
          pendingConnectionSave = payload;
          if (request("settingsTest", connection)) { setBusy(true); showTest("Checking connection before saving…"); showMessage(""); }
          else pendingConnectionSave = null;
        } else if (request("settingsSave", payload)) { setBusy(true); showMessage("Saving…"); }
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
      defaults = reply.defaults || null;
      setBusy(false);
      showLifetime(reply.lifetime);
      savedCustomProvider = reply.config?.custom_provider;
      loadConnection(savedCustomProvider);
      panel.querySelector("#codex-decision-settings-provider").value = reply.config?.provider || "openai";
      panel.querySelector("#codex-decision-settings-key").value = "";
      showProviderKeys(reply);
      savedConnection = JSON.stringify(connectionValues());
      panel.querySelector("#codex-decision-settings-fallback").checked = reply.config?.fallback_enabled === true;
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
      if (reply.result?.ok) {
        testedConnection = JSON.stringify(connectionValues());
        showTest("Connection verified", "ok");
        const payload = pendingConnectionSave;
        pendingConnectionSave = null;
        if (payload && request("settingsSave", payload)) { setBusy(true); showMessage("Saving…"); }
      }
      else {
        pendingConnectionSave = null;
        const reasons = { DECISION_HTTP_401: "Invalid", DECISION_KEY_EXPIRED: "Expired", DECISION_HTTP_403: "Rejected",
          DECISION_HTTP_429: "Rate limited", DECISION_TIMEOUT: "Timed out", DECISION_NETWORK_ERROR: "Network error",
          DECISION_INVALID_RESPONSE: "Invalid response", DECISION_KEY_MISSING: "No saved key",
          DECISION_KEY_INVALID: "Invalid", DECISION_INVALID_SETTINGS: "Check endpoint, model, and authentication", DECISION_CREDENTIAL_UNSAFE: "Credential file unavailable" };
        showTest(reasons[reply.result?.reason] || "Connection failed", "error");
      }
    } else if (action === "settingsSave" && reply.action === "saved") {
      savedLogLimit = parseLogLimit(panel.querySelector("#codex-decision-settings-log-limit").value) || 50;
      savedNeverDeleteLogs = panel.querySelector("#codex-decision-settings-never-delete").checked;
      panel.querySelector("#codex-decision-settings-key").value = "";
      panel.querySelector("#codex-decision-settings-password").value = "";
      savedCustomProvider = connectionValues().customProvider || savedCustomProvider;
      savedConnection = JSON.stringify(connectionValues());
      testedConnection = savedConnection;
      showProviderKeys(reply);
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
