//! Bounded session log retention.
use super::*;

fn managed_name(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
        return false;
    };
    let valid_id = |id: &str| {
        id.len() == 32
            && id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if let Some(id) = name.strip_prefix("receipt-") {
        return valid_id(id);
    }
    name.strip_prefix("batch-")
        .and_then(|name| name.rsplit_once('-'))
        .is_some_and(|(id, number)| {
            valid_id(id)
                && (number == "0" || !number.starts_with('0'))
                && number.bytes().all(|byte| byte.is_ascii_digit())
                && number.parse::<usize>().is_ok_and(|n| n <= MAX_SOURCE_LINES)
        })
}

pub(super) fn prune(logs: &Path, budget: u64) {
    let index = logs.join("events.jsonl");
    if let Ok(Some(tail)) = read_private_tail(&index, 1_048_576) {
        if let Some(newline) = tail.iter().position(|byte| *byte == b'\n') {
            let _ = write_private(&index, &tail[newline + 1..], true);
        }
    }
    let Ok(entries) = fs::read_dir(logs) else {
        return;
    };
    #[cfg(unix)]
    // SAFETY: geteuid takes no arguments and reads this process's effective ID.
    let owner = unsafe { libc::geteuid() };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_symlink() {
            continue;
        }
        if path.is_dir() {
            if let Ok(children) = fs::read_dir(path) {
                for child in children.flatten() {
                    let item = child.path();
                    if !managed_name(&child.file_name()) {
                        continue;
                    }
                    let Ok(meta) = fs::symlink_metadata(&item) else {
                        continue;
                    };
                    if !meta.is_file() || meta.file_type().is_symlink() {
                        continue;
                    }
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::{MetadataExt, PermissionsExt};
                        // Retention owns only files created by the private
                        // record writer. Preserve copied or foreign content.
                        if meta.uid() != owner || meta.permissions().mode() & 0o077 != 0 {
                            continue;
                        }
                    }
                    files.push((meta.modified().ok(), item, meta.len()));
                }
            }
        }
    }
    let mut total: u64 = files.iter().map(|(_, _, size)| size).sum();
    files.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    for (_, path, size) in files {
        if total <= budget {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

#[cfg(test)]
#[path = "retention_tests.rs"]
mod tests;
