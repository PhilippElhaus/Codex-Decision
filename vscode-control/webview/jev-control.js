/* Local Codex composer control. Key setup uses the local extension bridge. */
(() => {
  const acquire = window.acquireVsCodeApi;
  if (typeof acquire !== "function") return;
  window.acquireVsCodeApi = function (...args) {
    const api = acquire.apply(this, args);
    window.__codexJevApi = api;
    return api;
  };

  let state = { enabled: false, outputEnabled: false, testBuildEnabled: false, searchListingEnabled: false, needsKey: false, health: null, busy: false, mode: "replace", recent: "No decision recorded yet", history: [], stats: {} };
  let root;
  let setup;
  let setupDismissed = false;
  let keyRequestId = 0;
  let externalRequestId = 0;
  let pending = 0;
  let retryRequestId = 0;
  let menuOpen = false;
  let layoutObserver;
  let observed = [];
  let positionScheduled = false;
  let compactAtWidth = 0;
  let seenModel = false;
  let viewId = newViewId();
  let viewLocation = window.location.href;
  const sentViews = new Map();
  const colors = { off: "#9a9a9a", healthy: "#87cda4", failed: "#e99490", busy: "#83bcf7" };

  function newViewId() {
    return `view-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  }

  function currentViewId() {
    if (window.location.href !== viewLocation) {
      viewLocation = window.location.href;
      viewId = newViewId();
      retryRequestId = 0;
      setupDismissed = false;
      state = { ...state, busy: false, recent: "No decision recorded yet", history: [], stats: {} };
      render();
    }
    return viewId;
  }

  function send(action, enabled, feature, key) {
    const api = window.__codexJevApi;
    if (!api) return 0;
    const id = ++pending;
    const current = currentViewId();
    sentViews.set(id, current);
    if (sentViews.size > 50) sentViews.delete(sentViews.keys().next().value);
    api.postMessage({ type: "codex-jev", action, enabled, feature, ...(key === undefined ? {} : { key }), viewId: current, id });
    return id;
  }

  function healthReason(reason) {
    const known = {
      JEV_KEY_MISSING: "API key missing or unreadable",
      JEV_HTTP_401: "API key rejected",
      JEV_HTTP_403: "Access denied",
      JEV_HTTP_429: "Rate limited",
      JEV_HTTP_529: "Jev overloaded",
      JEV_TIMEOUT: "Connection timed out",
      JEV_NETWORK_ERROR: "Network connection failed",
      JEV_INVALID_RESPONSE: "Invalid Jev response",
      JEV_CONFIG_ERROR: "Configuration error",
      JEV_UNAVAILABLE: "Connection check failed",
      BRIDGE_UNAVAILABLE: "VS Code bridge unavailable",
    };
    return known[reason] || (/^JEV_HTTP_\d{3}$/.test(reason || "")
      ? `API error ${reason.slice(-3)}` : "Connection check failed");
  }

  function keyResult(result) {
    if (result?.ok) return { text: "OK", ok: true };
    const labels = {
      JEV_KEY_MISSING: "Enter a valid key", JEV_HTTP_401: "Invalid", JEV_KEY_EXPIRED: "Expired",
      JEV_HTTP_403: "Access denied", JEV_HTTP_429: "Rate limited", JEV_TIMEOUT: "Timed out",
      JEV_NETWORK_ERROR: "Network error", JEV_INVALID_RESPONSE: "Invalid response",
    };
    return { text: labels[result?.reason] || "Connection failed", ok: false };
  }

  function showKeyStatus(text, ok) {
    const label = setup.querySelector("#codex-jev-key-status");
    label.textContent = text;
    label.dataset.ok = String(ok);
  }

  function requestKey(action) {
    if (keyRequestId) return;
    const key = setup.querySelector("#codex-jev-key").value;
    if (key.length < 8 || key.length > 4096 || /\s|\0/.test(key)) {
      showKeyStatus("Enter a valid key", false);
      return;
    }
    keyRequestId = send(action, undefined, undefined, key);
    if (!keyRequestId) {
      showKeyStatus("Connection unavailable", false);
      return;
    }
    setup.querySelector("#codex-jev-test-key").disabled = true;
    setup.querySelector("#codex-jev-save-key").disabled = true;
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
      #codex-jev { position: fixed; z-index: 2147483600; display: none; font-family: inherit; }
      #codex-jev * { box-sizing: border-box; }
      #codex-jev-button { display: inline-flex; align-items: center; gap: 7px; height: var(--codex-jev-button-height, 34px); min-height: 0; max-height: var(--codex-jev-button-height, 34px); padding: 0 12px; border: 0; border-radius: 999px; background: #303030; color: #9a9a9a; font-family: inherit; font-size: 14px; font-weight: 600; line-height: 18px; cursor: pointer; transition: color 220ms ease-in-out, background-color 220ms ease-in-out; }
      #codex-jev[data-compact="true"] #codex-jev-button { gap: 0; padding: 0 4px; }
      #codex-jev[data-compact="true"] #codex-jev-label { display: none; }
      #codex-jev-observe { display: none; margin-left: 2px; padding: 1px 3px; border: 1px solid #9a9a9a77; border-radius: 3px; color: #bdbdbd; font-size: 9px; font-weight: 700; line-height: 12px; letter-spacing: .04em; }
      #codex-jev[data-observe="true"] #codex-jev-observe { display: inline-block; }
      #codex-jev[data-compact="true"] #codex-jev-observe { display: none; }
      #codex-jev-button:hover, #codex-jev-button[aria-expanded="true"] { background: #3a3a3a; }
      #codex-jev-button:focus-visible, .codex-jev-option:focus-visible { outline: 2px solid #83bcf7; outline-offset: 2px; }
      #codex-jev-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 15%, transparent); transition: box-shadow 220ms ease-in-out; }
      #codex-jev-menu, #codex-jev-tip { position: absolute; bottom: calc(100% + 9px); right: 0; box-shadow: 0 12px 30px #0009; }
      #codex-jev-menu { display: none; width: min(296px, calc(100vw - 24px)); padding: 6px; border: 1px solid var(--vscode-menu-border, #ffffff26); border-radius: 12px; background: var(--vscode-menu-background, #212121); color: var(--vscode-menu-foreground, #e8e8e8); }
      #codex-jev-menu[data-open="true"] { display: block; }
      #codex-jev-menu h2 { margin: 5px 10px 6px; color: var(--vscode-descriptionForeground, #a8a8a8); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
      .codex-jev-option { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border: 0; border-radius: 6px; background: transparent; color: inherit; text-align: left; font: inherit; cursor: pointer; }
      .codex-jev-option:hover { background: var(--vscode-list-hoverBackground, #ffffff12); }
      .codex-jev-check { display: grid; place-items: center; width: 16px; height: 16px; border: 1px solid var(--vscode-checkbox-border, #858585); border-radius: 4px; flex: none; background: transparent; }
      .codex-jev-option[aria-checked="true"] .codex-jev-check { background: var(--vscode-checkbox-selectBackground, #3a83f7); border-color: var(--vscode-checkbox-selectBorder, #3a83f7); color: var(--vscode-checkbox-foreground, #fff); }
      .codex-jev-option[aria-checked="true"] .codex-jev-check::after { content: ""; width: 8px; height: 5px; border: solid currentColor; border-width: 0 0 2px 2px; transform: translateY(-1px) rotate(-45deg); }
      .codex-jev-option strong { display: block; font-size: 13px; font-weight: 600; line-height: 18px; }
      .codex-jev-option small { display: block; color: var(--vscode-descriptionForeground, #aaa); font-size: 11px; line-height: 15px; margin-top: 1px; }
      #codex-jev-menu p { margin: 5px 0 0; padding: 9px 10px 4px; border-top: 1px solid var(--vscode-menu-separatorBackground, #ffffff1a); color: var(--vscode-descriptionForeground, #999); font-size: 11px; }
      #codex-jev-tip { display: none; width: min(420px, calc(100vw - 24px)); padding: 11px 13px; border: 1px solid #454545; border-radius: 11px; background: #292929; color: #dedede; pointer-events: auto; font-size: 12px; line-height: 1.45; white-space: normal; }
      #codex-jev-tip[data-needs-key="true"] { width: min(252px, calc(100vw - 24px)); padding: 9px 11px; }
      #codex-jev-tip[data-needs-key="true"] #codex-jev-mode, #codex-jev-tip[data-needs-key="true"] #codex-jev-session-heading, #codex-jev-tip[data-needs-key="true"] #codex-jev-stats, #codex-jev-tip[data-needs-key="true"] #codex-jev-tokens, #codex-jev-tip[data-needs-key="true"] #codex-jev-history-heading, #codex-jev-tip[data-needs-key="true"] #codex-jev-history, #codex-jev-tip[data-needs-key="true"] #codex-jev-empty { display: none !important; }
      #codex-jev-tip::after { content: ""; position: absolute; top: 100%; left: 0; right: 0; height: 10px; }
      #codex-jev:hover #codex-jev-tip, #codex-jev:focus-within #codex-jev-tip { display: block; }
      #codex-jev[data-menu="true"] #codex-jev-tip { display: none; }
      #codex-jev-health-row { display: flex; align-items: center; gap: 5px; min-height: 20px; }
      #codex-jev-health-row strong { color: #fff; white-space: nowrap; }
      #codex-jev-health-reason { display: none; color: #e99490; margin: 0; min-width: 0; }
      #codex-jev-retry { display: none; margin-left: auto; padding: 2px 7px; border: 1px solid #666; border-radius: 8px; background: #383838; color: #eee; font: inherit; cursor: pointer; }
      #codex-jev-retry:hover { background: #484848; }
      #codex-jev-retry:disabled { opacity: .6; cursor: default; }
      #codex-jev-retry:focus-visible { outline: 2px solid #83bcf7; outline-offset: 2px; }
      #codex-jev-tip span { display: block; color: #aaa; margin-top: 3px; }
      #codex-jev-tip #codex-jev-health-reason { color: #e99490; margin: 0; }
      #codex-jev-stats { color: #d4d4d4; }
      #codex-jev-tokens { margin-top: 3px; color: #d4d4d4; }
      #codex-jev-tip h3 { margin: 10px 0 4px; color: #aaa; font-size: 11px; font-weight: 650; letter-spacing: .04em; }
      #codex-jev-history { margin: 0; padding-left: 18px; color: #d4d4d4; }
      #codex-jev-history li { margin-top: 3px; }
      #codex-jev-history strong { font-weight: 700; color: #fff; }
      #codex-jev-empty { margin: 0; color: #888; }
      #codex-jev-connect { position: fixed; inset: 0; z-index: 2147483640; display: none; align-items: center; justify-content: center; box-sizing: border-box; overflow: auto; padding: 16px; background: var(--vscode-editor-background, #111); color: var(--vscode-foreground, #d0d0d0); font-family: inherit; isolation: isolate; container-type: inline-size; }
      #codex-jev-connect * { box-sizing: border-box; }
      #codex-jev-connect-art { position: absolute; inset: 0; overflow: hidden; pointer-events: none; mask-image: radial-gradient(ellipse at center, #000 20%, #0009 48%, transparent 80%); }
      #codex-jev-connect-art pre { position: absolute; top: 50%; left: 50%; margin: 0; color: #bdc9d3; opacity: .18; font: 12px/18px monospace; letter-spacing: 2px; white-space: pre; animation: codex-jev-art-drift 14s ease-in-out infinite alternate; }
      @keyframes codex-jev-art-drift { from { transform: translate(-52%, -51%) rotate(-2deg); } to { transform: translate(-48%, -49%) rotate(2deg); } }
      @media (prefers-reduced-motion: reduce) { #codex-jev-connect-art pre { animation: none; transform: translate(-50%, -50%); } }
      #codex-jev-connect-card { position: relative; width: min(100%, 460px); min-width: 0; margin: auto; padding: 28px; border: 1px solid var(--vscode-panel-border, #3c3c3c); border-radius: 12px; background: var(--vscode-editor-background, #1b1b1b); box-shadow: 0 20px 60px #0008; }
      #codex-jev-connect-heading { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
      #codex-jev-connect h1 { margin: 0; font-size: clamp(28px, 5vw, 36px); line-height: 1.2; }
      #codex-jev-connect-icon { width: 38px; height: 38px; object-fit: contain; flex: none; }
      #codex-jev-connect p { margin: 0 0 28px; color: var(--vscode-descriptionForeground, #999); font-size: 14px; line-height: 1.5; }
      #codex-jev-connect label { display: block; margin-bottom: 6px; font-size: 14px; }
      #codex-jev-key { width: 100%; height: 42px; padding: 8px 10px; border: 1px solid var(--vscode-input-border, #555); border-radius: 9px; outline: none; background: var(--vscode-input-background, #202020); color: var(--vscode-input-foreground, #ddd); font: inherit; }
      #codex-jev-key:focus { border-color: var(--vscode-focusBorder, #e4a900); }
      #codex-jev-connect-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
      #codex-jev-connect button { min-height: 36px; padding: 7px 13px; border: 1px solid var(--vscode-contrastBorder, #707070); border-radius: 10px; background: var(--vscode-button-secondaryBackground, #262626); color: var(--vscode-button-secondaryForeground, #ddd); font: inherit; cursor: pointer; }
      #codex-jev-connect button:hover { background: var(--vscode-button-secondaryHoverBackground, #353535); }
      #codex-jev-connect button:focus-visible { outline: 2px solid var(--vscode-focusBorder, #83bcf7); outline-offset: 2px; }
      #codex-jev-connect button:disabled { opacity: .55; cursor: default; }
      #codex-jev-connect-footer { display: flex; align-items: center; gap: 10px; margin-top: 18px; }
      #codex-jev-connect-footer button { white-space: nowrap; }
      #codex-jev-skip-key { margin-left: auto; }
      #codex-jev-connect-link { margin: 18px 0 0 !important; text-align: center; font-size: 12px !important; }
      #codex-jev-connect-link a { color: var(--vscode-textLink-foreground, #83bcf7); text-decoration: none; }
      #codex-jev-connect-link a:hover { text-decoration: underline; }
      #codex-jev-connect-link a:focus-visible { outline: 2px solid var(--vscode-focusBorder, #83bcf7); outline-offset: 2px; }
      #codex-jev-connect #codex-jev-save-key { border-color: transparent; background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
      #codex-jev-connect #codex-jev-save-key:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
      @container (max-width: 420px) { #codex-jev-connect-card { padding: 20px; } #codex-jev-connect-heading { gap: 8px; } #codex-jev-connect h1 { font-size: 24px; white-space: nowrap; } #codex-jev-connect-icon { width: 32px; height: 32px; } #codex-jev-connect-footer { display: grid; grid-template-columns: minmax(0, 1fr); } #codex-jev-connect-footer button { width: 100%; } #codex-jev-skip-key { margin-left: 0; } }
      @container (max-width: 300px) { #codex-jev-connect-card { padding: 16px; } #codex-jev-connect h1 { font-size: 20px; } #codex-jev-connect-icon { width: 28px; height: 28px; } }
      #codex-jev-key-status { min-width: 0; font-size: 12px; font-weight: 600; }
      #codex-jev-key-status[data-ok="true"] { color: var(--vscode-testing-iconPassed, #4ec97f); }
      #codex-jev-key-status[data-ok="false"] { color: var(--vscode-errorForeground, #f48771); }
    `;
    document.head.appendChild(style);
    root = document.createElement("div");
    root.id = "codex-jev";
    root.innerHTML = `
      <button id="codex-jev-button" type="button" aria-label="Jev integrations" aria-expanded="false" aria-controls="codex-jev-menu"><span id="codex-jev-dot"></span><span id="codex-jev-label">jev</span><span id="codex-jev-observe">MON</span></button>
      <div id="codex-jev-tip" role="group" aria-label="Jev status"><div id="codex-jev-health-row"><strong></strong><span id="codex-jev-health-reason"></span><button id="codex-jev-retry" type="button">Retry</button></div><span id="codex-jev-mode"></span><h3 id="codex-jev-session-heading">This session</h3><div id="codex-jev-stats"></div><div id="codex-jev-tokens"></div><h3 id="codex-jev-history-heading">Recent Actions</h3><ol id="codex-jev-history"></ol><p id="codex-jev-empty">None yet</p></div>
      <div id="codex-jev-menu" role="group" aria-label="Jev integrations" data-open="false"><h2>Jev integrations</h2><button id="codex-jev-option" class="codex-jev-option" type="button" role="checkbox" aria-checked="false"><span class="codex-jev-check"></span><span><strong>Output filter</strong><small>Check repetitive tool output with Jev</small></span></button><button id="codex-jev-test-build" class="codex-jev-option" type="button" role="checkbox" aria-checked="false"><span class="codex-jev-check"></span><span><strong>Test/build logs</strong><small>Jev checks routine lines before trimming</small></span></button><button id="codex-jev-search-listing" class="codex-jev-option" type="button" role="checkbox" aria-checked="false"><span class="codex-jev-check"></span><span><strong>Search/listing</strong><small>Jev trims broad search and file lists</small></span></button><button id="codex-jev-open-connect" class="codex-jev-option" type="button">Connect Jev…</button><p>Select none to turn Jev off.</p></div>`;
    document.body.appendChild(root);
    setup = document.createElement("div");
    setup.id = "codex-jev-connect";
    setup.setAttribute("role", "dialog");
    setup.setAttribute("aria-modal", "true");
    setup.setAttribute("aria-labelledby", "codex-jev-connect-title");
    setup.innerHTML = `<div id="codex-jev-connect-art" aria-hidden="true"><pre></pre></div><div id="codex-jev-connect-card"><div id="codex-jev-connect-heading"><h1 id="codex-jev-connect-title">Connect Jev</h1><img id="codex-jev-connect-icon" src="./assets/jev-icon.png" alt=""></div><p>Enter a typesafe.ai API key to use the selected integrations.</p><label for="codex-jev-key">API key</label><input id="codex-jev-key" type="password" autocomplete="off" spellcheck="false" maxlength="4096"><div id="codex-jev-connect-actions"><button id="codex-jev-test-key" type="button">Test API key</button><span id="codex-jev-key-status" role="status" aria-live="polite"></span></div><div id="codex-jev-connect-footer"><button id="codex-jev-save-key" type="button">Save API key</button><button id="codex-jev-skip-key" type="button">Skip for now</button></div><p id="codex-jev-connect-link">Need a key? <a href="https://typesafe.ai/" rel="noopener noreferrer">Get an API key at typesafe.ai</a></p></div>`;
    document.body.appendChild(setup);
    setup.querySelector("#codex-jev-connect-art pre").textContent = Array.from({ length: 48 }, (_, row) =>
      Array.from({ length: 76 }, (_, column) => {
        const value = Math.abs(Math.sin(row * 19.31 + column * 37.17) * 10000) % 1;
        return value > .88 ? "*" : value > .73 ? "+" : value > .5 ? "·" : " ";
      }).join("")).join("\n");
    setup.addEventListener("click", (event) => event.stopPropagation());
    setup.addEventListener("keydown", (event) => event.stopPropagation());
    setup.querySelector("#codex-jev-key").addEventListener("input", () => showKeyStatus("", false));
    setup.querySelector("#codex-jev-test-key").addEventListener("click", () => requestKey("testApiKey"));
    setup.querySelector("#codex-jev-save-key").addEventListener("click", () => requestKey("saveApiKey"));
    setup.querySelector("#codex-jev-connect-link a").addEventListener("click", (event) => {
      event.preventDefault();
      externalRequestId = send("openTypeSafe");
      if (!externalRequestId) showKeyStatus("Could not open browser", false);
    });
    setup.querySelector("#codex-jev-skip-key").addEventListener("click", () => {
      setupDismissed = true;
      setup.querySelector("#codex-jev-key").value = "";
      showKeyStatus("", false);
      render();
    });
    root.querySelector("#codex-jev-open-connect").addEventListener("click", (event) => {
      event.stopPropagation();
      setupDismissed = false;
      menuOpen = false;
      render();
    });
    root.querySelector("#codex-jev-button").addEventListener("click", (event) => {
      event.stopPropagation();
      menuOpen = !menuOpen;
      render();
    });
    root.querySelector("#codex-jev-option").addEventListener("click", (event) => {
      event.stopPropagation();
      send("setSelection", !state.outputEnabled, "output");
      render();
    });
    root.querySelector("#codex-jev-test-build").addEventListener("click", (event) => {
      event.stopPropagation();
      send("setSelection", !state.testBuildEnabled, "test_build");
      render();
    });
    root.querySelector("#codex-jev-search-listing").addEventListener("click", (event) => {
      event.stopPropagation();
      send("setSelection", !state.searchListingEnabled, "search_listing");
      render();
    });
    root.querySelector("#codex-jev-retry").addEventListener("click", (event) => {
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
    document.addEventListener("click", (event) => {
      if (menuOpen && !root.contains(event.target)) { menuOpen = false; render(); }
    });
    document.addEventListener("keydown", (event) => {
      if (menuOpen && event.key === "Escape") { menuOpen = false; render(); }
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
    if (showSetup && !wasVisible) queueMicrotask(() => setup.querySelector("#codex-jev-key").focus());
    root.querySelector("#codex-jev-open-connect").style.display = needsSetup ? "flex" : "none";
    const button = root.querySelector("#codex-jev-button");
    const visual = !state.enabled ? "off" : state.busy ? "busy" :
      state.health?.ok === true ? "healthy" : state.health?.ok === false ? "failed" : "off";
    button.style.color = colors[visual];
    root.dataset.observe = String(state.enabled && state.mode === "observe");
    button.setAttribute("aria-expanded", String(menuOpen));
    root.dataset.menu = String(menuOpen);
    root.querySelector("#codex-jev-menu").dataset.open = String(menuOpen);
    root.querySelector("#codex-jev-option").setAttribute("aria-checked", String(state.outputEnabled));
    root.querySelector("#codex-jev-test-build").setAttribute("aria-checked", String(state.testBuildEnabled));
    root.querySelector("#codex-jev-search-listing").setAttribute("aria-checked", String(state.searchListingEnabled));
    const status = !state.enabled ? "Jev off" : needsSetup ? "API key needed" : state.health?.ok === true ? "Jev connected" :
      state.health?.ok === false ? "Jev unavailable" : "Checking Jev connection";
    root.querySelector("#codex-jev-tip").dataset.needsKey = String(needsSetup);
    root.querySelector("#codex-jev-health-row strong").textContent = status;
    const unavailable = state.enabled && (state.health?.ok === false || needsSetup);
    const reason = root.querySelector("#codex-jev-health-reason");
    reason.textContent = unavailable && !needsSetup ? `· ${healthReason(state.health.reason)}` : "";
    reason.style.display = unavailable && !needsSetup ? "inline" : "none";
    const retry = root.querySelector("#codex-jev-retry");
    retry.style.display = unavailable ? "inline-block" : "none";
    retry.disabled = Boolean(retryRequestId);
    retry.textContent = needsSetup ? "Connect" : retryRequestId ? "Checking…" : "Retry";
    root.querySelector("#codex-jev-mode").textContent = state.enabled ?
      `${[state.outputEnabled && "output", state.testBuildEnabled && "test/build", state.searchListingEnabled && "search/listing"].filter(Boolean).join(" + ")}${state.mode === "observe" ? " · monitor" : ""}` : "No integrations selected. Click to choose.";
    const stats = state.stats || {};
    const completed = Number(stats.completed) || 0;
    const average = completed ? formatDuration((Number(stats.elapsedMs) || 0) / completed) : "—";
    const totals = `${completed} checked · ${Number(stats.replaced) || 0} replaced · ${average} avg`;
    root.querySelector("#codex-jev-stats").textContent = state.enabled ? totals : "";
    const tokens = `Tokens saved: ~${(Number(stats.estimatedTokensSaved) || 0).toLocaleString("en-US")}`;
    root.querySelector("#codex-jev-tokens").textContent = state.enabled ? tokens : "";
    root.querySelector("#codex-jev-session-heading").style.display = state.enabled ? "block" : "none";
    root.querySelector("#codex-jev-history-heading").style.display = state.enabled ? "block" : "none";
    const history = Array.isArray(state.history) ? state.history.slice(0, 3) : [];
    const list = root.querySelector("#codex-jev-history");
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
    root.querySelector("#codex-jev-empty").style.display = state.enabled && !history.length ? "block" : "none";
    button.setAttribute("aria-label", `${status}${unavailable ? `: ${healthReason(state.health?.reason)}` : ""}. This session: ${totals}. ${tokens}. ${history.join(". ") || state.recent}. Select Jev integrations`);
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
    const named = rightButtons.find(({ element }) => /\b(GPT|Codex|model)\b/i.test(controlName(element)));
    if (named) return named;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    let nearest = null;
    while ((node = walker.nextNode())) {
      const label = node.textContent.trim();
      if (!label || /^(Full access|Workspace write|Read-only)$/i.test(label) ||
          /^(IDE context|Context)$/i.test(label) || root?.contains(node)) continue;
      const element = node.parentElement?.closest('button,[role="button"]') || node.parentElement;
      const rect = visibleRect(element);
      if (!rect || rect.left <= anchor.rect.right || rect.left >= (nearest?.rect.left ?? window.innerWidth)) continue;
      const overlap = Math.min(rect.bottom, anchor.rect.bottom) - Math.max(rect.top, anchor.rect.top);
      if (overlap < Math.min(rect.height, anchor.rect.height) / 2) continue;
      nearest = { element, rect };
    }
    return nearest || rightButtons.sort((a, b) => a.rect.left - b.rect.left)[0] || null;
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
    const nextEdge = Math.min(modelEdge, nextToolbarEdge(anchor, toolbarScope(anchor, model)));
    const rightEdge = Number.isFinite(nextEdge) ? nextEdge - 8 : leftEdge;
    const available = rightEdge - leftEdge;
    const button = item.querySelector("#codex-jev-button");
    // The access control stays on the toolbar row even when the model is an icon.
    const modelHeight = model?.rect.height;
    const buttonHeight = modelHeight >= 28 && modelHeight <= 44 ? modelHeight : anchor.rect.height;
    item.style.setProperty("--codex-jev-button-height", `${Math.round(buttonHeight)}px`);
    item.style.display = "block";
    item.style.visibility = "hidden";
    item.dataset.compact = "false";
    const fullWidth = button.getBoundingClientRect().width;
    const paneWidth = document.documentElement.getBoundingClientRect().width;
    if (seenModel && (!model || available < fullWidth)) compactAtWidth = Math.max(compactAtWidth, paneWidth);
    if (paneWidth > compactAtWidth + 16) compactAtWidth = 0;
    item.dataset.compact = String(!model || available < fullWidth ||
      (compactAtWidth > 0 && paneWidth <= compactAtWidth + 16));
    const width = button.getBoundingClientRect().width;
    const fits = available >= width;
    const idealLeft = fits ? rightEdge - width : leftEdge + (available - width) / 2;
    const buttonLeft = Math.max(12, Math.min(idealLeft, window.innerWidth - width - 12));
    item.style.left = "auto";
    item.style.right = `${Math.round(window.innerWidth - buttonLeft - width)}px`;
    item.style.top = `${Math.round(anchor.rect.top + anchor.rect.height / 2 - button.getBoundingClientRect().height / 2)}px`;
    alignPopup(item.querySelector("#codex-jev-menu"), 296, buttonLeft, buttonLeft + width);
    alignPopup(item.querySelector("#codex-jev-tip"), state.needsKey ? 252 : 420, buttonLeft, buttonLeft + width);
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
    const observer = new MutationObserver(schedulePosition);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    window.addEventListener("resize", schedulePosition);
    window.addEventListener("scroll", schedulePosition, true);
    window.addEventListener("message", (event) => {
      if (event.data?.type !== "codex-jev-reply") return;
      const sentView = sentViews.get(event.data.id);
      sentViews.delete(event.data.id);
      if (event.data.id === retryRequestId) retryRequestId = 0;
      if (event.data.id === externalRequestId) {
        externalRequestId = 0;
        if (!event.data.status?.externalOpen) showKeyStatus("Could not open browser", false);
      }
      if (event.data.id === keyRequestId) {
        keyRequestId = 0;
        setup.querySelector("#codex-jev-test-key").disabled = false;
        setup.querySelector("#codex-jev-save-key").disabled = false;
        if (event.data.status?.keyTest) {
          const result = keyResult(event.data.status.keyTest);
          showKeyStatus(result.text, result.ok);
        } else if (event.data.status?.keySaved) {
          setup.querySelector("#codex-jev-key").value = "";
          showKeyStatus("", false);
        } else {
          showKeyStatus(event.data.status?.keySaveError || "Connection unavailable", false);
        }
      }
      if (!sentView || sentView !== currentViewId()) return;
      if (event.data.status && typeof event.data.status === "object") {
        state = event.data.status;
        render();
      }
    });
    setInterval(() => { if (!retryRequestId) send("status"); }, 120);
    setInterval(schedulePosition, 300);
    send("status");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
