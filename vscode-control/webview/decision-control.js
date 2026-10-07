/* Local Codex composer control. Key setup uses the local extension bridge. */
(() => {
  const acquire = window.acquireVsCodeApi;
  if (typeof acquire !== "function") return;
  window.acquireVsCodeApi = function (...args) {
    const api = acquire.apply(this, args);
    window.__codexDecisionApi = api;
    return api;
  };

  let state = { enabled: false, needsKey: false, health: null, hookHealth: null, panelFault: null, configurationError: null, sessionPending: true, classificationPulse: 0, mode: "replace", recent: "No decision recorded yet", history: [], stats: {} };
  let pulseSeen = 0;
  let pulseUntil = 0;
  let pulseTimer;
  let root;
  let setup;
  let setupDismissed = false;
  let keyRequestId = 0;
  let externalRequestId = 0;
  let pending = 0;
  let lastAppliedReply = 0;
  let retryRequestId = 0;
  let layoutObserver;
  let observed = [];
  let positionScheduled = false;
  let compactAtWidth = 0;
  let seenModel = false;
  let viewId = newViewId();
  let viewLocation = null;
  let bridgeFault = null;
  let bridgeWaitingSince = Date.now();
  const requestTimeoutMs = 10000;
  const sentViews = new Map();
  const colors = { healthy: "#87cda4", failed: "#e99490", pending: "#e6bc6a", classifying: "#69aef0" };

  function sessionId() {
    const route = document.documentElement.dataset;
    if (route.codexDecisionRouteKind) {
      return route.codexDecisionRouteKind === "local" && /^[A-Za-z0-9._-]{1,128}$/.test(route.codexDecisionSessionId || "")
        ? route.codexDecisionSessionId : null;
    }
    const match = window.location.pathname.match(/^\/local\/([A-Za-z0-9._-]{1,128})\/?$/) ||
      window.location.pathname.match(/^\/hotkey-window\/thread\/([A-Za-z0-9._-]{1,128})\/?$/);
    return match?.[1] || null;
  }

  function expectsLocalSession() {
    const route = document.documentElement.dataset.codexDecisionRouteKind;
    if (route) return route === "local";
    return /^\/(?:local\/|hotkey-window\/thread\/)/.test(window.location.pathname);
  }

  window.__codexDecisionSessionId = sessionId;
  window.__codexDecisionViewId = currentViewId;

  function newViewId() {
    return `view-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  }

  function currentViewId() {
    const route = document.documentElement.dataset;
    const location = `${window.location.href}\0${route.codexDecisionRouteKind || ""}\0${sessionId() || ""}`;
    if (location !== viewLocation) {
      viewLocation = location;
      viewId = newViewId();
      retryRequestId = 0;
      keyRequestId = 0;
      externalRequestId = 0;
      bridgeFault = null;
      bridgeWaitingSince = Date.now();
      setupDismissed = false;
      pulseSeen = 0;
      pulseUntil = 0;
      clearTimeout(pulseTimer);
      state = { ...state, enabled: false, needsKey: false, health: null, hookHealth: null,
        sessionPending: !sessionId(), configurationError: null, classificationPulse: 0,
        recent: "No decision recorded yet", history: [], stats: {} };
      render();
    }
    return viewId;
  }

  function send(action, enabled, key) {
    const api = window.__codexDecisionApi;
    if (!api) return 0;
    const id = ++pending;
    const current = currentViewId();
    sentViews.set(id, { viewId: current, action, expires: Date.now() + requestTimeoutMs });
    if (sentViews.size > 50) sentViews.delete(sentViews.keys().next().value);
    api.postMessage({ type: "codex-decision", action, enabled, focused: document.hasFocus() && document.visibilityState === "visible", ...(key === undefined ? {} : { key, provider: setup?.querySelector("#codex-decision-provider")?.value || state.provider || "openai" }), viewId: current, sessionId: sessionId(), expectsLocalSession: expectsLocalSession(), id });
    return id;
  }

  function expireRequests() {
    const current = currentViewId();
    let timedOut = bridgeWaitingSince !== null && Date.now() - bridgeWaitingSince >= requestTimeoutMs;
    for (const [id, request] of sentViews) {
      if (Date.now() < request.expires) continue;
      sentViews.delete(id);
      if (request.viewId !== current) continue;
      if (request.action === "status" && id < lastAppliedReply) continue;
      timedOut = true;
      if (id === retryRequestId) retryRequestId = 0;
      if (id === externalRequestId) externalRequestId = 0;
      if (id === keyRequestId) {
        keyRequestId = 0;
        setup.querySelector("#codex-decision-provider").disabled = false;
        setup.querySelector("#codex-decision-test-key").disabled = false;
        setup.querySelector("#codex-decision-save-key").disabled = false;
        showKeyStatus("Decision controls did not respond. Try again.", false);
      }
    }
    if (timedOut) {
      bridgeFault = "Decision controls did not respond. Reload VS Code and retry.";
      render();
    }
  }

  function healthReason(reason) {
    const known = {
      DECISION_KEY_MISSING: "API key missing or unreadable",
      DECISION_HTTP_401: "API key rejected",
      DECISION_HTTP_403: "Access denied",
      DECISION_HTTP_429: "Rate limited",
      DECISION_HTTP_529: "Decision overloaded",
      DECISION_TIMEOUT: "Connection timed out",
      DECISION_NETWORK_ERROR: "Network connection failed",
      DECISION_INVALID_RESPONSE: "Invalid Decision response",
      DECISION_CONFIG_ERROR: "Configuration error",
      DECISION_UNAVAILABLE: "Connection check failed",
      BRIDGE_UNAVAILABLE: "VS Code bridge unavailable",
    };
    return known[reason] || (/^DECISION_HTTP_\d{3}$/.test(reason || "")
      ? `API error ${reason.slice(-3)}` : "Connection check failed");
  }

  function keyResult(result) {
    if (result?.ok) return { text: "OK", ok: true };
    const labels = {
      DECISION_KEY_MISSING: "Enter a valid key", DECISION_HTTP_401: "Invalid", DECISION_KEY_EXPIRED: "Expired",
      DECISION_HTTP_403: "Access denied", DECISION_HTTP_429: "Rate limited", DECISION_TIMEOUT: "Timed out",
      DECISION_NETWORK_ERROR: "Network error", DECISION_INVALID_RESPONSE: "Invalid response",
    };
    return { text: labels[result?.reason] || "Connection failed", ok: false };
  }

  function showKeyStatus(text, ok) {
    const label = setup.querySelector("#codex-decision-key-status");
    label.textContent = text;
    label.dataset.ok = String(ok);
  }

  function requestKey(action) {
    if (keyRequestId) return;
    const key = setup.querySelector("#codex-decision-key").value;
    if (key.length < 8 || key.length > 4096 || /\s|\0/.test(key)) {
      showKeyStatus("Enter a valid key", false);
      return;
    }
    keyRequestId = send(action, undefined, key);
    if (!keyRequestId) {
      showKeyStatus("Connection unavailable", false);
      return;
    }
    setup.querySelector("#codex-decision-provider").disabled = true;
    setup.querySelector("#codex-decision-test-key").disabled = true;
    setup.querySelector("#codex-decision-save-key").disabled = true;
    showKeyStatus(action === "testApiKey" ? "Testing…" : "Saving…", false);
  }

  function formatDuration(elapsedMs) {
    const milliseconds = Math.max(0, Number(elapsedMs) || 0);
    return milliseconds >= 1000
      ? `${(Math.floor(milliseconds / 100) / 10).toFixed(1).replace(".", ",")}s`
      : `${Math.round(milliseconds)} ms`;
  }

  function create() {
    if (root) return root;
    const style = document.createElement("style");
    style.textContent = `
      #codex-decision { position: fixed; z-index: 2147483600; display: none; font-family: inherit; }
      #codex-decision * { box-sizing: border-box; }
      #codex-decision-button { display: inline-flex; align-items: center; gap: 7px; height: var(--codex-decision-button-height, 34px); min-height: 0; max-height: var(--codex-decision-button-height, 34px); padding: 0 12px; border: 0; border-radius: 999px; background: transparent; color: #9a9a9a; font-family: inherit; font-size: 14px; font-weight: 600; line-height: 18px; cursor: pointer; transition: color 220ms ease-in-out, background-color 220ms ease-in-out; }
      #codex-decision[data-compact="true"] #codex-decision-button { gap: 0; padding: 0 var(--codex-decision-compact-padding, 4px); }
      #codex-decision[data-compact="true"] #codex-decision-label { display: none; }
      #codex-decision-observe { display: none; margin-left: 2px; padding: 1px 3px; border: 1px solid #9a9a9a77; border-radius: 3px; color: #bdbdbd; font-size: 9px; font-weight: 700; line-height: 12px; letter-spacing: .04em; }
      #codex-decision[data-observe="true"] #codex-decision-observe { display: inline-block; }
      #codex-decision[data-compact="true"] #codex-decision-observe { display: none; }
      #codex-decision-button:disabled { cursor: default; }
      #codex-decision-button:hover { background: #303030; }
      #codex-decision-button:focus-visible { outline: 2px solid #83bcf7; outline-offset: 2px; }
      #codex-decision[data-classifying="true"] #codex-decision-dot { box-shadow: 0 0 0 3px #69aef044, 0 0 9px #69aef0aa; }
      #codex-decision-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 15%, transparent); transition: box-shadow 220ms ease-in-out; }
      #codex-decision-tip { position: absolute; bottom: calc(100% + 9px); right: 0; box-shadow: 0 12px 30px #0009; }
      #codex-decision-tip { display: none; width: min(420px, calc(100vw - 24px)); padding: 11px 13px; border: 1px solid #454545; border-radius: 11px; background: #292929; color: #dedede; pointer-events: auto; font-size: 12px; line-height: 1.45; white-space: normal; }
      #codex-decision-tip[data-needs-key="true"] { width: min(252px, calc(100vw - 24px)); padding: 9px 11px; }
      #codex-decision-tip[data-needs-key="true"] #codex-decision-session-heading, #codex-decision-tip[data-needs-key="true"] #codex-decision-stats, #codex-decision-tip[data-needs-key="true"] #codex-decision-tokens, #codex-decision-tip[data-needs-key="true"] #codex-decision-history-heading, #codex-decision-tip[data-needs-key="true"] #codex-decision-history, #codex-decision-tip[data-needs-key="true"] #codex-decision-empty { display: none !important; }
      #codex-decision-tip::after { content: ""; position: absolute; top: 100%; left: 0; right: 0; height: 10px; }
      #codex-decision:hover #codex-decision-tip, #codex-decision:focus-within #codex-decision-tip { display: block; }
      #codex-decision[data-no-session="true"] #codex-decision-tip { display: none !important; }
      #codex-decision-health-row { display: flex; align-items: center; gap: 8px; min-height: 20px; }
      #codex-decision-health-row[hidden] { display: none; }
      #codex-decision-health-row strong { color: #fff; white-space: nowrap; }
      #codex-decision-health-reason { display: none; color: #e99490; margin: 4px 0 0; overflow-wrap: anywhere; }
      #codex-decision-retry { display: none; margin-left: auto; padding: 2px 7px; border: 1px solid #666; border-radius: 8px; background: #383838; color: #eee; font: inherit; cursor: pointer; }
      #codex-decision-retry:hover { background: #484848; }
      #codex-decision-retry:disabled { opacity: .6; cursor: default; }
      #codex-decision-retry:focus-visible { outline: 2px solid #83bcf7; outline-offset: 2px; }
      #codex-decision-stats { color: #d4d4d4; }
      #codex-decision-tokens { margin-top: 3px; color: #d4d4d4; }
      #codex-decision-tip h3 { margin: 10px 0 4px; color: #aaa; font-size: 11px; font-weight: 650; letter-spacing: .04em; }
      #codex-decision-health-row[hidden] + #codex-decision-session-heading { margin-top: 0; }
      #codex-decision-history { margin: 0; padding-left: 18px; color: #d4d4d4; }
      #codex-decision-history li { margin-top: 3px; }
      #codex-decision-history strong { font-weight: 700; color: #fff; }
      #codex-decision-empty { margin: 0; color: #888; }
      #codex-decision-connect { position: fixed; inset: 0; z-index: 2147483640; display: none; align-items: center; justify-content: center; box-sizing: border-box; overflow: auto; padding: 16px; background: var(--vscode-editor-background, #111); color: var(--vscode-foreground, #d0d0d0); font-family: inherit; isolation: isolate; container-type: inline-size; }
      #codex-decision-connect * { box-sizing: border-box; }
      #codex-decision-connect-art { position: absolute; inset: 0; overflow: hidden; pointer-events: none; mask-image: radial-gradient(ellipse at center, #000 20%, #0009 48%, transparent 80%); }
      #codex-decision-connect-art pre { position: absolute; top: 50%; left: 50%; margin: 0; color: #bdc9d3; opacity: .18; font: 12px/18px monospace; letter-spacing: 2px; white-space: pre; animation: codex-decision-art-drift 14s ease-in-out infinite alternate; }
      @keyframes codex-decision-art-drift { from { transform: translate(-52%, -51%) rotate(-2deg); } to { transform: translate(-48%, -49%) rotate(2deg); } }
      @media (prefers-reduced-motion: reduce) { #codex-decision-connect-art pre { animation: none; transform: translate(-50%, -50%); } }
      #codex-decision-connect-card { position: relative; width: min(100%, 440px); min-width: 0; margin: auto; padding: 24px; border: 1px solid var(--vscode-panel-border, #3c3c3c); border-radius: 12px; background: var(--vscode-editor-background, #1b1b1b); box-shadow: 0 20px 60px #0008; }
      #codex-decision-connect-heading { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
      #codex-decision-connect h1 { margin: 0; font-size: clamp(26px, 5vw, 32px); line-height: 1.2; }
      #codex-decision-connect-icon { width: 34px; height: 34px; object-fit: contain; flex: none; }
      #codex-decision-connect p { margin: 0 0 22px; color: var(--vscode-descriptionForeground, #999); font-size: 14px; line-height: 1.5; }
      #codex-decision-connect label { display: block; margin-bottom: 6px; font-size: 14px; }
      #codex-decision-provider, #codex-decision-key { width: 100%; height: 40px; padding: 8px 10px; border: 1px solid var(--vscode-input-border, #555); border-radius: 8px; outline: none; background: var(--vscode-input-background, #202020); color: var(--vscode-input-foreground, #ddd); font: inherit; }
      #codex-decision-provider { margin-bottom: 12px; }
      #codex-decision-key:focus { border-color: var(--vscode-focusBorder, #e4a900); }
      #codex-decision-connect-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
      #codex-decision-connect button { min-height: 34px; padding: 6px 12px; border: 1px solid var(--vscode-contrastBorder, #707070); border-radius: 8px; background: var(--vscode-button-secondaryBackground, #262626); color: var(--vscode-button-secondaryForeground, #ddd); font: inherit; cursor: pointer; }
      #codex-decision-connect button:hover { background: var(--vscode-button-secondaryHoverBackground, #353535); }
      #codex-decision-connect button:focus-visible { outline: 2px solid var(--vscode-focusBorder, #83bcf7); outline-offset: 2px; }
      #codex-decision-connect button:disabled { opacity: .55; cursor: default; }
      #codex-decision-connect-footer { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
      #codex-decision-connect-footer button { white-space: nowrap; }
      #codex-decision-skip-key { margin-left: auto; }
      #codex-decision-connect-link { margin: 16px 0 0 !important; text-align: center; font-size: 12px !important; }
      #codex-decision-connect-link a { color: var(--vscode-textLink-foreground, #83bcf7); text-decoration: none; }
      #codex-decision-connect-link a:hover { text-decoration: underline; }
      #codex-decision-connect-link a:focus-visible { outline: 2px solid var(--vscode-focusBorder, #83bcf7); outline-offset: 2px; }
      #codex-decision-connect #codex-decision-save-key { border-color: transparent; background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
      #codex-decision-connect #codex-decision-save-key:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
      @container (max-width: 420px) { #codex-decision-connect-card { padding: 20px; } #codex-decision-connect-heading { gap: 8px; } #codex-decision-connect h1 { font-size: 24px; white-space: nowrap; } #codex-decision-connect-icon { width: 32px; height: 32px; } #codex-decision-connect-footer { display: grid; grid-template-columns: minmax(0, 1fr); } #codex-decision-connect-footer button { width: 100%; } #codex-decision-skip-key { margin-left: 0; } }
      @container (max-width: 300px) { #codex-decision-connect-card { padding: 16px; } #codex-decision-connect h1 { font-size: 20px; } #codex-decision-connect-icon { width: 28px; height: 28px; } }
      #codex-decision-key-status { min-width: 0; font-size: 12px; font-weight: 600; }
      #codex-decision-key-status[data-ok="true"] { color: var(--vscode-testing-iconPassed, #4ec97f); }
      #codex-decision-key-status[data-ok="false"] { color: var(--vscode-errorForeground, #f48771); }
    `;
    document.head.appendChild(style);
    root = document.createElement("div");
    root.id = "codex-decision";
    root.innerHTML = `
      <button id="codex-decision-button" type="button" role="switch" aria-label="Turn Decision on" aria-checked="false"><span id="codex-decision-dot"></span><span id="codex-decision-label">decision</span><span id="codex-decision-observe">MON</span></button>
      <div id="codex-decision-tip" role="group" aria-label="Decision activity"><div id="codex-decision-health-row"><strong></strong><button id="codex-decision-retry" type="button">Retry</button></div><p id="codex-decision-health-reason"></p><h3 id="codex-decision-session-heading">This session</h3><div id="codex-decision-stats"></div><div id="codex-decision-tokens"></div><h3 id="codex-decision-history-heading">Recent Actions</h3><ol id="codex-decision-history"></ol><p id="codex-decision-empty">None yet</p></div>`;
    document.body.appendChild(root);
    setup = document.createElement("div");
    setup.id = "codex-decision-connect";
    setup.setAttribute("role", "dialog");
    setup.setAttribute("aria-modal", "true");
    setup.setAttribute("aria-labelledby", "codex-decision-connect-title");
    setup.innerHTML = `<div id="codex-decision-connect-art" aria-hidden="true"><pre></pre></div><div id="codex-decision-connect-card"><div id="codex-decision-connect-heading"><h1 id="codex-decision-connect-title">Connect Decision</h1><img id="codex-decision-connect-icon" src="./assets/decision-icon.png" alt=""></div><p>Choose a provider and enter its API key.</p><label for="codex-decision-provider">Provider</label><select id="codex-decision-provider"><option value="openai">OpenAI Decisions</option><option value="typesafe">TypeSafe Jev</option></select><label for="codex-decision-key">API key</label><input id="codex-decision-key" type="password" autocomplete="off" spellcheck="false" maxlength="4096"><div id="codex-decision-connect-actions"><button id="codex-decision-test-key" type="button">Test API key</button><span id="codex-decision-key-status" role="status" aria-live="polite"></span></div><div id="codex-decision-connect-footer"><button id="codex-decision-save-key" type="button">Save API key</button><button id="codex-decision-skip-key" type="button">Skip for now</button></div><p id="codex-decision-connect-link">Need a key? <a href="https://platform.openai.com/api-keys" rel="noopener noreferrer">Get a provider API key</a></p></div>`;
    document.body.appendChild(setup);
    setup.querySelector("#codex-decision-provider").addEventListener("change", () => {
      setup.querySelector("#codex-decision-key").value = "";
      const selected = setup.querySelector("#codex-decision-provider").value;
      setup.querySelector("#codex-decision-connect-link a").href = selected === "typesafe" ? "https://typesafe.ai/" : "https://platform.openai.com/api-keys";
      showKeyStatus("", false);
    });
    setup.querySelector("#codex-decision-connect-art pre").textContent = Array.from({ length: 48 }, (_, row) =>
      Array.from({ length: 76 }, (_, column) => {
        const value = Math.abs(Math.sin(row * 19.31 + column * 37.17) * 10000) % 1;
        return value > .88 ? "*" : value > .73 ? "+" : value > .5 ? "·" : " ";
      }).join("")).join("\n");
    setup.addEventListener("click", (event) => event.stopPropagation());
    setup.addEventListener("keydown", (event) => event.stopPropagation());
    setup.querySelector("#codex-decision-key").addEventListener("input", () => showKeyStatus("", false));
    setup.querySelector("#codex-decision-test-key").addEventListener("click", () => requestKey("testApiKey"));
    setup.querySelector("#codex-decision-save-key").addEventListener("click", () => requestKey("saveApiKey"));
    setup.querySelector("#codex-decision-connect-link a").addEventListener("click", (event) => {
      event.preventDefault();
      externalRequestId = send("openProvider", undefined, "");
      if (!externalRequestId) showKeyStatus("Could not open browser", false);
    });
    setup.querySelector("#codex-decision-skip-key").addEventListener("click", () => {
      setupDismissed = true;
      setup.querySelector("#codex-decision-key").value = "";
      showKeyStatus("", false);
      render();
    });
    root.querySelector("#codex-decision-button").addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.currentTarget.disabled) return;
      send("setSelection", !state.enabled);
      render();
    });
    root.querySelector("#codex-decision-retry").addEventListener("click", (event) => {
      event.stopPropagation();
      if (state.needsKey) {
        setupDismissed = false;
        render();
        return;
      }
      if (retryRequestId) return;
      retryRequestId = send("retryConnection");
      render();
    });
    render();
    return root;
  }

  function render() {
    if (!root) return;
    const needsSetup = Boolean(state.enabled && state.needsKey);
    if (!needsSetup) setupDismissed = false;
    const showSetup = needsSetup && !setupDismissed;
    const wasVisible = setup.style.display === "flex";
    setup.style.display = showSetup ? "flex" : "none";
    if (showSetup && !wasVisible) {
      setup.querySelector("#codex-decision-provider").value = state.provider || "openai";
      setup.querySelector("#codex-decision-provider").dispatchEvent(new Event("change"));
      queueMicrotask(() => setup.querySelector("#codex-decision-key").focus());
    }
    const button = root.querySelector("#codex-decision-button");
    const noSession = state.sessionPending ||
      state.configurationError === "Codex session could not be identified";
    root.dataset.noSession = String(noSession);
    const saving = [...sentViews.values()].some((request) =>
      request.viewId === viewId && request.action === "setSelection");
    button.disabled = noSession || saving;
    button.setAttribute("aria-busy", String(saving));
    button.setAttribute("aria-checked", String(state.enabled));
    root.dataset.enabled = String(state.enabled);
    button.title = noSession ? "Open a local Codex thread to turn Decision on or off." :
      saving ? "Saving…" : state.enabled ? "Turn Decision off" : "Turn Decision on";
    const hook = state.hookHealth;
    const seen = Number(hook?.last_seen_ms) >= Number(state.viewStartedAt || Infinity);
    const versionMismatch = seen && hook.hook_version !== state.expectedHookVersion;
    const hookFailed = hook?.fault || (seen && Number(hook.last_error_ms || 0) >= Number(state.viewStartedAt || Infinity) &&
      Number(hook.last_error_ms || 0) > Number(hook.last_success_ms || 0));
    const choiceKeptFull = seen && hook?.last_skip === "choice_kept_full_output" &&
      Number(hook.last_skip_ms || 0) >= Number(hook.last_success_ms || 0) &&
      Number(hook.last_skip_ms || 0) >= Number(state.viewStartedAt || Infinity);
    const hookWaiting = state.enabled && !noSession && !seen &&
      Date.now() - Number(state.viewStartedAt || Date.now()) >= 60_000;
    const failed = Boolean(bridgeFault) || state.health?.ok === false;
    const visual = failed ? "failed" : state.health?.ok === true ? "healthy" : "pending";
    const classifying = Boolean(state.enabled && !noSession && !bridgeFault && Date.now() < pulseUntil);
    root.dataset.classifying = String(classifying);
    button.style.color = classifying ? colors.classifying :
      state.enabled || bridgeFault ? colors[visual] : "#9a9a9a";
    const observe = String(state.enabled && state.mode === "observe");
    if (root.dataset.observe !== observe) {
      root.dataset.observe = observe;
      schedulePosition();
    }
    const status = bridgeFault ? "Decision control unavailable" : state.health?.ok === false ? "Decision API unavailable" :
      state.health?.ok === true ? "Decision API connected" : "Checking Decision API";
    const checking = !bridgeFault && state.health?.ok !== true && state.health?.ok !== false;
    root.querySelector("#codex-decision-tip").dataset.needsKey = String(needsSetup);
    const healthRow = root.querySelector("#codex-decision-health-row");
    healthRow.hidden = !failed && !checking && !needsSetup && !state.configurationError && !state.panelFault &&
      !hookFailed && !versionMismatch && !choiceKeptFull && !hookWaiting;
    healthRow.querySelector("strong").textContent = healthRow.hidden ? "" :
      bridgeFault ? status : state.configurationError ? "Decision configuration error" : state.panelFault ? "Decision view unavailable" :
      versionMismatch ? "Decision hook version mismatch" : hookFailed ? "Decision hook failed" :
      hookWaiting && !failed && !checking && !needsSetup ? "No Decision hook activity" :
      needsSetup ? "Decision API key required" : status;
    const unavailable = failed || Boolean(state.configurationError || state.panelFault || hookFailed || versionMismatch);
    const reason = root.querySelector("#codex-decision-health-reason");
    reason.textContent = (unavailable || choiceKeptFull || hookWaiting) && !needsSetup ? `${bridgeFault || state.configurationError || state.panelFault ||
      (versionMismatch ? "Update the Decision plugin and control together" :
        hookFailed ? (hook.fault || hook.last_error || "Tool output was left unchanged") :
        choiceKeptFull ? "Choice kept the latest output complete" :
          hookWaiting && !failed && !checking ? "Run a local command. If activity stays empty, check /hooks and reload VS Code." : healthReason(state.health?.reason))}` : "";
    reason.style.display = (unavailable || choiceKeptFull || hookWaiting) && !needsSetup ? "block" : "none";
    const retry = root.querySelector("#codex-decision-retry");
    retry.style.display = bridgeFault || (!state.configurationError && (needsSetup || state.health?.ok === false)) ? "inline-block" : "none";
    retry.disabled = Boolean(retryRequestId);
    retry.textContent = needsSetup ? "Connect" : retryRequestId ? "Checking…" : "Retry";
    const stats = state.stats || {};
    const completed = Number(stats.completed) || 0;
    const average = completed ? formatDuration((Number(stats.elapsedMs) || 0) / completed) : "—";
    const totals = `${completed} checked · ${Number(stats.replaced) || 0} replaced · ${average} avg`;
    root.querySelector("#codex-decision-stats").textContent = state.enabled ? totals : "";
    const tokens = `Tokens saved: ~${(Number(stats.estimatedTokensSaved) || 0).toLocaleString("en-US")}`;
    root.querySelector("#codex-decision-tokens").textContent = state.enabled ? tokens : "";
    root.querySelector("#codex-decision-session-heading").style.display = state.enabled ? "block" : "none";
    root.querySelector("#codex-decision-history-heading").style.display = state.enabled ? "block" : "none";
    const history = Array.isArray(state.history) ? state.history.slice(0, 3) : [];
    const list = root.querySelector("#codex-decision-history");
    list.style.display = state.enabled ? "block" : "none";
    list.replaceChildren(...history.map((line) => {
      const item = document.createElement("li");
      const match = String(line).match(/^(.*) · (-\d+%)$/);
      if (match) {
        item.append(document.createTextNode(`${match[1]} · `));
        const reduction = document.createElement("strong");
        reduction.textContent = match[2];
        item.append(reduction);
      } else {
        item.textContent = String(line);
      }
      return item;
    }));
    const empty = root.querySelector("#codex-decision-empty");
    empty.style.display = !state.enabled || !history.length ? "block" : "none";
    empty.textContent = state.enabled
      ? seen && hook?.last_skip
        ? `Hook ran; latest output skipped: ${hook.last_skip.replaceAll("_", " ")}.`
        : "No hook decision in this session. Short or protected results may be skipped."
      : "Decision is off for this session. Click to turn it on.";
    const activity = state.enabled
      ? `This session: ${totals}. ${tokens}. ${history.join(". ") || state.recent}.`
      : empty.textContent;
    button.setAttribute("aria-label", noSession ? `${status}. Open a local Codex thread to turn Decision on or off` :
      `${status}${unavailable ? `: ${reason.textContent}` : ""}. ${activity} ${saving ? "Saving." : state.enabled ? "Turn Decision off." : "Turn Decision on."}`);
  }

  function visibleRect(element) {
    const rect = element?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
  }

  function toolbarButtons() {
    return [...document.querySelectorAll('button,[role="button"]')].filter((element) => {
      if (root?.contains(element)) return false;
      const rect = visibleRect(element);
      return rect && rect.bottom > window.innerHeight / 2 && rect.bottom < window.innerHeight;
    });
  }

  function controlName(element) {
    return [element.textContent, element.getAttribute("aria-label"), element.getAttribute("title"),
      element.querySelector("svg title")?.textContent].filter(Boolean).join(" ").trim();
  }

  function findAnchor() {
    if (!document.body) return null;
    const buttons = toolbarButtons();
    const named = buttons.find((element) => /\b(Full access|Workspace write|Read-only)\b/i.test(controlName(element)));
    if (named) return { element: named, rect: visibleRect(named) };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!/^(Full access|Workspace write|Read-only)$/i.test(node.textContent.trim())) continue;
      if (root?.contains(node)) continue;
      const element = node.parentElement?.closest('button,[role="button"]') || node.parentElement;
      const rect = visibleRect(element);
      if (rect && rect.bottom > window.innerHeight / 2 && rect.bottom < window.innerHeight) {
        return { element, rect };
      }
    }
    // Codex may replace the permission label with a yellow shield icon.
    const shield = buttons.find((element) => {
      const icon = element.querySelector("svg");
      if (!icon) return false;
      return [element, icon, icon.querySelector("path")].filter(Boolean).some((part) => {
        const style = getComputedStyle(part);
        return [style.color, style.stroke, style.fill].some((value) => {
          const channels = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/)?.slice(1).map(Number);
          return channels && channels[0] > 140 && channels[1] > 95 && channels[2] < 100;
        });
      });
    });
    if (shield) return { element: shield, rect: visibleRect(shield) };
    return null;
  }

  function findModel(anchor) {
    const buttons = toolbarButtons();
    const rightButtons = buttons.map((element) => ({ element, rect: visibleRect(element) }))
      .filter(({ rect }) => rect.left > anchor.rect.right &&
        Math.min(rect.bottom, anchor.rect.bottom) - Math.max(rect.top, anchor.rect.top) >
        Math.min(rect.height, anchor.rect.height) / 2);
    const modelRank = (name) => /\bGPT\b/i.test(name) ? 3 : /\bmodel\b/i.test(name) ? 2 :
      /\bCodex\b/i.test(name) ? 1 : 0;
    const byModelRank = (a, b) => modelRank(controlName(b.element)) - modelRank(controlName(a.element)) ||
      b.rect.left - a.rect.left;
    const namedButtons = rightButtons.filter(({ element }) => modelRank(controlName(element)) > 0);
    const namedModel = namedButtons.sort(byModelRank)[0];
    // The highest-ranked button already identifies the model. Avoid walking a long chat.
    if (namedModel && modelRank(controlName(namedModel.element)) === 3) return namedModel;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    const namedText = [];
    while ((node = walker.nextNode())) {
      const label = node.textContent.trim();
      if (!modelRank(label) || root?.contains(node)) continue;
      const element = node.parentElement?.closest('button,[role="button"]') || node.parentElement;
      const rect = visibleRect(element);
      if (!rect || rect.left <= anchor.rect.right) continue;
      const overlap = Math.min(rect.bottom, anchor.rect.bottom) - Math.max(rect.top, anchor.rect.top);
      if (overlap < Math.min(rect.height, anchor.rect.height) / 2) continue;
      namedText.push({ element, rect });
    }
    return [...namedButtons, ...namedText].sort(byModelRank)[0] ||
      rightButtons.sort((a, b) => a.rect.left - b.rect.left)[0] || null;
  }

  function commonAncestor(first, second) {
    for (let element = first; element; element = element.parentElement) {
      if (element.contains(second)) return element;
    }
    return document.body;
  }

  function observeLayout(anchor, model) {
    if (!layoutObserver) return;
    const elements = [anchor.element, model.element, commonAncestor(anchor.element, model.element)];
    if (observed.length === elements.length && observed.every((element, index) => element === elements[index])) return;
    layoutObserver.disconnect();
    observed = elements;
    for (const element of new Set(elements)) layoutObserver.observe(element);
  }

  function alignPopup(element, width, buttonLeft, rightEdge) {
    const actualWidth = Math.min(width, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rightEdge - actualWidth, window.innerWidth - actualWidth - 12));
    element.style.left = `${Math.round(left - buttonLeft)}px`;
    element.style.right = "auto";
  }

  function toolbarScope(anchor, model) {
    if (model) {
      const shared = commonAncestor(anchor.element, model.element);
      if (shared !== document.body) return shared;
    }
    for (let element = anchor.element.parentElement; element && element !== document.body;
      element = element.parentElement) {
      const rect = visibleRect(element);
      if (rect && rect.width >= window.innerWidth * 0.7 && rect.height <= 250) return element;
    }
    return document.body;
  }

  function nextToolbarEdge(anchor, scope) {
    const rowCenter = anchor.rect.top + anchor.rect.height / 2;
    let edge = Infinity;
    const consider = (rect) => {
      if (rect && rect.left > anchor.rect.right + 2 && rect.top <= rowCenter + 4 &&
          rect.bottom >= rowCenter - 4) edge = Math.min(edge, rect.left);
    };
    for (const element of scope.querySelectorAll('button,[role="button"],svg')) {
      if (root.contains(element) || anchor.element.contains(element)) continue;
      consider(visibleRect(element));
    }
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent.trim() || root.contains(node) || anchor.element.contains(node)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      consider(range.getBoundingClientRect());
    }
    return edge;
  }

  function position() {
    const item = create();
    const anchor = findAnchor();
    if (!anchor) { item.style.display = "none"; return; }
    const model = findModel(anchor);
    if (model) seenModel = true;
    observeLayout(anchor, model || anchor);
    const leftEdge = anchor.rect.right + 7;
    const modelEdge = model && model.rect.left > anchor.rect.right ? model.rect.left : Infinity;
    // Decorative text and SVGs may sit between the access and model controls.
    // Once the model is known, it alone defines the right edge for Decision.
    const nextEdge = Number.isFinite(modelEdge) ? modelEdge :
      nextToolbarEdge(anchor, toolbarScope(anchor, model));
    if (!Number.isFinite(nextEdge)) { item.style.display = "none"; return; }
    let rightEdge = Number.isFinite(nextEdge) ? nextEdge - 8 : leftEdge;
    const available = rightEdge - leftEdge;
    const button = item.querySelector("#codex-decision-button");
    // The access control stays on the toolbar row even when the model is an icon.
    const modelHeight = model?.rect.height;
    const buttonHeight = modelHeight >= 28 && modelHeight <= 44 ? modelHeight : anchor.rect.height;
    item.style.setProperty("--codex-decision-button-height", `${Math.round(buttonHeight)}px`);
    item.style.display = "block";
    item.style.visibility = "hidden";
    item.dataset.compact = "false";
    const fullWidth = button.getBoundingClientRect().width;
    const paneWidth = document.documentElement.getBoundingClientRect().width;
    if (seenModel && (!model || available < fullWidth)) compactAtWidth = Math.max(compactAtWidth, paneWidth);
    if (paneWidth > compactAtWidth + 16) compactAtWidth = 0;
    item.dataset.compact = String(!model || available < fullWidth ||
      (compactAtWidth > 0 && paneWidth <= compactAtWidth + 16));
    // Tight gaps still have room for the dot when the normal margins do not fit.
    // Keep it on the toolbar row; a completely closed gap must not put it over the prompt.
    item.style.removeProperty("--codex-decision-compact-padding");
    if (item.dataset.compact === "true" && available < 15 && Number.isFinite(nextEdge)) {
      const compactWidth = Math.min(15, nextEdge - anchor.rect.right - 4);
      if (compactWidth < 7) { item.style.display = "none"; return; }
      item.style.setProperty("--codex-decision-compact-padding", `${(compactWidth - 7) / 2}px`);
      rightEdge = nextEdge - 2;
    }
    const width = button.getBoundingClientRect().width;
    const idealLeft = rightEdge - width;
    const buttonLeft = Math.max(12, Math.min(idealLeft, window.innerWidth - width - 12));
    item.style.left = "auto";
    item.style.right = `${Math.round(window.innerWidth - buttonLeft - width)}px`;
    const rowTop = anchor.rect.top + anchor.rect.height / 2 - button.getBoundingClientRect().height / 2;
    item.style.top = `${Math.round(rowTop)}px`;
    alignPopup(item.querySelector("#codex-decision-tip"), state.needsKey ? 252 : 420, buttonLeft, buttonLeft + width);
    item.style.visibility = "";
  }

  function schedulePosition() {
    if (positionScheduled) return;
    positionScheduled = true;
    setTimeout(() => { positionScheduled = false; position(); }, 0);
  }

  function start() {
    create();
    position();
    if (typeof ResizeObserver === "function") layoutObserver = new ResizeObserver(schedulePosition);
    const observer = new MutationObserver((records) => {
      if (records.some((record) => !root?.contains(record.target) && !setup?.contains(record.target))) schedulePosition();
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ["class", "style", "hidden", "aria-label"] });
    schedulePosition();
    window.addEventListener("resize", schedulePosition);
    window.addEventListener("scroll", schedulePosition, true);
    window.addEventListener("message", (event) => {
      if (event.data?.type !== "codex-decision-reply") return;
      const sentView = sentViews.get(event.data.id);
      sentViews.delete(event.data.id);
      if (!sentView || sentView.viewId !== currentViewId()) return;
      if (event.data.id === retryRequestId) retryRequestId = 0;
      if (event.data.id === externalRequestId) {
        externalRequestId = 0;
        if (!event.data.status?.externalOpen) showKeyStatus("Could not open browser", false);
      }
      if (event.data.id === keyRequestId) {
        keyRequestId = 0;
        setup.querySelector("#codex-decision-provider").disabled = false;
        setup.querySelector("#codex-decision-test-key").disabled = false;
        setup.querySelector("#codex-decision-save-key").disabled = false;
        if (event.data.status?.keyTest) {
          const result = keyResult(event.data.status.keyTest);
          showKeyStatus(result.text, result.ok);
        } else if (event.data.status?.keySaved) {
          setup.querySelector("#codex-decision-key").value = "";
          showKeyStatus("", false);
        } else {
          showKeyStatus(event.data.status?.keySaveError || "Connection unavailable", false);
        }
      }
      if (event.data.id >= lastAppliedReply &&
          event.data.status && typeof event.data.status === "object") {
        lastAppliedReply = event.data.id;
        bridgeWaitingSince = null;
        bridgeFault = event.data.status.health?.reason === "BRIDGE_UNAVAILABLE"
          ? "Decision controls are unavailable. Reload VS Code and retry." : null;
        state = event.data.status;
        const pulse = state.classificationPulse;
        if (Number.isSafeInteger(pulse) && pulse >= 0 && pulse !== pulseSeen) {
          if (pulse > pulseSeen && state.enabled && !state.sessionPending) {
            pulseUntil = Date.now() + 500;
            clearTimeout(pulseTimer);
            pulseTimer = setTimeout(() => { pulseUntil = 0; render(); }, 500);
          }
          pulseSeen = pulse;
        }
        if (!state.enabled || state.sessionPending) pulseUntil = 0;
        render();
      }
    });
    setInterval(() => { expireRequests(); if (!retryRequestId) send("status"); }, 1000);
    window.addEventListener("focus", () => send("status"));
    document.addEventListener("visibilitychange", () => send("status"));
    window.addEventListener("codex-decision-route", () => send("status"));
    setInterval(schedulePosition, 1500);
    send("status");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
