//! Inspect the exact installed patch without changing host or rollback files.
use super::*;

pub(super) fn read(
    repo: &Path,
    root: &Path,
    backup: &Path,
    spec: &Spec,
    bridges: &bridge::Bridges,
) -> Result<&'static str, String> {
    let pristine = lifecycle::originals(root, spec)?
        .iter()
        .all(|(path, bytes)| hash(bytes) == spec.hash(path));
    if pristine {
        if backup.exists() {
            lifecycle::manifest(backup, spec)?;
            lifecycle::validate_originals(backup, spec)?;
        }
        for asset in [CONTROL, SETTINGS, ICON] {
            if root.join(asset).exists() || root.join(asset).is_symlink() {
                return Err(format!("Codex asset already exists: {asset}"));
            }
        }
        return Ok("unpatched");
    }
    let metadata = lifecycle::manifest(backup, spec)?;
    lifecycle::validate_patched(root, &metadata, spec)?;
    lifecycle::validate_originals(backup, spec)?;
    let original = lifecycle::saved_originals(root, backup, spec)?;
    let wanted = changed(repo, &original, spec, bridges)?;
    let mut current = true;
    for (path, bytes) in wanted {
        if metadata["patched"].get(path).is_some() {
            current &= exact(root, path)? == bytes;
        } else {
            current = false;
            if [CONTROL, SETTINGS, ICON].contains(&path) {
                if root.join(path).exists() || root.join(path).is_symlink() {
                    return Err(format!("Codex asset already exists: {path}"));
                }
            } else if hash(&exact(root, path)?)
                != spec.hash(if path == spec.physical(IMAGE) {
                    IMAGE
                } else if path == spec.physical(ROUTE) {
                    ROUTE
                } else {
                    path
                })
            {
                return Err(format!("unmanaged Codex file changed: {path}"));
            }
        }
    }
    Ok(if current { "ready" } else { "outdated" })
}
