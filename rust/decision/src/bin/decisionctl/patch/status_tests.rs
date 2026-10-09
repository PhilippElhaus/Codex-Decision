use super::bridge::Bridges;
use super::*;

struct Fixture {
    _directory: tempfile::TempDir,
    repo: PathBuf,
    root: PathBuf,
    backup: PathBuf,
    spec: Spec,
    bridges: Bridges,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("host");
        let backup = directory.path().join("rollback");
        let profile = Spec::production("26.1007.21434").unwrap().1;
        let source = BTreeMap::from([
            (HOST, format!("prefix {HOST_ANCHOR} suffix").into_bytes()),
            (INDEX, profile.index_anchor.as_bytes().to_vec()),
            (IMAGE, profile.image_anchor.as_bytes().to_vec()),
            (ROUTE, profile.route_anchor.as_bytes().to_vec()),
        ]);
        let spec = Spec(
            source
                .iter()
                .map(|(path, bytes)| (*path, hash(bytes)))
                .collect(),
            profile,
        );
        for (path, bytes) in source {
            let target = root.join(spec.physical(path));
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, bytes).unwrap();
        }
        Self {
            _directory: directory,
            repo: Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."),
            root,
            backup,
            spec,
            bridges: Bridges {
                image: String::new(),
                marketplace: String::new(),
            },
        }
    }

    fn state(&self, assets: &Path) -> Result<&'static str, String> {
        status::read(assets, &self.root, &self.backup, &self.spec, &self.bridges)
    }

    fn apply(&self) {
        lifecycle::apply(
            &self.repo,
            &self.root,
            &self.backup,
            &self.spec,
            &self.bridges,
        )
        .unwrap();
    }
}

#[test]
fn status_is_read_only_and_distinguishes_installed_upgrades_and_restores() {
    let fixture = Fixture::new();
    assert_eq!(fixture.state(&fixture.repo).unwrap(), "unpatched");
    assert!(
        !fixture.backup.exists(),
        "inspection must not create rollback state"
    );
    fixture.apply();
    let manifest = exact(&fixture.backup, "manifest.json").unwrap();
    let host = exact(&fixture.root, HOST).unwrap();
    let modified = fs::metadata(fixture.root.join(HOST))
        .unwrap()
        .modified()
        .unwrap();
    assert_eq!(fixture.state(&fixture.repo).unwrap(), "ready");
    assert_eq!(manifest, exact(&fixture.backup, "manifest.json").unwrap());
    assert_eq!(host, exact(&fixture.root, HOST).unwrap());
    assert_eq!(
        modified,
        fs::metadata(fixture.root.join(HOST))
            .unwrap()
            .modified()
            .unwrap()
    );
    let packaged = fixture._directory.path().join("control");
    for asset in [
        "patch-assets/host-bridge.jsfrag",
        "patch-assets/route-bridge.jsfrag",
        "webview/decision-control.js",
        "webview/decision-settings.js",
        "icon.png",
    ] {
        let target = packaged.join(asset);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(
            target,
            exact(&fixture.repo.join("vscode-control"), asset).unwrap(),
        )
        .unwrap();
    }
    assert_eq!(
        fixture.state(&packaged).unwrap(),
        "ready",
        "VSIX and repository roots agree"
    );
    fs::write(
        packaged.join("webview/decision-control.js"),
        "upgraded control",
    )
    .unwrap();
    assert_eq!(fixture.state(&packaged).unwrap(), "outdated");
    lifecycle::update(
        &packaged,
        &fixture.root,
        &fixture.backup,
        &fixture.spec,
        &fixture.bridges,
    )
    .unwrap();
    assert_eq!(fixture.state(&packaged).unwrap(), "ready");
    lifecycle::restore(&fixture.root, &fixture.backup, &fixture.spec).unwrap();
    assert_eq!(
        fixture.state(&packaged).unwrap(),
        "unpatched",
        "saved prior rollback permits reapply"
    );
}

#[test]
fn status_refuses_host_rollback_and_metadata_tampering() {
    for target in ["host", "rollback", "metadata", "removed-digest"] {
        let fixture = Fixture::new();
        fixture.apply();
        match target {
            "host" => fs::write(fixture.root.join(HOST), "tampered").unwrap(),
            "rollback" => fs::write(fixture.backup.join(HOST), "tampered").unwrap(),
            _ => {
                let mut value: Value =
                    serde_json::from_slice(&exact(&fixture.backup, "manifest.json").unwrap())
                        .unwrap();
                if target == "removed-digest" {
                    value["patched"].as_object_mut().unwrap().remove(HOST);
                } else {
                    value["originalRoute"] = json!("tampered");
                }
                fs::write(
                    fixture.backup.join("manifest.json"),
                    serde_json::to_vec(&value).unwrap(),
                )
                .unwrap();
            }
        }
        assert!(fixture.state(&fixture.repo).is_err(), "refuse {target}");
    }
    assert!(
        Spec::production("26.1007.99999").is_err(),
        "unknown builds stay pinned"
    );
}

#[cfg(unix)]
#[test]
fn patch_lock_is_exclusive_released_on_drop_and_rejects_linked_ancestors() {
    let fixture = Fixture::new();
    let lock = locking::acquire(&fixture.backup).unwrap();
    let error = locking::acquire(&fixture.backup).unwrap_err();
    assert_eq!(error, "Decision patch is busy; retry later");
    assert!(!fixture.backup.exists(), "locking creates no state");
    drop(lock);
    assert!(locking::acquire(&fixture.backup).is_ok());
    let link = fixture._directory.path().join("linked");
    std::os::unix::fs::symlink(&fixture.root, &link).unwrap();
    assert!(locking::acquire(&link.join("rollback")).is_err());
    assert!(exact(&link, HOST).is_err());
    fixture.apply();
    let saved_route = fixture.backup.join(fixture.spec.physical(ROUTE));
    fs::remove_file(&saved_route).unwrap();
    let outside = fixture._directory.path().join("unowned");
    std::os::unix::fs::symlink(&outside, saved_route).unwrap();
    assert!(fixture.state(&fixture.repo).is_err());
    assert!(lifecycle::update(
        &fixture.repo,
        &fixture.root,
        &fixture.backup,
        &fixture.spec,
        &fixture.bridges
    )
    .is_err());
    assert!(
        !outside.exists(),
        "dangling rollback links never receive writes"
    );
}

#[test]
fn october_host_profile_pins_every_mutated_asset() {
    let spec = Spec::production("26.1007.21434").unwrap();
    assert_eq!(
        spec.physical(IMAGE),
        "webview/assets/app-initial-c014f9ee4429.js"
    );
    assert_eq!(
        spec.physical(ROUTE),
        "webview/assets/app-initial-97d3534ad35f.js"
    );
    for path in [HOST, INDEX, IMAGE, ROUTE] {
        assert_eq!(spec.hash(path).len(), 64);
        assert!(spec.hash(path).bytes().all(|byte| byte.is_ascii_hexdigit()));
    }
}
