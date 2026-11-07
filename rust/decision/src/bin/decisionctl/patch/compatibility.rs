//! Select reviewed assets even when a distribution changes its package version.
use super::*;

#[cfg(test)]
#[path = "compatibility_tests.rs"]
mod tests;

pub(super) fn installed(version: &str, root: &Path, backup: &Path) -> Result<Spec, String> {
    if let Ok(spec) = Spec::production(version) {
        return Ok(spec);
    }
    // Never infer compatibility from a version prefix or insertion point alone.
    matching(
        root,
        backup,
        profiles::VERSIONS
            .iter()
            .filter_map(|version| Spec::production(version).ok()),
    )
    .ok_or_else(|| "unsupported Codex assets; revalidate the composer patch".into())
}

fn matching(root: &Path, backup: &Path, candidates: impl Iterator<Item = Spec>) -> Option<Spec> {
    let source = if backup.exists() { backup } else { root };
    let host_hash = hash(&exact(source, HOST).ok()?);
    candidates
        .filter(|spec| spec.hash(HOST) == host_hash)
        .find(|spec| {
            if backup.exists()
                && (lifecycle::manifest(backup, spec).is_err()
                    || lifecycle::validate_originals(backup, spec).is_err())
            {
                return false;
            }
            lifecycle::saved_originals(root, backup, spec).is_ok_and(|originals| {
                originals
                    .iter()
                    .all(|(path, bytes)| hash(bytes) == spec.hash(path))
            })
        })
}
