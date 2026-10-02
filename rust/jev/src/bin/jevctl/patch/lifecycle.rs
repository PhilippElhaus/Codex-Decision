use super::*;

fn originals(root: &Path, spec: &Spec) -> Result<BTreeMap<&'static str, Vec<u8>>, String> {
    [HOST, INDEX, IMAGE, ROUTE]
        .into_iter()
        .map(|path| exact(root, spec.physical(path)).map(|bytes| (path, bytes)))
        .collect()
}

fn manifest(backup: &Path, spec: &Spec) -> Result<Value, String> {
    let value = crate::read_json(&backup.join("manifest.json"), 32_000)?;
    if value["version"] != spec.1.version
        || value["original"] != spec.manifest_original()
        || !value["patched"].is_object()
    {
        return Err("rollback metadata changed".into());
    }
    Ok(value)
}

fn validate_patched(root: &Path, metadata: &Value, spec: &Spec) -> Result<(), String> {
    for (path, expected) in metadata["patched"].as_object().unwrap() {
        if ![
            HOST,
            INDEX,
            spec.physical(IMAGE),
            spec.physical(ROUTE),
            CONTROL,
            SETTINGS,
            ICON,
        ]
        .contains(&path.as_str())
            || hash(&exact(root, path)?) != expected.as_str().ok_or("invalid patched digest")?
        {
            return Err(format!("patched file changed: {path}"));
        }
    }
    Ok(())
}

fn validate_originals(backup: &Path, spec: &Spec) -> Result<(), String> {
    for path in [HOST, INDEX] {
        if hash(&exact(backup, spec.physical(path))?) != spec.hash(path) {
            return Err(format!("rollback file changed: {path}"));
        }
    }
    for path in [IMAGE, ROUTE] {
        if backup.join(spec.physical(path)).is_file()
            && hash(&exact(backup, spec.physical(path))?) != spec.hash(path)
        {
            return Err(format!("rollback file changed: {path}"));
        }
    }
    Ok(())
}

fn write_files(root: &Path, files: &BTreeMap<&'static str, Vec<u8>>) -> Result<(), String> {
    for (path, bytes) in files {
        let target = root.join(path);
        fs::create_dir_all(target.parent().ok_or("invalid patch target")?)
            .map_err(|error| error.to_string())?;
        if [CONTROL, SETTINGS, ICON].contains(path) && !target.exists() && !target.is_symlink() {
            fs::write(target, bytes).map_err(|error| error.to_string())?;
        } else {
            write_exact(&target, bytes)?;
        }
    }
    Ok(())
}

fn rollback(root: &Path, original: &BTreeMap<&'static str, Vec<u8>>, assets: &[&str]) {
    for (path, bytes) in original {
        let _ = write_exact(&root.join(path), bytes);
    }
    for asset in assets {
        let _ = fs::remove_file(root.join(asset));
    }
}

pub(super) fn apply(
    repo: &Path,
    root: &Path,
    backup: &Path,
    spec: &Spec,
    bridges: &bridge::Bridges,
) -> Result<(), String> {
    let exists = backup.exists();
    if exists {
        let _ = manifest(backup, spec)?;
        validate_originals(backup, spec)?;
    }
    for asset in [CONTROL, SETTINGS, ICON] {
        if root.join(asset).exists() || root.join(asset).is_symlink() {
            return Err(format!("Codex asset already exists: {asset}"));
        }
    }
    let original = originals(root, spec)?;
    let files = changed(repo, &original, spec, bridges)?;
    if !exists {
        fs::create_dir(backup).map_err(|error| error.to_string())?;
        for (path, bytes) in &original {
            let target = backup.join(spec.physical(path));
            fs::create_dir_all(target.parent().unwrap()).map_err(|error| error.to_string())?;
            fs::write(target, bytes).map_err(|error| error.to_string())?;
        }
    }
    let patched: BTreeMap<&str, String> = files
        .iter()
        .map(|(path, bytes)| (*path, hash(bytes)))
        .collect();
    let metadata = json!({"version":spec.1.version,"original":spec.manifest_original(),
        "originalImage":spec.hash(IMAGE),"originalRoute":spec.hash(ROUTE),"patched":patched});
    let mut bytes = serde_json::to_vec_pretty(&metadata).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    let result = write_files(root, &files).and_then(|_| {
        if exists {
            write_exact(&backup.join("manifest.json"), &bytes)
        } else {
            fs::write(backup.join("manifest.json"), &bytes).map_err(|error| error.to_string())
        }
    });
    if result.is_err() {
        let physical = original
            .into_iter()
            .map(|(path, bytes)| (spec.physical(path), bytes))
            .collect();
        rollback(root, &physical, &[CONTROL, SETTINGS, ICON]);
    }
    result
}

pub(super) fn update(
    repo: &Path,
    root: &Path,
    backup: &Path,
    spec: &Spec,
    bridges: &bridge::Bridges,
) -> Result<(), String> {
    let mut metadata = manifest(backup, spec)?;
    validate_patched(root, &metadata, spec)?;
    validate_originals(backup, spec)?;
    let old_manifest = exact(backup, "manifest.json")?;
    let mut original = BTreeMap::new();
    for path in [HOST, INDEX, IMAGE, ROUTE] {
        let bytes = if backup.join(spec.physical(path)).is_file() {
            exact(backup, spec.physical(path))?
        } else {
            exact(root, spec.physical(path))?
        };
        original.insert(path, bytes);
    }
    let files = changed(repo, &original, spec, bridges)?;
    for asset in [CONTROL, SETTINGS, ICON] {
        if metadata["patched"].get(asset).is_none()
            && (root.join(asset).exists() || root.join(asset).is_symlink())
        {
            return Err(format!("Codex asset already exists: {asset}"));
        }
    }
    let new_assets: Vec<&str> = [CONTROL, SETTINGS, ICON]
        .into_iter()
        .filter(|asset| metadata["patched"].get(*asset).is_none())
        .collect();
    let previous: BTreeMap<&str, Vec<u8>> = files
        .keys()
        .filter(|path| metadata["patched"].get(**path).is_some())
        .map(|path| exact(root, path).map(|bytes| (*path, bytes)))
        .collect::<Result<_, _>>()?;
    for path in [IMAGE, ROUTE] {
        if !backup.join(spec.physical(path)).is_file() {
            let target = backup.join(spec.physical(path));
            fs::create_dir_all(target.parent().unwrap()).map_err(|error| error.to_string())?;
            fs::write(target, &original[path]).map_err(|error| error.to_string())?;
        }
    }
    for (path, bytes) in &files {
        metadata["patched"][*path] = json!(hash(bytes));
    }
    metadata["originalImage"] = json!(spec.hash(IMAGE));
    metadata["originalRoute"] = json!(spec.hash(ROUTE));
    let mut new_manifest =
        serde_json::to_vec_pretty(&metadata).map_err(|error| error.to_string())?;
    new_manifest.push(b'\n');
    let result = write_files(root, &files)
        .and_then(|_| write_exact(&backup.join("manifest.json"), &new_manifest));
    if result.is_err() {
        for (path, bytes) in previous {
            let _ = write_exact(&root.join(path), &bytes);
        }
        for asset in new_assets {
            let _ = fs::remove_file(root.join(asset));
        }
        let _ = write_exact(&backup.join("manifest.json"), &old_manifest);
    }
    result
}

pub(super) fn restore(root: &Path, backup: &Path, spec: &Spec) -> Result<(), String> {
    let metadata = manifest(backup, spec)?;
    validate_patched(root, &metadata, spec)?;
    validate_originals(backup, spec)?;
    for path in [HOST, INDEX, IMAGE, ROUTE] {
        if backup.join(spec.physical(path)).is_file() {
            write_exact(
                &root.join(spec.physical(path)),
                &exact(backup, spec.physical(path))?,
            )?;
        }
    }
    for asset in [CONTROL, SETTINGS, ICON] {
        if metadata["patched"].get(asset).is_some() {
            fs::remove_file(root.join(asset)).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub fn run(action: &str, repo: &Path, extension: &Path, backup: &Path) -> Result<(), String> {
    if !repo.is_dir()
        || extension.is_symlink()
        || backup.is_symlink()
        || !extension.is_absolute()
        || !backup.is_absolute()
        || [extension, backup].iter().any(|path| {
            let text = path.to_string_lossy().to_ascii_lowercase();
            text == "/mnt/d" || text.starts_with("/mnt/d/") || text.starts_with("d:\\")
        })
    {
        return Err("extension and rollback must be valid paths off D:".into());
    }
    let package = crate::read_json(&extension.join("package.json"), 1_000_000)?;
    let version = package["version"]
        .as_str()
        .ok_or("Codex extension version missing")?;
    let spec = Spec::production(version)?;
    match action {
        "apply" => apply(repo, extension, backup, &spec, &bridge::bridges(repo)?),
        "update" => update(repo, extension, backup, &spec, &bridge::bridges(repo)?),
        "restore" => restore(extension, backup, &spec),
        _ => Err("unknown patch action".into()),
    }?;
    println!("{action}: {} composer control ready", spec.1.version);
    Ok(())
}
