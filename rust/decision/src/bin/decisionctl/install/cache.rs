//! Preserve versioned hook paths already recorded by Codex threads.
use super::*;
use std::fs::Metadata;

const INVALID: &str =
    "Decision cache contains unsafe or unknown installation state; preserve it before repair";
const CHANGED: &str =
    "An active Decision cache changed during installation; its rollback was retained";

#[derive(Default)]
struct Budget {
    entries: usize,
    bytes: u64,
}

#[derive(Default)]
struct Tree {
    directories: BTreeMap<PathBuf, u32>,
    files: BTreeMap<PathBuf, Metadata>,
}

#[derive(Default)]
pub(super) struct Version {
    directories: BTreeMap<PathBuf, u32>,
    files: BTreeMap<PathBuf, (Vec<u8>, u32)>,
}

fn private_name(name: &OsStr) -> bool {
    let Some(name) = name.to_str().map(str::to_ascii_lowercase) else {
        return true;
    };
    matches!(
        name.as_str(),
        ".env" | "auth.json" | "id_rsa" | "id_ed25519"
    ) || [".env.", "credential", "token"]
        .iter()
        .any(|prefix| name.starts_with(prefix))
        || [".key", ".p12", ".pfx"]
            .iter()
            .any(|suffix| name.ends_with(suffix))
}

fn tree(root: &Path, budget: &mut Budget) -> Result<Tree, String> {
    let mut result = Tree::default();
    if storage::info(root)?.is_none() {
        return Ok(result);
    }
    let mut pending = vec![(PathBuf::new(), 0)];
    while let Some((relative, depth)) = pending.pop() {
        let path = root.join(&relative);
        let info = storage::info(&path)?.ok_or(INVALID)?;
        budget.entries += 1;
        if budget.entries > 4096 || depth > 32 {
            return Err(INVALID.into());
        }
        if info.is_dir() {
            result
                .directories
                .insert(relative.clone(), storage::mode(&info));
            for entry in fs::read_dir(path).map_err(|_| INVALID)? {
                let name = entry.map_err(|_| INVALID)?.file_name();
                if private_name(&name) || pending.len() + budget.entries >= 4096 {
                    return Err(INVALID.into());
                }
                pending.push((relative.join(name), depth + 1));
            }
        } else if info.is_file() && depth > 0 {
            budget.bytes = budget.bytes.checked_add(info.len()).ok_or(INVALID)?;
            if info.len() > FILE_LIMIT || budget.bytes > 512 * 1024 * 1024 {
                return Err(INVALID.into());
            }
            result.files.insert(relative, info);
        } else {
            return Err(INVALID.into());
        }
    }
    Ok(result)
}

fn read(path: &Path, expected: &Metadata, limit: u64) -> Result<Vec<u8>, String> {
    let matches = |actual: Metadata| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if (
                actual.dev(),
                actual.ino(),
                actual.ctime(),
                actual.ctime_nsec(),
            ) != (
                expected.dev(),
                expected.ino(),
                expected.ctime(),
                expected.ctime_nsec(),
            ) {
                return false;
            }
        }
        actual.is_file()
            && actual.len() == expected.len()
            && actual.modified().ok() == expected.modified().ok()
            && storage::mode(&actual) == storage::mode(expected)
    };
    if !storage::info(path)?.is_some_and(matches) {
        return Err(CHANGED.into());
    }
    let data = storage::read(path, limit)?;
    if data.len() as u64 != expected.len() || !storage::info(path)?.is_some_and(matches) {
        return Err(CHANGED.into());
    }
    Ok(data)
}

pub(super) fn snapshot(root: &Path) -> Result<BTreeMap<String, Version>, String> {
    let mut snapshots = BTreeMap::new();
    if storage::info(root)?.is_none() {
        return Ok(snapshots);
    }
    let mut budget = Budget::default();
    let mut inventories = BTreeMap::new();
    for entry in fs::read_dir(root).map_err(|_| INVALID)? {
        if inventories.len() >= 32 {
            return Err(INVALID.into());
        }
        let version = entry
            .map_err(|_| INVALID)?
            .file_name()
            .into_string()
            .map_err(|_| INVALID)?;
        parse_version(&version)?;
        inventories.insert(version.clone(), tree(&root.join(version), &mut budget)?);
    }
    // Validate ownership of every version before reading any cached binary.
    for (version, inventory) in &inventories {
        let info = inventory.files.get(Path::new(MANIFEST)).ok_or(INVALID)?;
        let data = read(&root.join(version).join(MANIFEST), info, 128_000)?;
        let manifest = codex_decision::strict_json::parse(&data).map_err(|_| INVALID)?;
        if manifest["name"] != PLUGIN || manifest["version"] != *version {
            return Err(INVALID.into());
        }
    }
    for (version, inventory) in inventories {
        let mut saved = Version {
            directories: inventory.directories,
            ..Version::default()
        };
        let path = root.join(&version);
        for (relative, info) in inventory.files {
            let data = read(&path.join(&relative), &info, FILE_LIMIT)?;
            saved.files.insert(relative, (data, storage::mode(&info)));
        }
        snapshots.insert(version, saved);
    }
    Ok(snapshots)
}

pub(super) fn save(
    cache: &Path,
    snapshots: &BTreeMap<String, Version>,
    root: &Path,
    source: &Path,
) -> Result<Option<PathBuf>, String> {
    if snapshots.is_empty() {
        return Ok(None);
    }
    let root = root.join(uuid::Uuid::new_v4().to_string());
    let mut versions = serde_json::Map::new();
    for (version, saved) in snapshots {
        for (path, (data, _)) in &saved.files {
            storage::write(
                &root.join("cache").join(version).join(path),
                data,
                0o600,
                true,
            )?;
        }
        let modes: BTreeMap<_, _> = saved
            .files
            .iter()
            .map(|(path, (_, mode))| (path, mode))
            .collect();
        versions.insert(
            version.clone(),
            json!({"modes": modes, "directories": saved.directories}),
        );
    }
    let metadata = json!({"cacheRoot": cache, "versions": versions});
    storage::write(
        &root.join("cache-state.json"),
        metadata.to_string().as_bytes(),
        0o600,
        true,
    )?;
    storage::write(
        &root.join("source.json"),
        json!({"source": source}).to_string().as_bytes(),
        0o600,
        true,
    )?;
    Ok(Some(root))
}

pub(super) fn restore(
    cache: &Path,
    snapshots: &BTreeMap<String, Version>,
    installed: Option<&str>,
) -> Result<(), String> {
    let managed: HashSet<PathBuf> = FILES.iter().map(PathBuf::from).collect();
    let managed_directories: HashSet<_> = managed
        .iter()
        .flat_map(|name| name.ancestors().skip(1))
        .collect();
    for (version, saved) in snapshots {
        let fresh = Some(version.as_str()) == installed;
        let keep_file = |path: &Path| !fresh || !managed.contains(path);
        let keep_directory = |path: &Path| !fresh || !managed_directories.contains(path);
        let root = cache.join(version);
        let present = tree(&root, &mut Budget::default())?;
        for (relative, mode) in &present.directories {
            if keep_directory(relative)
                && (!fresh || saved.directories.contains_key(relative))
                && saved.directories.get(relative) != Some(mode)
            {
                return Err(CHANGED.into());
            }
        }
        for (relative, info) in &present.files {
            if !keep_file(relative) || fresh && !saved.files.contains_key(relative) {
                continue;
            }
            let (data, mode) = saved.files.get(relative).ok_or(CHANGED)?;
            if storage::mode(info) != *mode
                || &read(&root.join(relative), info, FILE_LIMIT)? != data
            {
                return Err(CHANGED.into());
            }
        }
        let mut created = Vec::new();
        for (relative, mode) in &saved.directories {
            if !keep_directory(relative) || present.directories.contains_key(relative) {
                continue;
            }
            let path = root.join(relative);
            storage::mkdir(&path)?;
            created.push((path, *mode));
        }
        for (relative, (data, mode)) in &saved.files {
            if !keep_file(relative) || present.files.contains_key(relative) {
                continue;
            }
            let path = root.join(relative);
            if let Err(error) = storage::write(&path, data, *mode, false) {
                let Some(info) = storage::info(&path)? else {
                    return Err(error);
                };
                if storage::mode(&info) != *mode || &read(&path, &info, FILE_LIMIT)? != data {
                    return Err(CHANGED.into());
                }
            }
        }
        for (path, mode) in created.into_iter().rev() {
            storage::set_mode(&path, mode)?;
        }
    }
    Ok(())
}
