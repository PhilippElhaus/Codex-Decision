use super::bridge::{image_bridge, marketplace_bridge, Bridges};
use super::lifecycle::{apply, restore, update};
use super::*;

#[test]
fn pinned_patch_applies_updates_rejects_tampering_and_restores() {
    patch_cycle(profiles::LEGACY);
    patch_cycle(Spec::production("26.930.21537").unwrap().1);
    patch_cycle(Spec::production("26.930.31730").unwrap().1);
    patch_cycle(Spec::production("26.930.41038").unwrap().1);
    patch_cycle(Spec::production("26.930.51102").unwrap().1);
    patch_cycle(Spec::production("26.930.61225").unwrap().1);
    patch_cycle(Spec::production("26.1002.51308").unwrap().1);
}

fn patch_cycle(profile: profiles::Profile) {
    let bridges = fixture_bridges();
    let directory = tempfile::tempdir().unwrap();
    let root = directory
        .path()
        .join(format!("openai.chatgpt-{}", profile.version));
    let backup = directory.path().join("rollback");
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let source = BTreeMap::from([
        (HOST, format!("prefix {HOST_ANCHOR} suffix").into_bytes()),
        (
            INDEX,
            format!("<html>{}</html>", profile.index_anchor).into_bytes(),
        ),
        (
            IMAGE,
            format!("prefix {} suffix", profile.image_anchor).into_bytes(),
        ),
        (
            ROUTE,
            format!("prefix {} suffix", profile.route_anchor).into_bytes(),
        ),
    ]);
    let spec = Spec(
        source
            .iter()
            .map(|(path, bytes)| (*path, hash(bytes)))
            .collect(),
        profile,
    );
    for (path, bytes) in &source {
        let target = root.join(spec.physical(path));
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, bytes).unwrap();
    }
    apply(&repo, &root, &backup, &spec, &bridges).unwrap();
    let first = exact(&backup, "manifest.json").unwrap();
    assert!(as_text(&exact(&root, HOST).unwrap())
        .unwrap()
        .contains("codexDecision.bridge"));
    assert!(as_text(&exact(&root, spec.physical(ROUTE)).unwrap())
        .unwrap()
        .contains("codexDecisionSessionId"));
    assert_eq!(
        exact(&root, CONTROL).unwrap(),
        exact(&repo, "vscode-control/webview/decision-control.js").unwrap()
    );
    update(&repo, &root, &backup, &spec, &bridges).unwrap();
    assert_eq!(first, exact(&backup, "manifest.json").unwrap());
    let host = root.join(HOST);
    fs::write(&host, "tampered").unwrap();
    assert!(update(&repo, &root, &backup, &spec, &bridges).is_err());
    fs::write(
        &host,
        changed(&repo, &source, &spec, &bridges).unwrap()[HOST].as_slice(),
    )
    .unwrap();
    restore(&root, &backup, &spec).unwrap();
    for (path, bytes) in &source {
        assert_eq!(exact(&root, spec.physical(path)).unwrap(), *bytes);
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
    assert!(host.contains("relevancePolicy:u.relevancePolicy"));
    assert!(
        !host.contains("feature:u.feature") && !host.contains("searchRelevance:u.searchRelevance")
    );
    assert!(route.contains("hotkey-window") && route.contains("codexDecisionSessionId"));
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
    for version in [
        VERSION,
        "26.930.21537",
        "26.930.31730",
        "26.930.41038",
        "26.930.51102",
        "26.930.61225",
        "26.1002.51308",
    ] {
        let fragment =
            profiles::route_fragment(route.clone(), Spec::production(version).unwrap().1);
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
            let bindings = if version == VERSION {
                "let ZK={},TK={useContext:()=>({location:{pathname}})},WG=()=>{},_K=()=>true;"
            } else if version == "26.1002.51308" {
                "let CK={},ZG={useContext:()=>({location:{pathname}})},hG=()=>{},HG=()=>true;"
            } else if version == "26.930.21537" {
                "let TK={},$G={useContext:()=>({location:{pathname}})},vG=()=>{},GG=()=>true;"
            } else if ["26.930.51102", "26.930.61225"].contains(&version) {
                "let Fq={},lq={useContext:()=>({location:{pathname}})},OK=()=>{},tq=()=>true;"
            } else {
                "let DK={},tK={useContext:()=>({location:{pathname}})},bG=()=>{},qG=()=>true;"
            };
            let function = match version {
                VERSION => "vK",
                "26.930.21537" => "KG",
                "26.1002.51308" => "UG",
                "26.930.51102" | "26.930.61225" => "nq",
                _ => "JG",
            };
            let script = format!("let window={{dispatchEvent:()=>{{}}}};let document={{documentElement:{{dataset:{{codexDecisionSessionId:'stale'}}}}}};let pathname={};{bindings}{fragment}{function}();process.stdout.write(JSON.stringify(document.documentElement.dataset));", json!(pathname));
            let output = Command::new("node").arg("-e").arg(script).output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let result: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(result["codexDecisionRouteKind"], kind);
            assert_eq!(result["codexDecisionSessionId"].as_str(), session);
        }
    }
    for limit in [50, 0] {
        let message = json!({"type":"codex-decision","action":"settingsSave","key":"",
                "mode":"replace","relevancePolicy":{"omit_min":95,"exact_max":5},
                "logLimitMb":limit,"neverDeleteLogs":false,"choiceGateEnabled":true});
        let script = format!("let captured=null,handler=null;let e={{onDidReceiveMessage(f){{handler=f;return {{}}}},postMessage(){{}}}},require=()=>({{commands:{{executeCommand(_,payload){{captured=payload;return Promise.resolve({{}})}}}}}}),s={{markMessageReceived(){{}}}};{host}{{}} }});handler({message});setTimeout(()=>process.stdout.write(JSON.stringify(captured)),0);");
        let output = Command::new("node").arg("-e").arg(script).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        if limit > 0 {
            assert_eq!(result["logLimitMb"], limit);
            assert_eq!(result["relevancePolicy"]["omit_min"], 95);
        } else {
            assert!(result.is_null());
        }
    }
}

#[test]
fn wsl_bridges_rewrite_only_owned_paths() {
    let bridges = fixture_bridges();
    let image = bridges.image;
    let home = "/home/fixture";
    for (incoming, should_rewrite) in [
        (
            format!("{home}/plugins/codex-decision/assets/icon.png"),
            true,
        ),
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
    let fragment = bridges.marketplace;
    assert!(!fragment.is_empty());
    let windows = r"\\wsl.localhost\Fixture\home\fixture\.agents\plugins\marketplace.json";
    for (name, should_rewrite) in [
        ("codex-decision", true),
        ("codex-chime", true),
        ("unrelated", false),
    ] {
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

fn fixture_bridges() -> Bridges {
    let marketplace = Path::new("/home/fixture/.agents/plugins/marketplace.json");
    Bridges {
        image: image_bridge("/home/fixture", r"\\wsl.localhost\Fixture\").unwrap(),
        marketplace: marketplace_bridge(
            marketplace,
            br#"{"plugins":[{"name":"codex-decision"},{"name":"codex-chime"},{"name":"unrelated"}]}"#,
            r"\\wsl.localhost\Fixture\home\fixture\.agents\plugins\marketplace.json",
            Some("Fixture"),
        ),
    }
}

#[test]
fn invalid_bridge_paths_never_expand_rewrites() {
    assert!(image_bridge("/home/fixture", r"C:\").is_err());
    assert!(marketplace_bridge(
        Path::new("relative.json"),
        br#"{"plugins":[{"name":"codex-decision"}]}"#,
        r"C:\marketplace.json",
        None
    )
    .is_empty());
    assert!(marketplace_bridge(
        Path::new("/fixture.json"),
        br#"{"plugins":[{"name":"unrelated"}]}"#,
        r"C:\marketplace.json",
        None
    )
    .is_empty());
}
