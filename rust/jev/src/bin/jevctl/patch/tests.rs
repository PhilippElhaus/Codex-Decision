use super::bridge::{image_bridge, marketplace_bridge, wslpath};
use super::lifecycle::{apply, restore, update};
use super::*;

#[test]
fn pinned_patch_applies_updates_rejects_tampering_and_restores() {
    if image_bridge().is_err() {
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join(format!("openai.chatgpt-{VERSION}"));
    let backup = directory.path().join("rollback");
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let source = BTreeMap::from([
        (HOST, format!("prefix {HOST_ANCHOR} suffix").into_bytes()),
        (INDEX, format!("<html>{INDEX_ANCHOR}</html>").into_bytes()),
        (IMAGE, format!("prefix {IMAGE_ANCHOR} suffix").into_bytes()),
        (ROUTE, format!("prefix {ROUTE_ANCHOR} suffix").into_bytes()),
    ]);
    let spec = Spec(
        source
            .iter()
            .map(|(path, bytes)| (*path, hash(bytes)))
            .collect(),
    );
    for (path, bytes) in &source {
        let target = root.join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, bytes).unwrap();
    }
    apply(&repo, &root, &backup, &spec).unwrap();
    let first = exact(&backup, "manifest.json").unwrap();
    assert!(as_text(&exact(&root, HOST).unwrap())
        .unwrap()
        .contains("codexJev.bridge"));
    assert!(as_text(&exact(&root, ROUTE).unwrap())
        .unwrap()
        .contains("codexJevSessionId"));
    assert_eq!(
        exact(&root, CONTROL).unwrap(),
        exact(&repo, "vscode-control/webview/jev-control.js").unwrap()
    );
    update(&repo, &root, &backup, &spec).unwrap();
    assert_eq!(first, exact(&backup, "manifest.json").unwrap());
    let host = root.join(HOST);
    fs::write(&host, "tampered").unwrap();
    assert!(update(&repo, &root, &backup, &spec).is_err());
    fs::write(
        &host,
        changed(&repo, &source, &spec).unwrap()[HOST].as_slice(),
    )
    .unwrap();
    restore(&root, &backup, &spec).unwrap();
    for (path, bytes) in &source {
        assert_eq!(exact(&root, path).unwrap(), *bytes);
    }
    for asset in [CONTROL, SETTINGS, ICON] {
        assert!(!root.join(asset).exists());
    }
}

#[test]
fn bridge_source_keeps_settings_actions_and_exact_router_route() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let host = as_text(&exact(&repo, "vscode-control/patch-assets/host-bridge.jsfrag").unwrap())
        .unwrap()
        .to_owned();
    let route = as_text(&exact(&repo, "vscode-control/patch-assets/route-bridge.jsfrag").unwrap())
        .unwrap()
        .to_owned();
    assert!(
        host.contains("settingsRead")
            && host.contains("settingsSave")
            && host.contains("settingsTest")
    );
    assert!(host.contains("searchRelevance:u.searchRelevance"));
    assert!(route.contains("hotkey-window") && route.contains("codexJevSessionId"));
    assert_eq!(host.matches("if(s.markMessageReceived()").count(), 1);
}

#[test]
fn bridge_fragments_publish_routes_and_validate_settings_messages() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let route = as_text(&exact(&repo, "vscode-control/patch-assets/route-bridge.jsfrag").unwrap())
        .unwrap()
        .to_owned();
    let host = as_text(&exact(&repo, "vscode-control/patch-assets/host-bridge.jsfrag").unwrap())
        .unwrap()
        .to_owned();
    for (pathname, kind, session) in [
        ("/local/thread-one", "local", Some("thread-one")),
        (
            "/hotkey-window/thread/thread-two",
            "local",
            Some("thread-two"),
        ),
        ("/remote/remote-task", "remote", None),
        ("/settings", "none", None),
    ] {
        let script = format!("let window={{dispatchEvent:()=>{{}}}};let document={{documentElement:{{dataset:{{codexJevSessionId:'stale'}}}}}};let ZK={{}},TK={{useContext:()=>({{location:{{pathname:{}}}}})}},WG=()=>{{}},_K=()=>true;{route}vK();process.stdout.write(JSON.stringify(document.documentElement.dataset));", json!(pathname));
        let output = Command::new("node").arg("-e").arg(script).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["codexJevRouteKind"], kind);
        assert_eq!(result["codexJevSessionId"].as_str(), session);
    }
    for relevant in [7, 101] {
        let message = json!({"type":"codex-jev","action":"settingsSave","key":"",
                "mode":"replace","linePolicy":{},"searchRelevance":{"guard_enabled":true,"relevant_max":relevant},
                "logLimitMb":50,"neverDeleteLogs":false,"choiceGateEnabled":true});
        let script = format!("let captured=null,handler=null;let e={{onDidReceiveMessage(f){{handler=f;return {{}}}},postMessage(){{}}}},require=()=>({{commands:{{executeCommand(_,payload){{captured=payload;return Promise.resolve({{}})}}}}}}),s={{markMessageReceived(){{}}}};{host}{{}} }});handler({message});setTimeout(()=>process.stdout.write(JSON.stringify(captured)),0);");
        let output = Command::new("node").arg("-e").arg(script).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        if relevant <= 100 {
            assert_eq!(result["searchRelevance"]["relevant_max"], relevant);
        } else {
            assert!(result.is_null());
        }
    }
}

#[test]
fn wsl_bridges_rewrite_only_owned_paths() {
    let Ok(image) = image_bridge() else {
        return;
    };
    let home = std::env::var("HOME").unwrap();
    for (incoming, should_rewrite) in [
        (format!("{home}/plugins/codex-jev/assets/icon.png"), true),
        (
            format!("{home}/.codex/plugins/cache/personal/codex-chime/1/assets/icon.png"),
            true,
        ),
        ("/tmp/other.png".to_owned(), false),
    ] {
        let script = format!("let o={};{image}process.stdout.write(o);", json!(incoming));
        let output = Command::new("node").arg("-e").arg(script).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result = String::from_utf8(output.stdout).unwrap();
        assert_eq!(result != incoming, should_rewrite);
    }
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let fragment = marketplace_bridge(&repo);
    if fragment.is_empty() {
        return;
    }
    let marketplace = PathBuf::from(home).join(".agents/plugins/marketplace.json");
    let windows = wslpath(&marketplace).unwrap();
    for (name, should_rewrite) in [("codex-jev", true), ("unrelated", false)] {
        let message = json!({"type":"mcp-request","request":{"method":"plugin/read",
                "params":{"marketplacePath":windows,"pluginName":name}}});
        let script = format!(
            "let u={message};{fragment}process.stdout.write(u.request.params.marketplacePath);"
        );
        let output = Command::new("node").arg("-e").arg(script).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result = String::from_utf8(output.stdout).unwrap();
        assert_eq!(result != windows, should_rewrite);
    }
}
