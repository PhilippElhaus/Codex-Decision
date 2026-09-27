/* Jev settings inside the version-pinned Codex settings view. */
(() => {
  const sections = [
    ["output", "Output filter", [
      ["routine_min", "Routine noise, minimum", "Act only when Jev rates routine noise at least this high."],
      ["exact_max", "Exact text needed, maximum", "Keep output if the chance exact lines matter is higher."],
      ["unique_max", "Unique value, maximum", "Keep output if the chance of a one-time value is higher."],
    ]],
    ["test_build", "Test/build logs", [
      ["routine_min", "Routine lines, minimum", "Trim only when Jev rates omitted lines as routine."],
      ["exact_max", "Exact test text needed, maximum", "Keep lines when exact names or values may matter."],
      ["unique_max", "Unique value, maximum", "Keep lines when a unique result may be present."],
    ]],
    ["search_listing", "Search/listing", [
      ["summarize_probability_min", "Summarize probability, minimum", "Minimum probability for a group to be summarized."],
      ["summarize_confidence_min", "Summarize confidence, minimum", "Minimum confidence for summarizing a group."],
      ["drop_probability_min", "Drop probability, minimum", "Minimum probability for omitting a group."],
      ["drop_confidence_min", "Drop confidence, minimum", "Minimum confidence for omitting a group."],
    ]],
  ];
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
    const api = window.__codexJevApi;
    if (!api || pending) return false;
    const id = `jev-settings-${++nextId}`;
    pending = { id, action };
    api.postMessage({ type: "codex-jev", id, action, ...payload });
    return true;
  }

  function showMessage(value, kind = "") {
    const item = panel?.querySelector("#codex-jev-settings-message");
    if (item) { item.textContent = value; item.className = kind; }
  }

  function showTest(value, kind = "") {
    const item = panel?.querySelector("#codex-jev-settings-test-status");
    if (item) { item.textContent = value; item.className = kind; }
  }

  function setBusy(value) {
    busy = value;
    if (!panel) return;
    panel.querySelector("#codex-jev-settings-test").disabled = value;
    panel.querySelector("#codex-jev-settings-save").disabled = value;
    panel.querySelector("#codex-jev-settings-open-logs").disabled = value;
  }

  function formatDuration(milliseconds) {
    if (!milliseconds) return "—";
    return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
  }

  function showLifetime(stats = {}) {
    const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0).toLocaleString("en-US");
    panel.querySelector("#codex-jev-settings-lifetime-tokens").textContent = `~${count(stats.estimatedTokensSaved)}`;
    panel.querySelector("#codex-jev-settings-lifetime-replaced").textContent = count(stats.replaced);
    panel.querySelector("#codex-jev-settings-lifetime-calls").textContent = count(stats.calls);
    panel.querySelector("#codex-jev-settings-lifetime-time").textContent = formatDuration(stats.averageMs);
  }

  function thresholdValues() {
    const values = {};
    for (const [hook, , fields] of sections) {
      values[hook] = {};
      for (const [name] of fields) {
        const input = panel.querySelector(`#codex-jev-settings-${hook}-${name}`);
        if (!input.checkValidity() || !/^\d+$/.test(input.value.trim())) {
          input.focus();
          throw new Error("Enter whole percentages from 0 to 100.");
        }
        values[hook][name] = Number(input.value);
      }
    }
    return values;
  }

  function createPanel() {
    if (panel) return panel;
    const style = document.createElement("style");
    style.textContent = `
      [data-codex-jev-settings="true"][aria-selected="false"] { background: transparent !important; }
      [data-codex-jev-settings="true"][aria-selected="true"] { background: var(--vscode-list-activeSelectionBackground, #303030) !important; color: var(--vscode-list-activeSelectionForeground, #f3f3f3) !important; }
      nav[aria-label="Settings"]:has([data-codex-jev-settings="true"][aria-selected="true"]) button[aria-label="Voice"] { background: transparent !important; }
      #codex-jev-settings-panel { box-sizing: border-box; width: 100%; max-width: 740px; margin: 0 auto; padding: 28px 24px 56px; color: var(--vscode-foreground, #d0d0d0); font: 13px var(--vscode-font-family, sans-serif); }
      #codex-jev-settings-panel * { box-sizing: border-box; }
      #codex-jev-settings-panel .header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
      #codex-jev-settings-panel h1 { font-size: 24px; margin: 0; }
      #codex-jev-settings-panel h2 { font-size: 17px; margin: 26px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-panel-border, #333); }
      #codex-jev-settings-panel .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 9px; }
      #codex-jev-settings-panel .metric { min-width: 0; padding: 13px; border: 1px solid var(--vscode-panel-border, #3b3b3b); border-radius: 10px; background: #ffffff06; }
      #codex-jev-settings-panel .metric strong { display: block; font-size: 20px; font-weight: 650; line-height: 1.2; font-variant-numeric: tabular-nums; }
      #codex-jev-settings-panel .metric span { display: block; margin-top: 5px; color: var(--vscode-descriptionForeground, #999); font-size: 11px; line-height: 1.3; }
      #codex-jev-settings-panel p, #codex-jev-settings-panel small { color: var(--vscode-descriptionForeground, #999); line-height: 1.5; }
      #codex-jev-settings-panel .field { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 11px 0; }
      #codex-jev-settings-panel .field label { max-width: 540px; }
      #codex-jev-settings-panel small { display: block; margin-top: 3px; }
      #codex-jev-settings-panel input, #codex-jev-settings-panel select { background: var(--vscode-input-background, #181818); color: var(--vscode-input-foreground, #ddd); border: 1px solid var(--vscode-input-border, #555); border-radius: 9px; padding: 7px 9px; font: inherit; }
      #codex-jev-settings-panel input[type=number] { width: 76px; }
      #codex-jev-settings-panel input[type=password] { width: min(100%, 340px); }
      #codex-jev-settings-panel button { min-height: 36px; padding: 7px 12px; border: 1px solid var(--vscode-contrastBorder, #555); border-radius: 10px; background: var(--vscode-button-secondaryBackground, #282828); color: var(--vscode-button-secondaryForeground, #e5e5e5); font: inherit; cursor: pointer; }
      #codex-jev-settings-panel button:hover { background: var(--vscode-button-secondaryHoverBackground, #363636); }
      #codex-jev-settings-panel button.primary { border-color: transparent; background: #ececec; color: #202020; }
      #codex-jev-settings-panel button.primary:hover { background: #d6d6d6; }
      #codex-jev-settings-panel button:focus-visible, #codex-jev-settings-panel select:focus-visible, #codex-jev-settings-panel input:focus-visible { outline: 2px solid var(--vscode-focusBorder, #83bcf7); outline-offset: 2px; }
      #codex-jev-settings-panel button:disabled { opacity: .55; cursor: default; }
      #codex-jev-settings-panel .actions { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
      #codex-jev-settings-test-status { font-size: 12px; font-weight: 600; }
      #codex-jev-settings-panel .ok { color: var(--vscode-testing-iconPassed, #4ec97f); }
      #codex-jev-settings-panel .error { color: var(--vscode-errorForeground, #f48771); }
      #codex-jev-settings-message { min-height: 22px; margin-top: 12px; }
      @media (max-width: 650px) { #codex-jev-settings-panel .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } #codex-jev-settings-panel .field { display: block; } #codex-jev-settings-panel input, #codex-jev-settings-panel select { margin-top: 8px; } }
    `;
    document.head.append(style);
    panel = document.createElement("div");
    panel.id = "codex-jev-settings-panel";
    panel.innerHTML = `<div class="header"><h1>Jev</h1><button id="codex-jev-settings-open-logs" type="button">Open logs</button></div><section aria-label="Lifetime activity"><h2>Lifetime</h2><div class="metrics"><div class="metric"><strong id="codex-jev-settings-lifetime-tokens">—</strong><span>Estimated tokens saved</span></div><div class="metric"><strong id="codex-jev-settings-lifetime-replaced">—</strong><span>Results shortened</span></div><div class="metric"><strong id="codex-jev-settings-lifetime-calls">—</strong><span>Jev checks</span></div><div class="metric"><strong id="codex-jev-settings-lifetime-time">—</strong><span>Avg. decision time</span></div></div></section><section><h2>API key</h2><div class="field"><label for="codex-jev-settings-key">API key</label><input id="codex-jev-settings-key" type="password" autocomplete="off" spellcheck="false" maxlength="4096"></div><div class="actions"><button id="codex-jev-settings-test" type="button">Test API key</button><span id="codex-jev-settings-test-status" role="status" aria-live="polite"></span></div></section><section><h2>Behavior</h2><div class="field"><label for="codex-jev-settings-mode">Mode<small>Monitor keeps output · Filter shortens it.</small></label><select id="codex-jev-settings-mode"><option value="observe">Monitor</option><option value="replace">Filter</option></select></div><div id="codex-jev-settings-thresholds"></div></section><div class="actions"><button id="codex-jev-settings-save" type="button" class="primary">Save settings</button></div><p id="codex-jev-settings-message" role="status" aria-live="polite"></p>`;
    const thresholds = panel.querySelector("#codex-jev-settings-thresholds");
    for (const [hook, heading, fields] of sections) {
      const title = document.createElement("h2");
      title.textContent = heading;
      thresholds.append(title);
      for (const [name, label, help] of fields) {
        const id = `codex-jev-settings-${hook}-${name}`;
        const row = document.createElement("div");
        row.className = "field";
        const caption = document.createElement("label");
        caption.htmlFor = id;
        caption.textContent = `${label} (%)`;
        caption.title = help;
        const input = document.createElement("input");
        input.id = id;
        input.type = "number";
        input.min = "0";
        input.max = "100";
        input.step = "1";
        input.required = true;
        input.title = help;
        row.append(caption, input);
        thresholds.append(row);
      }
    }
    panel.querySelector("#codex-jev-settings-test").addEventListener("click", () => {
      if (busy) return;
      const key = panel.querySelector("#codex-jev-settings-key").value.trim();
      if (!key && !hasKey) { showTest("Missing", "error"); return; }
      if (request("settingsTest", { key })) { setBusy(true); showTest("Checking…"); showMessage(""); }
    });
    panel.querySelector("#codex-jev-settings-open-logs").addEventListener("click", () => {
      if (busy) return;
      if (request("settingsOpenLogs")) { setBusy(true); showMessage(""); }
    });
    panel.querySelector("#codex-jev-settings-key").addEventListener("input", () => showTest(""));
    panel.querySelector("#codex-jev-settings-save").addEventListener("click", () => {
      if (busy) return;
      try {
        const key = panel.querySelector("#codex-jev-settings-key").value.trim();
        const mode = panel.querySelector("#codex-jev-settings-mode").value;
        const thresholds = thresholdValues();
        if (request("settingsSave", { key, mode, thresholds })) {
          setBusy(true); showMessage("Saving…"); showTest("");
        }
      } catch (error) { showMessage(error.message, "error"); }
    });
    return panel;
  }

  function handleReply(data) {
    if (!pending || data?.type !== "codex-jev-reply" || data.id !== pending.id) return;
    const action = pending.action;
    pending = null;
    setBusy(false);
    const reply = data.status?.settings;
    if (!reply || reply.action === "error") {
      showMessage(reply?.message || "Jev settings are unavailable.", "error");
      return;
    }
    if (action === "settingsRead" && reply.action === "ready") {
      hasKey = Boolean(reply.hasKey);
      panel.querySelector("#codex-jev-settings-key").placeholder = hasKey ? "••••••••" : "Enter API key";
      showLifetime(reply.lifetime);
      panel.querySelector("#codex-jev-settings-mode").value = reply.config?.mode || "replace";
      for (const [hook, , fields] of sections) {
        for (const [name] of fields) {
          panel.querySelector(`#codex-jev-settings-${hook}-${name}`).value =
            reply.config?.thresholds?.[hook]?.[name] ?? "";
        }
      }
    } else if (action === "settingsTest" && reply.action === "tested") {
      if (reply.result?.ok) showTest("OK", "ok");
      else {
        const reasons = { JEV_HTTP_401: "Invalid", JEV_KEY_EXPIRED: "Expired", JEV_HTTP_403: "Rejected",
          JEV_HTTP_429: "Rate limited", JEV_TIMEOUT: "Timed out", JEV_NETWORK_ERROR: "Network error",
          JEV_INVALID_RESPONSE: "Invalid response" };
        showTest(reasons[reply.result?.reason] || "Connection failed", "error");
      }
    } else if (action === "settingsSave" && reply.action === "saved") {
      hasKey = true;
      panel.querySelector("#codex-jev-settings-key").value = "";
      panel.querySelector("#codex-jev-settings-key").placeholder = "••••••••";
      showMessage("Settings saved.", "ok");
    }
  }

  function restoreContent() {
    if (hiddenContent) hiddenContent.style.display = hiddenDisplay;
    hiddenContent = null;
    panel?.remove();
    if (navItem) { navItem.setAttribute("aria-selected", "false"); navItem.tabIndex = -1; }
  }

  function sync() {
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
      navItem.setAttribute("data-codex-jev-settings", "true");
      navItem.setAttribute("aria-label", "Jev");
      const label = [...navItem.querySelectorAll("*")].reverse().find((item) => item.textContent.trim() === "Voice");
      if (label) label.textContent = "Jev";
      else navItem.textContent = "Jev";
      const icon = navItem.querySelector("svg");
      if (icon) {
        const image = document.createElement("img");
        image.src = "./assets/jev-icon.png";
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
          if (!request("settingsRead")) showMessage("Jev settings are unavailable.", "error");
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
      if (!active || openingVoice || event.target.closest('[data-codex-jev-settings="true"]')) return;
      if (event.target.closest('nav[aria-label="Settings"] button,[role="tab"],a[href*="/settings/"]')) {
        active = false;
        restoreContent();
      }
    }, true);
    window.addEventListener("message", (event) => handleReply(event.data));
    new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, characterData: true });
    window.addEventListener("popstate", schedule);
    setInterval(schedule, 400);
    schedule();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
