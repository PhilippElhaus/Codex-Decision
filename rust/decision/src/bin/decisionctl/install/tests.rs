use super::*;
use std::cell::Cell;

fn payload(root: &Path, version: &str) {
    for file in FILES {
        let data = if *file == MANIFEST {
            json!({"name": PLUGIN, "version": version}).to_string()
        } else {
            format!("fixture {version} {file}")
        };
        storage::write(&root.join(file), data.as_bytes(), package_mode(file), true).unwrap();
    }
}

#[test]
fn preserves_registration_and_restores_evicted_versions() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let codex = home.join(".codex");
    let bundled = temp.path().join("payload");
    let marketplace = home.join(".local/share/codex-decision");
    let source = marketplace.join("plugins/codex-decision");
    let cache = codex.join("plugins/cache").join(MARKETPLACE).join(PLUGIN);
    let data = codex
        .join("plugins/data")
        .join(format!("{PLUGIN}-{MARKETPLACE}"));
    let registered = Cell::new(false);
    let current = Cell::new(None);
    let adds = Cell::new(0);
    let run = |args: &[&OsStr]| match args
        .iter()
        .map(|arg| arg.to_string_lossy())
        .collect::<Vec<_>>()
        .as_slice()
    {
        [action] if action == "list" => {
            let installed = current.get().map(|version| json!({"name": PLUGIN, "installed":true, "enabled":true,
                    "version":version, "marketplaceName":MARKETPLACE, "pluginId":format!("{PLUGIN}@{MARKETPLACE}"),
                    "source":{"source":"local", "path":source}}));
            Ok(json!({"installed": installed.into_iter().collect::<Vec<_>>()}))
        }
        [action, sub] if action == "marketplace" && sub == "list" => {
            let roots = if registered.get() {
                json!([{"name":MARKETPLACE,"root":marketplace}])
            } else {
                json!([])
            };
            Ok(json!({"marketplaces":roots}))
        }
        [action, sub, _] if action == "marketplace" && sub == "add" => {
            registered.set(true);
            Ok(json!({}))
        }
        [action, _] if action == "add" => {
            if let Some(old) = current.get() {
                fs::remove_dir_all(cache.join(old)).unwrap();
            }
            let version = if adds.get() == 0 { "1.0.0" } else { "1.0.1" };
            current.set(Some(version));
            adds.set(adds.get() + 1);
            payload(&cache.join(version), version);
            Ok(json!({}))
        }
        _ => panic!("unexpected Codex fixture command"),
    };
    payload(&bundled, "1.0.0");
    assert_eq!(
        install(&bundled, &home, &codex, None, run).unwrap()["status"],
        "installed"
    );
    assert_eq!(
        install(&bundled, &home, &codex, Some(&data), run).unwrap()["status"],
        "ready"
    );
    let extra = cache.join("1.0.0/active-thread.txt");
    storage::write(&extra, b"retained", 0o600, true).unwrap();
    payload(&bundled, "1.0.1");
    let updated = install(&bundled, &home, &codex, Some(&data), run).unwrap();
    assert_eq!(updated["status"], "installed");
    assert!(updated["cacheRollback"].is_string());
    assert_eq!(fs::read(extra).unwrap(), b"retained");
    assert_eq!(adds.get(), 2);
}

#[test]
fn refuses_unknown_cache_before_reading_private_file() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    payload(&root.join("1.0.0"), "1.0.0");
    storage::write(
        &root.join("1.0.0/.env"),
        b"synthetic private fixture",
        0o600,
        true,
    )
    .unwrap();
    assert!(cache::snapshot(root).is_err());
}
