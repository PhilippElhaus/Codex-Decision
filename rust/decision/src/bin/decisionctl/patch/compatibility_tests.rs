use super::*;

struct Fixture {
    _directory: tempfile::TempDir,
    root: PathBuf,
    backup: PathBuf,
    spec: Spec,
    originals: BTreeMap<&'static str, Vec<u8>>,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("host");
        let backup = directory.path().join("rollback");
        let profile = Spec::production("26.51021.22027").unwrap().1;
        let originals = BTreeMap::from([
            (HOST, format!("prefix {HOST_ANCHOR} suffix").into_bytes()),
            (INDEX, profile.index_anchor.as_bytes().to_vec()),
            (IMAGE, profile.image_anchor.as_bytes().to_vec()),
            (ROUTE, profile.route_anchor.as_bytes().to_vec()),
        ]);
        let spec = Spec(
            originals
                .iter()
                .map(|(path, bytes)| (*path, hash(bytes)))
                .collect(),
            profile,
        );
        for (path, bytes) in &originals {
            let target = root.join(spec.physical(path));
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, bytes).unwrap();
        }
        Self {
            _directory: directory,
            root,
            backup,
            spec,
            originals,
        }
    }

    fn select(&self) -> Option<Spec> {
        matching(&self.root, &self.backup, std::iter::once(self.spec.clone()))
    }
}

#[test]
fn preview_profile_pins_its_changed_entry_and_plugin_module() {
    let preview = Spec::production("26.51021.22027").unwrap();
    let stable = Spec::production("26.1021.22027").unwrap();
    assert_eq!(
        preview.physical(IMAGE),
        "webview/assets/use-plugins-52fc2bccd2b9.js"
    );
    assert!(preview.1.index_anchor.contains("index-e622cadf605d.js"));
    assert_eq!(preview.hash(HOST), stable.hash(HOST));
    assert_eq!(preview.hash(ROUTE), stable.hash(ROUTE));
    assert_ne!(preview.hash(INDEX), stable.hash(INDEX));
    assert_ne!(preview.hash(IMAGE), stable.hash(IMAGE));
}

#[test]
fn compatible_assets_require_every_original_and_preserve_unknown_files() {
    let fixture = Fixture::new();
    assert!(fixture.select().is_some());
    assert!(!fixture.backup.exists());
    for path in [HOST, INDEX, IMAGE, ROUTE] {
        let target = fixture.root.join(fixture.spec.physical(path));
        fs::write(&target, "changed module with the same package version").unwrap();
        assert!(fixture.select().is_none(), "reject changed {path}");
        assert!(!fixture.backup.exists());
        fs::write(&target, &fixture.originals[path]).unwrap();
    }
    assert!(installed("26.59999.99999", &fixture.root, &fixture.backup).is_err());
    // The same host and router are insufficient when the index/plugin differ.
    let mut other = fixture.spec.clone();
    other.0.insert(INDEX, hash(b"other index"));
    assert!(matching(&fixture.root, &fixture.backup, std::iter::once(other)).is_none());
}

#[test]
fn compatible_asset_selection_survives_upgrade_and_exact_restore() {
    let fixture = Fixture::new();
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let bridges = bridge::Bridges {
        image: String::new(),
        marketplace: String::new(),
    };
    assert_eq!(
        status::read(
            &repo,
            &fixture.root,
            &fixture.backup,
            &fixture.select().unwrap(),
            &bridges
        )
        .unwrap(),
        "unpatched"
    );
    lifecycle::apply(
        &repo,
        &fixture.root,
        &fixture.backup,
        &fixture.select().unwrap(),
        &bridges,
    )
    .unwrap();
    assert_eq!(
        status::read(
            &repo,
            &fixture.root,
            &fixture.backup,
            &fixture.select().unwrap(),
            &bridges
        )
        .unwrap(),
        "ready"
    );
    lifecycle::update(
        &repo,
        &fixture.root,
        &fixture.backup,
        &fixture.select().unwrap(),
        &bridges,
    )
    .unwrap();
    lifecycle::restore(&fixture.root, &fixture.backup, &fixture.select().unwrap()).unwrap();
    assert_eq!(
        status::read(
            &repo,
            &fixture.root,
            &fixture.backup,
            &fixture.select().unwrap(),
            &bridges
        )
        .unwrap(),
        "unpatched"
    );
    for (path, bytes) in &fixture.originals {
        assert_eq!(
            exact(&fixture.root, fixture.spec.physical(path)).unwrap(),
            *bytes
        );
    }
    let manifest_path = fixture.backup.join("manifest.json");
    let manifest = fs::read(&manifest_path).unwrap();
    fs::write(&manifest_path, b"{}").unwrap();
    assert!(
        fixture.select().is_none(),
        "reject unrelated rollback metadata"
    );
    fs::write(&manifest_path, manifest).unwrap();
    fs::write(fixture.backup.join(HOST), b"changed rollback").unwrap();
    assert!(fixture.select().is_none(), "reject changed rollback bytes");
}
